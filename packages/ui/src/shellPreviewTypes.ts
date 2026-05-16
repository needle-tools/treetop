/**
 * Shape passed into `ShellPreview.svelte`. Lives outside the
 * component because Svelte 5 disallows `export interface` from a
 * component's instance script — types belong in a plain TS module
 * so consumers can import them alongside the default component
 * export without tripping svelte-check.
 */
export interface ShellCmd {
  ts: string;
  line: string;
}
