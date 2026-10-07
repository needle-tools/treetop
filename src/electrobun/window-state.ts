export type WindowBounds = { x: number; y: number; width: number; height: number };
export type WindowState = WindowBounds & { fullscreen: boolean; maximized: boolean };

/** WebView2 creates its controller asynchronously. Restore native window mode
 * only once the inner view is ready to receive the resulting resize. */
export function restoreWindowModeOnReady(state: WindowState, window: {
  onReady: (callback: () => void) => void;
  maximize: () => void;
  setFullScreen: (enabled: boolean) => void;
}): void {
  if (!state.maximized && !state.fullscreen) return;
  let restored = false;
  window.onReady(() => {
    if (restored) return;
    restored = true;
    if (state.maximized) window.maximize();
    if (state.fullscreen) window.setFullScreen(true);
  });
}

function sane(bounds: WindowBounds): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width >= 400 && bounds.height >= 300 && bounds.x > -10000 && bounds.y > -10000;
}

export function restoreWindowState(value: unknown): WindowState {
  const bounds = value as WindowState | null;
  if (!bounds || !sane(bounds))
    return { x: 100, y: 100, width: 1400, height: 900, fullscreen: false, maximized: false };
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    fullscreen: bounds.fullscreen === true, maximized: bounds.maximized === true };
}

export function captureWindowState(previous: WindowState, bounds: WindowBounds,
  mode: { fullscreen: boolean; maximized: boolean; minimized: boolean }): WindowState {
  if (mode.minimized || !sane(bounds)) return previous;
  return { ...(mode.fullscreen || mode.maximized ? previous : bounds),
    fullscreen: mode.fullscreen, maximized: mode.maximized };
}
