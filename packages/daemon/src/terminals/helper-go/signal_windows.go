//go:build windows

package main

import "os"

// Windows has no SIGTERM, so "soft" can't mean "send a polite signal."
// Instead we close the pseudoconsole: ClosePseudoConsole delivers a
// CTRL_CLOSE_EVENT to the attached client, which gives it a window to run
// its shutdown handler and flush state (e.g. Claude writing .claude.json)
// before Windows force-terminates it. The daemon waits out the grace
// period, then escalates to a hard kill for any straggler — which on
// Windows is the only true terminate, Process.Kill() (TerminateProcess).
func sendSignal(t *term, hard bool) {
	if hard {
		_ = t.cmd.Process.Kill()
		return
	}
	t.close()
}

// exitSignal returns "" on Windows — there's no signal concept; an
// abnormal exit is just a non-zero ExitCode.
func exitSignal(_ *os.ProcessState) string {
	return ""
}
