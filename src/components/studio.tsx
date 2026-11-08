"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppCard } from "@/components/app-card";
import { easeSlide, exitOpacity, MIN_CARD_GAP, NAV_MS, trackGap } from "@/lib/ease-slide";
import type { CatalogApp } from "@/lib/types";

function mod(value: number, count: number): number {
  return ((value % count) + count) % count;
}

function clearMask(node: HTMLElement) {
  node.style.removeProperty("mask-image");
  node.style.removeProperty("-webkit-mask-image");
}

/** Soften a card where it crosses the browser edge, instead of a hard clip. */
function edgeMask(left: number, width: number, viewportWidth: number): string {
  const feather = Math.min(280, Math.max(96, width * 0.34));
  const fadeLeft = left < -0.5;
  const fadeRight = left + width > viewportWidth + 0.5;
  if (!fadeLeft && !fadeRight) return "";
  if (fadeLeft && fadeRight) {
    const start = -left;
    const end = viewportWidth - left;
    return `linear-gradient(to right, transparent ${start}px, #fff ${start + feather}px, #fff ${Math.max(start + feather, end - feather)}px, transparent ${end}px)`;
  }
  if (fadeLeft) {
    const start = -left;
    return `linear-gradient(to right, transparent ${start}px, #fff ${start + feather}px)`;
  }
  const end = viewportWidth - left;
  return `linear-gradient(to right, #fff ${end - feather}px, transparent ${end}px)`;
}

function placedSlot(itemIndex: number, anchor: number, end: number, count: number): number {
  const low = Math.min(anchor, end) - 1;
  const high = Math.max(anchor, end) + 1;
  if (itemIndex >= low && itemIndex <= high) return itemIndex;
  let placed: number | null = null;
  let best = Infinity;
  for (const turn of [-1, 1]) {
    const pos = itemIndex + turn * count;
    if (pos < low || pos > high) continue;
    const dist = Math.abs(pos - end);
    if (dist < best) {
      best = dist;
      placed = pos;
    }
  }
  return placed ?? itemIndex;
}

function setMask(node: HTMLElement, mask: string) {
  if (!mask) {
    clearMask(node);
    return;
  }
  node.style.setProperty("mask-image", mask);
  node.style.setProperty("-webkit-mask-image", mask);
  node.style.setProperty("mask-repeat", "no-repeat");
  node.style.setProperty("-webkit-mask-repeat", "no-repeat");
  node.style.setProperty("mask-size", "100% 100%");
  node.style.setProperty("-webkit-mask-size", "100% 100%");
}

