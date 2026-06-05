import { describe, it, expect } from "bun:test";
import {
  emptyDaemonForm,
  normalizeDaemonForm,
  emptyProvisionForm,
  normalizeProvisionForm,
  stripHostPort,
  DEFAULT_REMOTE_DAEMON_PORT,
  type DaemonFormFields,
  type ProvisionFormFields,
} from "../src/remote-daemon-form";

describe("stripHostPort", () => {
  it("strips a trailing :port from an IPv4 / hostname", () => {
    expect(stripHostPort("1.2.3.4:7777")).toBe("1.2.3.4");
    expect(stripHostPort("host.example:22")).toBe("host.example");
    expect(stripHostPort("  box:80  ")).toBe("box");
  });
  it("leaves a bare host untouched", () => {
    expect(stripHostPort("1.2.3.4")).toBe("1.2.3.4");
    expect(stripHostPort("host.example")).toBe("host.example");
  });
  it("leaves IPv6 (multiple colons) untouched", () => {
    expect(stripHostPort("::1")).toBe("::1");
    expect(stripHostPort("fe80::1")).toBe("fe80::1");
  });
});

/**
 * The "Add remote daemon" form normalizer mirrors the daemon-side
 * addRemoteDaemon() contract (workspace.ts): host required, label←host,
 * port←7777, blank optionals omitted. These pin that contract so the
 * client can't drift from the server (which re-validates).
 */

function form(over: Partial<DaemonFormFields> = {}): DaemonFormFields {
  return { ...emptyDaemonForm(), ...over };
}

