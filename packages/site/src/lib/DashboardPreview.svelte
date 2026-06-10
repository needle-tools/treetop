<script lang="ts">
  // Faux sidebar + sticky-note canvas, echoing the real dashboard so the
  // landing page shows the product, not a generic screenshot frame. Swap
  // the inner mock for a real screenshot/<img> once one exists.
  const sidebar = [
    "Overview",
    "Worktrees",
    "Agents",
    "Sessions",
    "Notes",
    "Diffs",
    "Peers",
  ];
  const notes = [
    { t: "Untangle nodes", b: "Group the auth + billing worktrees under one thread." },
    { t: "Ship the canopy", b: "Land the hero, then wire the tour video." },
    { t: "Agent: research", b: "Summarise the three competitor dashboards." },
  ];
</script>

<section class="preview" id="tour">
  <div class="shell">
    <div class="window">
      <div class="titlebar">
        <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <span class="wintitle">Treetop</span>
      </div>
      <div class="body">
        <aside class="sidebar">
          {#each sidebar as item, i}
            <div class="nav-item" class:active={i === 1}>{item}</div>
          {/each}
        </aside>
        <div class="canvas">
          <button class="play" aria-label="Watch the tour">
            <svg viewBox="0 0 24 24" width="26" height="26">
              <circle cx="12" cy="12" r="11" fill="rgba(255,255,255,0.12)" />
              <path d="M10 8l6 4-6 4z" fill="#fff" />
            </svg>
          </button>
          {#each notes as note, i}
            <div class="note n{i}">
              <strong>{note.t}</strong>
              <span>{note.b}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
</section>

<style>
  .preview {
    padding: clamp(1.5rem, 5vw, 4rem) 0 clamp(3rem, 7vw, 5rem);
  }
  .window {
    background: var(--app-bg);
    border-radius: var(--radius-lg);
    box-shadow: 0 40px 90px -40px rgba(20, 36, 14, 0.7);
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.06);
  }
  .titlebar {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.7rem 1rem;
    background: #15150f;
  }
  .dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
  }
  .dot.r {
    background: #ff5f57;
  }
  .dot.y {
    background: #febc2e;
  }
  .dot.g {
    background: #28c840;
  }
  .wintitle {
    margin: 0 auto;
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.5);
    font-weight: 600;
  }

  .body {
    display: grid;
    grid-template-columns: 180px 1fr;
    min-height: 360px;
  }
  .sidebar {
    background: var(--app-surface);
    padding: 1rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    border-right: 1px solid rgba(255, 255, 255, 0.05);
  }
  .nav-item {
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    font-size: 0.85rem;
    color: rgba(255, 255, 255, 0.62);
  }
  .nav-item.active {
    background: color-mix(in srgb, var(--brand) 30%, transparent);
    color: #eafbe0;
  }

  .canvas {
    position: relative;
    background:
      radial-gradient(60% 60% at 30% 20%, rgba(96, 183, 76, 0.08), transparent),
      #1a1a1b;
    padding: 1.5rem;
  }
  .play {
    position: absolute;
    top: 1.2rem;
    right: 1.2rem;
    border: 0;
    background: transparent;
    color: #fff;
  }

  .note {
    position: absolute;
    width: 175px;
    padding: 0.85rem 0.9rem;
    border-radius: 4px 4px 10px 4px;
    background: var(--note-paper, #ffec80);
    color: #2a2516;
    box-shadow: 0 12px 24px -10px rgba(0, 0, 0, 0.6);
    transform: rotate(var(--rot));
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .note strong {
    font-size: 0.85rem;
  }
  .note span {
    font-size: 0.76rem;
    line-height: 1.35;
    opacity: 0.8;
  }
  .n0 {
    --rot: -3deg;
    top: 2rem;
    left: 2.5rem;
  }
  .n1 {
    --rot: 2deg;
    top: 7rem;
    left: 13rem;
    background: #d7e8a8;
  }
  .n2 {
    --rot: -1.5deg;
    top: 12rem;
    left: 5rem;
    background: #fbe7a0;
  }

  @media (max-width: 640px) {
    .note {
      display: none;
    }
  }
</style>
