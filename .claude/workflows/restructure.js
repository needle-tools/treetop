export const meta = {
  name: 'restructure',
  description: 'Two-track cleanup for supergit: (1) map large TS/Svelte files for safe restructuring + pin behavior with domless tests, and (2) audit CSS toward one clean, themeable design-token file. Emits a single PR-sized roadmap.',
  whenToUse: 'Run over supergit to produce a prioritized, PR-sized restructuring roadmap: a green characterization-test safety net for the monster TS/Svelte files, AND a design-token consolidation plan (one themeable tokens file, fewer globals, merged component CSS). Pass args as an array of repo-relative file paths to override the default code targets; the CSS track always scans packages/ui/src.',
  phases: [
    { title: 'Map', model: 'sonnet', detail: 'one agent per large file: responsibilities, design decisions to preserve, reusable/testable extraction seams, hot paths to instrument, test gaps' },
    { title: 'Pin', model: 'sonnet', detail: 'write domless characterization tests for genuinely-untested behavior; run them; report green/deferred' },
    { title: 'CSS audit', model: 'sonnet', detail: 'token + color audit toward a themeable tokens file; global-CSS leakage + component-merge audit' },
    { title: 'CSS guard', model: 'sonnet', detail: 'write a domless guard test locking the token contract so consolidation cannot silently drop a token' },
    { title: 'Synthesize', detail: 'merge both tracks into one prioritized, PR-sized roadmap (code + CSS)' },
  ],
}

// ── Targets ──────────────────────────────────────────────────────────────────
// Code track: default to the two monster files; override via args: ["path/a", ...].
const TARGETS = (Array.isArray(args) && args.length)
  ? args
  : [
      'packages/daemon/src/server.ts',
      'packages/ui/src/App.svelte',
    ]

// CSS track always scans the UI package + compares to this north-star token file
// (good direction, not perfect): small base palette, everything else derived via
// oklch(from ...) / color-mix(), themes override only the base.
const CSS_ROOT = 'packages/ui/src'
const CSS_REFERENCE = '/Users/marcelwiessler/git/webitor/packages/core.ui/src/lib/styles/styles.css'

const short = (p) => p.split('/').slice(-1)[0]

// ── Schemas ──────────────────────────────────────────────────────────────────
const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'lineCount', 'oneLineCharter', 'responsibilities', 'designDecisions', 'extractionSeams', 'hotPaths', 'testGaps'],
  properties: {
    file: { type: 'string' },
    lineCount: { type: 'number' },
    oneLineCharter: { type: 'string', description: 'What this file is fundamentally responsible for, in one sentence.' },
    responsibilities: {
      type: 'array',
      description: 'The distinct concerns this file currently mixes together.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['concern', 'approxLines', 'lineRange'],
        properties: {
          concern: { type: 'string' },
          approxLines: { type: 'number' },
          lineRange: { type: 'string', description: 'e.g. "1200-1480"' },
        },
      },
    },
    designDecisions: {
      type: 'array',
      description: 'Non-obvious choices, invariants, WHY-comments, gotchas, and ordering constraints that MUST survive any refactor. This is the "do not lose design decisions" ledger.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['decision', 'lineRef', 'whyItMatters', 'riskIfLost'],
        properties: {
          decision: { type: 'string' },
          lineRef: { type: 'string' },
          whyItMatters: { type: 'string' },
          riskIfLost: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    extractionSeams: {
      type: 'array',
      description: 'Proposed modules to extract — the reusable/testable pieces. Order by extraction safety (safest first).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['proposedModule', 'purpose', 'currentLines', 'reusable', 'pureTestable', 'dependencies', 'extractionRisk', 'rationale'],
        properties: {
          proposedModule: { type: 'string', description: 'Proposed new file/module name, e.g. "session-poll-etag.ts"' },
          purpose: { type: 'string' },
          currentLines: { type: 'string' },
          reusable: { type: 'boolean', description: 'Would other modules genuinely reuse this, or is it single-call-site? Be honest — do not invent reuse.' },
          pureTestable: { type: 'boolean', description: 'Can it become a pure, domless-testable unit?' },
          dependencies: { type: 'array', items: { type: 'string' }, description: 'What it depends on that complicates extraction (globals, closures, Svelte reactivity, module state).' },
          extractionRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
          rationale: { type: 'string' },
        },
      },
    },
    hotPaths: {
      type: 'array',
      description: 'Code on a hot path (polling loops, render/reactive recompute, per-keystroke handlers, large-file scans, per-request work). Where performance must be measurable.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'lineRef', 'whyHot', 'suggestedMeasurement'],
        properties: {
          description: { type: 'string' },
          lineRef: { type: 'string' },
          whyHot: { type: 'string', description: 'What makes this hot — frequency, payload size, fan-out.' },
          suggestedMeasurement: { type: 'string', description: 'Concrete hook: e.g. "wrap in a named timing span exported via /api/debug/timings" or "mark()/measure() around the reactive block".' },
        },
      },
    },
    testGaps: {
      type: 'array',
      description: 'Behaviors NOT already covered by an existing test that a refactor could silently break.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['behavior', 'kind', 'feasibleNow'],
        properties: {
          behavior: { type: 'string' },
          kind: { type: 'string', enum: ['integration', 'unit', 'post-extraction'], description: 'integration = exercise via route/server today; unit = an already-importable helper; post-extraction = only testable after a seam is extracted.' },
          feasibleNow: { type: 'boolean', description: 'Can a meaningful test be written against TODAY\'s code without extracting anything first?' },
        },
      },
    },
  },
}

const TEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'testFilesWritten', 'allGreen', 'behaviorsPinned', 'deferred', 'notes'],
  properties: {
    file: { type: 'string' },
    testFilesWritten: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths of NEW test files created (empty if nothing was feasible today).' },
    allGreen: { type: 'boolean', description: 'Did every newly-written test pass when run?' },
    behaviorsPinned: { type: 'array', items: { type: 'string' } },
    deferred: {
      type: 'array',
      description: 'Behaviors NOT pinned now because they require an extraction first — feed these into the roadmap as the post-extraction test list.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['behavior', 'blockedBy'],
        properties: {
          behavior: { type: 'string' },
          blockedBy: { type: 'string', description: 'Which extraction seam must land before this is testable.' },
        },
      },
    },
    notes: { type: 'string', description: 'Include behaviors you SKIPPED because an existing test already covers them.' },
  },
}

const CSS_AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['definedTokenCount', 'hardcodedColorCount', 'duplicateValues', 'shouldBeTokens', 'proposedTokenSystem', 'globalLeakage', 'largeFiles', 'mergeCandidates', 'scopingRisks', 'gapsVsReference'],
  properties: {
    definedTokenCount: { type: 'number' },
    hardcodedColorCount: { type: 'number', description: 'Distinct hardcoded color literals still living in component CSS that should reference a token.' },
    duplicateValues: {
      type: 'array',
      description: 'Sets of near-identical literal values (e.g. five slightly-different greys) that should collapse to one token.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['values', 'proposedToken', 'occurrences'],
        properties: {
          values: { type: 'array', items: { type: 'string' } },
          proposedToken: { type: 'string' },
          occurrences: { type: 'number' },
        },
      },
    },
    shouldBeTokens: {
      type: 'array',
      description: 'High-traffic literal values (colors, radii, font-sizes, spacing) that should become tokens.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value', 'occurrences', 'proposedToken', 'files'],
        properties: {
          value: { type: 'string' },
          occurrences: { type: 'number' },
          proposedToken: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    proposedTokenSystem: {
      type: 'object',
      additionalProperties: false,
      description: 'The target: a small base palette + derived tokens + theme overrides, modeled on the reference (oklch(from ...) / color-mix). Keep the base set SMALL and reasonable.',
      required: ['baseTokens', 'derivedTokens', 'themeStrategy', 'estimatedFinalTokenCount'],
      properties: {
        baseTokens: {
          type: 'array',
          description: 'The minimal set someone edits to re-skin the whole app (e.g. brand, background).',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'value', 'note'],
            properties: { name: { type: 'string' }, value: { type: 'string' }, note: { type: 'string' } },
          },
        },
        derivedTokens: {
          type: 'array',
          description: 'Tokens computed from the base via color-mix/oklch so theming cascades automatically.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'derivation'],
            properties: { name: { type: 'string' }, derivation: { type: 'string', description: 'e.g. "color-mix(in srgb, var(--text) 50%, var(--background))"' } },
          },
        },
        themeStrategy: { type: 'string', description: 'How dark/light theming hangs off the base (e.g. :root[data-theme="light"] overrides only --background + --brand; the rest re-derives).' },
        estimatedFinalTokenCount: { type: 'number' },
      },
    },
    globalLeakage: {
      type: 'array',
      description: ':global() rules / unscoped selectors that leak across components and risk collisions.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['where', 'selector', 'risk'],
        properties: { where: { type: 'string' }, selector: { type: 'string' }, risk: { type: 'string', enum: ['high', 'medium', 'low'] } },
      },
    },
    largeFiles: {
      type: 'array',
      description: 'Oversized CSS files and the concerns they conflate.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'lines', 'concerns'],
        properties: { file: { type: 'string' }, lines: { type: 'number' }, concerns: { type: 'string' } },
      },
    },
    mergeCandidates: {
      type: 'array',
      description: 'Components / CSS files that are duplicative or were meant to merge (unfinished consolidation).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['items', 'rationale'],
        properties: { items: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } },
      },
    },
    scopingRisks: { type: 'array', items: { type: 'string' }, description: 'Specific cross-contamination hazards to respect during consolidation (e.g. Popover root needing shell+variant rules — see styles/*.css header comments).' },
    gapsVsReference: { type: 'string', description: 'How the current system differs from the reference direction, and what to adopt (derived tokens, theming hooks, oklch usage).' },
  },
}

