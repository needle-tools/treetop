//go:build !windows

package main

import (
	"os"
	"syscall"
)

func sendSignal(t *term, hard bool) {
	sig := syscall.SIGTERM
	if hard {
		sig = syscall.SIGKILL
	}
	_ = t.cmd.Process.Signal(sig)
}

// exitSignal returns the signal name if the process was killed by one,
// or "" if it exited normally. Unix-only: relies on WaitStatus.Signaled().
func exitSignal(state *os.ProcessState) string {
	if state == nil {
		return ""
	}
	if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return ws.Signal().String()
	}
	return ""
}
