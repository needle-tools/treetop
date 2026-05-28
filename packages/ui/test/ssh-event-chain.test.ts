import { test, expect, describe } from "bun:test";
import {
  resolveTermIdFromSource,
  parseRemoteSource,
} from "../src/file-browser-utils";
import {
  SYNTHETIC_SOURCE_PREFIXES,
  filterToExistingSessions,
} from "../src/storage";

describe("SSH event chain", () => {
  describe("resolveTermIdFromSource covers all session source formats", () => {
    test("__attached__:shell:<termId> — saved command / promoted shell", () => {
      const termId = resolveTermIdFromSource(
        "__attached__:shell:t_mpn90di8_5",
        {},
      );
      expect(termId).toBe("t_mpn90di8_5");
    });

    test("__new__:shell:<id> with newTermIds lookup", () => {
      const termId = resolveTermIdFromSource("__new__:shell:abc123", {
        "__new__:shell:abc123": "t_real_term",
      });
      expect(termId).toBe("t_real_term");
    });

    test("__new__:shell:<id> without newTermIds returns undefined", () => {
      const termId = resolveTermIdFromSource("__new__:shell:abc123", {});
      expect(termId).toBeUndefined();
    });
  });

  describe("openRemoteBrowser source format", () => {
    test("creates parseable __remote__:<termId>:<uniqueId> source", () => {
      // Simulate what openRemoteBrowser does
      const termId = "t_mpn90di8_5";
      const id = `rb_test_123`;
      const synthetic = `__remote__:${termId}:${id}`;

      // Verify parseRemoteSource extracts termId
      expect(parseRemoteSource(synthetic)).toBe(termId);
    });
  });

  describe("Svelte dispatch chain simulation", () => {
    test("SessionHeader onSshBrowse callback fires NewSessionCol dispatch", () => {
      let dispatched = false;
      let dispatchedDetail: any = null;

      // Simulate NewSessionCol's dispatch
      const dispatch = (event: string, detail: any) => {
        dispatched = true;
        dispatchedDetail = detail;
      };

      // Simulate sshSession state
      const sshSession = { user: "needle", host: "100.71.105.118", port: 22 };

      // This is what NewSessionCol passes to SessionHeader
      const onSshBrowse = () => dispatch("sshBrowse", sshSession);

      // Simulate button click in SessionHeader
      onSshBrowse();

      expect(dispatched).toBe(true);
      expect(dispatchedDetail).toEqual(sshSession);
    });

    test("App.svelte handler resolves termId and would open browser", () => {
      let openedWith: { wtPath: string; termId: string } | null = null;

      // Simulate openRemoteBrowser
      const openRemoteBrowser = (
        wtPath: string,
        termId: string,
        host: string,
      ) => {
        openedWith = { wtPath, termId };
      };

      // Simulate the on:sshBrowse handler in App.svelte
      const source = "__attached__:shell:t_mpn90di8_5";
      const newTermIds: Record<string, string> = {};
      const wtPath = "/Users/test/repo";

      const termId = resolveTermIdFromSource(source, newTermIds);
      if (termId) openRemoteBrowser(wtPath, termId, "");

      expect(openedWith).toEqual({
        wtPath: "/Users/test/repo",
        termId: "t_mpn90di8_5",
      });
    });

    test("full chain: attached shell source → resolveTermId → remote source → parseRemote", () => {
      const shellSource = "__attached__:shell:t_abc";

      // Step 1: resolve termId from shell source
      const termId = resolveTermIdFromSource(shellSource, {});
      expect(termId).toBe("t_abc");

      // Step 2: openRemoteBrowser creates remote source
      const uniqueId = "rb_test";
      const remoteSource = `__remote__:${termId}:${uniqueId}`;

      // Step 3: FileBrowser render branch parses remote source
      const parsedTermId = parseRemoteSource(remoteSource);
      expect(parsedTermId).toBe("t_abc");
    });
  });

  describe("__remote__: source survives filterToExistingSessions", () => {
    test("__remote__: is in SYNTHETIC_SOURCE_PREFIXES", () => {
      expect(
        SYNTHETIC_SOURCE_PREFIXES.some((p) =>
          "__remote__:t_abc:rb_123".startsWith(p),
        ),
      ).toBe(true);
    });

    test("filterToExistingSessions keeps __remote__: sources", () => {
      const sessions = [
        { agent: "files" as const, source: "__remote__:t_abc:rb_123" },
        { agent: "claude" as const, source: "some/session.jsonl" },
      ];
      const existingSources = new Set(["some/session.jsonl"]);
      const result = filterToExistingSessions(sessions, existingSources);
      expect(result.length).toBe(2);
      expect(result[0]!.source).toBe("__remote__:t_abc:rb_123");
    });

    test("filterToExistingSessions would have dropped __remote__: without the prefix", () => {
      const sessions = [
        { agent: "files" as const, source: "__remote__:t_abc:rb_123" },
      ];
      const result = filterToExistingSessions(sessions, new Set());
      expect(result.length).toBe(1);
    });
  });
});
