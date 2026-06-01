// supergit-pty-helper — Go replacement for helper.mjs.
//
// Same NDJSON wire protocol as the Node version. Hosts multiple PTYs,
// talks to the Bun daemon over stdin/stdout. No Node dependency.
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/aymanbagabas/go-pty"
)

type term struct {
	cmd       *pty.Cmd
	pty       pty.Pty
	closeOnce sync.Once
}

// close tears down the PTY exactly once. Both the soft-kill path (Windows)
// and the exit goroutine call this; closing a pty twice would otherwise
// race. On Windows, closing the pseudoconsole delivers a CTRL_CLOSE_EVENT
// to the attached child — the graceful "you're about to die, flush now"
// signal that lets Claude finish writing .claude.json.
func (t *term) close() {
	t.closeOnce.Do(func() { _ = t.pty.Close() })
}

var (
	terms   = make(map[string]*term)
	termsMu sync.Mutex
)

func emit(v any) {
	b, _ := json.Marshal(v)
	os.Stdout.Write(append(b, '\n'))
}

func fail(message string, id string) {
	m := map[string]any{"ev": "error", "message": message}
	if id != "" {
		m["id"] = id
	}
	emit(m)
}

// scrubEnv returns a copy of the current env with launcher-specific
// portless, no-color, and macOS session-restore vars removed.
func scrubEnv() []string {
	skip := map[string]bool{
		"PORT":                 true,
		"PORTLESS_URL":         true,
		"NODE_EXTRA_CA_CERTS":  true,
		"TERM_PROGRAM":         true,
		"TERM_PROGRAM_VERSION": true,
		"TERM_SESSION_ID":      true,
		"TERM":                 true,
		"NO_COLOR":             true,
		"COLOR":                true,
	}
	var out []string
	for _, kv := range os.Environ() {
		for i := range kv {
			if kv[i] == '=' {
				if !skip[kv[:i]] {
					out = append(out, kv)
				}
				break
			}
		}
	}
	out = append(out, "SHELL_SESSIONS_DISABLE=1")
	out = append(out, "TERM=xterm-256color")
	out = append(out, "COLORTERM=truecolor")
	return out
}

func mergeEnv(base []string, extra map[string]string) []string {
	if len(extra) == 0 {
		return base
	}
	override := make(map[string]string, len(extra))
	for k, v := range extra {
		override[k] = v
	}
	var out []string
	for _, kv := range base {
		for i := range kv {
			if kv[i] == '=' {
				if _, ok := override[kv[:i]]; !ok {
					out = append(out, kv)
				}
				break
			}
		}
	}
	for k, v := range override {
		out = append(out, k+"="+v)
	}
	return out
}

func envSnapshot(env []string) map[string]any {
	keys := []string{
		"TERM_PROGRAM", "TERM_SESSION_ID", "SHELL_SESSIONS_DISABLE",
		"ZDOTDIR", "HISTFILE", "HISTSIZE", "SAVEHIST",
		"TERM", "COLORTERM", "NO_COLOR", "COLOR", "HOME", "SHELL", "PATH",
	}
	lookup := make(map[string]string, len(env))
	for _, kv := range env {
		for i := range kv {
			if kv[i] == '=' {
				lookup[kv[:i]] = kv[i+1:]
				break
			}
		}
	}
	snap := make(map[string]any, len(keys))
	for _, k := range keys {
		if v, ok := lookup[k]; ok {
			snap[k] = v
		} else {
			snap[k] = nil
		}
	}
	return snap
}

