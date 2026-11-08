"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Size of one render bucket, in CSS pixels. */
const CELL = 24;
/** Canvas pixels per bucket in the mask. Keeps bucket edges crisp once the mask is scaled up. */
const MASK_SCALE = 4;
/** How far from the cursor buckets start rendering. */
const RADIUS = 104;
/** A bucket takes this long to render in once its turn comes. */
const RISE_MS = 140;
/** A rendered bucket stays rendered this long after the cursor leaves. */
const HOLD_MS = 700;
/** Then it fades back to the grey viewport over this long. */
const DECAY_MS = 1400;
/** Frames between mask uploads. 2 means roughly 30 updates per second. */
const MASK_EVERY = 2;

type Grid = {
  cols: number;
  rows: number;
  /** When each bucket starts rendering. 0 means never scheduled. */
  start: Float64Array;
  /** When the cursor last touched each bucket. */
  touched: Float64Array;
};

function makeGrid(width: number, height: number): Grid {
  const cols = Math.ceil(width / CELL) + 1;
  const rows = Math.ceil(height / CELL) + 1;
  return { cols, rows, start: new Float64Array(cols * rows), touched: new Float64Array(cols * rows) };
}

function heatAt(grid: Grid, index: number, now: number): number {
  const start = grid.start[index];
  if (!start || now < start) return 0;
  const rise = Math.min(1, (now - start) / RISE_MS);
  const idle = now - grid.touched[index] - HOLD_MS;
  const fall = idle <= 0 ? 1 : Math.max(0, 1 - idle / DECAY_MS);
  return rise * fall;
}

/**
 * A grey "viewport" filter over the whole page, with holes cut where the cursor has been.
 * Under a hole the page shows its real colours, so the UI looks rendered only where you point.
 */
function RenderReveal() {
  const veilRef = useRef<HTMLDivElement>(null);
  const bucketsRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const veil = veilRef.current;
    const buckets = bucketsRef.current;
    if (!veil || !buckets) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const small = document.createElement("canvas");
    const big = document.createElement("canvas");
    const smallCtx = small.getContext("2d");
    const bigCtx = big.getContext("2d");
    const bucketCtx = buckets.getContext("2d");
    if (!smallCtx || !bigCtx || !bucketCtx) return;

    let grid = makeGrid(window.innerWidth, window.innerHeight);
    let image = smallCtx.createImageData(grid.cols, grid.rows);
    let raf = 0;
    let frame = 0;
    let dpr = 1;

    const size = () => {
      grid = makeGrid(window.innerWidth, window.innerHeight);
      small.width = grid.cols;
      small.height = grid.rows;
      big.width = grid.cols * MASK_SCALE;
      big.height = grid.rows * MASK_SCALE;
      image = smallCtx.createImageData(grid.cols, grid.rows);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      buckets.width = Math.round(window.innerWidth * dpr);
      buckets.height = Math.round(window.innerHeight * dpr);
      veil.style.setProperty("--mask-w", `${grid.cols * CELL}px`);
      veil.style.setProperty("--mask-h", `${grid.rows * CELL}px`);
    };

    const setMask = (url: string) => {
      const value = url ? `url(${url})` : "none";
      veil.style.setProperty("mask-image", value);
      veil.style.setProperty("-webkit-mask-image", value);
    };

    /** Queue the buckets around a point. Nearer buckets render first, with a little jitter. */
    const touchCircle = (x: number, y: number, radius: number, now: number) => {
      const c0 = Math.max(0, Math.floor((x - radius) / CELL));
      const c1 = Math.min(grid.cols - 1, Math.floor((x + radius) / CELL));
      const r0 = Math.max(0, Math.floor((y - radius) / CELL));
      const r1 = Math.min(grid.rows - 1, Math.floor((y + radius) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const dx = (c + 0.5) * CELL - x;
          const dy = (r + 0.5) * CELL - y;
          const dist = Math.hypot(dx, dy);
          if (dist > radius) continue;
          const index = r * grid.cols + c;
          if (heatAt(grid, index, now) <= 0) {
            grid.start[index] = now + (reduce ? 0 : (dist / radius) * 90 + Math.random() * 70);
          }
          grid.touched[index] = Math.max(grid.start[index], now);
        }
      }
    };

    const touchRect = (rect: DOMRect, now: number) => {
      const pad = CELL;
      const c0 = Math.max(0, Math.floor((rect.left - pad) / CELL));
      const c1 = Math.min(grid.cols - 1, Math.floor((rect.right + pad) / CELL));
      const r0 = Math.max(0, Math.floor((rect.top - pad) / CELL));
      const r1 = Math.min(grid.rows - 1, Math.floor((rect.bottom + pad) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const index = r * grid.cols + c;
          if (heatAt(grid, index, now) <= 0) grid.start[index] = now + (reduce ? 0 : Math.random() * 120);
          grid.touched[index] = Math.max(grid.start[index], now);
        }
      }
    };

    const draw = (now: number) => {
      raf = 0;
      frame++;
      const data = image.data;
      let live = false;
      bucketCtx.clearRect(0, 0, buckets.width, buckets.height);
      if (!reduce) {
        bucketCtx.lineWidth = Math.max(1, dpr);
        bucketCtx.strokeStyle = "rgba(255, 255, 255, 0.95)";
        bucketCtx.shadowColor = "rgba(0, 0, 0, 0.45)";
        bucketCtx.shadowBlur = 2 * dpr;
        bucketCtx.beginPath();
      }
      for (let i = 0; i < grid.cols * grid.rows; i++) {
        const start = grid.start[i];
        const heat = heatAt(grid, i, now);
        if (start && (heat > 0 || now < start)) live = true;
        // Opaque mask shows the grey veil. A rendered bucket clears it.
        const p = i * 4;
        data[p] = 0;
        data[p + 1] = 0;
        data[p + 2] = 0;
        data[p + 3] = Math.round(255 * (1 - heat));
        // Bucket corners while a bucket is rendering, like a renderer working through tiles.
        if (!reduce && start && now >= start - 50 && now < start + RISE_MS + 40) {
          const x = (i % grid.cols) * CELL * dpr + 2 * dpr;
          const y = Math.floor(i / grid.cols) * CELL * dpr + 2 * dpr;
          const s = (CELL - 4) * dpr;
          const k = 5 * dpr;
          bucketCtx.moveTo(x, y + k);
          bucketCtx.lineTo(x, y);
          bucketCtx.lineTo(x + k, y);
          bucketCtx.moveTo(x + s - k, y);
          bucketCtx.lineTo(x + s, y);
          bucketCtx.lineTo(x + s, y + k);
          bucketCtx.moveTo(x + s, y + s - k);
          bucketCtx.lineTo(x + s, y + s);
          bucketCtx.lineTo(x + s - k, y + s);
          bucketCtx.moveTo(x + k, y + s);
          bucketCtx.lineTo(x, y + s);
          bucketCtx.lineTo(x, y + s - k);
        }
      }
      if (!reduce) bucketCtx.stroke();
      if (!live) {
        grid.start.fill(0);
        grid.touched.fill(0);
        setMask("");
        return;
      }
      if (frame % MASK_EVERY === 0) {
        smallCtx.putImageData(image, 0, 0);
        bigCtx.imageSmoothingEnabled = false;
        bigCtx.clearRect(0, 0, big.width, big.height);
        bigCtx.drawImage(small, 0, 0, big.width, big.height);
        setMask(big.toDataURL("image/png"));
      }
      raf = requestAnimationFrame(draw);
    };

    const wake = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const onMove = (event: PointerEvent) => {
      touchCircle(event.clientX, event.clientY, RADIUS, performance.now());
      wake();
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches(":focus-visible")) return;
      touchRect(target.getBoundingClientRect(), performance.now());
      wake();
    };
    const onResize = () => {
      size();
      wake();
    };

    size();
    if (!reduce) {
      // One diagonal render pass on load, so it's clear there is a finished version under the grey.
      const now = performance.now() + 350;
      for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
          const index = r * grid.cols + c;
          grid.start[index] = now + (c + r) * 14 + Math.random() * 40;
          grid.touched[index] = grid.start[index] + RISE_MS;
        }
      }
      wake();
    }

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onMove, { passive: true });
    window.addEventListener("focusin", onFocus);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onMove);
      window.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <>
      <div className="vp-veil" ref={veilRef} aria-hidden="true" />
      <canvas className="vp-buckets" ref={bucketsRef} aria-hidden="true" />
    </>
  );
}

