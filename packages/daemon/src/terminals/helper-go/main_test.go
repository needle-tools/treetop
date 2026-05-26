package main

import (
	"strings"
	"testing"
)

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
