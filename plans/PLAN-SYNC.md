# PLAN-SYNC.md — cross-machine settings & state sync via Needle Cloud

Living plan. Adjacent to [PLAN-SESSION-SHARE.md](./PLAN-SESSION-SHARE.md)
(LAN-based session transfer) and [PLAN-REMOTE.md](./PLAN-REMOTE.md)
(peer discovery). This plan is about syncing *user-scoped* settings and
lightweight state across machines over the internet, using Needle identity
and Needle Cloud as the transport.

## What we're adding, in one line

A Needle account login in supergit that enables encrypted sync of
settings, notes, stored commands, and UI preferences to a
`cloud.needle.tools` endpoint — so a user's supergit feels the same on
every machine without manual export/import.

## Why

Multi-machine is the normal case: laptop, desktop, maybe a CI box.
Today every supergit workspace is an island. Session *sharing* across
the LAN is covered by PLAN-SESSION-SHARE, but settings, notes, and
commands have no sync story at all. A user who configures repo custom
links on the desktop has to redo them on the laptop.

Requiring a Needle login also opens the door to future features
(cloud-backed session archive, team workspaces, license gating) without
adding another identity system later.

## Hard rules

1. **Local-first, always.** Sync is push/pull, never a hard
   dependency. Everything works offline from local files. The cloud
   copy is a convenience, not the source of truth. If the Needle
   endpoint is unreachable, supergit works exactly as it does today.
2. **Client-side encryption.** The blob is encrypted before upload
   (AES-256-GCM or libsodium secretbox, key derived from a
   user-held secret or device key). The Needle relay stores an
   opaque ciphertext — it never sees plaintext settings or notes.
3. **Forward-compatible schema.** The sync payload carries a schema
   version. Unknown keys are preserved (not stripped) on
   read so that a newer client's data survives being touched by an
   older client. Migrations are a pure function chain, one step per
   version bump.
4. **No repo paths in the sync blob.** Local filesystem paths differ
   across machines. Repos are identified by remote URL (or a
   stable repo id), never by absolute path. Each machine maintains
   its own path mapping.
5. **Pluggable backend.** The sync transport is behind a
   `SyncProvider` interface. Needle Cloud is the shipped
   implementation; the interface is simple enough that a
   self-hosted or filesystem provider could replace it.

## Auth: Needle Logto login

- supergit embeds a Logto OIDC client (PKCE flow, no client secret).
- On first launch (or "Sign in" action), the user authenticates via
  browser redirect to Needle's Logto tenant.
- The daemon stores the refresh token securely (OS keychain via
  `keytar` or a local encrypted file) and exchanges it for
  short-lived JWTs as needed.
- The JWT is sent to `cloud.needle.tools/api/supergit/sync` as a
  Bearer token. The cloud endpoint validates the token against
  Logto's JWKS and scopes the storage to the authenticated user id.
- Login is **required** for sync but **not required** to use
  supergit. An unauthenticated user gets the full local experience
  minus sync.

## What gets synced

### Sync (high priority — user-facing config)

| Data | Current file | Sync key | Notes |
|------|-------------|----------|-------|
| UI preferences | `prefs.json` | `prefs` | Note positions, z-order, open sessions, folded rows, etc. |
| Stored commands / custom links | `repos.json` → `customLinks[]` | `commands` | Detached from repo paths; keyed by repo remote URL. |
| Session titles | `session-titles.json` | `sessionTitles` | Human names for agent sessions. |
| Sticky notes | `notes/*.md` | `notes` | Full frontmatter + body. |
| Onboarding state | localStorage flag | `onboarding` | So walkthrough doesn't re-trigger on a new machine. |

### Don't sync (machine-local)

| Data | Why |
|------|-----|
| `peer-identity.json` | LAN identity, must be unique per machine. |
| `messages.json` | P2P messages, LAN-scoped, TTL'd. |
| `peer-mutes.json` | Muting is a per-machine social decision. |
| `events.jsonl` | Undo/redo audit log, grows unbounded, local-only. |
| `errors.jsonl` | Diagnostic, machine-specific. |
| `ollama/` | Local terminal transcripts. |
| `session-invites/` | Transient inbox, LAN-scoped. |
| `imported-sessions/` | JSONL lives in agent project dirs, not ours to sync. |
| `repos.json` → `path` | Absolute paths differ per machine. |

