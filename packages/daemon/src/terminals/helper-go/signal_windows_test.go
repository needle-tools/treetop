//go:build windows

package main

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aymanbagabas/go-pty"
	"golang.org/x/sys/windows"
)

func TestWindowsConsoleCloseReapsWatcherWithoutBlockingKillLoop(t *testing.T) {
	dir := t.TempDir()
	script := "require('fs').writeFileSync('watcher.pid',String(process.pid));process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"
	if err := os.WriteFile(filepath.Join(dir, "watcher.cjs"), []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	p, err := pty.New()
	if err != nil {
		t.Fatal(err)
	}
	shell, err := exec.LookPath("cmd.exe")
	if err != nil {
		t.Fatal(err)
	}
	cmd := p.Command(shell, "/d", "/c", "node", "watcher.cjs")
	cmd.Dir = dir
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		p.Close()
		t.Fatal(err)
	}
	terminal := &term{cmd: cmd, pty: p, done: make(chan struct{})}
	rootHandle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(cmd.Process.Pid))
	if err != nil {
		cmd.Process.Kill()
		terminal.close()
		t.Fatal(err)
	}
	// Retaining the original process handles prevents PID reuse during cleanup.
	defer windows.CloseHandle(rootHandle)
	var childHandle windows.Handle
	childPID := 0
	defer func() {
		// Only these fixture PIDs belong to this test.
		var code uint32
		if windows.GetExitCodeProcess(rootHandle, &code) == nil && code == 259 {
			exec.Command("taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run()
		}
		if childHandle != 0 && windows.GetExitCodeProcess(childHandle, &code) == nil && code == 259 {
			exec.Command("taskkill", "/PID", strconv.Itoa(childPID), "/T", "/F").Run()
		}
		if childHandle != 0 {
			windows.CloseHandle(childHandle)
		}
		terminal.close()
	}()
	go io.Copy(io.Discard, p)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(filepath.Join(dir, "watcher.pid"))
		childPID, _ = strconv.Atoi(strings.TrimSpace(string(data)))
		if childPID > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if childPID <= 0 {
		t.Fatal("fixture watcher did not start")
	}
	childHandle, err = windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(childPID))
	if err != nil {
		t.Fatal(err)
	}
	go func() { cmd.Process.Wait(); terminal.close() }()
	returned := make(chan struct{})
	go func() { sendSignal(terminal, false); close(returned) }()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("soft close blocked the helper command loop")
	}
	time.Sleep(500 * time.Millisecond)
	sendSignal(terminal, true)
	select {
	case <-terminal.done:
	case <-time.After(5 * time.Second):
		t.Fatal("console did not close after escalation")
	}
	var code uint32
	if windows.GetExitCodeProcess(childHandle, &code) == nil && code == 259 {
		t.Fatal("watcher child survived confirmed console close")
	}
}
