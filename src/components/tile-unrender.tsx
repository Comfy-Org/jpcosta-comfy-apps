"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Reverse 3D's wait screen: the clip's first frame un-renders tile by tile, like a Cycles render running backwards.
 * Done tiles show the grey playblast still of that frame. The tiles being worked on show render noise and orange corners.
 * `progress` (0 to 1) sets how many tiles are done. Once `done` is set, the rest flip and `onFinished` fires.
 */

type Rect = { left: number; top: number; width: number; height: number };

const EMPTY: Rect = { left: 0, top: 0, width: 0, height: 0 };
const FINISH_HOLD_MS = 700;

function containRect(boxW: number, boxH: number, aspect: number): Rect {
  if (boxW <= 0 || boxH <= 0) return EMPTY;
  let width = boxW;
  let height = boxW / aspect;
  if (height > boxH) {
    height = boxH;
    width = boxH * aspect;
  }
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Cycles-style order: rings out from the centre tile, each ring walked around. */
function spiralOrder(cols: number, rows: number): number[] {
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const tiles: { index: number; ring: number; angle: number }[] = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      tiles.push({ index: y * cols + x, ring: Math.max(Math.abs(dx), Math.abs(dy)), angle: Math.atan2(dy, dx) });
    }
  }
  tiles.sort((a, b) => a.ring - b.ring || a.angle - b.angle);
  return tiles.map((tile) => tile.index);
}

function makeNoise(size: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const image = ctx.createImageData(size, size);
    for (let index = 0; index < size * size; index += 1) {
      const base = 70 + Math.random() * 140;
      image.data[index * 4] = base + (Math.random() - 0.5) * 60;
      image.data[index * 4 + 1] = base + (Math.random() - 0.5) * 60;
      image.data[index * 4 + 2] = base + (Math.random() - 0.5) * 60;
      image.data[index * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }
  return canvas;
}

/** Without a still, done tiles show the frame in flat grey, so the un-render still reads. */
function greyOf(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.filter = "grayscale(1) contrast(0.55) brightness(1.25) blur(3px)";
    ctx.drawImage(image, 0, 0);
  }
  return canvas;
}

function useImage(url: string | null): HTMLImageElement | null {
  const [loaded, setLoaded] = useState<{ url: string; image: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (live) setLoaded({ url, image });
    };
    image.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  return url && loaded?.url === url ? loaded.image : null;
}

