<script lang="ts">
  const links = ["Product", "Use cases", "Resources", "Pricing"];
</script>

<header class="nav">
  <div class="shell nav-row">
    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true">
        <!-- small sprouting-leaf glyph -->
        <svg viewBox="0 0 24 24" width="22" height="22">
          <path
            d="M12 22V11c0-3 2-6 8-7-1 5-4 8-8 8m0 1c-.5-2.5-2.5-4.5-6-5 .5 3 2.5 5 6 5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <span class="brand-word">treetop</span>
    </a>

    <nav class="links">
      {#each links as link}
        <a href="/#{link.toLowerCase().replace(' ', '-')}">{link}</a>
      {/each}
    </nav>

    <div class="actions">
      <a class="signin" href="/#signin">Sign in</a>
      <a class="btn btn-primary" href="/#get-started">Get started</a>
    </div>
  </div>
</header>

<style>
  .nav {
    position: sticky;
    top: 0;
    z-index: 20;
    padding: 0.85rem 0;
    backdrop-filter: saturate(1.1) blur(6px);
    background: color-mix(in srgb, var(--cream) 70%, transparent);
  }
  .nav-row {
    display: flex;
    align-items: center;
    gap: 2rem;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--forest-700);
  }
  .brand-word {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 1.3rem;
    letter-spacing: -0.01em;
  }

  .links {
    display: flex;
    gap: 1.6rem;
    margin: 0 auto;
    font-weight: 600;
    font-size: 0.92rem;
    color: var(--ink-2);
  }
  .links a:hover {
    color: var(--ink-1);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 1.1rem;
  }
  .signin {
    font-weight: 600;
    font-size: 0.92rem;
    color: var(--ink-2);
  }
  .signin:hover {
    color: var(--ink-1);
  }

  @media (max-width: 820px) {
    .links {
      display: none;
    }
  }
</style>