function FrameCounter() {
  const [frame, setFrame] = useState(1);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t0 = performance.now();
    const id = window.setInterval(() => {
      setFrame(1 + (Math.floor(((performance.now() - t0) / 1000) * 24) % 240));
    }, 1000 / 24);
    return () => window.clearInterval(id);
  }, []);
  return <>{String(frame).padStart(4, "0")}</>;
}

function AxisGizmo() {
  return (
    <svg className="vp-axis" viewBox="0 0 64 64" aria-hidden="true">
      <line x1="20" y1="44" x2="48" y2="50" stroke="#e5484d" />
      <line x1="20" y1="44" x2="20" y2="14" stroke="#30a46c" />
      <line x1="20" y1="44" x2="8" y2="56" stroke="#3e63dd" />
      <text x="51" y="53" fill="#e5484d">X</text>
      <text x="16" y="10" fill="#30a46c">Y</text>
      <text x="1" y="63" fill="#3e63dd">Z</text>
    </svg>
  );
}

/** Fake viewport menu for the site header. Decoration only. */
export function ViewportMenu() {
  return (
    <div className="vp-menu" aria-hidden="true">
      {["View", "Shading", "Lighting", "Show", "Renderer", "Panels"].map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
}

/** Wraps a page so the whole UI reads as a 3D viewport that renders where the cursor goes. */
export function ViewportShell({ children }: { children: ReactNode }) {
  return (
    <div className="vp">
      <div className="vp-world" aria-hidden="true">
        <div className="vp-floor" />
      </div>
      {children}
      <div className="vp-hud" aria-hidden="true">
        <span className="vp-hud-br">
          Frame <b><FrameCounter /></b> · 24 fps
        </span>
        <AxisGizmo />
      </div>
      <RenderReveal />
    </div>
  );
}
