import { leaves, rng, type VineShape } from "./vine-core";

const kinds = ["ivory", "bells", "fern", "monstera", "rose", "daisy", "poppy", "star", "clover", "tall", "branching", "cluster", "pear", "tree", "oak", "birch"] as const;
export type PlantKind = typeof kinds[number];
export const plantKind = (seed: number): PlantKind => {
  const r = rng((seed ^ 0x5be0cd19) >>> 0), choice = r();
  return choice < .83 ? kinds[Math.floor(r() * 9)]! : choice < .96 ? kinds[9 + Math.floor(r() * 4)]! : kinds[13 + Math.floor(r() * 3)]!;
};
export const isCactus = (kind: PlantKind) => kinds.indexOf(kind) >= 9;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
type Point = [number, number];
interface Bloom { x: number; y: number; bud: boolean }
export function botanicalFlowers(seed: number, length: number, height: number): Bloom[] {
  return flowerAnchors(seed, length, height).map(leaf => ({x: leaf.x + leaf.side * 10, y: leaf.y - 4, bud: length < (-leaf.y / height) + .08}));
}
function flowerAnchors(seed: number, length: number, height: number) {
  const random = rng((seed ^ 0x729ac31) >>> 0);
  let slot = 0;
  return leaves({seed, length}, height).filter((_, i) => {
    if (i % 9 === 0) slot = 3 + Math.floor(random() * 5);
    return i % 9 === slot;
  });
}
export function cactusSpines(x: number, y: number, rx: number, ry: number): string {
  let svg = "";
  for (const side of [-1, 1]) for (const t of [-.65, -.22, .25, .65]) {
    const px = x + side * rx * Math.sqrt(1-t*t), py = y + ry*t;
    svg += `<path d="M${px} ${py} l${side*3} ${t*3-1} M${px} ${py} l${side*2} ${t*3+1}" stroke="#c0bd94" stroke-width=".65" fill="none"/>`;
  }
  return svg;
}
export function cactusGeometry(seed: number, length: number, kind: PlantKind) {
  const random = rng(seed), maxHeight = 250 + random() * 90;
  const curve = (y: number) => Math.sin(y * .025 + seed) * 3;
  const stems: {points: Point[]; width: number}[] = [];
  const flowers: Bloom[] = [];
  const pads: {x: number; y: number; rx: number; ry: number; lean: number}[] = [];
  length = clamp(length);
  if (length === 0) return {stems, flowers, pads};
  if (kind === "pear") {
    for (let i = 0; i < 8; i++) {
      const g = clamp((length - i * .09) / .25);
      if (!g) continue;
      const parent = pads.at(-1), ry = 3 + g * 20;
      const lean = (random() - .5) * .28;
      const x = parent ? parent.x - parent.lean * parent.ry + Math.sin(i * 2) * parent.rx * .25 : 0;
      const bottom = parent ? parent.y - parent.ry + 5 : 0;
      const y = bottom - ry;
      pads.push({x, y, rx: 3 + g * 9, ry, lean});
      if (g > .9 && i % 3 === 1) flowers.push({x: x - lean * ry * 1.6 + (i % 2 ? 1 : -1) * (3 + g * 9) * .7, y: y - ry * .6, bud: false});
    }
  } else {
    const h = maxHeight * length;
    const points: Point[] = [[0, 0]];
    for (let y = 4; y < h; y += 4) points.push([curve(y), -y]);
    points.push([curve(h), -h]); stems.push({points, width: 13});
    const count = kind === "branching" || isTree(kind) ? 5 : 2;
    for (let i = 0; i < count; i++) {
      const g = clamp((length - .3 - i * .1) / .27), side = i % 2 ? 1 : -1;
      const y = 48 + i * 40, armHeight = 32 + random() * 42;
      if (!g) continue;
      const full: Point[] = [];
      for (let j = 0; j <= 40; j++) {
        const t = j / 40;
        full.push([curve(y) + side * 19 * Math.sin(Math.min(1, t * 2) * Math.PI / 2), -y - (t < .5 ? 12 * (1 - Math.cos(t * Math.PI)) : 12 + (t - .5) * 2 * armHeight)]);
      }
      const visible = full.slice(0, Math.max(2, Math.ceil(full.length * g)));
      stems.push({points: visible, width: 9});
      if (g > .85) { const tip = visible.at(-1)!; flowers.push({x: tip[0], y: tip[1] - 5, bud: g < .98}); }
    }
    if (kind === "cluster") for (let i = 0; i < 3; i++) {
      const g = clamp((length - .3 - i * .12) / .5);
      if (g) stems.push({points: [[(i - 1) * 17, 0], [(i - 1) * 17 + 2, -g * (65 + i * 25)]], width: 10});
    }
    if (length > .9) flowers.push({x: curve(h), y: -h - 6, bud: length < .98});
  }
  return {stems, flowers, pads};
}
function bloom(kind: PlantKind, b: Bloom): string {
  const color = kind === "poppy" ? "#bd796c" : kind === "star" ? "#9caad0" : kind === "bells" ? "#ac9ac2" : kind === "rose" || kind === "clover" || isCactus(kind) ? "#c18bA4" : "#d7d0a6";
  let shape = "";
  if (b.bud) shape = `<path d="M-2 3 Q-7 -7 0 -9 Q7 -5 2 3Z" fill="${color}"/>`;
  else if (kind === "bells") shape = `<path d="M0 -9 C-8 -8 -5 0 -9 5 Q-5 9 -2 5 Q2 10 5 5 Q9 8 9 4 C5 0 7 -8 0 -9Z" fill="${color}"/>`;
  else {
    const n = kind === "daisy" ? 10 : kind === "clover" ? 13 : kind === "poppy" ? 4 : 5;
    for (let i = 0; i < n; i++) shape += kind === "star" ? `<path d="M-3 0 Q-5 -6 0 -11 Q5 -6 3 0Z" fill="${color}" transform="rotate(${i * 360 / n})"/>` : `<ellipse cy="-4" rx="${kind === "daisy" ? 1.8 : 3.5}" ry="5" fill="${color}" transform="rotate(${i * 360 / n})"/>`;
    shape += `<circle r="2.5" fill="${kind === "poppy" ? "#443b36" : "#b19a58"}"/>`;
    if (kind === "rose") shape += '<path d="M-3 1 Q-5 -5 1 -4 Q6 -1 0 3" stroke="#925b70" fill="none"/>';
  }
  return `<g transform="translate(${b.x} ${b.y}) scale(.8)">${shape}</g>`;
}
export function botanicalMarkup(v: VineShape, height: number): string {
  const kind = plantKind(v.seed);
  if (!isCactus(kind)) {
    const anchors = flowerAnchors(v.seed, v.length, height);
    return botanicalFlowers(v.seed, v.length, height).map((b, i) => {
      const a = anchors[i]!;
      return `<path d="M${a.x} ${a.y} Q${b.x} ${a.y} ${b.x} ${b.y}" fill="none" stroke="#71874e" stroke-width="1"/>` + bloom(kind, b);
    }).join("");
  }
  const geometry = cactusGeometry(v.seed, v.length, kind);
  if (isTree(kind)) {
    const style = treeAppearance(kind);
    return geometry.stems.map(({points}, index) => {
      const random = rng((v.seed ^ (index * 7919) ^ 0x37a810) >>> 0);
      const d = points.map(([x,y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
      const thickness = treeTrunkWidth(v.seed, kind);
      let markup = index ? `<path d="${d}" fill="none" stroke="${style.bark}" stroke-width="${thickness * .4}" stroke-linecap="round" stroke-linejoin="round"/>` : "";
      if (!index) for (let i = 1; i < points.length; i++) {
        const [x,y] = points[i-1]!, [nx,ny] = points[i]!;
        const taper = Math.max(.45, 1 - Math.abs(y) / 550);
        markup += `<path d="M${x} ${y} L${nx} ${ny}" fill="none" stroke="${style.bark}" stroke-width="${thickness * taper}" stroke-linecap="round"/>`;
      }
      // Marks follow the fixed trunk points, so existing bark never stretches.
      if (!index) for (let i = 2; i < points.length - 1; i += style.spacing) {
        const [x,y] = points[i]!;
        const offset = (i % 3 - 1) * .7;
        const mark = kind === "birch"
          ? `M${x-2.6} ${y} l${2.3 + i % 2} -.5 M${x+1} ${y+2} l1.6 -.3`
          : kind === "oak"
            ? `M${x+offset-1} ${y+2} q-1 -2 0 -5 M${x+1.5} ${y-1} l-.3 -4`
            : `M${x-2} ${y} q2 -.8 3 -.3`;
        markup += `<path d="${mark}" fill="none" stroke="${style.mark}" stroke-width="${kind === "birch" ? 1 : .65}" stroke-linecap="round" opacity=".75"/>`;
        const side = i % 2 ? -1 : 1;
        const edge = thickness * Math.max(.45, 1 - Math.abs(y) / 550) / 2 - .4;
        markup += `<path d="M${x + side*edge} ${y+2} l${side * (kind === "oak" ? 1.5 : .8)} -1.5 l${-side*.5} -2" fill="none" stroke="${style.bark}" stroke-width="1.2" stroke-linejoin="round"/>`;
      }
      for (let i = index ? 8 : 12; i < points.length; i += index ? 5 : 14) {
        const [x,y] = points[i]!;
        for (const side of [-1, 1]) {
          const angle = side * (22 + random() * 75);
          const scale = .42 + random() * .36;
          const color = treeLeafColor(kind, random());
          markup += `<path d="${style.leaf}" fill="${color}" transform="translate(${x} ${y + (random()-.5)*4}) rotate(${angle}) scale(${scale})"/>`;
        }
      }
      return markup;
    }).join("");
  }
  let svg = "";
  for (const {points, width} of geometry.stems) {
    const d = points.map(([x,y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
    svg += `<path d="${d}" fill="none" stroke="#486f50" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="#7b9c69" stroke-width="1.2" transform="translate(-2 0)"/>`;
    for (let i = 3; i < points.length; i += 4) {const [x,y] = points[i]!; svg += `<path d="M${x-width/2} ${y} l-2 -1 M${x+width/2} ${y-3} l2 -1" stroke="#b7b58d" stroke-width=".6"/>`;}
  }
  for (const p of geometry.pads) {
    svg += `<g transform="matrix(1 0 ${p.lean} 1 ${-p.lean * (p.y + p.ry)} 0)">`;
    svg += `<ellipse cx="${p.x}" cy="${p.y}" rx="${p.rx}" ry="${p.ry}" fill="#527b54"/>`;
    for (let i = -1; i <= 1; i++) svg += `<path d="M${p.x+i*2} ${p.y-p.ry*.85} Q${p.x+i*p.rx} ${p.y} ${p.x+i*2} ${p.y+p.ry*.85}" fill="none" stroke="#89a371" stroke-width=".9"/>`;
    svg += cactusSpines(p.x, p.y, p.rx, p.ry);
    svg += `</g>`;
  }
  return svg + geometry.flowers.map(b => bloom(kind, b)).join("");
}
export const DEFAULT_LEAF_SHAPE = "M0 0 C -4.5 -4 -4.5 -11 0 -15 C 4.5 -11 4.5 -4 0 0 Z";
export function botanicalLeaves(v: VineShape, height: number) {
  const kind = plantKind(v.seed);
  const random = rng((v.seed ^ 0x381acf) >>> 0);
  return leaves(v, height, kind === "monstera" ? Math.max(1, Math.floor(height / 32)) : undefined).map(leaf => {
    const choice = random();
    return {
      ...leaf,
      scale: leaf.scale * (kind === "monstera" ? .55 + choice * .25 : 1),
      shape: kind === "monstera" && choice < .4 ? "M0 0 C-12 -4 -13 -19 -3 -21 C9 -23 12 -7 0 0Z" : leafShape(kind, DEFAULT_LEAF_SHAPE),
    };
  });
}
export function leafShape(kind: PlantKind, fallback: string): string {
  if (kind === "monstera") return "M0 0 C-17 -3 -18 -21 -7 -24 L-6 -15 L-3 -25 Q4 -29 8 -23 L3 -14 L11 -20 Q19 -9 0 0Z";
  if (kind === "fern") return "M0 0 L-6 -4 L-2 -5 L-8 -9 L-3 -10 L-8 -15 L-2 -15 L0 -23 L2 -15 L8 -15 L3 -10 L8 -9 L2 -5 L6 -4Z";
  if (kind === "daisy") return "M0 0 Q-4 -8 0 -21 Q4 -8 0 0Z";
  return fallback;
}

const isTree = (kind: PlantKind) => kind === "tree" || kind === "oak" || kind === "birch";
export function treeTrunkWidth(seed: number, kind: PlantKind) {
  const variation = rng((seed ^ 0x7ac159) >>> 0)();
  return (kind === "oak" ? 6 : kind === "birch" ? 4 : 5) + variation * 5;
}
export function treeLeafColor(kind: PlantKind, variation: number) {
  const palettes = kind === "birch" ? ["#768e4d", "#91a85e", "#a3b574", "#627b47"]
    : kind === "oak" ? ["#64763e", "#788c48", "#8c9b58", "#53683c"]
    : ["#697f46", "#829651", "#99a965", "#596f40"];
  return palettes[Math.min(3, Math.floor(Math.max(0, variation) * 4))]!;
}
export function treeAppearance(kind: PlantKind) {
  if (kind === "birch") return {bark: "#c9c7ac", mark: "#53574a", green: "#91a85e", spacing: 4, leaf: "M0 0 L-6 -7 L-4 -12 L0 -18 L5 -11 L6 -7Z"};
  if (kind === "oak") return {bark: "#78654d", mark: "#433e30", green: "#788c48", spacing: 2, leaf: "M0 0 C-5 -1 -7 -5 -3 -6 C-10 -8 -8 -12 -3 -11 C-8 -16 -4 -19 0 -21 C5 -18 7 -15 3 -12 C10 -12 9 -7 4 -6 C8 -3 4 -1 0 0Z"};
  return {bark: "#939588", mark: "#555e51", green: "#829651", spacing: 5, leaf: "M0 0 C-10 -5 -8 -15 0 -20 C9 -14 9 -5 0 0Z"};
}
