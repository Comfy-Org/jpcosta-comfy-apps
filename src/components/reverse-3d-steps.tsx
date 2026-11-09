"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Id of the header slot that shows the step indicator. */
export const STEP_SLOT_ID = "r3d-steps";

export type Step = 1 | 2 | 3;

const STEP_NAMES: Record<Step, string> = { 1: "Video", 2: "Un-render", 3: "Result" };

const noop = () => () => {};

/** Header slot for the step indicator. Rendered by the page, filled by the card. */
export function StepSlot() {
  return <div className="r3d-steps-slot" id={STEP_SLOT_ID} />;
}

/** 1 Video · 2 Tweak · 3 Result, drawn into the site header. Done steps can be clicked to go back. */
export function StepNav({ step, reached, onPick }: { step: Step; reached: Step; onPick: (step: Step) => void }) {
  const target = useSyncExternalStore(
    noop,
    () => document.getElementById(STEP_SLOT_ID),
    () => null,
  );
  const nav = (
    <nav className="r3d-steps" aria-label="Steps">
      {([1, 2, 3] as Step[]).map((item) => {
        const state = item === step ? "on" : item <= reached ? "done" : "";
        return (
          <button
            key={item}
            type="button"
            className={state}
            aria-current={item === step ? "step" : undefined}
            disabled={item > reached || item === step}
            onClick={() => onPick(item)}
          >
            <b>{item}</b>
            <span>{STEP_NAMES[item]}</span>
          </button>
        );
      })}
    </nav>
  );
  return target ? createPortal(nav, target) : nav;
}

const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm";

