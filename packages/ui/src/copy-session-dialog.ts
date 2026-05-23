import { writable } from "svelte/store";

export interface CopySessionRequest {
  source: string;
}

export const activeCopy = writable<CopySessionRequest | null>(null);

export function openCopy(source: string): void {
  activeCopy.set({ source });
}

export function closeCopy(): void {
  activeCopy.set(null);
}
