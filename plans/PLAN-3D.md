# supergit — 3D / binary handling

Companion plan to [PLAN.md](./PLAN.md). The main plan covers the dashboard +
workflow pillar; **this one is self-contained** and covers the 3D / binary
asset pillar: format-aware diff, semantic merge for Blender and Unity, and
the chunked content-addressed store that makes the whole binary story
efficient. Two pillars, one product — they share a daemon and a UI shell
but ship independently. Neither blocks the other.

## What this is, in one line
The only git client that actually shows you what changed in your glb,
`.blend`, or Unity scene — and the storage layer that makes a 500 MB binary
edit push in milliseconds.

## Decisions so far
- **Independent shipping cadence from PLAN.md.** The dashboard pillar can
  ship v0 without any binary work, and vice versa.
- **Local-first, cloud-optional.** The CAS prototypes purely on local disk;
  Needle Cloud is one possible backend among several.
- **Diff before merge.** We promise diff for everything; merge only where
  it's actually tractable (Unity YAML yes, Blender block-level eventually,
  Blender mesh-level for arbitrary edits probably never).
- **Plug into the dashboard via a `DiffProvider` interface.** The binary
  side doesn't get its own UI shell; it ships viewers that render inside
  the main dashboard's diff pane.
- **TDD discipline applies here too.** Format providers, the CAS, and merge
  drivers are exactly the kind of code where AI agents could break
  invariants silently — every block ships with an executable spec. See
  [DEVELOPMENT.md](./DEVELOPMENT.md).

