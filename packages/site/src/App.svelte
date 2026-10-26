<script lang="ts">
  const github = "https://github.com/needle-tools/treetop";
  const releases = `${github}/releases`;

  function reveal(node: HTMLElement) {
    node.classList.add("reveal-ready");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          node.classList.add("is-visible");
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.15 },
    );
    observer.observe(node);
    return {
      destroy() {
        observer.disconnect();
      },
    };
  }
</script>

{#snippet platforms()}
  <span class="platforms"
    >For <span
      ><svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="currentColor"
        aria-hidden="true"
        ><path
          d="M1 1h6.5v6.5H1zm7.5 0H15v6.5H8.5zM1 8.5h6.5V15H1zm7.5 0H15V15H8.5z"
        /></svg
      >Windows</span
    >
    and
    <span
      ><svg
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill="currentColor"
        aria-hidden="true"
        ><path
          d="M16.6 1c.1 1.4-.5 2.7-1.3 3.6-.9 1-2.1 1.6-3.4 1.5-.2-1.3.5-2.7 1.3-3.5C14.1 1.6 15.5 1 16.6 1ZM20.7 17c-.5 1.2-.8 1.7-1.4 2.7-.9 1.3-2.1 3-3.6 3-1.3 0-1.7-.9-3.4-.9s-2.2.9-3.4.9c-1.5 0-2.6-1.5-3.5-2.8C2.9 16.2 2.4 11.5 4 9c1.1-1.8 2.9-2.9 4.7-2.9 1.4 0 2.4.9 3.6.9 1.1 0 2-.9 3.6-.9 1.6 0 3.3.9 4.3 2.3-3.8 2.1-3.2 7.1.5 8.6Z"
        /></svg
      >macOS</span
    ></span
  >
{/snippet}

<svelte:head><meta name="theme-color" content="#f0f4ef" /></svelte:head>
<a class="skip" href="#main">Skip to content</a>
<div class="page">
  <header>
    <a class="brand" href="/" aria-label="Treetop home">Treetop</a>
    <nav aria-label="Main navigation">
      <a href={github}>GitHub</a><a href={releases}>Download</a>
    </nav>
  </header>
  <main id="main">
    <section class="hero" aria-labelledby="headline">
      <div class="intro">
        <h1 id="headline">A little perspective.<br />For a lot of agents.</h1>
        <p class="description">
          <span>Your AI coding sessions, repositories, and terminals.</span>
          <span>One workspace to keep it all in view.</span>
        </p>
        <div class="download">
          <a class="button" href={releases}
            >Download Treetop <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              aria-hidden="true"
              ><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5" /></svg
            ></a
          >
          {@render platforms()}
        </div>
      </div>
      <div class="identity">
        <img
          src="/logo.svg"
          width="320"
          height="320"
          alt="Treetop's three layered paper canopies"
        />
        <p>Room for every thread.</p>
      </div>
    </section>
    <section class="features" aria-label="What you can do with Treetop">
      <article use:reveal>
        <div class="feature-copy">
          <h2>Keep your bearings.</h2>
          <p>
            Follow Claude Code and Codex sessions side by side. See what's
            running and what needs your attention.
          </p>
        </div>
        <div class="feature-art sessions" aria-hidden="true"></div>
      </article>
      <article use:reveal>
        <div class="feature-copy">
          <h2>Stay close to the work.</h2>
          <p>
            Move between repos, worktrees, diffs, and persistent terminals
            without losing your place.
          </p>
        </div>
        <img
          class="worktree-illustration"
          src="/paper-worktrees.png"
          width="1254"
          height="1254"
          loading="lazy"
          alt="A paper repository card branching into feature/search and fix/login worktrees, each with its own changes and terminal status"
        />
      </article>
      <article use:reveal>
        <div class="feature-copy">
          <h2>Let your agents take part.</h2>
          <p>
            Control Treetop through MCP. Give your agents access to the
            workspace you use together.
          </p>
        </div>
        <div class="feature-art agents" aria-hidden="true"></div>
      </article>
    </section>
    <section class="closing" aria-labelledby="closing-title">
      <h2 id="closing-title">A place for your next project.</h2>
      <p>Local-first. Connect remote machines when you need them.</p>
      <div class="download">
        <a class="button" href={releases}
          >Download Treetop
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            aria-hidden="true"
            ><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5" /></svg
          >
        </a>
        {@render platforms()}
      </div>
    </section>
  </main>
  <footer>
    <a href={github}>Explore on GitHub</a>
    <a href="https://needle.tools">Made by Needle</a><span
      >&copy; {new Date().getFullYear()} Needle</span
    >
  </footer>
  <div
    class="closing-vista"
    role="img"
    aria-label="Sunlit treetops seen from just above the forest canopy"
  ></div>
</div>
