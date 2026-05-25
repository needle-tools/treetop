//go:build windows

package main

import "os"

// Windows has no SIGTERM/SIGKILL distinction at the process API level —
// both map to terminating the process. We always use Process.Kill().
func sendSignal(t *term, _ bool) {
	_ = t.cmd.Process.Kill()
}

// exitSignal returns "" on Windows — there's no signal concept; an
// abnormal exit is just a non-zero ExitCode.
func exitSignal(_ *os.ProcessState) string {
	return ""
}
