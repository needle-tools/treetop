export function createCounter(initial = 0) {
  let count = $state(initial);
  const doubled = $derived(count * 2);
  const isPositive = $derived(count > 0);

  return {
    get count() { return count; },
    get doubled() { return doubled; },
    get isPositive() { return isPositive; },
    increment() { count++; },
    decrement() { count--; },
    reset() { count = initial; },
  };
}

export function trackEffect<T>(
  getter: () => T,
): { values: T[]; cleanup: () => void } {
  const values: T[] = [];
  const cleanup = $effect.root(() => {
    $effect(() => {
      values.push(getter());
    });
  });
  return { values, cleanup };
}
