/**
 * Characterization tests for the display-helpers functions that were
 * duplicated inside OpenInActions.svelte.  These pin the REAL behavior
 * of the shared module so that the dedup is safe to verify.
 *
 * All tests are domless (no browser, no Svelte runtime) — they run
 * straight in bun:test.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  fileManagerLabel,
  fileManagerIcon,
  remoteButtonLabel,
  pushCount,
  pushBadgeDanger,
} from "../src/display-helpers";
import type { RemoteRef } from "../src/display-helpers";

// ---------------------------------------------------------------------------
// Helpers for UA stubbing.
// We patch globalThis.navigator before each case and restore it after.
// try/finally in each test guarantees restoration even on assertion failure.
// ---------------------------------------------------------------------------

function withNavigator<T>(ua: string | undefined, fn: () => T): T {
  const original = globalThis.navigator;
  try {
    if (ua === undefined) {
      // Simulate SSR / node environment where navigator is not defined.
      // @ts-expect-error intentionally deleting navigator
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", {
        value: { userAgent: ua },
        configurable: true,
        writable: true,
      });
    }
    return fn();
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

// ---------------------------------------------------------------------------
// fileManagerLabel
// ---------------------------------------------------------------------------

describe("fileManagerLabel", () => {
  it('returns "Finder" on macOS (Mac in UA)', () => {
    const result = withNavigator(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      () => fileManagerLabel(),
    );
    expect(result).toBe("Finder");
  });

  it('returns "Finder" on iPhone (iPhone in UA)', () => {
    const result = withNavigator(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      () => fileManagerLabel(),
    );
    expect(result).toBe("Finder");
  });

  it('returns "Finder" on iPad (iPad in UA)', () => {
    const result = withNavigator(
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)",
      () => fileManagerLabel(),
    );
    expect(result).toBe("Finder");
  });

  it('returns "Explorer" on Windows (Win in UA)', () => {
    const result = withNavigator(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      () => fileManagerLabel(),
    );
    expect(result).toBe("Explorer");
  });

  it('returns "Files" on Linux', () => {
    const result = withNavigator(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      () => fileManagerLabel(),
    );
    expect(result).toBe("Files");
  });

  it('returns "Files" on Android', () => {
    const result = withNavigator(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
      () => fileManagerLabel(),
    );
    expect(result).toBe("Files");
  });

  it('returns "Files" when navigator is undefined (SSR/node)', () => {
    const result = withNavigator(undefined, () => fileManagerLabel());
    expect(result).toBe("Files");
  });
});

// ---------------------------------------------------------------------------
// fileManagerIcon
// ---------------------------------------------------------------------------

describe("fileManagerIcon", () => {
  it('returns "finder" on macOS (Mac in UA)', () => {
    const result = withNavigator(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      () => fileManagerIcon(),
    );
    expect(result).toBe("finder");
  });

  it('returns "finder" on iPhone', () => {
    const result = withNavigator(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      () => fileManagerIcon(),
    );
    expect(result).toBe("finder");
  });

  it('returns "finder" on iPad', () => {
    const result = withNavigator(
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)",
      () => fileManagerIcon(),
    );
    expect(result).toBe("finder");
  });

  it('returns "explorer" on Windows', () => {
    const result = withNavigator(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      () => fileManagerIcon(),
    );
    expect(result).toBe("explorer");
  });

  it('returns "files" on Linux', () => {
    const result = withNavigator(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      () => fileManagerIcon(),
    );
    expect(result).toBe("files");
  });

  it('returns "files" when navigator is undefined (SSR/node)', () => {
    const result = withNavigator(undefined, () => fileManagerIcon());
    expect(result).toBe("files");
  });
});

// ---------------------------------------------------------------------------
// remoteButtonLabel
// ---------------------------------------------------------------------------

describe("remoteButtonLabel", () => {
  // Known providers → pretty label.
  const knownProviders: Array<[string, string]> = [
    ["github", "GitHub"],
    ["gitlab", "GitLab"],
    ["bitbucket", "Bitbucket"],
    ["azure", "Azure"],
    ["codeberg", "Codeberg"],
    ["sourcehut", "sourcehut"],
    ["gitea", "Gitea"],
  ];

  for (const [provider, label] of knownProviders) {
    it(`returns "${label}" for provider="${provider}" with name="origin"`, () => {
      const remote: RemoteRef = {
        name: "origin",
        url: `https://${provider}.com/user/repo`,
        webUrl: `https://${provider}.com/user/repo`,
        provider,
        host: `${provider}.com`,
      };
      expect(remoteButtonLabel(remote)).toBe(label);
    });

    it(`returns "${label} (upstream)" for provider="${provider}" with name="upstream"`, () => {
      const remote: RemoteRef = {
        name: "upstream",
        url: `https://${provider}.com/user/repo`,
        webUrl: `https://${provider}.com/user/repo`,
        provider,
        host: `${provider}.com`,
      };
      expect(remoteButtonLabel(remote)).toBe(`${label} (upstream)`);
    });
  }

  it("falls back to host when provider is null, name=origin", () => {
    const remote: RemoteRef = {
      name: "origin",
      url: "https://custom.example.com/repo",
      webUrl: "https://custom.example.com/repo",
      provider: null,
      host: "custom.example.com",
    };
    expect(remoteButtonLabel(remote)).toBe("custom.example.com");
  });

  it("falls back to host when provider is unknown, name=origin", () => {
    // Unknown provider key → PROVIDER_LABELS lookup returns undefined → falls back to host.
    const remote: RemoteRef = {
      name: "origin",
      url: "https://selfhosted.example.com/repo",
      webUrl: "https://selfhosted.example.com/repo",
      provider: "unknown-forge",
      host: "selfhosted.example.com",
    };
    expect(remoteButtonLabel(remote)).toBe("selfhosted.example.com");
  });

  it("falls back to name when both provider and host are null, name=origin", () => {
    const remote: RemoteRef = {
      name: "origin",
      url: "git@example.com:user/repo.git",
      webUrl: null,
      provider: null,
      host: null,
    };
    expect(remoteButtonLabel(remote)).toBe("origin");
  });

  it("falls back to name when both provider and host are null, non-origin name", () => {
    const remote: RemoteRef = {
      name: "fork",
      url: "git@example.com:user/fork.git",
      webUrl: null,
      provider: null,
      host: null,
    };
    expect(remoteButtonLabel(remote)).toBe("fork (fork)");
  });

  it("appends remote name in parens for non-origin remotes with host fallback", () => {
    const remote: RemoteRef = {
      name: "upstream",
      url: "https://custom.example.com/repo",
      webUrl: "https://custom.example.com/repo",
      provider: null,
      host: "custom.example.com",
    };
    expect(remoteButtonLabel(remote)).toBe("custom.example.com (upstream)");
  });
});

describe("pushCount", () => {
  it("returns 0 for null/undefined branch status", () => {
    expect(pushCount(null)).toBe(0);
    expect(pushCount(undefined)).toBe(0);
  });

  it("uses ahead when the branch tracks an upstream", () => {
    expect(pushCount({ ahead: 3, unpushed: null })).toBe(3);
  });

  it("falls back to unpushed when there's no upstream (ahead is 0)", () => {
    // Daemon fills `unpushed` only when upstream is null, in which case
    // git reports ahead as 0 — so the fallback picks up the real count.
    expect(pushCount({ ahead: 0, unpushed: 5 })).toBe(5);
  });

  it("is 0 when both are 0 / null", () => {
    expect(pushCount({ ahead: 0, unpushed: null })).toBe(0);
    expect(pushCount({ ahead: 0, unpushed: 0 })).toBe(0);
    expect(pushCount({ ahead: 0 })).toBe(0);
  });
});

describe("pushBadgeDanger", () => {
  it("marks unpushed commits with no remote target as danger", () => {
    expect(pushBadgeDanger({ upstream: null, ahead: 0, unpushed: 2 })).toBe(
      true,
    );
  });

  it("keeps normal ahead commits green when a remote target exists", () => {
    expect(
      pushBadgeDanger({ upstream: "origin/main", ahead: 2, unpushed: null }),
    ).toBe(false);
  });

  it("does not mark zero-count no-remote branches as danger", () => {
    expect(pushBadgeDanger({ upstream: null, ahead: 0, unpushed: 0 })).toBe(
      false,
    );
  });
});
