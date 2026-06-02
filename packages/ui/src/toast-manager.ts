/**
 * toast-manager.ts
 *
 * Pure, injected-dependency toast state machine extracted from App.svelte.
 * Production callers pass the real `setTimeout`/`clearTimeout` and the
 * `play` function from "./sound". Tests inject fakes so no real timers fire
 * and no DOM is needed.
 */

export interface Toast {
  id: number;
  kind: "error" | "info" | "success" | "invite" | "warning";
  message: string;
  title?: string;
  /** When set, the toast renders an agent brand mark (AgentIcon) instead
   *  of the default emoji glyph. Used by usage-warning toasts so the user
   *  instantly sees which provider is throttling. */
  agent?: string;
  /** Render the message line in italics — used for message previews
   *  (the quoted body of an incoming peer message). */
  messageItalic?: boolean;
  /** When set, clicking the toast body fires this callback (and also
   *  dismisses the toast). Used by the session-share invite toast to
   *  open the accept/decline dialog. */
  onClick?: () => void;
  /** When true, the toast does NOT auto-dismiss on a timer. The user
   *  has to click the body (which fires onClick) or the close button.
   *  Used for invite toasts that should persist until acted on. */
  persist?: boolean;
}

export type ToastKind = Toast["kind"];

export type AddToastOpts = {
  kind: ToastKind;
  message: string;
  title?: string;
  agent?: string;
  messageItalic?: boolean;
  ttlMs?: number;
  onClick?: () => void;
  persist?: boolean;
  silent?: boolean;
};

export interface ToastManagerDeps<H = ReturnType<typeof setTimeout>> {
  /** Called whenever the toast list changes (add or dismiss). */
  onChange: (toasts: Toast[]) => void;
  /** Play a named sound effect. Injected so tests can record calls. */
  play: (sound: string) => void;
  /** Schedule a deferred dismissal; defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => H;
  /** Cancel a scheduled dismissal; defaults to `clearTimeout`. */
  clear?: (handle: H) => void;
}

export interface ToastManager {
  /** Add a toast. Returns the new toast id, or -1 if message was empty. */
  addToast: (opts: AddToastOpts) => number;
  /** Dismiss a toast by id, clearing its auto-dismiss timer if any. */
  dismissToast: (id: number) => void;
  /** Return the current toast list snapshot. */
  toasts: () => Toast[];
}

// TTL constants — must match App.svelte exactly.
const TTL_ERROR = 12_000;
const TTL_WARNING = 10_000;
const TTL_DEFAULT = 7_000;

/**
 * Create a toast manager with injected dependencies.
 *
 * @example Production use:
 * ```ts
 * const { addToast, dismissToast } = createToastManager({
 *   onChange: (t) => (toasts = t),
 *   play,
 * });
 * ```
 */
export function createToastManager<H = ReturnType<typeof setTimeout>>(
  deps: ToastManagerDeps<H>,
): ToastManager {
  const {
    onChange,
    play,
    schedule = (fn, ms) => setTimeout(fn, ms) as unknown as H,
    clear = (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  } = deps;

  let toastList: Toast[] = [];
  let seq = 0;
  const timers = new Map<number, H>();

  function notify() {
    onChange(toastList);
  }

  function addToast(opts: AddToastOpts): number {
    if (!opts.message) return -1;

    const id = ++seq;
    toastList = [
      ...toastList,
      {
        id,
        kind: opts.kind,
        message: opts.message,
        title: opts.title,
        agent: opts.agent,
        messageItalic: opts.messageItalic,
        onClick: opts.onClick,
        persist: opts.persist,
      },
    ];
    notify();

    if (!opts.silent) {
      if (opts.kind === "error") play("error");
      else if (opts.kind === "invite") play("peer-session");
      else if (opts.kind === "warning") play("toast-warning");
    }

    if (!opts.persist) {
      const ttl =
        opts.ttlMs ??
        (opts.kind === "error"
          ? TTL_ERROR
          : opts.kind === "warning"
            ? TTL_WARNING
            : TTL_DEFAULT);
      timers.set(id, schedule(() => dismissToast(id), ttl));
    }

    return id;
  }

  function dismissToast(id: number): void {
    const h = timers.get(id);
    if (h !== undefined) {
      clear(h);
      timers.delete(id);
    }
    toastList = toastList.filter((x) => x.id !== id);
    notify();
  }

  function toasts(): Toast[] {
    return toastList;
  }

  return { addToast, dismissToast, toasts };
}
