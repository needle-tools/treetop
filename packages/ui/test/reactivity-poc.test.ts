import { test, expect, describe } from "bun:test";
import { flush } from "svelte/internal/client";
import { createCounter, trackEffect } from "./reactivity-poc.svelte.ts";

describe("svelte 5 runes — DOM-free reactivity", () => {
  test("$state: reads initial value", () => {
    const c = createCounter(5);
    expect(c.count).toBe(5);
  });

  test("$state: mutation updates value", () => {
    const c = createCounter();
    c.increment();
    expect(c.count).toBe(1);
  });

  test("$derived: recomputes on state change", () => {
    const c = createCounter(3);
    expect(c.doubled).toBe(6);
    c.increment();
    expect(c.doubled).toBe(8);
  });

  test("$derived: boolean derived tracks correctly", () => {
    const c = createCounter(0);
    expect(c.isPositive).toBe(false);
    c.increment();
    expect(c.isPositive).toBe(true);
    c.decrement();
    expect(c.isPositive).toBe(false);
  });

  test("reset returns to initial value", () => {
    const c = createCounter(10);
    c.increment();
    c.increment();
    expect(c.count).toBe(12);
    c.reset();
    expect(c.count).toBe(10);
    expect(c.doubled).toBe(20);
  });

  test("$effect.root: tracks side effects without DOM", () => {
    const c = createCounter();
    const { values, cleanup } = trackEffect(() => c.count);

    flush();
    expect(values).toEqual([0]);

    c.increment();
    flush();
    expect(values).toEqual([0, 1]);

    c.increment();
    c.increment();
    flush();
    expect(values).toEqual([0, 1, 3]);

    cleanup();
  });
});
