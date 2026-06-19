<script lang="ts">
  import {
    WorkspacePreview,
    hydrateWorkspacePreviewSession,
    parseWorkspacePreviewJsonl,
    type BranchStatus,
    type FileStatus,
    type NoteShape,
    type WorkspacePreviewRow,
    type WtSummary,
  } from "@supergit/ui/components";
  import arduinoJsonl from "../fixtures/sessions/arduino-lab.claude.jsonl?raw";
  import pcbJsonl from "../fixtures/sessions/pcb-design.codex.jsonl?raw";
  import spritesheetJsonl from "../fixtures/sessions/spritesheet-assets.claude.jsonl?raw";
  import warpJsonl from "../fixtures/sessions/warp-drive.codex.jsonl?raw";
  import websiteJsonl from "../fixtures/sessions/website-launch.claude.jsonl?raw";

  const MEMORY_KEY = "site-preview-v4";

  function ago(minutes: number): string {
    return new Date(Date.now() - minutes * 60_000).toISOString();
  }

  const websitePath = "~/wt/supergit/website";
  const hardwarePath = "~/wt/supergit/hardware-lab";
  const experimentsPath = "~/wt/supergit/experiments";
  const websiteAuthPath = "~/wt/supergit/auth";
  const hardwareFirmwarePath = "~/wt/supergit/firmware";
  const experimentsSpritesPath = "~/wt/supergit/sprites";
  const websiteAnchor = `worktree:${websitePath}`;
  const hardwareAnchor = `worktree:${hardwarePath}`;
  const experimentsAnchor = `worktree:${experimentsPath}`;

  const websiteTranscript = parseWorkspacePreviewJsonl(websiteJsonl);
  const spritesheetTranscript = parseWorkspacePreviewJsonl(spritesheetJsonl);
  const arduinoTranscript = parseWorkspacePreviewJsonl(arduinoJsonl);
  const pcbTranscript = parseWorkspacePreviewJsonl(pcbJsonl);
  const warpTranscript = parseWorkspacePreviewJsonl(warpJsonl);

  const websiteBranchStatus: BranchStatus = {
    branch: "feat/reuse-ui",
    upstream: "origin/feat/reuse-ui",
    ahead: 2,
    behind: 0,
    aheadOldestTime: null,
    unpushed: null,
  };
  const websiteFileStatus: FileStatus = {
    staged: 1,
    unstaged: 2,
    untracked: 1,
    dirtyLines: 84,
  };
  const websiteSummary: WtSummary = {
    staged: ["packages/ui/src/WorkspacePreview.svelte"],
    unstaged: [
      "packages/ui/src/App.svelte",
      "packages/site/src/lib/DashboardPreview.svelte",
    ],
    untracked: ["packages/ui/src/WorktreePreviewRow.svelte"],
    unpushedCommits: [
      {
        sha: "8f3a1d9c4b7e",
        author: "Treetop",
        date: ago(18),
        subject: "Extract reusable worktree row controls",
      },
      {
        sha: "41ce8822a901",
        author: "Treetop",
        date: ago(44),
        subject: "Make site preview consume production UI components",
      },
    ],
    unfetchedCommits: [],
  };

  const hardwareBranchStatus: BranchStatus = {
    branch: "lab/arduino-pcb",
    upstream: "origin/lab/arduino-pcb",
    ahead: 0,
    behind: 1,
    aheadOldestTime: null,
    unpushed: null,
  };
  const hardwareFileStatus: FileStatus = {
    staged: 0,
    unstaged: 3,
    untracked: 0,
    dirtyLines: 126,
  };
  const hardwareSummary: WtSummary = {
    staged: [],
    unstaged: [
      "workshop/night_garden.ino",
      "hardware/bringup-checklist.md",
      "scripts/bringup.sh",
    ],
    untracked: [],
    unpushedCommits: [],
    unfetchedCommits: [
      {
        sha: "1bd77f0cc2aa",
        author: "Treetop",
        date: ago(52),
        subject: "Add sensor board bring-up checklist",
      },
    ],
  };

  const experimentsBranchStatus: BranchStatus = {
    branch: "toy/warp-and-sprites",
    upstream: "origin/toy/warp-and-sprites",
    ahead: 3,
    behind: 0,
    aheadOldestTime: ago(180),
    unpushed: null,
  };
  const experimentsFileStatus: FileStatus = {
    staged: 2,
    unstaged: 1,
    untracked: 2,
    dirtyLines: 240,
  };
  const experimentsSummary: WtSummary = {
    staged: ["src/sim/warp-field.ts", "art/spritesheet_spec.md"],
    unstaged: ["tools/check_spritesheet.ts"],
    untracked: ["art/forest_robot.png", "scripts/demo-booth.sh"],
    unpushedCommits: [
      {
        sha: "9ac8302e171d",
        author: "Treetop",
        date: ago(92),
        subject: "Prototype warp-field stability controls",
      },
      {
        sha: "5e86df9a4a0b",
        author: "Treetop",
        date: ago(141),
        subject: "Specify forest robot spritesheet pipeline",
      },
      {
        sha: "78c40f74ef10",
        author: "Treetop",
        date: ago(180),
        subject: "Add asset validation command",
      },
    ],
    unfetchedCommits: [],
  };

  const rows: WorkspacePreviewRow[] = [
    {
      key: "site-preview-website",
      repo: {
        id: "site-preview-repo",
        name: "website",
        path: "~/wt/supergit",
        color: "#60b74c",
      },
      worktree: {
        path: websitePath,
        branch: "feat/reuse-ui",
        branchStatus: websiteBranchStatus,
        fileStatus: websiteFileStatus,
        branchChoices: [
          "feat/reuse-ui",
          "main",
          "site/copy-polish",
          "origin/main",
        ],
      },
      repoWorktrees: [
        { path: websitePath, branch: "feat/reuse-ui" },
        { path: websiteAuthPath, branch: "feat/auth-flow" },
        { path: "~/wt/supergit/billing", branch: "feat/billing-copy" },
      ],
      summary: websiteSummary,
      sessions: [
        hydrateWorkspacePreviewSession(
          {
            agent: "claude",
            cwd: websitePath,
            source: "site-preview-session-website",
            sessionId: "mock-claude-site-launch",
            title: "Launch the Treetop website",
            state: "working",
            lastActive: ago(4),
            model: "claude-sonnet-4-5-20250929",
            claudeModel: "sonnet",
            claudeEffort: "high",
            contextTokens: 142_800,
            contextTokensExact: true,
            contextWindow: 200_000,
          },
          websiteTranscript,
        ),
      ],
    },
    {
      key: "site-preview-hardware",
      repo: {
        id: "site-preview-hardware-repo",
        name: "hardware lab",
        path: "~/wt/supergit",
        color: "#f0b84a",
      },
      worktree: {
        path: hardwarePath,
        branch: "lab/arduino-pcb",
        branchStatus: hardwareBranchStatus,
        fileStatus: hardwareFileStatus,
        branchChoices: [
          "lab/arduino-pcb",
          "main",
          "lab/night-garden",
          "origin/lab/boards",
        ],
      },
      repoWorktrees: [
        { path: hardwarePath, branch: "lab/arduino-pcb" },
        { path: hardwareFirmwarePath, branch: "lab/firmware-bringup" },
        { path: "~/wt/supergit/enclosure", branch: "lab/enclosure" },
      ],
      summary: hardwareSummary,
      sessions: [
        hydrateWorkspacePreviewSession(
          {
            agent: "claude",
            cwd: hardwarePath,
            source: "site-preview-session-arduino",
            sessionId: "mock-claude-arduino-lab",
            title: "Teach Arduino Night Garden",
            state: "idle",
            lastActive: ago(16),
            model: "claude-haiku-4-5-20251001",
            claudeModel: "haiku",
            claudeEffort: "medium",
            contextTokens: 52_400,
            contextTokensExact: true,
            contextWindow: 200_000,
          },
          arduinoTranscript,
        ),
        hydrateWorkspacePreviewSession(
          {
            agent: "codex",
            cwd: hardwarePath,
            source: "site-preview-session-pcb",
            sessionId: "mock-codex-pcb-design",
            title: "Design the sensor PCB",
            state: "awaiting",
            lastActive: ago(24),
            model: "gpt-5.2-codex",
            contextTokens: 118_000,
            contextTokensExact: false,
            contextWindow: 400_000,
          },
          pcbTranscript,
        ),
      ],
    },
    {
      key: "site-preview-experiments",
      repo: {
        id: "site-preview-experiments-repo",
        name: "experiments",
        path: "~/wt/supergit",
        color: "#a88cff",
      },
      worktree: {
        path: experimentsPath,
        branch: "toy/warp-and-sprites",
        branchStatus: experimentsBranchStatus,
        fileStatus: experimentsFileStatus,
        branchChoices: [
          "toy/warp-and-sprites",
          "main",
          "toy/warp-field",
          "art/spritesheet-pipeline",
        ],
      },
      repoWorktrees: [
        { path: experimentsPath, branch: "toy/warp-and-sprites" },
        { path: experimentsSpritesPath, branch: "art/spritesheet-pipeline" },
        { path: "~/wt/supergit/warp-sim", branch: "toy/warp-field" },
      ],
      summary: experimentsSummary,
      sessions: [
        hydrateWorkspacePreviewSession(
          {
            agent: "codex",
            cwd: experimentsPath,
            source: "site-preview-session-warp",
            sessionId: "mock-codex-warp-drive",
            title: "Prototype a warp-drive toy",
            state: "working",
            lastActive: ago(9),
            model: "gpt-5.2-codex",
            contextTokens: 236_500,
            contextTokensExact: false,
            contextWindow: 400_000,
          },
          warpTranscript,
        ),
        hydrateWorkspacePreviewSession(
          {
            agent: "claude",
            cwd: experimentsPath,
            source: "site-preview-session-sprites",
            sessionId: "mock-claude-spritesheet",
            title: "Plan forest robot spritesheets",
            state: "idle",
            lastActive: ago(31),
            model: "claude-sonnet-4-5-20250929",
            claudeModel: "sonnet",
            claudeEffort: "low",
            contextTokens: 83_200,
            contextTokensExact: true,
            contextWindow: 200_000,
          },
          spritesheetTranscript,
        ),
      ],
    },
  ];

  const initialNotes: NoteShape[] = [
    {
      id: "site-note-1",
      anchors: [websiteAnchor],
      tags: [],
      body: "Group the auth + billing worktrees under one thread.",
      createdAt: ago(60),
      updatedAt: ago(35),
      kind: "note",
    },
    {
      id: "site-note-2",
      anchors: [websiteAnchor],
      tags: [],
      body: "Use the real row controls on the public site.",
      createdAt: ago(42),
      updatedAt: ago(21),
      kind: "note",
    },
    {
      id: "site-note-3",
      anchors: [websiteAnchor],
      tags: [],
      body: "Zen mode should focus the row, not tint a fake canvas.",
      createdAt: ago(28),
      updatedAt: ago(8),
      kind: "note",
    },
    {
      id: "site-note-4",
      anchors: [hardwareAnchor],
      tags: [],
      body: "Arduino handout needs friendly debugging steps.",
      createdAt: ago(34),
      updatedAt: ago(12),
      kind: "note",
    },
    {
      id: "site-note-5",
      anchors: [experimentsAnchor],
      tags: [],
      body: "Spritesheet validator should fail before bad assets reach the game.",
      createdAt: ago(25),
      updatedAt: ago(10),
      kind: "note",
    },
  ];
</script>

<section class="preview" id="tour">
  <div class="shell">
    <WorkspacePreview memoryKey={MEMORY_KEY} {rows} {initialNotes} sticky />
  </div>
</section>

<style>
  .preview {
    padding: clamp(1.5rem, 5vw, 4rem) 0 clamp(3rem, 7vw, 5rem);
  }
  .preview .shell {
    position: relative;
  }
</style>