export function TileUnrender({
  frame,
  still,
  progress,
  done,
  onFinished,
}: {
  /** The clip's first frame. */
  frame: string | null;
  /** That frame as a grey playblast still. Null while it is drawn, or when it could not be. */
  still: string | null;
  progress: number;
  done: boolean;
  onFinished?: () => void;
}) {
  const frameImage = useImage(frame);
  const stillImage = useImage(still);
  const aspect = frameImage ? frameImage.naturalWidth / Math.max(1, frameImage.naturalHeight) : 16 / 9;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rect, setRect] = useState<Rect>(EMPTY);
  const [hud, setHud] = useState({ samples: 4096, tile: 0, tiles: 0 });
  const shown = useRef(0);
  const live = useRef({ frameImage, stillImage, progress, done, onFinished });
  useEffect(() => {
    live.current = { frameImage, stillImage, progress, done, onFinished };
  }, [frameImage, stillImage, progress, done, onFinished]);

  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const measure = () => setRect(containRect(node.clientWidth, node.clientHeight, aspect));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [aspect]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || rect.width <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const cols = W >= H ? 12 : 8;
    const tileW = W / cols;
    const rows = Math.max(1, Math.round(H / tileW));
    const tileH = H / rows;
    const order = spiralOrder(cols, rows);
    const total = order.length;
    const noise = makeNoise(256);
    const reduce = reducedMotion();
    let grey: { source: HTMLImageElement; canvas: HTMLCanvasElement } | null = null;
    let finishedAt = 0;
    let raf = 0;
    let lastHud = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const state = live.current;
      const target = state.done ? 1 : Math.max(0, Math.min(0.97, state.progress));
      // Ease the shown count toward the real progress, so tiles flip one by one.
      const goal = target * total;
      const gap = goal - shown.current;
      const speed = state.done ? Math.max(0.35, Math.abs(gap) * 0.12) : Math.max(0.06, Math.abs(gap) * 0.08);
      shown.current += reduce ? gap : Math.sign(gap) * Math.min(Math.abs(gap), speed);
      const doneTiles = Math.min(total, Math.floor(shown.current + 1e-6));

      let blast: CanvasImageSource | null = state.stillImage;
      if (!blast && state.frameImage && state.done) {
        if (grey?.source !== state.frameImage) grey = { source: state.frameImage, canvas: greyOf(state.frameImage) };
        blast = grey.canvas;
      }
      const blastW = blast instanceof HTMLImageElement ? blast.naturalWidth : blast instanceof HTMLCanvasElement ? blast.width : 0;
      const blastH = blast instanceof HTMLImageElement ? blast.naturalHeight : blast instanceof HTMLCanvasElement ? blast.height : 0;

      ctx.fillStyle = "#8f9195";
      ctx.fillRect(0, 0, W, H);
      if (state.frameImage) ctx.drawImage(state.frameImage, 0, 0, W, H);
      for (let k = 0; k < doneTiles; k += 1) {
        const tile = order[k];
        const x = (tile % cols) * tileW;
        const y = Math.floor(tile / cols) * tileH;
        if (blast && blastW > 0) {
          ctx.drawImage(blast, (x / W) * blastW, (y / H) * blastH, (tileW / W) * blastW, (tileH / H) * blastH, x, y, tileW + 0.5, tileH + 0.5);
        } else {
          ctx.drawImage(noise, 0, 0, 64, 64, x, y, tileW + 0.5, tileH + 0.5);
        }
      }
      const working = doneTiles >= total ? 0 : 3;
      ctx.lineWidth = Math.max(2, W / 400);
      ctx.strokeStyle = "#ff8a2a";
      for (let k = doneTiles; k < Math.min(doneTiles + working, total); k += 1) {
        const tile = order[k];
        const x = (tile % cols) * tileW;
        const y = Math.floor(tile / cols) * tileH;
        const offset = reduce ? 0 : Math.floor((now / 40 + k * 37) % 192);
        ctx.globalAlpha = 0.85;
        ctx.drawImage(noise, offset, (offset * 7) % 192, 64, 64, x, y, tileW, tileH);
        ctx.globalAlpha = 1;
        const c = Math.min(tileW, tileH) * 0.22;
        ctx.beginPath();
        ctx.moveTo(x, y + c);
        ctx.lineTo(x, y);
        ctx.lineTo(x + c, y);
        ctx.moveTo(x + tileW - c, y);
        ctx.lineTo(x + tileW, y);
        ctx.lineTo(x + tileW, y + c);
        ctx.moveTo(x + tileW, y + tileH - c);
        ctx.lineTo(x + tileW, y + tileH);
        ctx.lineTo(x + tileW - c, y + tileH);
        ctx.moveTo(x + c, y + tileH);
        ctx.lineTo(x, y + tileH);
        ctx.lineTo(x, y + tileH - c);
        ctx.stroke();
      }
      if (now - lastHud > 120) {
        lastHud = now;
        const share = Math.min(1, shown.current / total);
        setHud({
          samples: Math.max(1, Math.round(4096 * (1 - share) ** 2)),
          tile: Math.min(total, doneTiles + (working ? 1 : 0)),
          tiles: total,
        });
      }
      if (state.done && doneTiles >= total) {
        if (!finishedAt) finishedAt = now;
        if (now - finishedAt > FINISH_HOLD_MS) {
          cancelAnimationFrame(raf);
          state.onFinished?.();
        }
      } else {
        finishedAt = 0;
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [rect.width, rect.height]);

  return (
    <div ref={boxRef} className="tile-unrender">
      <div className="tile-unrender-frame" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
        <canvas ref={canvasRef} className="tile-unrender-canvas" aria-label="The first frame, un-rendering tile by tile" />
        <span className="tile-unrender-hud tr">Samples {hud.samples.toLocaleString("en-US")}</span>
        {hud.tiles ? (
          <span className="tile-unrender-hud tl">
            Tile {hud.tile}/{hud.tiles}
          </span>
        ) : null}
      </div>
    </div>
  );
}
