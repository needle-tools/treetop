package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveCwdFallsBackWhenMissing(t *testing.T) {
	tmp := t.TempDir()

	// An existing directory is used verbatim, no warning.
	if dir, warn := resolveCwd(tmp); dir != tmp || warn != "" {
		t.Fatalf("existing dir: got (%q, %q), want (%q, \"\")", dir, warn, tmp)
	}

	// Empty cwd → inherit helper cwd silently.
	if dir, warn := resolveCwd(""); dir != "" || warn != "" {
		t.Fatalf("empty cwd: got (%q, %q), want (\"\", \"\")", dir, warn)
	}

	// A missing directory (the stale-foreign-cwd / session-share case) must
	// not become cmd.Dir, and must warn naming the offending path.
	missing := filepath.Join(tmp, "does-not-exist")
	dir, warn := resolveCwd(missing)
	if dir != "" {
		t.Fatalf("missing cwd should not be used as Dir, got %q", dir)
	}
	if warn == "" || !strings.Contains(warn, missing) {
		t.Fatalf("missing cwd should warn naming %q, got %q", missing, warn)
	}

	// A path that exists but is a file, not a directory, is rejected too.
	f := filepath.Join(tmp, "afile")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if dir, warn := resolveCwd(f); dir != "" || warn == "" {
		t.Fatalf("file path: got (%q, %q), want (\"\", <warning>)", dir, warn)
	}
}

func TestWantHardKill(t *testing.T) {
	// Only the literal "SIGKILL" means "force-terminate"; everything else
	// (the default "SIGTERM", a missing field, garbage) is a soft kill so
	// the child gets a chance to flush before we escalate.
	cases := []struct {
		arg  any
		want bool
	}{
		{"SIGKILL", true},
		{"SIGTERM", false},
		{"", false},
		{nil, false},
		{"sigkill", false}, // case-sensitive on purpose
		{9, false},         // wrong type
	}
	for _, c := range cases {
		if got := wantHardKill(c.arg); got != c.want {
			t.Fatalf("wantHardKill(%#v) = %v, want %v", c.arg, got, c.want)
		}
	}
}

func TestScrubEnvForcesSingleColorCapableTerm(t *testing.T) {
	t.Setenv("TERM", "dumb")

	env := scrubEnv()
	terms := []string{}
	for _, kv := range env {
		if strings.HasPrefix(kv, "TERM=") {
			terms = append(terms, kv)
		}
	}

	if len(terms) != 1 {
		t.Fatalf("expected exactly one TERM entry, got %v from env %v", terms, env)
	}
	if terms[0] != "TERM=xterm-256color" {
		t.Fatalf("expected TERM=xterm-256color, got %q", terms[0])
	}
}

func TestScrubEnvRemovesPortlessAndTerminalIdentity(t *testing.T) {
	for key, value := range map[string]string{
		"PORT":                 "27787",
		"PORTLESS_URL":         "https://example.test",
		"NODE_EXTRA_CA_CERTS":  "/tmp/cert.pem",
		"TERM_PROGRAM":         "Apple_Terminal",
		"TERM_PROGRAM_VERSION": "455",
		"TERM_SESSION_ID":      "w0t0p0",
		"NO_COLOR":             "1",
		"COLOR":                "0",
	} {
		t.Setenv(key, value)
	}

	env := scrubEnv()
	for _, kv := range env {
		key := strings.SplitN(kv, "=", 2)[0]
		switch key {
		case "PORT", "PORTLESS_URL", "NODE_EXTRA_CA_CERTS", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "NO_COLOR", "COLOR":
			t.Fatalf("expected %s to be scrubbed from %v", key, env)
		}
	}
}
