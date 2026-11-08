/** Reads the page into flat primitives for the Reverse 3D blockout: boxes for controls, bars for text. */

export type Shape =
  | { kind: "strip" | "slab" | "block" | "well" | "screen" | "media" | "dashed"; x: number; y: number; w: number; h: number; depth: number; face: number }
  | { kind: "bar"; x: number; y: number; w: number; h: number; light: boolean };

const SLAB = ".card";
const STRIP = ".site-header";
const SCREEN = ".preview, .scene-dock";
const WELL = ".seg, .slot, .track, .slider input[type='range']";
const DASHED = ".upload";
const BLOCK = ".btn, button.run, .seg button.on, .icon, .pill, .chip, .mockpill, .big, .toast, .warn, .thumb, .brand-mark";
const MEDIA = "video, img, canvas.scene-orbit";
const ALL = [STRIP, SLAB, SCREEN, WELL, DASHED, BLOCK, MEDIA].join(", ");

function visible(el: Element): boolean {
  const check = (el as HTMLElement & { checkVisibility?: (o: object) => boolean }).checkVisibility;
  return check ? check.call(el, { opacityProperty: true, visibilityProperty: true }) : true;
}

function lightText(color: string): boolean {
  const m = color.match(/\d+(\.\d+)?/g);
  if (!m || m.length < 3) return false;
  const [r, g, b] = m.map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

/** Read the page into flat grey primitives: boxes for controls, bars for text. */
export function collectShapes(root: Element, vw: number, vh: number): Shape[] {
  const shapes: Shape[] = [];
  const onScreen = (r: DOMRect) => r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  for (const el of root.querySelectorAll(ALL)) {
    const r = el.getBoundingClientRect();
    if (!onScreen(r) || !visible(el)) continue;
    const base = { x: r.left, y: r.top, w: r.width, h: r.height };
    if (el.matches(STRIP)) shapes.push({ kind: "strip", ...base, depth: 0, face: 176 });
    else if (el.matches(SLAB)) shapes.push({ kind: "slab", ...base, depth: 10, face: 188 });
    else if (el.matches(SCREEN)) shapes.push({ kind: "screen", ...base, depth: 0, face: 92 });
    else if (el.matches(MEDIA)) shapes.push({ kind: "media", ...base, depth: 0, face: 112 });
    else if (el.matches(DASHED)) shapes.push({ kind: "dashed", ...base, depth: 0, face: 0 });
    else if (el.matches(WELL)) {
      if (el instanceof HTMLInputElement && el.type === "range") {
        const track = { x: r.left, y: r.top + r.height / 2 - 3, w: r.width, h: 6 };
        shapes.push({ kind: "well", ...track, depth: 0, face: 140 });
        const min = Number(el.min) || 0;
        const max = Number(el.max) || 100;
        const frac = max === min ? 0 : (Number(el.value) - min) / (max - min);
        const size = 18;
        shapes.push({ kind: "block", x: r.left + frac * (r.width - size), y: r.top + r.height / 2 - size / 2 - 2, w: size, h: size, depth: 4, face: 226 });
      } else {
        shapes.push({ kind: "well", ...base, depth: 0, face: 150 });
      }
    } else {
      const big = el.matches("button.run");
      shapes.push({ kind: "block", ...base, depth: big ? 7 : 5, face: big ? 232 : 220 });
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const tone = new Map<Element, boolean>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent || !node.textContent.trim()) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest("svg, select, option, .vp-hud")) continue;
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    if (!rects.length) continue;
    let light = tone.get(parent);
    if (light === undefined) {
      if (!visible(parent)) continue;
      light = lightText(getComputedStyle(parent).color);
      tone.set(parent, light);
    }
    for (const r of rects) {
      if (!onScreen(r) || r.width < 3) continue;
      shapes.push({ kind: "bar", x: r.left, y: r.top, w: r.width, h: r.height, light });
    }
  }
  return shapes;
}

/** Cheap stable pseudo-random from a position, so word lengths don't change between layouts. */
export function hash(a: number, b: number): number {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