export function Studio({
  apps,
  mock,
  configured,
  notice = null,
}: {
  apps: CatalogApp[];
  mock: boolean;
  configured: boolean;
  notice?: string | null;
}) {
  const count = apps.length;
  const viewportRef = useRef<HTMLDivElement>(null);
  const reelRef = useRef<HTMLDivElement>(null);
  const stageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const metricsRef = useRef({ width: 0, gap: MIN_CARD_GAP });
  const indexRef = useRef(0);
  const posRef = useRef(0);
  const anchorRef = useRef(0);
  const trackEndRef = useRef(0);
  const busyRef = useRef(false);
  const animRef = useRef<{ from: number; to: number; t0: number } | null>(null);
  const rafRef = useRef(0);
  const [index, setIndex] = useState(0);
  const [trackPos, setTrackPos] = useState(0);
  const [anchor, setAnchor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [metrics, setMetrics] = useState({ width: 0, gap: MIN_CARD_GAP });

  const current = apps[index];
  const carousel = count > 1;
  const cardW = Math.max(0, metrics.width);
  const step = cardW + metrics.gap;

  function setSlideOpen(open: boolean) {
    viewportRef.current?.classList.toggle("is-open", open);
  }

  function reveal(pos: number) {
    const anim = animRef.current;
    const nodes = stageRefs.current;
    if (!anim) {
      for (let i = 0; i < count; i++) {
        const node = nodes[i];
        if (!node) continue;
        const on = i === indexRef.current;
        node.style.opacity = on ? "1" : "0";
        node.style.pointerEvents = on ? "" : "none";
        clearMask(node);
      }
      return;
    }
    const viewW = document.documentElement.clientWidth;
    const span = anim.to - anim.from;
    const progress = span === 0 ? 1 : (pos - anim.from) / span;
    const faded = exitOpacity(progress);
    for (let i = 0; i < count; i++) {
      const node = nodes[i];
      if (!node) continue;
      const slot = placedSlot(i, anchorRef.current, trackEndRef.current, count);
      const leaving = slot === anim.from;
      const traveling = span > 0 ? slot > anim.from && slot <= anim.to : slot < anim.from && slot >= anim.to;
      const opacity = leaving ? faded : traveling ? 1 : 0;
      node.style.opacity = String(opacity);
      node.style.pointerEvents = "none";
      if (opacity <= 0) {
        clearMask(node);
        continue;
      }
      const rect = node.getBoundingClientRect();
      setMask(node, edgeMask(rect.left, rect.width, viewW));
    }
  }

  function paint(pos: number) {
    const reel = reelRef.current;
    const { width, gap } = metricsRef.current;
    if (!reel || width <= 0) return;
    reel.style.gap = `${gap}px`;
    reel.style.transform = `translate3d(${-pos * (width + gap)}px, 0, 0)`;
    reveal(pos);
  }

  function finish(to: number) {
    const settled = mod(to, count);
    animRef.current = null;
    posRef.current = settled;
    indexRef.current = settled;
    anchorRef.current = settled;
    trackEndRef.current = settled;
    busyRef.current = false;
    setSlideOpen(false);
    setIndex(settled);
    setAnchor(settled);
    setTrackPos(settled);
    setBusy(false);
    if (settled === to) paint(settled);
  }

  function frame(now: number) {
    const anim = animRef.current;
    if (!anim) return;
    const t = (now - anim.t0) / NAV_MS;
    if (t >= 1) {
      finish(anim.to);
      return;
    }
    const pos = anim.from + (anim.to - anim.from) * easeSlide(t);
    posRef.current = pos;
    paint(pos);
    rafRef.current = requestAnimationFrame(frame);
  }

  useLayoutEffect(() => {
    if (animRef.current) {
      reveal(posRef.current);
      return;
    }
    setSlideOpen(false);
    paint(trackPos);
    // paint and reveal read refs. This effect re-runs when the track moves or the card size changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackPos, metrics.width, metrics.gap]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const desktop = window.matchMedia("(min-width: 981px)").matches;
    if (desktop || metrics.width <= 0) {
      viewport.style.height = "";
      return;
    }
    const node = stageRefs.current[index];
    if (!node) return;
    const apply = () => {
      const next = node.offsetHeight;
      if (next > 0) viewport.style.height = `${next}px`;
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, [index, metrics.width]);

  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const read = () => {
      const rect = node.getBoundingClientRect();
      const viewW = document.documentElement.clientWidth;
      const margin = Math.max(rect.left, viewW - rect.right);
      const next = { width: node.clientWidth, gap: trackGap(margin) };
      const prev = metricsRef.current;
      if (prev.width === next.width && prev.gap === next.gap) return;
      metricsRef.current = next;
      if (animRef.current) {
        cancelAnimationFrame(rafRef.current);
        animRef.current = null;
        const settled = mod(indexRef.current, count);
        posRef.current = settled;
        anchorRef.current = settled;
        trackEndRef.current = settled;
        busyRef.current = false;
        setSlideOpen(false);
        setBusy(false);
        setAnchor(settled);
        setTrackPos(settled);
      }
      setMetrics(next);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    window.addEventListener("resize", read);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", read);
      cancelAnimationFrame(rafRef.current);
    };
  }, [count]);

  function goTo(target: number) {
    if (count < 2 || busyRef.current) return;
    const from = indexRef.current;
    const next = mod(target, count);
    if (next === from) return;
    let delta = next - from;
    if (delta > count / 2) delta -= count;
    if (delta < -count / 2) delta += count;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    indexRef.current = next;
    setIndex(next);
    cancelAnimationFrame(rafRef.current);
    if (reduce || metricsRef.current.width <= 0) {
      animRef.current = null;
      posRef.current = next;
      anchorRef.current = next;
      trackEndRef.current = next;
      busyRef.current = false;
      setSlideOpen(false);
      setBusy(false);
      setAnchor(next);
      setTrackPos(next);
      return;
    }
    const fromPos = posRef.current;
    const dest = fromPos + delta;
    anchorRef.current = fromPos;
    trackEndRef.current = dest;
    busyRef.current = true;
    setSlideOpen(true);
    setBusy(true);
    animRef.current = { from: fromPos, to: dest, t0: performance.now() };
    setAnchor(fromPos);
    setTrackPos(dest);
    rafRef.current = requestAnimationFrame(frame);
  }

  const goToRef = useRef<(target: number) => void>(() => {});
  useEffect(() => {
    goToRef.current = goTo;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        goToRef.current(indexRef.current + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToRef.current(indexRef.current - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function cardShift(itemIndex: number): string | undefined {
    if (cardW <= 0) return undefined;
    const placed = placedSlot(itemIndex, anchor, trackPos, count);
    if (placed === itemIndex) return undefined;
    return `translate3d(${(placed - itemIndex) * step}px, 0, 0)`;
  }

  return (
    <div className="app">
      <header className="site-header">
        <div className="header-bar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="22" height="22">
                <rect width="32" height="32" rx="8" fill="#211927" />
                <path
                  transform="translate(4.2 3.4) scale(0.52)"
                  fill="#F2FF59"
                  d="M35.6487 36.021C35.733 35.7387 35.7791 35.4411 35.7791 35.1283C35.7791 33.3963 34.3675 31.9924 32.6262 31.9924H18.4956C17.7361 32 17.1147 31.3896 17.1147 30.6342C17.1147 30.4969 17.1377 30.3672 17.1684 30.2451L20.9734 17.0606C21.1345 16.4807 21.6715 16.0534 22.3005 16.0534L36.4848 16.0382C39.4766 16.0382 42.0005 14.0315 42.76 11.2923L44.8926 3.94468C44.9616 3.68526 45 3.40296 45 3.12065C45 1.39628 43.5961 0 41.8624 0L24.7017 0C21.7252 0 19.209 1.99142 18.4342 4.70005L16.992 9.71292C16.8232 10.2852 16.2939 10.7048 15.6648 10.7048H11.5453C8.59189 10.7048 6.0987 12.6581 5.30089 15.3362L0.11507 33.3505C0.0383566 33.6175 0 33.9075 0 34.1974C0 35.9294 1.41152 37.3333 3.15292 37.3333H7.20338C7.96284 37.3333 8.58421 37.9437 8.58421 38.7067C8.58421 38.8364 8.56887 38.9661 8.53051 39.0882L7.09598 44.0553C7.02694 44.3224 6.98091 44.597 6.98091 44.8794C6.98091 46.6037 8.38476 48 10.1185 48L27.2869 47.9847C30.2711 47.9847 32.7873 45.9857 33.5544 43.2618L35.641 36.0286L35.6487 36.021Z"
                />
              </svg>
            </span>
            <span className="brand-word">Comfy API Apps</span>
          </div>
          <div className="header-actions">{mock ? <span className="mockpill">Mock mode</span> : null}</div>
        </div>
      </header>
      <main className="page">
        <div className="hero">
          <h1>{current?.name}</h1>
          <p>Fun apps powered by ComfyUI</p>
        </div>
        {!mock && !configured ? (
          <p className="warn">Set COMFY_API_KEY or COMFY_CLOUD_API_KEY on the server to run live jobs, or COMFY_MOCK=1 for sample output.</p>
        ) : null}
        {!mock && notice ? <p className="warn">{notice}</p> : null}
        {carousel ? (
          <nav className="header-nav" aria-label="Apps">
            {apps.map((item, itemIndex) => (
              <button key={item.id} type="button" className={itemIndex === index ? "on" : ""} onClick={() => goTo(itemIndex)}>
                {item.name}
              </button>
            ))}
          </nav>
        ) : null}
        <div className="stage-wrap">
          {carousel ? (
          <button className="nav-arrow prev" type="button" aria-label="Previous app" onClick={() => goTo(index - 1)}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10.25 3.25 5.5 8l4.75 4.75" />
            </svg>
          </button>
          ) : null}
          <div className={busy ? "track-viewport is-open" : "track-viewport"} ref={viewportRef}>
            <div
              className="reel"
              ref={reelRef}
              style={{ gap: metrics.gap, pointerEvents: busy ? "none" : undefined }}
            >
              {apps.map((item, itemIndex) => (
                <div
                  key={item.id}
                  className="stage"
                  ref={(node) => {
                    stageRefs.current[itemIndex] = node;
                  }}
                  style={{
                    width: cardW || "100%",
                    flexBasis: cardW || "100%",
                    maxWidth: cardW || "100%",
                    transform: cardShift(itemIndex),
                  }}
                >
                  <div className="stage-body" inert={itemIndex !== index}>
                    <AppCard app={item} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          {carousel ? (
          <button className="nav-arrow next" type="button" aria-label="Next app" onClick={() => goTo(index + 1)}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.75 3.25 10.5 8l-4.75 4.75" />
            </svg>
          </button>
          ) : null}
        </div>
        {carousel ? (
        <div className="dots">
          <p className="foot-note">The API key stays on the server. Arrow keys move between apps.</p>
          <div className="dotrow">
            {apps.map((item, itemIndex) => (
              <button key={item.id} type="button" className={itemIndex === index ? "on" : ""} aria-label={item.name} onClick={() => goTo(itemIndex)} />
            ))}
            <span className="count">
              {index + 1} / {count}
            </span>
          </div>
        </div>
        ) : null}
      </main>
      <footer className="site-footer">
        <p>
          Fun apps made by{" "}
          <a href="https://x.com/jp_costa" target="_blank" rel="noopener noreferrer">
            JP Costa
          </a>
          .
        </p>
        <p>
          Powered by{" "}
          <a href="https://comfy.org/platform/comfy-api/" target="_blank" rel="noopener noreferrer">
            ComfyUI
          </a>{" "}
          on{" "}
          <a href="https://cloud.comfy.org/" target="_blank" rel="noopener noreferrer">
            Comfy Cloud
          </a>
          .
        </p>
      </footer>
    </div>
  );
}
