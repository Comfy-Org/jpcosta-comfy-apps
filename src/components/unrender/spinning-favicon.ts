"use client";

import { useEffect } from "react";

const SPRITE = "/brand/favicon-sprite.png";
/** Frames in the sprite: one quarter turn, which loops because a cube looks the same every 90 degrees. */
const FRAMES = 24;
const FRAME_MS = 83;

/**
 * Spins the tab icon. Only Firefox animates a GIF favicon, so the page swaps the
 * icon through the sprite's frames itself. Reduced motion keeps the still cube.
 */
export function useSpinningFavicon(): void {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    let stopped = false;
    const links: { el: HTMLLinkElement; href: string; type: string }[] = [];

    const image = new Image();
    image.onload = () => {
      if (stopped) return;
      const size = image.height;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const frames: string[] = [];
      for (let i = 0; i < FRAMES; i++) {
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(image, i * size, 0, size, size, 0, 0, size, size);
        frames.push(canvas.toDataURL("image/png"));
      }
      document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]').forEach((el) => {
        links.push({ el, href: el.href, type: el.type });
        el.type = "image/png";
      });
      if (!links.length) return;
      let frame = 0;
      const tick = () => {
        for (const { el } of links) el.href = frames[frame];
        frame = (frame + 1) % FRAMES;
      };
      tick();
      timer = window.setInterval(tick, FRAME_MS);
    };
    image.src = SPRITE;

    return () => {
      stopped = true;
      window.clearInterval(timer);
      for (const { el, href, type } of links) {
        el.href = href;
        el.type = type;
      }
    };
  }, []);
}