func handleSpawn(msg map[string]any) {
	id, _ := msg["id"].(string)
	cmdArr, _ := msg["cmd"].([]any)
	cwd, _ := msg["cwd"].(string)
	cols := intOr(msg["cols"], 80)
	rows := intOr(msg["rows"], 24)

	if id == "" || len(cmdArr) == 0 {
		fail("spawn needs id and cmd[]", id)
		return
	}

	args := make([]string, len(cmdArr))
	for i, a := range cmdArr {
		args[i] = fmt.Sprint(a)
	}

	// go-pty requires that we create the PTY first, then spawn through
	// p.Command(...) — on Windows the ConPTY pseudoconsole has to be
	// attached as a process attribute at CreateProcess time, which
	// stdlib's os/exec can't do. Same code path works on unix too.
	p, err := pty.New()
	if err != nil {
		fail("pty create failed: "+err.Error(), id)
		return
	}
	if err := p.Resize(cols, rows); err != nil {
		_ = p.Close()
		fail("pty resize failed: "+err.Error(), id)
		return
	}

	cmd := p.Command(args[0], args[1:]...)
	if cwd != "" {
		cmd.Dir = cwd
	}

	base := scrubEnv()
	var extra map[string]string
	if envMap, ok := msg["env"].(map[string]any); ok {
		extra = make(map[string]string, len(envMap))
		for k, v := range envMap {
			extra[k] = fmt.Sprint(v)
		}
	}
	merged := mergeEnv(base, extra)
	cmd.Env = merged

	if err := cmd.Start(); err != nil {
		_ = p.Close()
		fail("spawn failed: "+err.Error(), id)
		return
	}

	t := &term{cmd: cmd, pty: p}
	termsMu.Lock()
	terms[id] = t
	termsMu.Unlock()

	emit(map[string]any{"ev": "spawned", "id": id, "pid": cmd.Process.Pid})
	emit(map[string]any{"ev": "env-snapshot", "id": id, "env": envSnapshot(merged)})

	// Wait for the child to exit in one goroutine, read PTY output in
	// another. When the child exits, close the master fd so the read
	// loop breaks — relying on EIO from the slave close alone isn't
	// reliable when subprocesses keep the slave fd open.
	exitCh := make(chan *os.ProcessState, 1)
	go func() {
		state, _ := cmd.Process.Wait()
		exitCh <- state
		t.close()
	}()

	go func() {
		buf := make([]byte, 16384)
		for {
			n, err := p.Read(buf)
			if n > 0 {
				emit(map[string]any{
					"ev":      "data",
					"id":      id,
					"dataB64": base64.StdEncoding.EncodeToString(buf[:n]),
				})
			}
			if err != nil {
				break
			}
		}

		state := <-exitCh
		code := 0
		if state != nil {
			code = state.ExitCode()
		}
		termsMu.Lock()
		delete(terms, id)
		termsMu.Unlock()

		ev := map[string]any{"ev": "exit", "id": id, "code": code}
		if sig := exitSignal(state); sig != "" {
			ev["signal"] = sig
		}
		emit(ev)
	}()
}

func handleWrite(msg map[string]any) {
	id, _ := msg["id"].(string)
	termsMu.Lock()
	t := terms[id]
	termsMu.Unlock()
	if t == nil {
		return
	}
	data, err := base64.StdEncoding.DecodeString(msgStr(msg, "dataB64"))
	if err != nil {
		fail("write: bad base64: "+err.Error(), id)
		return
	}
	if _, err := t.pty.Write(data); err != nil {
		fail("write failed: "+err.Error(), id)
	}
}

func handleResize(msg map[string]any) {
	id, _ := msg["id"].(string)
	termsMu.Lock()
	t := terms[id]
	termsMu.Unlock()
	if t == nil {
		return
	}
	cols := intOr(msg["cols"], 80)
	rows := intOr(msg["rows"], 24)
	_ = t.pty.Resize(cols, rows)
}

func handleKill(msg map[string]any) {
	id, _ := msg["id"].(string)
	termsMu.Lock()
	t := terms[id]
	termsMu.Unlock()
	if t == nil {
		return
	}
	killTerm(t, msg["signal"])
}

func killAll() {
	termsMu.Lock()
	defer termsMu.Unlock()
	for _, t := range terms {
		killTerm(t, nil)
	}
}

// killTerm sends SIGTERM/SIGKILL on unix; on Windows, where neither
// signal exists, it falls back to Process.Kill() (terminate). `sigArg`
// is the raw value from the JSONL "signal" field — accepted strings
// are "SIGTERM" (default) and "SIGKILL"; anything else maps to TERM.
func killTerm(t *term, sigArg any) {
	if t == nil || t.cmd == nil || t.cmd.Process == nil {
		return
	}
	sendSignal(t, wantHardKill(sigArg))
}

// wantHardKill maps the raw JSONL "signal" field to whether we should
// force-terminate. Only the literal "SIGKILL" is hard; the default
// "SIGTERM", a missing field, or anything unexpected is a soft kill so the
// child gets a chance to clean up first.
func wantHardKill(sigArg any) bool {
	s, ok := sigArg.(string)
	return ok && s == "SIGKILL"
}

func intOr(v any, fallback int) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return fallback
}

func msgStr(msg map[string]any, key string) string {
	s, _ := msg[key].(string)
	return s
}

func main() {
	emit(map[string]any{"ev": "ready"})

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		killAll()
		os.Exit(0)
	}()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var msg map[string]any
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			fail("invalid json: "+err.Error(), "")
			continue
		}

		switch msg["op"] {
		case "spawn":
			handleSpawn(msg)
		case "write":
			handleWrite(msg)
		case "resize":
			handleResize(msg)
		case "kill":
			handleKill(msg)
		default:
			fail("unknown op: "+fmt.Sprint(msg["op"]), "")
		}
	}

	killAll()
}
