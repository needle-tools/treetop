/**
 * Scans PTY output for §play-sound:TAG§ markers, strips them from
 * the byte stream, and returns extracted tags. Handles markers that
 * span chunk boundaries via a per-terminal residual buffer.
 */

const MARKER_RE = /§play-sound:([\w-]+)§/g;
const MARKER_BYTES = new TextEncoder().encode("§");
const SECTION_SIGN = MARKER_BYTES[0]!; // 0xC2 (first byte of UTF-8 §)

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

export interface ScanResult {
  output: Uint8Array;
  tags: string[];
}

const DEFAULT_GRACE_MS = 5000;

export class SoundMarkerScanner {
  private residual = "";
  private scanEnabledAt: number;

  constructor(graceMs: number = DEFAULT_GRACE_MS) {
    this.scanEnabledAt = Date.now() + graceMs;
  }

  scan(chunk: Uint8Array): ScanResult {
    if (Date.now() < this.scanEnabledAt) {
      return { output: chunk, tags: [] };
    }
    const text = this.residual + decoder.decode(chunk);
    this.residual = "";

    if (!text.includes("§")) {
      return { output: chunk, tags: [] };
    }

    // If the chunk ends mid-marker, buffer the tail.
    const lastSection = text.lastIndexOf("§");
    const afterLast = text.slice(lastSection);
    if (afterLast.length > 0 && !afterLast.endsWith("§")) {
      // Might be a partial marker — hold it back
      const prefix = "§play-sound:";
      if (prefix.startsWith(afterLast) || afterLast.startsWith(prefix.slice(0, afterLast.length))) {
        this.residual = afterLast;
        const before = text.slice(0, lastSection);
        return this.extract(before);
      }
    }

    return this.extract(text);
  }

  /** Flush any buffered residual (e.g. on terminal exit). */
  flush(): ScanResult {
    if (!this.residual) return { output: new Uint8Array(0), tags: [] };
    const text = this.residual;
    this.residual = "";
    return this.extract(text);
  }

  private extract(text: string): ScanResult {
    const tags: string[] = [];
    const cleaned = text.replace(MARKER_RE, (_match, tag: string) => {
      tags.push(tag);
      return "";
    });
    // Strip blank lines left behind by removed markers
    const output = cleaned.replace(/^\s*\n/gm, (line, offset) => {
      // Only strip if this blank line was at a marker position
      return tags.length > 0 ? "" : line;
    });
    return {
      output: encoder.encode(output),
      tags,
    };
  }
}
