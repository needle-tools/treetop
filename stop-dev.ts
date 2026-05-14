// `bun stop-dev` — kill the dev daemon (port 7777) and Vite (7779).
// Prod (`:27787`) is deliberately NOT killed; this script is safe to
// run while the prod dashboard is in use.
//
// Use when:
//   - dev is wedged and you want to start fresh: `bun stop-dev && bun dev`.
//   - you're switching to prod and want to free the dev ports.
//   - a previous `bun dev` left orphan processes (rare since dev.ts
//     pre-flights the same kill, but possible after a hard crash).
//
// To stop prod, see plans/PLAN.md / CLAUDE.md: it's a deliberate
// process kill on :27787 and the rule is "ask first."

import { killDevPorts } from "./dev-ports";

await killDevPorts();
console.log("dev: stopped (prod on :27787 untouched)");
