import { test, expect, describe } from "bun:test";

// Mirror the regexes from TerminalView.svelte so we can test them
const WIN_PROMPT_RE = /(?:^|\n)(?:.*\s)?(?:PS )?([A-Za-z]:\\[^\r\n>]*?)>\s*$/;
const UNIX_PROMPT_RE = /(?:^|\n)\S+?:([/~][^\r\n$#]*?)[#$%]\s*$/;

function extractCwd(output: string): string | null {
  const stripped = output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
  const winMatch = stripped.match(WIN_PROMPT_RE);
  const unixMatch = stripped.match(UNIX_PROMPT_RE);
  const raw = winMatch?.[1] ?? unixMatch?.[1];
  if (!raw) return null;
  return raw.replace(/\\/g, "/");
}

describe("SSH prompt CWD parser", () => {
  describe("Windows cmd.exe", () => {
    test("hostname + path prompt", () => {
      expect(extractCwd("needle@NEEDLE-NUC2-WIN C:\\Users\\needle>"))
        .toBe("C:/Users/needle");
    });

    test("bare drive:\\path prompt", () => {
      expect(extractCwd("C:\\Users\\needle\\Music>"))
        .toBe("C:/Users/needle/Music");
    });

    test("prompt after command output", () => {
      expect(extractCwd("some file listing\nneedle@HOST C:\\Users\\test>"))
        .toBe("C:/Users/test");
    });

    test("root of drive", () => {
      expect(extractCwd("C:\\>")).toBe("C:/");
    });

    test("path with spaces", () => {
      expect(extractCwd("needle@HOST C:\\Program Files\\Unity>"))
        .toBe("C:/Program Files/Unity");
    });
  });

  describe("PowerShell", () => {
    test("PS prompt", () => {
      expect(extractCwd("PS C:\\Users\\needle>"))
        .toBe("C:/Users/needle");
    });

    test("PS prompt after output", () => {
      expect(extractCwd("output line\nPS C:\\Windows\\System32>"))
        .toBe("C:/Windows/System32");
    });
  });

  describe("Unix bash/zsh", () => {
    test("user@host:/path$", () => {
      expect(extractCwd("user@server:/home/user$"))
        .toBe("/home/user");
    });

    test("user@host:~$", () => {
      expect(extractCwd("user@server:~$"))
        .toBe("~");
    });

    test("user@host:~/projects$", () => {
      expect(extractCwd("user@server:~/projects$"))
        .toBe("~/projects");
    });

    test("root prompt with #", () => {
      expect(extractCwd("root@server:/etc#"))
        .toBe("/etc");
    });
  });

  describe("ANSI escape stripping", () => {
    test("strips CSI sequences before matching", () => {
      expect(extractCwd("\x1b[32mneedle@HOST\x1b[0m C:\\Users\\needle>"))
        .toBe("C:/Users/needle");
    });

    test("strips OSC sequences", () => {
      expect(extractCwd("\x1b]0;title\x07C:\\Users\\needle>"))
        .toBe("C:/Users/needle");
    });
  });

  describe("no match", () => {
    test("plain text returns null", () => {
      expect(extractCwd("just some output text")).toBeNull();
    });

    test("empty string returns null", () => {
      expect(extractCwd("")).toBeNull();
    });

    test("command output without prompt returns null", () => {
      expect(extractCwd("total 42\ndrwxr-xr-x 5 user user 4096")).toBeNull();
    });
  });
});
