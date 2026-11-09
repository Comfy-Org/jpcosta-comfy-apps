/**
 * The Unrender page's wait screen: the page itself turns into grey clay, tile by tile, like a Cycles render
 * running backwards. Every element marked `data-b` is drawn as a block: "box" (buttons, pills), "t" (text, one bar
 * per line) or "img" (the shot, drawn as its grey playblast still). Tiles spiral out from the shot.
 * The page around the shot starts at once; the tiles over the shot wait for its still, then flip in one quick run.
 * No fades: a tile is either the styled page or the grey page, with render noise on the tiles being worked on.
 */

type Block =
  | { kind: "box"; x: number; y: number; w: number; h: number; r: number }
  | { kind: "t"; lines: { x: number; y: number; w: number; h: number }[] }
  | { kind: "img"; x: number; y: number; w: number; h: number; r: number };

export type UnrenderImages = { still: HTMLImageElement | null; frame: HTMLImageElement | null };

const PAGE = "#d5d7dc";
const BOX = "#b3b6bd";
const TEXT = "#a6a9b1";
const SHOT = "#bfc2c8";
const CORNER = "#ff8a2a";
/** How far a tile row eases toward the goal each frame, so a jump in progress still lands tile by tile. */
const CATCH_UP = 0.12;
/** The least a tile row moves per frame: about 20 frames per tile, so each tile can be seen resolving. */
const MIN_STEP = 0.05;
/**
 * A tile resolves once, in steps, like a progressive render: coarse pixels full of noise, finer and cleaner each
 * step, then the clean grey tile. Cells across the tile per step, and the share of cells still noise.
 */
const RESOLVE_CELLS = [3, 6, 12, 24];
const RESOLVE_NOISE = [0.75, 0.5, 0.28, 0.1];
/** The hover brush: cells this many times smaller than a render tile, un-rendered within RADIUS of the cursor. */
const HOVER_SPLIT = 4;
const HOVER_RADIUS = 0.45;
/** A brushed cell un-renders through the resolve steps in this long, stays clay, then flips back. */
const HOVER_RESOLVE_MS = 50;
const HOVER_HOLD_MS = 60;
/** Tiles per frame the shot flips at once its still is in. */
const SHOT_STEP = 0.4;

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Rings out from one tile, each ring walked around, so the page un-renders from the shot outwards. */
export function spiralFrom(cols: number, rows: number, cx: number, cy: number): number[] {
  const tiles: { index: number; ring: number; angle: number }[] = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const dx = x - cx;
      const dy = (y - cy) * 1.15;
      tiles.push({ index: y * cols + x, ring: Math.round(Math.hypot(dx, dy)), angle: Math.atan2(dy, dx) });
    }
  }
  tiles.sort((a, b) => a.ring - b.ring || a.angle - b.angle);
  return tiles.map((tile) => tile.index);
}

/** A small repeatable random stream, so a tile's noise only changes when its step does. */
function seeded(seed: number): () => number {
  let state = seed % 2147483647 || 1;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

/** One bar per rendered line of text, from the browser's own line boxes. */
function textLines(element: Element, baseX: number, baseY: number): { x: number; y: number; w: number; h: number }[] {
  const range = document.createRange();
  range.selectNodeContents(element);
  const rows: { x: number; y: number; r: number; b: number }[] = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width < 1 || rect.height < 1) continue;
    const row = rows.find((entry) => Math.abs(entry.y - rect.top) < rect.height * 0.5);
    if (row) {
      row.x = Math.min(row.x, rect.left);
      row.r = Math.max(row.r, rect.right);
      row.b = Math.max(row.b, rect.bottom);
    } else {
      rows.push({ x: rect.left, y: rect.top, r: rect.right, b: rect.bottom });
    }
  }
  range.detach();
  return rows.map((row) => {
    const h = row.b - row.y;
    return { x: row.x - baseX, y: row.y - baseY + h * 0.2, w: row.r - row.x, h: h * 0.6 };
  });
}

function measureBlocks(root: HTMLElement): Block[] {
  const base = root.getBoundingClientRect();
  const blocks: Block[] = [];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-b]"))) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const kind = element.dataset.b || "box";
    const x = rect.left - base.left;
    const y = rect.top - base.top;
    if (kind === "t") {
      const lines = textLines(element, base.left, base.top);
      if (lines.length) blocks.push({ kind: "t", lines });
      continue;
    }
    const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
    const r = Math.min(radius, rect.height / 2, rect.width / 2);
    blocks.push({ kind: kind === "img" ? "img" : "box", x, y, w: rect.width, h: rect.height, r });
  }
  return blocks;
}

