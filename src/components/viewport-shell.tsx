"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Blockout as Blockout3D } from "@/components/blockout-three";
import { collectShapes } from "@/lib/blockout-shapes";

/** Size of one render bucket, in CSS pixels. */
const CELL = 24;
/** How far from the cursor buckets start rendering. */
const RADIUS = 110;
/** A bucket takes this long to render in once its turn comes. */
const RISE_MS = 140;
/** A rendered bucket stays rendered this long after the cursor leaves. */
const HOLD_MS = 800;
/** Then it fades back to the blockout over this long. */
const DECAY_MS = 1400;

type Grid = {
  cols: number;
  rows: number;
  /** When each bucket starts rendering. 0 means never scheduled. */
  start: Float64Array;
  /** When the cursor last touched each bucket. Infinity keeps it rendered. */
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
 * A clay blockout of the whole page, rendered in 3D over it: boxes for every control, bars for every line of text.
 * Render buckets erase it wherever the cursor has been, and the real UI shows through.
 */
function Blockout() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bucketsRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const buckets = bucketsRef.current;
    const root = document.querySelector(".vp .app");
    const bctx = buckets?.getContext("2d");
    if (!canvas || !buckets || !root || !bctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // With no cursor to point with, the page renders once on load and stays rendered.
    const touchOnly = !window.matchMedia("(hover: hover)").matches;
    const hide = () => {
      canvas.style.display = "none";
      buckets.style.display = "none";
    };
    if (touchOnly && reduce) {
      hide();
      return;
    }

    let vw = window.innerWidth;
    let vh = window.innerHeight;
    let dpr = 1;
    let grid = makeGrid(vw, vh);
    let heat = new Uint8Array(grid.cols * grid.rows);
    let scene: Blockout3D | null = null;
    let layoutDirty = true;
    let sizeDirty = true;
    let raf = 0;
    let done = false;
    let disposed = false;

    const schedule = (cell: number, at: number, until: number) => {
      grid.start[cell] = at;
      grid.touched[cell] = until;
    };

    /** Queue the buckets around a point. Nearer buckets render first, with a little jitter. */
    const touchCircle = (x: number, y: number, now: number) => {
      const c0 = Math.max(0, Math.floor((x - RADIUS) / CELL));
      const c1 = Math.min(grid.cols - 1, Math.floor((x + RADIUS) / CELL));
      const r0 = Math.max(0, Math.floor((y - RADIUS) / CELL));
      const r1 = Math.min(grid.rows - 1, Math.floor((y + RADIUS) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const dist = Math.hypot((c + 0.5) * CELL - x, (r + 0.5) * CELL - y);
          if (dist > RADIUS) continue;
          const i = r * grid.cols + c;
          const queued = heatAt(grid, i, now) > 0 || grid.start[i] > now;
          const start = queued ? grid.start[i] : now + (reduce ? 0 : (dist / RADIUS) * 90 + Math.random() * 70);
          schedule(i, start, Math.max(start, now, grid.touched[i]));
        }
      }
    };

    const touchRect = (rect: DOMRect, now: number) => {
      const c0 = Math.max(0, Math.floor((rect.left - CELL) / CELL));
      const c1 = Math.min(grid.cols - 1, Math.floor((rect.right + CELL) / CELL));
      const r0 = Math.max(0, Math.floor((rect.top - CELL) / CELL));
      const r1 = Math.min(grid.rows - 1, Math.floor((rect.bottom + CELL) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const i = r * grid.cols + c;
          const start = heatAt(grid, i, now) > 0 ? grid.start[i] : now + (reduce ? 0 : Math.random() * 120);
          schedule(i, start, Math.max(start, now, grid.touched[i]));
        }
      }
    };

    const resize = () => {
      vw = window.innerWidth;
      vh = window.innerHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      buckets.width = Math.round(vw * dpr);
      buckets.height = Math.round(vh * dpr);
      const next = makeGrid(vw, vh);
      // Keep what was rendered where the old grid still overlaps.
      for (let r = 0; r < Math.min(grid.rows, next.rows); r++) {
        for (let c = 0; c < Math.min(grid.cols, next.cols); c++) {
          next.start[r * next.cols + c] = grid.start[r * grid.cols + c];
          next.touched[r * next.cols + c] = grid.touched[r * grid.cols + c];
        }
      }
      grid = next;
      heat = new Uint8Array(grid.cols * grid.rows);
      scene?.resize(vw, vh, dpr, grid.cols, grid.rows, CELL);
      sizeDirty = false;
    };

    const draw = (now: number) => {
      raf = 0;
      if (!scene) return;
      if (sizeDirty) resize();
      if (layoutDirty) {
        scene.setShapes(collectShapes(root, vw, vh));
        layoutDirty = false;
      }

      let live = false;
      let allRendered = true;
      for (let i = 0; i < grid.cols * grid.rows; i++) {
        const start = grid.start[i];
        const h = heatAt(grid, i, now);
        heat[i] = Math.round(h * 255);
        if (h < 1) allRendered = false;
        if (start && (now < start || (h > 0 && !(h >= 1 && grid.touched[i] === Infinity)))) live = true;
      }
      scene.render(heat);
      // The canvas starts grey in CSS so nothing flashes before the scene draws. Holes need it clear.
      canvas.style.background = "transparent";

      // Bucket corners while a bucket renders, like a renderer working through tiles.
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.clearRect(0, 0, vw, vh);
      if (!reduce) {
        bctx.lineWidth = 1.25;
        bctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
        bctx.beginPath();
        for (let i = 0; i < grid.cols * grid.rows; i++) {
          const start = grid.start[i];
          if (!start || now < start - 50 || now > start + RISE_MS + 40) continue;
          live = true;
          const x = (i % grid.cols) * CELL + 2.5;
          const y = Math.floor(i / grid.cols) * CELL + 2.5;
          const s = CELL - 5;
          const k = 5;
          bctx.moveTo(x, y + k);
          bctx.lineTo(x, y);
          bctx.lineTo(x + k, y);
          bctx.moveTo(x + s - k, y);
          bctx.lineTo(x + s, y);
          bctx.lineTo(x + s, y + k);
          bctx.moveTo(x + s, y + s - k);
          bctx.lineTo(x + s, y + s);
          bctx.lineTo(x + s - k, y + s);
          bctx.moveTo(x + k, y + s);
          bctx.lineTo(x, y + s);
          bctx.lineTo(x, y + s - k);
        }
        bctx.stroke();
      }

      if (touchOnly && allRendered && !live) {
        done = true;
        hide();
        scene.dispose();
        scene = null;
        return;
      }
      if (live || layoutDirty || sizeDirty) raf = requestAnimationFrame(draw);
    };

    const wake = () => {
      if (!done && !raf && scene) raf = requestAnimationFrame(draw);
    };
    const relayout = () => {
      layoutDirty = true;
      wake();
    };
    const onResize = () => {
      sizeDirty = true;
      relayout();
    };
    const onMove = (event: PointerEvent) => {
      if (touchOnly) return;
      touchCircle(event.clientX, event.clientY, performance.now());
      wake();
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches(":focus-visible")) return;
      touchRect(target.getBoundingClientRect(), performance.now());
      wake();
    };

    const observer = new MutationObserver(relayout);
    const resizer = new ResizeObserver(relayout);

    import("@/components/blockout-three")
      .then(({ createBlockout }) => {
        if (disposed) return;
        try {
          scene = createBlockout(canvas);
        } catch {
          // No WebGL: show the finished UI.
          hide();
          return;
        }
        resize();
        if (!reduce) {
          // One diagonal render pass on load, so it's clear there is a finished UI under the blocks.
          const now = performance.now() + 600;
          for (let r = 0; r < grid.rows; r++) {
            for (let c = 0; c < grid.cols; c++) {
              const at = now + (c + r) * 16 + Math.random() * 40;
              schedule(r * grid.cols + c, at, touchOnly ? Infinity : at + RISE_MS);
            }
          }
        }
        observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["class", "style", "value", "src", "disabled"],
        });
        resizer.observe(root);
        document.fonts?.ready.then(relayout).catch(() => {});
        relayout();
      })
      .catch((error) => {
        console.error("Reverse 3D blockout failed", error);
        hide();
      });

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onMove, { passive: true });
    window.addEventListener("focusin", onFocus);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", relayout, { passive: true, capture: true });
    window.addEventListener("input", relayout, { passive: true });
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      resizer.disconnect();
      scene?.dispose();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onMove);
      window.removeEventListener("focusin", onFocus);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", relayout, { capture: true });
      window.removeEventListener("input", relayout);
    };
  }, []);

  return (
    <>
      <canvas className="vp-clay" ref={canvasRef} aria-hidden="true" />
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
        <span className="vp-hint">Move the cursor to render</span>
        <span className="vp-hud-br">
          Frame <b><FrameCounter /></b> · 24 fps
        </span>
        <AxisGizmo />
      </div>
      <Blockout />
    </div>
  );
}
