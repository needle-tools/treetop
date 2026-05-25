import { writable } from "svelte/store";

export interface RepairRequest {
  source: string;
}

export const activeRepair = writable<RepairRequest | null>(null);

export function openRepair(source: string): void {
  activeRepair.set({ source });
}

export function closeRepair(): void {
  activeRepair.set(null);
}