const CSS_GUARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['testFilesWritten', 'allGreen', 'contractPinned', 'danglingRefsFound', 'notes'],
  properties: {
    testFilesWritten: { type: 'array', items: { type: 'string' } },
    allGreen: { type: 'boolean' },
    contractPinned: { type: 'string', description: 'What the guard locks (e.g. "all 82 current token names remain defined; every var(--x) referenced in component CSS resolves").' },
    danglingRefsFound: { type: 'array', items: { type: 'string' }, description: 'var(--x) used but not defined — findings for the roadmap, NOT committed as failing tests.' },
    notes: { type: 'string' },
  },
}

// ── Shared rules ─────────────────────────────────────────────────────────────
const RULES = `
Hard constraints (from this repo's CLAUDE.md — non-negotiable):
- Do NOT modify any source file (no .ts/.svelte/.css edits). Test files are the ONLY thing some stages may add.
- Do NOT run \`bun run build\`, \`bun run start\`, or any build. NEVER kill/restart any process; never bind a server to :27787.
- Goal: restructure into reusable + testable pieces and consolidate CSS into one themeable token system WITHOUT losing functionality or design decisions. Be conservative and honest — never invent reuse (three similar lines beats a premature helper), and flag every load-bearing invariant.
`

// ── Prompts: code track ──────────────────────────────────────────────────────
const mapPrompt = (file) => `Read the ENTIRE file \`${file}\` (it is large — read it fully, in chunks if needed) and produce a structured restructuring map.

You are the "Map" stage of a restructuring workflow. Your output feeds a characterization-test writer and a roadmap synthesizer, so be precise with line references.

FIRST, survey EXISTING test coverage — this repo already has ~94 test files and we must not propose or duplicate tests that already exist. Before listing any testGap:
- List the relevant test dir (\`packages/daemon/test/\` for daemon files, \`packages/ui/test/\` for UI files) and grep it for the behaviors, route names, function names, and types exported/used by this file.
- A behavior only counts as a testGap if NO existing test already pins it. When in doubt, open the candidate test file and confirm. Err toward "already covered."

Analyze and return (per the schema):
1. **responsibilities** — the distinct concerns this one file currently mixes. Give honest line ranges.
2. **designDecisions** — THE most important section. Every non-obvious choice, invariant, ordering constraint, WHY-comment, perf hack, or gotcha that a naive refactor would destroy. This is the "don't lose design decisions" ledger. Cite line refs. Mark riskIfLost.
3. **extractionSeams** — concrete, reusable/testable modules to peel out, ordered safest-first. For each: is it GENUINELY reusable (or single-call-site)? Can it become pure/domless-testable? What closures/globals/Svelte-reactivity/module-state make extraction risky?
4. **hotPaths** — anything on a hot path (polling, render/reactive recompute, per-keystroke, large-file scans, per-request work). For each, suggest a CONCRETE measurement hook so the hot path can be benchmarked before/after.
5. **testGaps** — genuinely-untested behaviors a refactor could silently break. Mark which are feasible to test TODAY (integration via route/server, or an already-importable helper) vs only after an extraction.
${RULES}
Do not write any files in this stage. Just analyze and return the structured map.`

