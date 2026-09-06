export interface VisualToolEnvAssignment {
  name: string;
  value: string;
}

export type VisualCommandSummary =
  | { kind: "read"; targets: string[] }
  | { kind: "directory"; targets: string[] }
  | { kind: "logs"; targets: string[]; tailLines?: number }
  | { kind: "search"; pattern: string; paths: string[]; source?: string }
  | { kind: "find"; root: string; patterns: string[] }
  | { kind: "batch-files"; tool: string; targets: string[] }
  | {
      kind: "count";
      metric: "lines" | "bytes" | "words" | "chars" | "items";
      targets: string[];
    }
  | { kind: "size"; targets: string[] }
  | { kind: "json-query"; filter: string; targets: string[]; source?: string }
  | {
      kind: "text-process";
      tool: "awk";
      expression: string;
      targets: string[];
      source?: string;
    }
  | { kind: "script-file"; language: string; script: string; args: string[] }
  | { kind: "process-check"; pattern?: string; pids?: string[] }
  | { kind: "container-check"; pattern?: string }
  | {
      kind: "git";
      action:
        | "status"
        | "remote"
        | "diff"
        | "diff-stat"
        | "diff-check"
        | "show"
        | "show-file"
        | "show-file-search"
        | "ls-files"
        | "log"
        | "branch"
        | "rev-parse"
        | "rev-list-count"
        | "check-ignore"
        | "add"
        | "commit";
      targets: string[];
      rev?: string;
      pattern?: string;
      staged?: boolean;
    }
  | {
      kind: "test";
      runner:
        | "Bun"
        | "Vitest"
        | "npm"
        | "Pytest"
        | "Playwright"
        | "Shell"
        | "TypeScript"
        | "Svelte";
      targets: string[];
      check?: boolean;
    }
  | { kind: "process-end"; pids: string[] }
  | { kind: "system-info"; action: "host" | "kernel" | "gpu" }
  | {
      kind: "system-probe";
      action:
        | "disk-space"
        | "file-metadata"
        | "file-type"
        | "resolve-link"
        | "find-command"
        | "checksum";
      targets: string[];
    }
  | { kind: "drive-check" }
  | { kind: "port-check"; ports: string[] }
  | { kind: "ssh-tunnel"; local: string; remote: string }
  | {
      kind: "remote-transfer";
      action: "upload" | "download";
      host: string;
      local: string;
      remotePath: string;
    }
  | { kind: "screen-sessions" }
  | { kind: "session-manager"; tool: "tmux"; action: "list" }
  | { kind: "listener-check"; terms: string[] }
  | { kind: "wait"; seconds: string }
  | {
      kind: "wait-url";
      url: string;
      attempts?: number;
      intervalSeconds?: number;
    }
  | {
      kind: "database";
      engine: "PostgreSQL" | "MySQL" | "MariaDB" | "SQLite";
      database?: string;
      query?: string;
    }
  | {
      kind: "browser";
      action:
        | "open"
        | "close"
        | "snapshot"
        | "screenshot"
        | "click"
        | "upload"
        | "download"
        | "fill"
        | "press"
        | "wait"
        | "get"
        | "scroll"
        | "console"
        | "network"
        | "pages"
        | "reload"
        | "emulate"
        | "mouse"
        | "script";
      target?: string;
      targetLabel?: string;
      detail?: string;
    }
  | { kind: "fetch"; url: string; output?: string }
  | { kind: "image-transform"; input: string; output: string }
  | {
      kind: "cmake";
      action: "configure" | "build";
      source?: string;
      build?: string;
      generator?: string;
    }
  | {
      kind: "filesystem";
      action: "create" | "delete" | "copy" | "move";
      targetKind: "file" | "folder" | "path";
      targets: string[];
    }
  | {
      kind: "workflow";
      tool: "GitHub" | "Google Cloud" | "Tailscale";
      action: string;
      targets: string[];
    };
