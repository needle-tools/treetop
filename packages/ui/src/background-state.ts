import { writable } from "svelte/store";
import { apiUrl } from "./api";
export const backgroundStatus = writable<any>({ enabled: false });
export const backgroundRestorePending = writable(false);
export async function refreshBackgroundStatus(reconnect = false) {
  try {
    const response = await fetch(
      apiUrl(`/api/background/${reconnect ? "reconnect" : "status"}`),
      {
        method: reconnect ? "POST" : "GET",
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!response.ok) throw new Error(`Background status: ${response.status}`);
    const status = await response.json();
    backgroundStatus.set(status);
    // Each window must reconcile the canonical selection before ungating spawns,
    // including when another window already completed recovery.
    if (status.restore) backgroundRestorePending.set(true);
    return status;
  } catch (error) {
    console.warn("Background status unavailable", error);
    return undefined;
  }
}
