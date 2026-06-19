<script lang="ts">
  import Nav from "./lib/Nav.svelte";
  import Hero from "./lib/Hero.svelte";
  import DashboardPreview from "./lib/DashboardPreview.svelte";
</script>

<div class="page">
  <Nav />
  <main>
    <Hero />
    <DashboardPreview />
  </main>
</div>

<style>
  /* The hero half is cream, fading toward the foliage at the canopy edge.
     The dashboard preview rides on its own dark band inside the section. */
  .page {
    min-height: 100vh;
    background:
      radial-gradient(
        120% 80% at 78% -5%,
        color-mix(in srgb, var(--leaf-soft) 55%, var(--cream)) 0%,
        transparent 55%
      ),
      var(--cream);
    overflow-x: clip;
  }
</style>
