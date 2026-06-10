<script lang="ts">
  import CanopyScene from "./CanopyScene.svelte";
</script>

<section class="hero shell">
  <div class="copy">
    <p class="eyebrow">For explorers and wayfarers</p>
    <h1 class="title">Treetop</h1>
    <p class="lede">
      The agent orchestration for your notes, projects, and AI agents.
    </p>
    <p class="sub">
      From above the canopy, coordinate every agent, untangle every node, and
      keep every thread connected to one living workspace.
    </p>

    <div class="cta">
      <a class="btn btn-primary" href="/#get-started">Get started</a>
      <a class="btn btn-ghost" href="/#tour">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor" />
        </svg>
        Watch the tour
      </a>
    </div>
  </div>

  <div class="art">
    <CanopyScene />
  </div>
</section>

<style>
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
    align-items: center;
    gap: clamp(1.5rem, 4vw, 3.5rem);
    padding-top: clamp(2rem, 6vw, 4.5rem);
    padding-bottom: clamp(2rem, 5vw, 4rem);
  }

  .eyebrow {
    font-family: var(--font-display);
    font-style: italic;
    font-size: 1.05rem;
    color: var(--forest-500);
    margin: 0 0 0.4rem;
  }
  .title {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: clamp(3.5rem, 9vw, 6.5rem);
    line-height: 0.95;
    letter-spacing: -0.02em;
    color: var(--forest-900);
    margin: 0 0 1.1rem;
  }
  .lede {
    font-size: clamp(1.05rem, 1.6vw, 1.35rem);
    font-weight: 600;
    color: var(--ink-1);
    margin: 0 0 0.8rem;
    max-width: 30ch;
  }
  .sub {
    font-size: 1.02rem;
    line-height: 1.55;
    color: var(--ink-3);
    margin: 0 0 1.8rem;
    max-width: 42ch;
  }

  .cta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.8rem;
  }

  .art {
    position: relative;
  }

  @media (max-width: 880px) {
    .hero {
      grid-template-columns: 1fr;
    }
    .art {
      order: -1;
    }
  }
</style>