### The repo identity problem

`repos.json` stores repos by local path. Paths differ across machines
(`/Users/marcel/…` vs `/home/marcel/…`). Sync must decouple identity
from location:

- **Sync key**: the repo's primary remote URL (e.g.
  `github.com/user/repo`), normalized and stripped of protocol/auth.
- **Local mapping**: each machine maintains `path` locally. On sync
  pull, if a synced repo's remote URL matches a locally registered
  repo, merge the synced metadata (custom links, color, name) into
  the local entry. If no local match, store the metadata as
  "unmatched" — it activates automatically when the user adds a repo
  with that remote.

## Sync payload format

### Option A: versioned JSON blob (recommended for v1)

```jsonc
{
  "version": 1,
  "updatedAt": "2026-05-26T12:00:00Z",
  "prefs": { /* ... */ },
  "commands": {
    "github.com/user/repo": [
      { "label": "Deploy", "type": "command", "value": "make deploy" }
    ]
  },
  "sessionTitles": { /* ... */ },
  "notes": [
    {
      "id": "uuid",
      "kind": "note",
      "body": "...",
      "frontmatter": { /* ... */ }
    }
  ],
  "onboarding": { "walkthroughSeen": true }
}
```

- Client serializes → encrypts → uploads as a single blob.
- Server stores one blob per user, returns it on GET.
- Conflict resolution: **last-write-wins** by `updatedAt`. Sufficient
  for single-user settings. If two machines edit offline, the last one
  to come online wins. Acceptable because settings edits are
  infrequent and low-stakes (you can redo a preference toggle).
- Total size: typically < 100KB. Well within any reasonable API limit.

### Option B: SQLite (deferred)

A local SQLite DB with migration support (via Drizzle, Kysely, or
raw `ALTER TABLE`) that syncs as an encrypted binary blob. Advantages:

- Partial updates (sync individual rows, not the whole blob).
- Schema migrations via SQL (`ALTER TABLE`, data transforms).
- Timestamp-per-row enables smarter merge than whole-blob LWW.
- Bun has native SQLite support (`bun:sqlite`), zero dependencies.

Disadvantages:

- Binary format — can't inspect/debug as easily as JSON.
- SQLite file sync requires either shipping the whole file or a
  change-tracking layer (CRsqlite, Turso embedded replicas).
- Overkill for < 100KB of config data at v1.

**Recommendation**: start with Option A (JSON blob). Migrate to SQLite
if/when data volume or conflict frequency demands it. The
`SyncProvider` interface abstracts this — swapping the local
serialization format doesn't change the cloud transport.

### Option C: CRDTs (deferred further)

