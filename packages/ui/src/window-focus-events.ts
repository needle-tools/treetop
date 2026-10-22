export const NATIVE_WINDOW_FOCUS_EVENT = "treetop:native-window-focus";

export function nativeWindowFocusScript(focused: boolean): string {
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify(NATIVE_WINDOW_FOCUS_EVENT)}, { detail: { focused: ${focused} } }));`;
}
