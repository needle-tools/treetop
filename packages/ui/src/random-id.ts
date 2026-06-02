/**
 * A v4 UUID that also works in NON-secure browsing contexts.
 *
 * `crypto.randomUUID()` is only defined in a secure context (HTTPS or
 * localhost). When the dashboard is opened over plain HTTP on a LAN IP
 * (or any non-localhost host) `crypto.randomUUID` is `undefined`, so a
 * bare call throws "crypto.randomUUID is not a function". `getRandomValues`
 * IS available in insecure contexts, so we build an RFC-4122 v4 from it.
 *
 * The result must be a real UUID: these ids become Claude's `--session-id`,
 * which rejects non-UUID values. `cryptoImpl` is injectable for testing.
 */
export function randomUUID(cryptoImpl: Crypto | undefined = globalThis.crypto): string {
  if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") {
    return cryptoImpl.randomUUID();
  }
  const b = new Uint8Array(16);
  if (cryptoImpl && typeof cryptoImpl.getRandomValues === "function") {
    cryptoImpl.getRandomValues(b);
  } else {
    // Last-ditch (no Web Crypto at all): Math.random is weak but still
    // yields a well-formed, collision-unlikely v4 for client-side ids.
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10xx
  const h: string[] = [];
  for (let i = 0; i < 16; i++) h.push(b[i]!.toString(16).padStart(2, "0"));
  return (
    `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-` +
    `${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`
  );
}
