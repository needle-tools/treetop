<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher, tick } from "svelte";
  import { WALKTHROUGH_STEPS } from "./onboarding-walkthrough";

  export let wtPath: string;
  export let currentStep: number;

  const dispatch = createEventDispatcher<{ next: void; skip: void }>();
  const total = WALKTHROUGH_STEPS.length;

  let highlightEl: HTMLDivElement | null = null;
  let tooltipEl: HTMLDivElement | null = null;
  let targetMissing = false;
  let textVisible = false;
  let transitioning = false;
  let displayedStep = currentStep;
  let typedText = "";
  let typeTimer: ReturnType<typeof setTimeout> | null = null;
  let showEmoji = false;

  function stopTyping() {
    if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
  }

  function typeOut(full: string): Promise<void> {
    stopTyping();
    typedText = "";
    return new Promise<void>((resolve) => {
      let i = 0;
      function tick_() {
        if (i >= full.length) { resolve(); return; }
        typedText = full.slice(0, ++i);
        typeTimer = setTimeout(tick_, 9);
      }
      tick_();
    });
  }

  function getTarget() {
    const step = WALKTHROUGH_STEPS[currentStep];
    if (!step) return null;
    const el = step.target(wtPath);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return el;
  }

  function positionHighlight(r: DOMRect) {
    if (!highlightEl) return;
    const pad = 4;
    highlightEl.style.top = `${r.top - pad}px`;
    highlightEl.style.left = `${r.left - pad}px`;
    highlightEl.style.width = `${r.width + pad * 2}px`;
    highlightEl.style.height = `${r.height + pad * 2}px`;
    highlightEl.classList.remove("walkthrough-hidden");
  }

  function positionTooltip(r: DOMRect) {
    if (!tooltipEl) return;
    const step = WALKTHROUGH_STEPS[displayedStep];
    const gap = 12;
    tooltipEl.style.opacity = "1";
    tooltipEl.style.transform = "none";
    tooltipEl.classList.remove("walkthrough-hidden");

    // let the browser lay out so we can measure
    const ttRect = tooltipEl.getBoundingClientRect();

    if (step?.placement === "top") {
      tooltipEl.style.top = `${r.top - gap - ttRect.height}px`;
    } else {
      tooltipEl.style.top = `${r.bottom + gap}px`;
    }

    let left = r.left + r.width / 2 - ttRect.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - ttRect.width - 8));
    tooltipEl.style.left = `${left}px`;
  }

  function wait(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  async function animateEntrance() {
    const el = getTarget();
    if (!el) {
      targetMissing = true;
      textVisible = true;
      displayedStep = currentStep;
      return;
    }
    targetMissing = false;
    transitioning = true;

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await wait(350);

    const r = el.getBoundingClientRect();

    // 1. fly highlight to target
    positionHighlight(r);
    await wait(300);

    // 2. show tooltip box (scale up)
    displayedStep = currentStep;
    typedText = "";
    showEmoji = false;
    textVisible = true;
    await tick();
    if (tooltipEl) {
      tooltipEl.classList.remove("walkthrough-hidden");
      tooltipEl.style.opacity = "0";
      tooltipEl.style.transform = "scale(0.92)";
      positionTooltip(r);
      tooltipEl.style.opacity = "0";
      tooltipEl.style.transform = "scale(0.92)";
    }
    await tick();
    await wait(30);
    if (tooltipEl) {
      tooltipEl.style.opacity = "1";
      tooltipEl.style.transform = "scale(1)";
    }
    await wait(200);

    // 3. typewrite the text, then pop emoji
    const step = WALKTHROUGH_STEPS[displayedStep];
    if (step) await typeOut(step.message);
    showEmoji = true;
    transitioning = false;
  }

  async function animateTransition() {
    transitioning = true;
    stopTyping();
    showEmoji = false;

    // 1. fade out text (tooltip box stays visible)
    textVisible = false;
    await wait(200);

    // 2. fly highlight + tooltip to new target
    const el = getTarget();
    if (!el) {
      targetMissing = true;
      textVisible = true;
      displayedStep = currentStep;
      transitioning = false;
      return;
    }
    targetMissing = false;

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await wait(350);

    const r = el.getBoundingClientRect();
    positionHighlight(r);
    displayedStep = currentStep;
    typedText = "";
    textVisible = true;
    await tick();
    positionTooltip(r);
    await wait(350);

    // 3. typewrite the new text, then pop emoji
    const step = WALKTHROUGH_STEPS[displayedStep];
    if (step) await typeOut(step.message);
    showEmoji = true;
    transitioning = false;
  }

  function onScrollResize() {
    if (transitioning) return;
    const el = getTarget();
    if (!el) return;
    const r = el.getBoundingClientRect();
    positionHighlight(r);
    positionTooltip(r);
  }

  let mounted = false;

  onMount(() => {
    document.body.appendChild(highlightEl!);
    document.body.appendChild(tooltipEl!);
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    mounted = true;
    void animateEntrance();
  });

  onDestroy(() => {
    stopTyping();
    window.removeEventListener("scroll", onScrollResize, true);
    window.removeEventListener("resize", onScrollResize);
    highlightEl?.remove();
    tooltipEl?.remove();
  });

  let prevStep = currentStep;
  $: if (mounted && currentStep !== prevStep) {
    prevStep = currentStep;
    void animateTransition();
  }
</script>

<div class="walkthrough-highlight walkthrough-hidden" bind:this={highlightEl}></div>

<div class="walkthrough-tooltip walkthrough-hidden" bind:this={tooltipEl}>
  <div class="walkthrough-msg" class:walkthrough-text-visible={textVisible}>
    {#if targetMissing}
      Unfold the row to continue the tour.
    {:else}
      {typedText}{#if showEmoji} <span
        class="walkthrough-emoji walkthrough-emoji-enter walkthrough-emoji-{WALKTHROUGH_STEPS[displayedStep]?.emojiAnim ?? 'bounce'}"
      >{WALKTHROUGH_STEPS[displayedStep]?.emoji ?? ""}</span>{/if}
    {/if}
  </div>
  <div class="walkthrough-tooltip-footer" class:walkthrough-text-visible={textVisible}>
    {#if displayedStep < total - 1}
      <button class="walkthrough-btn-skip" on:click={() => dispatch("skip")}
              disabled={transitioning}>
        Skip
      </button>
    {:else}
      <span></span>
    {/if}
    <span class="walkthrough-step-indicator">
      {displayedStep + 1} of {total}
    </span>
    <button class="walkthrough-btn-next" on:click={() => dispatch("next")}
            disabled={targetMissing || transitioning}>
      {displayedStep >= total - 1 ? "Finish" : "Next"}
    </button>
  </div>
</div>