## Contents
- [Vision](#vision) — who this serves, what the pain looks like.
- [Binary diff](#binary-diff) — plugin architecture, glTF as the flagship, images and audio after.
- [Blender](#blender) — block-level diff via SDNA self-description; semantic merge as a v2/v3 stretch.
- [Unity](#unity) — semantic scene merge, .meta GUID resolver, `Library/` snapshot caching.
- [Smart LFS / chunked CAS](#smart-lfs--chunked-cas) — format-aware content-addressed storage, local first, cloud optional.
- [Needle Cloud plays (3D side)](#needle-cloud-plays-3d-side) — CAS backend and cloud-side semantic preview render.
- [Roadmap](#roadmap) — v0/v1/v2/v3 for this pillar.
- [Open questions](#open-questions) — binary-specific design calls.

---

## Vision

General-purpose git clients (Fork, GitKraken, GitHub Desktop, VSCode's git
pane) treat binary files as opaque blobs. "Binary file changed" is all you
get, even for the formats that drive entire industries — glTF, Blender,
Unity scenes, KTX2 textures, EXR images.

This pillar fixes that with **format-aware everything**: diff, merge, storage,
dedup. Built on top of the daemon and UI shell from the dashboard plan, but
designed for a specific audience whose repos are full of 3D / game / WebXR
assets and whose workflows live and die on binary review.

The concrete daily pains:
- "Fork shows 'binary file changed' for a 50 MB glb and I have to open it
  in a viewer to see what the AI did." → format-aware diff with embedded
  3D A/B viewer.
- "Reviewing AI-generated 3D edits is the bottleneck." → semantic readouts
  next to the visual: *Material X node graph changed, Mesh Hero +1200 verts*.
- "My Unity repo is 80 GB because of binary churn." → chunked CAS dedups
  across branches and across files.
- "Branch-switching in Unity recompiles `Library/` for 20 minutes." →
  snapshot caching keyed by Assets + ProjectSettings hash.
- "Unity `.meta` GUID conflicts wipe out an afternoon every week." →
  auto-resolver with project-wide reference rewrites.

Audiences, in order:
- Needle Engine / WebXR / Three.js devs (overlaps perfectly with the
  Needle audience).
- Blender artists shipping to web.
- Unity studios (bigger market, harder sell, later).

---

## Binary diff

A plugin architecture with one interface (`can_handle` / `diff` / `render`) and
many implementations per file format. Fork shows "binary file changed" and
you're flying blind; supergit shows "the Hero mesh has 1200 more verts and the
metal material's roughness map was replaced — here, look."

```rust
trait DiffProvider {
    fn can_handle(&self, path: &Path, old: &[u8], new: &[u8]) -> bool;
    fn diff(&self, old: &[u8], new: &[u8]) -> DiffArtifact;
    fn render(&self, diff: &DiffArtifact) -> WebView;
}
```

**glTF / GLB** (flagship, this pillar's v0):
- Structural diff over the JSON tree: meshes, materials, textures, animations,
  node hierarchy, extensions.
- Asset-stats delta: tri count, draw calls, texture memory, file size.
- Embedded 3D viewer (Needle Engine) with A/B toggle, side-by-side, and slider
  scrub. Changed meshes tinted red.
- Animation diff: play clips synced, keyframe-count delta, duration delta.

**Images** (v1): pixel diff via pixelmatch/dssim, side-by-side / overlay /
channel split, KTX2 / EXR / HDR support, mipmap inspector, alpha viewer.

**Audio** (v2): waveform + spectrogram diff. Lower priority but cheap.

**Generic binary fallback**: size delta, mime type, first 64 bytes hex.
Never say "binary file changed" with no info.

Performance: diff providers run in a daemon worker pool, results cached by
`(old_hash, new_hash)`. Large files (500 MB glb) stream structural diff first
and defer buffer diff to a "load buffers" button.

---

## Blender

`.blend` is a self-describing memory dump: every struct is documented by the
SDNA block at the start of the file, so we can parse without Blender running.
Combined with the fact that a `.blend` is a list of named data-blocks
(Objects, Meshes, Materials, Actions), this unlocks **block-level diff and
eventually merge** without ever loading the whole file as bytes.

Diff (achievable v2):
- Hash each block on save → diff is set-difference of hashes, usually <5% of
  blocks.
- Semantic readout: *"Material Metal_Rough node graph changed (added Mix node),
  Mesh Hero +1200 verts, Action Walk keyframe count 24 → 32."*
- 500 MB file diffs in milliseconds because we only inspect changed blocks.

Merge (v3, hard but real):
- Three-way at block granularity. Non-overlapping edits auto-merge (you added
  a Material, they added a ShapeKey on a different mesh → trivial).
- Same-block edits surface as conflicts with **3D preview of both sides**.
- **AI-assisted merge** for hard conflicts: hand Claude the ancestor + both
  diffs + 3D context, let it propose a resolved block. This is genuinely the
  feature nobody else can build.
- Mesh vertex-level merge for arbitrary edits is the hardest case — we don't
  promise it. "Pick a side" + AI is the v3 fallback.

---

## Unity

Unity is easier than Blender (scene/prefab files are YAML with stable GUIDs)
and the audience is bigger (game studios). The three high-value features are
**semantic scene merge, `.meta` GUID auto-resolution, and `Library/` snapshot
caching** — all of which Unity itself does badly or not at all.

- **Scene / prefab YAML semantic merge**: replace Unity SmartMerge (famously
  broken). Understand GameObject hierarchy, component composition, prefab
  overrides. Conflicts get 3D preview where possible.
- **.meta GUID auto-resolver**: the single most hated Unity merge problem.
  Two people import the same asset, get different GUIDs, refs break across
  the project. Detect divergent-GUID-same-path → pick one + rewrite every
  reference project-wide. Studios install supergit just for this.
- **`Library/` snapshot caching**: the import cache is gitignored because it's
  huge, but regenerating it on branch-switch eats 10–30 min on big projects.
  Snapshot `Library/` per commit into the local CAS keyed by `Assets/` +
  `ProjectSettings/` hash. Switch branch → instant restore. Studios pay for
  Unity Accelerator for exactly this; we give it away on localhost.

Bonus: live Unity bridge via the Needle MCP tools (`unity_get_selected_objects`,
etc.). "Claude modified this scene, here's what changed *and* here's what's
currently open in your Unity."

---

## Smart LFS / chunked CAS

The thing that makes the binary story actually work end-to-end: a
**content-addressed object store** with **format-aware chunking**. Regular
Git LFS treats files as opaque blobs of bytes; we split files into *semantic*
chunks (Blender data-blocks, glb buffers, Unity import-cache entries) so that
a one-mesh edit in a 500 MB Blender file produces a tiny delta, and chunks
dedupe across files (two `.blend`s sharing a texture → stored once).

How it works:
1. On `add` / `commit`, supergit's clean filter runs the format parser, splits
   the file into named chunks, hashes each, writes new chunks to the CAS, and
   replaces the working-tree file with a tiny pointer manifest (just the chunk
   hashes + file metadata).
2. Git only ever sees the manifest — repos stay tiny.
3. On `checkout`, the smudge filter reassembles the real file from chunks in
   the CAS.
4. The diff system reuses the same chunk hashes — diff is set-difference plus
   per-format semantic readout for changed chunks. **The CAS *is* the diff
   infrastructure.**

```
.supergit/
  objects/<sha256>      ← chunk store (local default)
  manifests/<sha256>    ← per-file chunk lists
  config.toml           ← which formats to chunk, backend selection
```

**Crucial: this is prototypable locally with zero cloud dependency.** The CAS
is just a directory of files on disk. We can implement, ship, dogfood, and
debug the entire system before any cloud integration. That keeps the early
versions honest and means we can develop everything in this repo without any
external infra.

Backend abstraction is a single trait:

```rust
trait BlobStore {
    fn put(&self, hash: &Hash, bytes: &[u8]) -> Result<()>;
    fn get(&self, hash: &Hash) -> Result<Vec<u8>>;
    fn exists(&self, hash: &Hash) -> Result<bool>;
}
```

Implementations: **local disk** (default, ships first), **S3 / R2 / MinIO**
(self-host, corp users), **Needle Cloud** (default once we want network sync),
**GitHub LFS** (compat fallback for existing repos). Per-repo backend
selection in config. User never gets trapped.

What this gives us beyond LFS:
- A 5 GB Unity project with churning `Library/` stays 5 GB on disk total, not
  5 GB × N branches.
- Network transfer of a Blender edit pushes 200 KB, not 200 MB.
- Diffs are nearly free because chunks are already hashed and parsed.
- Branch-switch on a Unity project is seconds, not 30 minutes.

This is the feature that turns supergit from a nicer Fork into infrastructure
people would pay for.

---

## Needle Cloud plays (3D side)

Two cloud plays specific to this pillar; the dashboard-side plays (presence
relay, team mode) live in PLAN.md.

1. **CAS backend** (highest leverage, lowest effort). Needle Cloud already
   serves binary 3D assets globally; same infra, repurposed. `BlobStore` impl
   pointing at Needle Cloud → team-wide dedup, lazy-fetch on checkout, no
   LFS bill.
2. **Cloud-side semantic preview** ("GitHub for 3D" angle). Push a branch →
   cloud runs glb structural diff, headless-renders Blender thumbnails,
   screenshots Unity scenes → PR preview URL with the side-by-side viewer.
   GitHub structurally can't do this.

Guardrails: same as PLAN.md's cloud plays section — pluggable, never
required, don't fork git's protocol, don't compete on code hosting.

---

## Roadmap

Concrete tiering for the binary pillar. Ships in parallel with PLAN.md's
dashboard roadmap; neither blocks the other.

**v0 — first format, first viewer**
- glTF structural diff over the JSON tree.
- Embedded Needle Engine viewer with A/B toggle and side-by-side.
- Asset-stats delta (tri count, draw calls, file size).
- Wire into the dashboard's diff view as a `DiffProvider`.

**v1 — broaden the diff coverage, start the CAS**
- Image diff (PNG/JPG, then KTX2/EXR).
- Audio diff (waveform + spectrogram).
- Unity `.meta` GUID auto-resolver (low-hanging, huge payoff).
- Local CAS skeleton with format-aware chunking for glTF (smallest format to
  start). Local-disk backend only.

**v2 — Unity gets serious, Blender starts**
- Unity scene / prefab semantic merge (replace SmartMerge).
- Unity `Library/` snapshot caching.
- Blender block-level diff (read-only).
- First cloud backend for the CAS (Needle Cloud or S3).

**v3 — research-grade and team scale**
- Blender block-level merge (non-overlapping auto, AI-assisted conflict).
- Cloud-side preview render service.
- Plugin SDK for community formats (USD, FBX, etc.).

**Never ship**:
- Full deterministic mesh merge for arbitrary edits. Punt to "pick a side"
  + AI.
- LFS configuration UI. The CAS supersedes it; if users insist on LFS, it's
  a fallback `BlobStore` impl, not a UI feature.

---

## Open questions

Binary-pillar questions only. Dashboard questions live in PLAN.md.

1. **Commits that include a chunked binary.** The pointer manifest is what
   git stores, but reviewers on GitHub won't see the binary. Probably: a
   bot / Action pulls the chunks and posts a comment with the diff link.
2. **CAS garbage collection.** When is a chunk safe to delete? Probably
   "reachable from any commit in any registered repo." Easy to compute,
   easy to get wrong — needs a careful retention policy.
3. **First binary format to invest in beyond glTF.** Unity `.meta` resolver
   is shallow but instantly valuable; Blender block-level diff is deeper
   but harder. Probably ship `.meta` resolver in v1 because payoff per line
   of code is unmatched.
4. **AI-assisted merge: where does the LLM run?** Local Claude session,
   hosted call, or per-user-choice? Probably per-user-choice with a default
   of "whichever Claude session is open in the same worktree."
5. **Plugin SDK for community formats: when?** Likely v3 — the format-
   provider interface needs to settle through real implementations first.
   Premature SDK = bad interface frozen too early.
6. **Chunking determinism.** A `.blend` save may reorder blocks; chunking
   must be stable under reorder or dedup falls apart. Investigate Blender's
   write path early.