function drawCover(ctx: CanvasRenderingContext2D, image: CanvasImageSource, iw: number, ih: number, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(image, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

export class PageUnrender {
  private canvas: HTMLCanvasElement;
  private root: HTMLElement;
  private grey = document.createElement("canvas");
  private scratch = document.createElement("canvas");
  private blocks: Block[] = [];
  /** Tiles clear of the shot, spiralling out from it. */
  private order: number[] = [];
  /** Tiles over the shot, which wait for its still. */
  private shotOrder: number[] = [];
  private shotShown = 0;
  private shotReady = false;
  private cols = 1;
  private rows = 1;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private shown = 0;
  private goal = 0;
  private images: UnrenderImages = { still: null, frame: null };
  private frame = 0;
  private dirty = true;
  private filled = false;
  private reduce = reducedMotion();
  private observer: ResizeObserver;
  /** The hover brush: on while the page is idle; cells under the cursor turn to clay for a moment. */
  private hoverOn = false;
  private pointer: { x: number; y: number } | null = null;
  private brushed = new Map<number, number>();
  /** Called once each time every tile is grey. */
  onFilled: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, root: HTMLElement) {
    this.canvas = canvas;
    this.root = root;
    this.observer = new ResizeObserver(() => {
      this.dirty = true;
    });
    this.observer.observe(root);
    root.addEventListener("pointermove", this.onPointer);
    root.addEventListener("pointerleave", this.onLeave);
    this.frame = requestAnimationFrame(this.tick);
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.root.removeEventListener("pointermove", this.onPointer);
    this.root.removeEventListener("pointerleave", this.onLeave);
  }

  /** The hover brush is on while the page waits for a shot; it never runs during a render. */
  setHover(on: boolean) {
    this.hoverOn = on;
    if (!on) this.brushed.clear();
  }

  private onPointer = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const box = this.root.getBoundingClientRect();
    this.pointer = { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  private onLeave = () => {
    this.pointer = null;
  };

  /** 0 is the styled page, 1 is all grey. */
  setGoal(goal: number) {
    const next = Math.min(1, Math.max(0, goal));
    if (next < 1) this.filled = false;
    this.goal = next;
  }

  /** The shot's still (or grey frame) is in: its tiles may flip. */
  setShotReady(ready: boolean) {
    if (!ready) this.filled = false;
    this.shotReady = ready;
  }

  setImages(images: UnrenderImages) {
    this.images = images;
    this.dirty = true;
  }

  /** The layout changed (a panel opened, the shot changed): read the blocks again. */
  remeasure() {
    this.dirty = true;
  }

  get covered(): boolean {
    return this.shown > 0.5;
  }

  private layout() {
    const box = this.root.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = box.width;
    this.height = box.height;
    const W = Math.max(1, Math.round(box.width * this.dpr));
    const H = Math.max(1, Math.round(box.height * this.dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    this.blocks = measureBlocks(this.root);
    const target = box.width < 640 ? 64 : 96;
    const cols = Math.max(5, Math.round(box.width / target));
    const tile = box.width / cols;
    const rows = Math.max(1, Math.ceil(box.height / tile));
    const shot = this.blocks.find((block) => block.kind === "img");
    const cx = shot && shot.kind === "img" ? Math.floor((shot.x + shot.w / 2) / tile) : (cols - 1) / 2;
    const cy = shot && shot.kind === "img" ? Math.floor((shot.y + shot.h / 2) / tile) : Math.min(rows - 1, 4);
    const over = (index: number) => {
      if (!shot || shot.kind !== "img") return false;
      const x = (index % cols) * tile;
      const y = Math.floor(index / cols) * tile;
      return x < shot.x + shot.w - 1 && x + tile > shot.x + 1 && y < shot.y + shot.h - 1 && y + tile > shot.y + 1;
    };
    const spiral = spiralFrom(cols, rows, cx, cy);
    const order = spiral.filter((index) => !over(index));
    const shotOrder = spiral.filter(over);
    if (order.join() !== this.order.join() || shotOrder.join() !== this.shotOrder.join()) {
      const ratio = this.order.length ? this.shown / this.order.length : 0;
      const shotRatio = this.shotOrder.length ? this.shotShown / this.shotOrder.length : 0;
      this.cols = cols;
      this.rows = rows;
      this.order = order;
      this.shotOrder = shotOrder;
      this.shown = ratio * order.length;
      this.shotShown = shotRatio * shotOrder.length;
    }
    this.paintGrey();
    this.dirty = false;
  }

  /** The whole grey page, painted once; tiles copy from it. */
  private paintGrey() {
    const { width, height, dpr } = this;
    this.grey.width = this.canvas.width;
    this.grey.height = this.canvas.height;
    const ctx = this.grey.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = PAGE;
    ctx.fillRect(0, 0, width, height);
    for (const block of this.blocks) {
      if (block.kind === "t") {
        ctx.fillStyle = TEXT;
        for (const line of block.lines) {
          ctx.beginPath();
          ctx.roundRect(line.x, line.y, line.w, line.h, Math.min(5, line.h / 2));
          ctx.fill();
        }
        continue;
      }
      if (block.kind === "box") {
        ctx.fillStyle = BOX;
        ctx.beginPath();
        ctx.roundRect(block.x, block.y, block.w, block.h, block.r);
        ctx.fill();
        continue;
      }
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(block.x, block.y, block.w, block.h, block.r);
      ctx.clip();
      ctx.fillStyle = SHOT;
      ctx.fillRect(block.x, block.y, block.w, block.h);
      const { still, frame } = this.images;
      if (still?.naturalWidth) {
        drawCover(ctx, still, still.naturalWidth, still.naturalHeight, block.x, block.y, block.w, block.h);
      } else if (frame?.naturalWidth) {
        ctx.filter = "grayscale(1) contrast(0.55) brightness(1.25) blur(3px)";
        drawCover(ctx, frame, frame.naturalWidth, frame.naturalHeight, block.x, block.y, block.w, block.h);
        ctx.filter = "none";
      }
      ctx.restore();
    }
  }

  private tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    if (this.dirty) this.layout();
    this.brush(now);
    const total = this.order.length;
    const goal = this.goal * total;
    const gap = goal - this.shown;
    if (this.reduce || Math.abs(gap) < 0.02) this.shown = goal;
    else this.shown += Math.sign(gap) * Math.min(Math.abs(gap), Math.max(MIN_STEP, Math.abs(gap) * CATCH_UP));
    // The shot flips in one quick run once its still is in, and back out with the page.
    const shotTotal = this.shotOrder.length;
    const shotGoal = this.shotReady && this.goal > 0 ? shotTotal : 0;
    const shotGap = shotGoal - this.shotShown;
    if (this.reduce || Math.abs(shotGap) < 0.02) this.shotShown = shotGoal;
    else this.shotShown += Math.sign(shotGap) * Math.min(Math.abs(shotGap), Math.max(SHOT_STEP, Math.abs(shotGap) * CATCH_UP));
    this.draw(now);
    if (!this.filled && this.goal === 1 && this.shown >= total && this.shotShown >= shotTotal) {
      this.filled = true;
      this.onFilled?.();
    }
  };

  /** Marks the hover cells near the cursor, away from the shot (its slider stays usable). */
  private brush(now: number) {
    if (!this.hoverOn || this.goal > 0 || this.shown > 0.01 || !this.pointer) return;
    const cell = this.width / this.cols / HOVER_SPLIT;
    const cols = this.cols * HOVER_SPLIT;
    const rows = Math.ceil(this.height / cell);
    const shot = this.blocks.find((block) => block.kind === "img");
    const reach = cell * HOVER_SPLIT * HOVER_RADIUS;
    const { x, y } = this.pointer;
    const c0 = Math.max(0, Math.floor((x - reach) / cell));
    const c1 = Math.min(cols - 1, Math.floor((x + reach) / cell));
    const r0 = Math.max(0, Math.floor((y - reach) / cell));
    const r1 = Math.min(rows - 1, Math.floor((y + reach) / cell));
    for (let row = r0; row <= r1; row += 1) {
      for (let col = c0; col <= c1; col += 1) {
        const cx = (col + 0.5) * cell;
        const cy = (row + 0.5) * cell;
        if (Math.hypot(cx - x, cy - y) > reach) continue;
        if (shot && shot.kind === "img" && cx > shot.x && cx < shot.x + shot.w && cy > shot.y && cy < shot.y + shot.h) continue;
        const index = row * cols + col;
        const since = this.brushed.get(index);
        // A cell still clay keeps its start, so it does not un-render again while the cursor sits on it.
        if (since === undefined || now - since > HOVER_RESOLVE_MS + HOVER_HOLD_MS) this.brushed.set(index, now);
        else if (now - since > HOVER_RESOLVE_MS) this.brushed.set(index, now - HOVER_RESOLVE_MS);
      }
    }
  }

  private drawBrush(ctx: CanvasRenderingContext2D, now: number) {
    if (!this.brushed.size) return;
    const cell = (this.width / this.cols / HOVER_SPLIT) * this.dpr;
    const cols = this.cols * HOVER_SPLIT;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const [index, since] of this.brushed) {
      const age = now - since;
      if (age > HOVER_RESOLVE_MS + HOVER_HOLD_MS) {
        this.brushed.delete(index);
        continue;
      }
      const sx = Math.floor((index % cols) * cell);
      const sy = Math.floor(Math.floor(index / cols) * cell);
      const size = Math.ceil(cell) + 1;
      if (age < HOVER_RESOLVE_MS && !this.reduce) this.resolveRect(ctx, sx, sy, size, index + 7, age / HOVER_RESOLVE_MS);
      else ctx.drawImage(this.grey, sx, sy, size, size, sx, sy, size, size);
    }
  }

  private draw(now: number) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const { dpr, cols } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const total = this.order.length;
    const done = Math.min(total, Math.floor(this.shown + 1e-6));
    const shotTotal = this.shotOrder.length;
    const shotDone = Math.min(shotTotal, Math.floor(this.shotShown + 1e-6));
    if (done === 0 && shotDone === 0 && this.goal === 0) {
      this.drawBrush(ctx, now);
      return;
    }
    this.brushed.clear();
    const tile = this.width / cols;
    const px = tile * dpr;
    const copy = (index: number) => {
      const sx = Math.floor((index % cols) * px);
      const sy = Math.floor(Math.floor(index / cols) * px);
      const sw = Math.ceil(px) + 1;
      ctx.drawImage(this.grey, sx, sy, sw, sw, sx, sy, sw, sw);
    };
    for (let k = 0; k < done; k += 1) copy(this.order[k]);
    for (let k = 0; k < shotDone; k += 1) copy(this.shotOrder[k]);
    if (this.goal === 0) return;
    // One tile at a time is "rendering": it resolves from coarse noisy pixels to the clean grey tile, with
    // orange corners like Cycles. Then the next one starts.
    const active: { index: number; share: number }[] = [];
    if (done < total) active.push({ index: this.order[done], share: this.shown - done });
    if (this.shotReady && shotDone < shotTotal) active.push({ index: this.shotOrder[shotDone], share: this.shotShown - shotDone });
    if (!active.length) return;
    for (const { index, share } of active) this.resolve(ctx, index, px, share);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2;
    ctx.strokeStyle = CORNER;
    for (const { index } of active) {
      const x = (index % cols) * tile;
      const y = Math.floor(index / cols) * tile;
      const c = Math.min(14, tile / 4);
      ctx.beginPath();
      for (const [ax, ay, dx, dy] of [
        [x + 1, y + 1, 1, 1],
        [x + tile - 1, y + 1, -1, 1],
        [x + 1, y + tile - 1, 1, -1],
        [x + tile - 1, y + tile - 1, -1, -1],
      ]) {
        ctx.moveTo(ax + dx * c, ay);
        ctx.lineTo(ax, ay);
        ctx.lineTo(ax, ay + dy * c);
      }
      ctx.stroke();
    }
  }

  /** Draws one tile partway resolved: `share` 0 is the coarsest, noisiest step, near 1 the finest. */
  private resolve(ctx: CanvasRenderingContext2D, index: number, px: number, share: number) {
    const sx = Math.floor((index % this.cols) * px);
    const sy = Math.floor(Math.floor(index / this.cols) * px);
    this.resolveRect(ctx, sx, sy, Math.ceil(px) + 1, index, share);
  }

  /** The same, for any square in device pixels; `seed` keeps its noise steady within a step. */
  private resolveRect(ctx: CanvasRenderingContext2D, sx: number, sy: number, size: number, seed: number, share: number) {
    const step = this.reduce ? RESOLVE_CELLS.length - 1 : Math.min(RESOLVE_CELLS.length - 1, Math.max(0, Math.floor(share * RESOLVE_CELLS.length)));
    const cells = RESOLVE_CELLS[step];
    const scratch = this.scratch;
    if (scratch.width !== cells) {
      scratch.width = cells;
      scratch.height = cells;
    }
    const small = scratch.getContext("2d");
    if (!small) return;
    small.imageSmoothingEnabled = true;
    small.drawImage(this.grey, sx, sy, size, size, 0, 0, cells, cells);
    const random = seeded(seed * 7919 + step * 104729 + 17);
    for (let cell = 0; cell < cells * cells; cell += 1) {
      if (random() >= RESOLVE_NOISE[step]) continue;
      const base = 70 + random() * 150;
      const r = Math.round(base + (random() - 0.5) * 80);
      const g = Math.round(base + (random() - 0.5) * 80);
      const b = Math.round(base + (random() - 0.5) * 80);
      small.fillStyle = `rgb(${r},${g},${b})`;
      small.fillRect(cell % cells, Math.floor(cell / cells), 1, 1);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, 0, 0, cells, cells, sx, sy, size, size);
    ctx.imageSmoothingEnabled = true;
  }
}