const testPrompt = (file, map) => `You are the "Pin" stage. Using the restructuring map below, write domless characterization tests that pin the CURRENT behavior of \`${file}\` — the safety net that must be green BEFORE anyone refactors.

Restructuring map (JSON):
${JSON.stringify(map, null, 2)}

Process:
1. First read an existing test to match conventions exactly:
   - For daemon (.ts): read \`packages/daemon/test/integration.test.ts\` — uses \`bun:test\`, temp dirs via \`mkdtemp\`, exercises real logic against the same payload contracts the routes use.
   - For UI (.svelte/.ts): read \`packages/ui/test/storage.test.ts\` — uses \`bun:test\`, imports PURE functions from src, uses an in-memory store; NO DOM.
2. Then CHECK FOR EXISTING COVERAGE — this repo already has ~94 test files. For each candidate behavior, grep the test dir (\`packages/daemon/test/\` or \`packages/ui/test/\`) for it and open any plausible match. If a behavior is already pinned by an existing test, SKIP it — do not duplicate. Only write tests that fill a genuine, currently-untested gap. Record anything you skipped as already-covered in \`notes\`.
3. From what remains, pick the highest-value \`testGaps\` where \`feasibleNow: true\`. Write ONE new test file pinning those behaviors. Name it clearly, e.g. \`packages/.../test/${short(file).replace(/\.(ts|svelte)$/, '')}-characterization.test.ts\`.
4. Tests must ASSERT real behavior (no test that passes without asserting; no mocking the thing under test — use temp dirs / in-memory stores). They must PASS against today's unchanged source.
5. Run ONLY your new test file (e.g. \`bun test <your-new-file>\`) and confirm green. Do not run the whole suite, do not build, do not start servers on fixed ports.
6. For behaviors that are only testable AFTER an extraction lands, do NOT fabricate a test — record them in \`deferred\` with the blocking seam so the roadmap can schedule them.

If NOTHING is feasible today without an extraction (common for tightly-coupled Svelte logic), write no file and return testFilesWritten: [] with everything in \`deferred\`. That is a valid, honest outcome.
${RULES}
Return the structured result.`

// ── Prompts: CSS track ───────────────────────────────────────────────────────
const cssAuditPrompt = () => `You are the "CSS audit" stage. Audit supergit's styling under \`${CSS_ROOT}\` and produce a plan to converge on ONE clean, themeable design-token file.

Context — the current state (already measured):
- ~82 tokens defined but no theming; the existing token file is \`packages/ui/src/styles/tokens.css\` (read it first — it has good WHY-comments to preserve).
- ~146 distinct hardcoded color literals scattered across component CSS; ~100 \`:global()\` usages; large CSS files (\`styles/notes.css\` ~2390 lines, \`styles/worktree-row.css\` ~1924, \`styles/popover.css\` ~737).
- Shared CSS deliberately lives in \`styles/*.css\` (NOT scoped in .svelte) — read the file-header comments in those files; they explain scoping decisions that MUST be preserved.

North-star reference (good DIRECTION, not perfect — read it): \`${CSS_REFERENCE}\`. Adopt ONLY its token philosophy: a SMALL base palette (brand, background) with everything else DERIVED via \`oklch(from var(--x) ...)\` and \`color-mix(...)\`, so overriding just the base re-skins the app. IMPORTANT — the reference is a web component + browser extension, so it carries shadow-DOM machinery (\`:host\`, \`:host(:state(default|dark|light))\`) that supergit does NOT have. supergit is a plain SPA: use \`:root\` for defaults and \`:root[data-theme="dark"|"light"]\` for themes ONLY. Do not introduce \`:host\` / \`:state()\` selectors.

Do this:
1. Read \`tokens.css\`, the reference, and sample the big component CSS files + a few .svelte \`<style>\` blocks. Grep for hardcoded colors and \`var(--\` usage.
2. Inventory: duplicate/near-duplicate literal values that should collapse to one token; high-traffic literals that should become tokens.
3. Design **proposedTokenSystem**: a SMALL base set + derived tokens + a theme strategy, in the reference's spirit but fitted to supergit's existing names where sensible (don't gratuitously rename what works). Keep the final token count reasonable, not sprawling. Preserve the intent behind existing tokens (the WHY-comments).
4. Audit structure: \`:global()\` leakage and collision risk, oversized files, components/CSS meant to merge (unfinished consolidation), and scoping hazards to respect.
${RULES}
Do not write any files in this stage. Return the structured audit.`

const cssGuardPrompt = (audit) => `You are the "CSS guard" stage. Write ONE domless test that locks the CURRENT token contract so the upcoming consolidation cannot silently drop or break a token.

CSS audit (JSON):
${JSON.stringify(audit, null, 2)}

Process:
1. Read \`packages/ui/test/storage.test.ts\` for \`bun:test\` conventions (pure, no DOM, just file reads + asserts).
2. Write a guard test, e.g. \`packages/ui/test/design-tokens.test.ts\`, that reads \`packages/ui/src/styles/tokens.css\` and asserts the current set of token NAMES is present (a name snapshot). This catches "consolidation accidentally deleted --chip-cyan-bg" without freezing token VALUES (so re-theming stays free).
3. Optionally, if it passes against today's code, also assert every \`var(--x)\` referenced in \`styles/*.css\` resolves to a defined token. If that FAILS today due to pre-existing dangling refs, do NOT commit a failing test — instead record those dangling refs in \`danglingRefsFound\` for the roadmap, and keep the committed test to the name-snapshot that is green.
4. Run ONLY your new test file and confirm green. No build, no server, no source edits.
${RULES}
Return the structured result.`