/** Step 1: the whole card is one drop zone. */
export function DropZone({
  title,
  sub,
  hot,
  onHot,
  onFile,
  children,
}: {
  title: string;
  sub: string;
  hot: boolean;
  onHot: (on: boolean) => void;
  onFile: (file: File) => void;
  children?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const take = (list: FileList | null | undefined) => {
    const file = list?.[0];
    if (file) onFile(file);
  };
  return (
    <div
      className={`upload r3d-drop ${hot ? "hot" : ""}`}
      role="button"
      tabIndex={0}
      aria-label="Choose a video"
      onClick={() => inputRef.current?.click()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        depth.current += 1;
        onHot(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) onHot(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        depth.current = 0;
        onHot(false);
        take(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={VIDEO_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          take(event.target.files);
          event.target.value = "";
        }}
      />
      <span className="big" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22">
          <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Zm0 0v9m0 0 8-4.5M12 12l-8-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      </span>
      <h2 className="r3d-drop-title">{title}</h2>
      <p className="r3d-drop-sub">{sub}</p>
      <span className="btn dark">
        <span className="arrow" aria-hidden="true">↑</span>
        Choose file
      </span>
      {children}
    </div>
  );
}

/** A hidden file input with a button that opens it. Used to swap the clip from step 2. */
export function PickButton({ className, children, onFile }: { className: string; children: ReactNode; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => inputRef.current?.click()}>
        {children}
      </button>
      <input
        ref={inputRef}
        className="r3d-hidden-input"
        type="file"
        accept={VIDEO_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = "";
        }}
      />
    </>
  );
}

/** Step 3: final shot on the left, playblast on the right, split by a handle you drag. */
export function VideoSplit({
  original,
  playblast,
  position,
  onChange,
}: {
  original: string;
  playblast: string;
  position: number;
  onChange: (value: number) => void;
}) {
  const leadRef = useRef<HTMLVideoElement>(null);
  const followRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(16 / 9);
  /** The playblast's shape wins; the final clip's shape holds until the playblast has loaded. */
  const shapeFromPlayblast = useRef(false);
  const [frame, setFrame] = useState({ left: 0, top: 0, width: 0, height: 0 });

  // The frame takes the clip's own shape, as big as the box allows, so the video fills it with no bars.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const boxW = box.clientWidth;
      const boxH = box.clientHeight;
      let width = boxW;
      let height = boxW / aspect;
      if (height > boxH) {
        height = boxH;
        width = boxH * aspect;
      }
      setFrame({ left: (boxW - width) / 2, top: (boxH - height) / 2, width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [aspect]);

  // A video that read its metadata before React hydrated never fires onLoadedMetadata for us.
  useEffect(() => {
    const lead = leadRef.current;
    const follow = followRef.current;
    const ready = [lead, follow].find((video) => video && video.readyState >= 1 && video.videoWidth > 0);
    if (!ready) return;
    if (ready === lead) shapeFromPlayblast.current = true;
    const shape = ready.videoWidth / ready.videoHeight;
    queueMicrotask(() => setAspect(shape));
  }, [original, playblast]);

  useEffect(() => {
    const lead = leadRef.current;
    const follow = followRef.current;
    if (!lead || !follow) return;
    const sync = () => {
      const length = Number.isFinite(follow.duration) && follow.duration > 0 ? follow.duration : lead.duration;
      const t = length ? lead.currentTime % length : lead.currentTime;
      if (Math.abs(follow.currentTime - t) > 0.12) follow.currentTime = t;
      if (lead.paused !== follow.paused) {
        if (lead.paused) follow.pause();
        else void follow.play().catch(() => {});
      }
    };
    lead.addEventListener("timeupdate", sync);
    lead.addEventListener("seeked", sync);
    lead.addEventListener("play", sync);
    lead.addEventListener("pause", sync);
    return () => {
      lead.removeEventListener("timeupdate", sync);
      lead.removeEventListener("seeked", sync);
      lead.removeEventListener("play", sync);
      lead.removeEventListener("pause", sync);
    };
  }, [original, playblast]);

  function move(clientX: number) {
    const target = frameRef.current;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    onChange(Math.min(97, Math.max(3, ((clientX - rect.left) / rect.width) * 100)));
  }

  return (
    <div
      ref={boxRef}
      className="preview r3d-split"
      role="slider"
      tabIndex={0}
      aria-label="Compare the final shot with the playblast"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(position)}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        move(event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event.clientX);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onChange(Math.max(3, position - 5));
        if (event.key === "ArrowRight") onChange(Math.min(97, position + 5));
      }}
    >
      <div ref={frameRef} className="r3d-split-frame" style={frame}>
        <video
          ref={followRef}
          className="r3d-split-media"
          src={original}
          muted
          playsInline
          loop
          preload="auto"
          aria-hidden="true"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (!shapeFromPlayblast.current && video.videoWidth > 0 && video.videoHeight > 0) {
              setAspect(video.videoWidth / video.videoHeight);
            }
          }}
        />
        <video
          ref={leadRef}
          className="r3d-split-media r3d-split-top"
          src={playblast}
          muted
          playsInline
          loop
          autoPlay
          preload="auto"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              shapeFromPlayblast.current = true;
              setAspect(video.videoWidth / video.videoHeight);
            }
          }}
          style={{ clipPath: `inset(0 0 0 ${position}%)` }}
        />
        <span className="r3d-split-handle" style={{ left: `${position}%` }} aria-hidden="true">
          <i>⟷</i>
        </span>
        <span className="r3d-tag l">final</span>
        <span className="r3d-tag r">playblast</span>
      </div>
    </div>
  );
}

/** One download button with the two files in a small menu. */
export function DownloadMenu({
  compareReady,
  compareNote,
  onPlayblast,
  onCompare,
}: {
  compareReady: boolean;
  compareNote: string;
  onPlayblast: () => void;
  onCompare: () => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="r3d-dl" ref={boxRef}>
      <button type="button" className="btn dark" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="arrow" aria-hidden="true">↓</span>
        Download
        <span className="r3d-caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="r3d-dl-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="btn"
            onClick={() => {
              setOpen(false);
              onPlayblast();
            }}
          >
            <b>Playblast</b>
            <span>Just the grey blocks</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="btn"
            disabled={!compareReady}
            onClick={() => {
              setOpen(false);
              onCompare();
            }}
          >
            <b>Side by side</b>
            <span>{compareNote}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
