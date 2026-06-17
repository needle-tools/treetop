/**
 * Reusable async confirm dialog. Replaces native `window.confirm()` so
 * the dashboard can render its own styled modal instead of the OS
 * sheet (which on macOS dims the dashboard for ~half a second and on
 * Linux drops out of the dark theme entirely).
 *
 * Usage:
 *
 *   const ok = await confirmDialog({
 *     title: "Remove the Coolify link?",
 *     message: "https://coolify.example.com/app/123",
 *     confirmLabel: "Remove",
 *     danger: true,
 *   });
 *   if (!ok) return;
 *
 * A single <ConfirmDialog /> instance must be mounted at the app root —
 * it subscribes to `activeConfirm` and renders whenever a request is
 * pending. Only one dialog is open at a time; concurrent calls queue
 * (latest call awaits until the earlier one resolves).
 */
import { writable, type Writable } from "svelte/store";

export interface ConfirmOptions {
  /** Primary heading. Required. */
  title: string;
  /** Optional secondary line — supports plain text, no markdown. Use
   *  to surface the specific resource being acted on (URL, path,
   *  branch name) so the user sees exactly what's about to change. */
  message?: string;
  /** Label on the confirming action. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label on the cancel action. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Style the confirm button as a destructive action (red wash). */
  danger?: boolean;
}

export interface ChoiceOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
  danger?: boolean;
  recommended?: boolean;
}

export interface ChoiceDialogOptions<T extends string = string> {
  /** Primary heading. Required. */
  title: string;
  /** Optional secondary line — supports plain text, no markdown. */
  message?: string;
  /** Smaller monospace detail line for paths or backend error text. */
  detail?: string;
  choices: ChoiceOption<T>[];
  /** Value returned for Esc / overlay dismissal. Defaults to null. */
  cancelValue?: T | null;
}

export interface ConfirmRequest extends ConfirmOptions {
  mode: "confirm";
  id: number;
  resolve: (ok: boolean) => void;
}

export interface ChoiceRequest extends ChoiceDialogOptions {
  mode: "choice";
  id: number;
  resolve: (value: string | null) => void;
}

export type ActiveConfirmRequest = ConfirmRequest | ChoiceRequest;

export const activeConfirm: Writable<ActiveConfirmRequest | null> =
  writable(null);

let nextId = 1;
let queue: Array<() => void> = [];
let busy = false;

/** Open a confirm dialog and resolve with the user's choice. Awaiting
 *  multiple in a row queues them; each one only renders once the
 *  previous resolves. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const run = () => {
      busy = true;
      activeConfirm.set({
        mode: "confirm",
        id: nextId++,
        ...opts,
        resolve: (ok) => {
          activeConfirm.set(null);
          busy = false;
          resolve(ok);
          const next = queue.shift();
          if (next) next();
        },
      });
    };
    if (busy) queue.push(run);
    else run();
  });
}

/** Open a shared dialog with explicit action choices. Resolves with the
 *  selected value, or `cancelValue` (default null) for Esc / overlay click. */
export function choiceDialog<T extends string>(
  opts: ChoiceDialogOptions<T>,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const run = () => {
      busy = true;
      activeConfirm.set({
        mode: "choice",
        id: nextId++,
        ...opts,
        resolve: (value) => {
          activeConfirm.set(null);
          busy = false;
          resolve((value ?? opts.cancelValue ?? null) as T | null);
          const next = queue.shift();
          if (next) next();
        },
      });
    };
    if (busy) queue.push(run);
    else run();
  });
}