// ── Prompt: synthesis ────────────────────────────────────────────────────────
const synthPrompt = (code, css) => `You are the "Synthesize" stage. Merge the code-restructuring track and the CSS/design-token track into ONE prioritized, PR-sized restructuring roadmap for supergit.

CODE TRACK — per-file maps + characterization-test results (JSON):
${JSON.stringify(code, null, 2)}

CSS TRACK — design-token audit + guard-test result (JSON):
${JSON.stringify(css, null, 2)}

Produce a Markdown roadmap:

## Code restructuring
For EACH file, a subsection:
- **Charter & current responsibilities.**
- **Design decisions to preserve** — load-bearing invariants sorted by riskIfLost. The contract any refactor must honor.
- **Extraction plan** — an ordered, PR-sized checklist. Each step = ONE PR: (a) module to extract, (b) why reusable/testable, (c) the characterization test that must be green first (cite the test file if written, or the deferred test to write), (d) extraction risk. Safest-first; respect "refactor first (tests green), THEN add behavior — never both in one PR."
- **Performance measurement plan** — hot paths + the concrete instrumentation hook for each, so improvements are measurable server- and frontend-side. Note any shared timing utility worth introducing once.

## CSS & design tokens
- **Target token file** — sketch the consolidated, themeable \`tokens.css\`: the small base palette, the derived tokens (with their color-mix/oklch derivations), and the dark/light theme strategy. Preserve the intent of existing tokens' WHY-comments.
- **Migration plan** — ordered, PR-sized steps: introduce derived/base tokens → migrate hardcoded literals file-by-file to tokens → add the light theme → merge duplicate component CSS / shrink oversized files → reduce \`:global()\` leakage. Each step cites its guard (the token-contract test) and any scoping hazard to respect.
- **Cleanup ledger** — merge candidates, dangling refs, and oversized files, each with a target.

## Suggested sequencing
A flat, numbered list of the first ~10 PRs across ALL tracks, ordered by (safety × value). Each line: PR title — one-clause why — its green-test precondition.

## Safety-net status
Which characterization/guard tests are already written + green, and which are deferred until a seam lands.

Be concrete and honest. Never invent reuse. Keep each PR genuinely PR-sized (reviewable in one sitting). This roadmap is the deliverable the user reads — make it actionable.`

// ── Run ──────────────────────────────────────────────────────────────────────
// Two tracks run concurrently; each agent is tagged with its phase so the
// progress display groups correctly despite the concurrency.
const [perFile, cssResult] = await Promise.all([
  // Code track: map -> pin, pipelined per file (no barrier between files).
  pipeline(
    TARGETS,
    (file) => agent(mapPrompt(file), { label: `map:${short(file)}`, phase: 'Map', model: 'sonnet', schema: MAP_SCHEMA }),
    (map, file) => map
      ? agent(testPrompt(file, map), { label: `pin:${short(file)}`, phase: 'Pin', model: 'sonnet', schema: TEST_SCHEMA })
          .then((tests) => ({ map, tests }))
      : null,
  ),
  // CSS track: audit -> guard test.
  (async () => {
    const audit = await agent(cssAuditPrompt(), { label: 'css:audit', phase: 'CSS audit', model: 'sonnet', schema: CSS_AUDIT_SCHEMA })
    const guard = audit
      ? await agent(cssGuardPrompt(audit), { label: 'css:guard', phase: 'CSS guard', model: 'sonnet', schema: CSS_GUARD_SCHEMA })
      : null
    return { audit, guard }
  })(),
])

const code = perFile.filter(Boolean)
const roadmap = await agent(synthPrompt(code, cssResult), { label: 'roadmap', phase: 'Synthesize' })

return {
  targets: TARGETS,
  roadmap,
  testFilesWritten: [
    ...code.flatMap((x) => x.tests?.testFilesWritten ?? []),
    ...(cssResult?.guard?.testFilesWritten ?? []),
  ],
  allGreen:
    code.every((x) => x.tests?.allGreen !== false) &&
    (cssResult?.guard?.allGreen !== false),
}