Automerge or Yjs for conflict-free offline merge. Only becomes
interesting if notes evolve into a collaborative feature (multiple
users editing the same workspace's notes). Massive complexity for a
single-user settings sync — not worth it now.

## Migration strategy

```ts
type SyncPayload = { version: number; [key: string]: unknown };

const migrations: Record<number, (data: SyncPayload) => SyncPayload> = {
  // version 1 → 2: added "commands" key
  2: (d) => { d.commands ??= {}; return d; },
  // version 2 → 3: renamed "prefs.notesHidden" → "prefs.notesCollapsed"
  3: (d) => {
    if (d.prefs?.notesHidden !== undefined) {
      d.prefs.notesCollapsed = d.prefs.notesHidden;
      delete d.prefs.notesHidden;
    }
    return d;
  },
};

function migrate(data: SyncPayload): SyncPayload {
  while (data.version < CURRENT_VERSION) {
    const next = data.version + 1;
    data = migrations[next]!(data);
    data.version = next;
  }
  return data;
}
```

Rules:
- Migrations are pure, deterministic, and tested.
- Unknown keys are always preserved (`...rest` spread, never
  cherry-pick known keys).
- Each migration has a unit test with before/after fixtures.
- Version only goes forward. Downgrade is not supported — older
  clients ignore keys they don't recognize but don't strip them.

## SyncProvider interface

```ts
interface SyncProvider {
  pull(): Promise<SyncPayload | null>;
  push(payload: SyncPayload): Promise<void>;
  readonly lastSyncedAt: Date | null;
  readonly isAuthenticated: boolean;
}
```

Implementations:
- `NeedleCloudSyncProvider` — the real one. Talks to
  `cloud.needle.tools/api/supergit/sync`. Encrypts/decrypts client-side.
- `NoopSyncProvider` — default when not logged in. `pull()` returns
  null, `push()` is a no-op.
- (future) `FileSyncProvider` — reads/writes an encrypted JSON file
  from a shared filesystem (Dropbox, iCloud Drive, NAS). For users who
  want sync without a Needle account.

## Cloud endpoint (Needle side)

Minimal API surface — the server is a dumb blob store:

```
PUT  /api/supergit/sync   — upload encrypted blob (auth: Bearer JWT)
GET  /api/supergit/sync   — download encrypted blob (auth: Bearer JWT)
```

- Storage scoped by Logto user id.
- Max blob size: 1MB (plenty for settings; reject larger).
- Rate limit: 60 writes/hour per user.
- No server-side decryption, no indexing, no schema awareness.
- Retention: indefinite (or until user deletes account).

## Sync lifecycle

1. **On login**: pull remote → decrypt → migrate → merge with local
   state (remote wins for keys with newer `updatedAt`, local wins
   for keys not present in remote).
2. **On local change**: debounce 5s → serialize → encrypt → push.
3. **On app launch** (already logged in): pull → merge (same as
   login, but skip auth flow).
4. **On conflict** (both sides changed since last sync): last-write-wins
   by `updatedAt`. The "loser" is not discarded — it's kept locally
   as `<key>.conflict.json` for manual inspection if needed. For v1
   this is best-effort; real conflicts in single-user settings are
   rare.
5. **On logout**: stop syncing. Local data is untouched.

## Encryption

- **Algorithm**: AES-256-GCM (available in Web Crypto API and
  Node/Bun `crypto` module).
- **Key derivation**: PBKDF2 or Argon2id from a user passphrase,
  or a random key stored in the OS keychain alongside the refresh
  token.
- **IV**: random 12 bytes per encryption, prepended to ciphertext.
- **Envelope**: `base64(iv + ciphertext + tag)` — single string,
  easy to store and transport.
- **Key rotation**: re-encrypt and re-push when the user changes
  passphrase. Old blobs are overwritten.

## Open questions

- **Passphrase vs device key?** A passphrase is more portable (works
  on any machine without key transfer) but adds UX friction. A
  device key is seamless but requires a key-exchange step when
  adding a new machine. Leaning toward device key stored in OS
  keychain + a recovery passphrase as fallback.
- **Granular sync?** v1 syncs the whole blob. If notes grow large,
  per-note sync (keyed by note id) might be needed. The JSON blob
  format supports this by splitting into sub-blobs, but the cloud
  endpoint would need multi-key storage.
- **Team workspaces?** This plan is single-user. If workspaces
  become shared (v2+), sync becomes collaboration — different
  problem, probably needs CRDTs or OT. Don't design for it now.
- **Needle Cloud endpoint ownership?** Who builds and maintains the
  `/api/supergit/sync` endpoint? Needs coordination with the Needle
  Cloud team.

## Non-goals

- Syncing session transcripts (covered by PLAN-SESSION-SHARE for
  LAN; cloud session archive is a separate future plan).
- Syncing repo content or git state (that's what git remotes are for).
- Real-time collaboration (v2+ at earliest).
- Replacing git as the workspace versioning mechanism.

## Implementation phases

**Phase 0 — Needle login (prerequisite)**
- Integrate Logto OIDC client in daemon.
- Store tokens securely.
- Show login state in UI (avatar, email, sign-out).
- No sync yet — just auth.

**Phase 1 — Basic sync (JSON blob)**
- `SyncProvider` interface + `NeedleCloudSyncProvider`.
- Serialize prefs + commands + session titles + notes → versioned
  JSON → encrypt → push/pull.
- Merge logic (LWW by `updatedAt`).
- UI indicator: "last synced 2m ago" / "sync error" / "offline."
- Migration chain with tests.

**Phase 2 — Robust sync**
- Conflict detection + `.conflict.json` sidecar.
- Retry with exponential backoff on push failure.
- Granular sync (per-section or per-note) if blob size warrants it.
- Settings UI to choose what syncs.

**Phase 3 — Alternative providers (optional)**
- `FileSyncProvider` for iCloud/Dropbox/NAS.
- Provider selection in settings.