describe("normalizeDaemonForm — required host", () => {
  it("rejects a blank host", () => {
    const r = normalizeDaemonForm(form({ host: "  " }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.host).toMatch(/required/);
  });

  it("accepts a host alone (everything else defaulted/omitted)", () => {
    const r = normalizeDaemonForm(form({ host: "1.2.3.4" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ label: "1.2.3.4", host: "1.2.3.4" });
  });

  it("trims the host", () => {
    const r = normalizeDaemonForm(form({ host: "  box.example  " }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.host).toBe("box.example");
  });
});

describe("normalizeDaemonForm — label default", () => {
  it("defaults a blank label to the host", () => {
    const r = normalizeDaemonForm(form({ host: "h", label: "  " }));
    if (r.ok) expect(r.payload.label).toBe("h");
  });

  it("keeps a provided label (trimmed)", () => {
    const r = normalizeDaemonForm(form({ host: "h", label: "  Hetzner  " }));
    if (r.ok) expect(r.payload.label).toBe("Hetzner");
  });
});

describe("normalizeDaemonForm — port", () => {
  it("omits port when blank (server applies 7777)", () => {
    const r = normalizeDaemonForm(form({ host: "h" }));
    if (r.ok) expect("port" in r.payload).toBe(false);
  });

  it("passes a valid port through", () => {
    const r = normalizeDaemonForm(form({ host: "h", port: "9000" }));
    if (r.ok) expect(r.payload.port).toBe(9000);
  });

  it("rejects a non-numeric port", () => {
    const r = normalizeDaemonForm(form({ host: "h", port: "abc" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.port).toMatch(/number/);
  });

  it("rejects an out-of-range port", () => {
    const r = normalizeDaemonForm(form({ host: "h", port: "70000" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.port).toMatch(/1.*65535/);
  });

  it("DEFAULT_REMOTE_DAEMON_PORT matches the daemon default", () => {
    expect(DEFAULT_REMOTE_DAEMON_PORT).toBe(7777);
  });
});

describe("normalizeDaemonForm — sshPort", () => {
  it("omits sshPort when blank (ssh uses 22)", () => {
    const r = normalizeDaemonForm(form({ host: "h" }));
    if (r.ok) expect("sshPort" in r.payload).toBe(false);
  });

  it("passes a valid sshPort through", () => {
    const r = normalizeDaemonForm(form({ host: "h", sshPort: "2222" }));
    if (r.ok) expect(r.payload.sshPort).toBe(2222);
  });

  it("rejects an invalid sshPort", () => {
    const r = normalizeDaemonForm(form({ host: "h", sshPort: "-1" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.sshPort).toBeDefined();
  });
});

describe("normalizeDaemonForm — optionals", () => {
  it("omits user / identityPath / color when blank", () => {
    const r = normalizeDaemonForm(form({ host: "h" }));
    if (r.ok) {
      expect("user" in r.payload).toBe(false);
      expect("identityPath" in r.payload).toBe(false);
      expect("color" in r.payload).toBe(false);
    }
  });

  it("includes trimmed user / identityPath", () => {
    const r = normalizeDaemonForm(
      form({ host: "h", user: " supergit ", identityPath: " /keys/id " }),
    );
    if (r.ok) {
      expect(r.payload.user).toBe("supergit");
      expect(r.payload.identityPath).toBe("/keys/id");
    }
  });

  it("accepts a #rrggbb color", () => {
    const r = normalizeDaemonForm(form({ host: "h", color: "#ff8800" }));
    if (r.ok) expect(r.payload.color).toBe("#ff8800");
  });

  it("accepts a #rgb shorthand color", () => {
    const r = normalizeDaemonForm(form({ host: "h", color: "#f80" }));
    if (r.ok) expect(r.payload.color).toBe("#f80");
  });

  it("rejects a non-hex color", () => {
    const r = normalizeDaemonForm(form({ host: "h", color: "orange" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.color).toMatch(/#rgb|rrggbb/);
  });
});

describe("normalizeDaemonForm — multiple errors", () => {
  it("reports every invalid field at once", () => {
    const r = normalizeDaemonForm(
      form({ host: "", port: "x", sshPort: "0", color: "nope" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.host).toBeDefined();
      expect(r.errors.port).toBeDefined();
      expect(r.errors.sshPort).toBeDefined();
      expect(r.errors.color).toBeDefined();
    }
  });
});

describe("emptyDaemonForm", () => {
  it("is all empty strings", () => {
    expect(emptyDaemonForm()).toEqual({
      label: "",
      host: "",
      user: "",
      port: "",
      sshPort: "",
      identityPath: "",
      color: "",
    });
  });
});

/**
 * The provision form is a subset (host/user/sshPort/label) feeding
 * POST /api/daemons/provision. host required; blank optionals omitted so the
 * installer/ssh fall back to their own defaults (root user, port 22).
 */
function pform(over: Partial<ProvisionFormFields> = {}): ProvisionFormFields {
  return { ...emptyProvisionForm(), ...over };
}

describe("normalizeProvisionForm", () => {
  it("rejects a blank host", () => {
    const r = normalizeProvisionForm(pform({ host: "   " }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.host).toMatch(/required/);
  });

  it("requires only the host — bare host defaults the user to root", () => {
    // install.sh needs root; a blank user otherwise falls back to ssh's LOCAL
    // username, which a fresh box rejects.
    const r = normalizeProvisionForm(pform({ host: "1.2.3.4" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ host: "1.2.3.4", user: "root" });
  });

  it("omits blank optionals but still defaults the POSIX user to root", () => {
    const r = normalizeProvisionForm(
      pform({ host: "h", user: "  ", sshPort: "", label: "  " }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ host: "h", user: "root" });
  });

  it("does NOT default to root for a Windows target (no universal admin name)", () => {
    const r = normalizeProvisionForm(pform({ host: "nuc", os: "windows" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.user).toBeUndefined();
  });

  it("strips a :port the user pasted onto the host", () => {
    const r = normalizeProvisionForm(pform({ host: "49.12.219.153:7777" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.host).toBe("49.12.219.153");
  });

  it("carries root:true when runAsRoot is set (POSIX)", () => {
    const r = normalizeProvisionForm(pform({ host: "h", runAsRoot: true }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.root).toBe(true);
  });

  it("omits root when not set", () => {
    const r = normalizeProvisionForm(pform({ host: "h" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.root).toBeUndefined();
  });

  it("ignores runAsRoot for Windows (SUPERGIT_USER is POSIX-only)", () => {
    const r = normalizeProvisionForm(
      pform({ host: "nuc", os: "windows", runAsRoot: true }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.root).toBeUndefined();
  });

  it("carries user / sshPort / label when provided", () => {
    const r = normalizeProvisionForm(
      pform({ host: "h", user: "root", sshPort: "2222", label: "hetzner" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({
        host: "h",
        user: "root",
        sshPort: 2222,
        label: "hetzner",
      });
    }
  });

  it("rejects a non-numeric ssh port", () => {
    const r = normalizeProvisionForm(pform({ host: "h", sshPort: "abc" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.sshPort).toMatch(/number/);
  });

  it("defaults to posix — os is omitted from the payload", () => {
    // posix is the implicit default; the daemon already treats a missing
    // os as posix, so we keep the payload clean (no redundant field).
    const r = normalizeProvisionForm(pform({ host: "h", os: "posix" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ host: "h", user: "root" });
  });

  it("carries os when the target is Windows", () => {
    const r = normalizeProvisionForm(pform({ host: "nuc", os: "windows" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ host: "nuc", os: "windows" });
  });

  it("empty os string is treated as posix (omitted, user defaults to root)", () => {
    const r = normalizeProvisionForm(pform({ host: "h", os: "" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ host: "h", user: "root" });
  });
});
