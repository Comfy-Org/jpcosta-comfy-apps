"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { clientFailureMessage, fetchBlobRetrying, type ClientStep } from "@/lib/client-fetch";
import { downloadBlob } from "@/lib/composite";
import { videoTypeRejectReason } from "@/lib/prepare-image";
import { requestPlayblastLook } from "@/lib/scene-client";
import { TERMINAL_STATUSES, type JobView } from "@/lib/types";
import { composeSideBySide, prepareReverse3dUpload, REVERSE_3D_MAX_SECONDS } from "@/lib/video-client";
import { VideoSplit } from "@/components/reverse-3d-steps";
import { ComfyLogo } from "@/components/unrender/comfy-logo";
import { PageUnrender } from "@/components/unrender/page-unrender";

/**
 * Unrender: one page. Drop a finished shot; while the video renders the page itself turns into grey clay,
 * tile by tile; the playblast then plays inside the grey page.
 * Access: the visitor's own Comfy API key (kept in this browser), or one free video per email signed in with a code.
 */

type Stage = "idle" | "gate" | "confirm" | "reading" | "look" | "render" | "finishing" | "result" | "error";

type AccessInfo = { email: string | null; used: boolean; emailLogin: boolean; mock: boolean };

/** `seconds`: the length the browser measured, at most 10; the server samples that much at 16 fps. */
type Clip = { file: File; url: string; trimmed: boolean; seconds?: number };

type Result = { jobId: string; blob: Blob; url: string; compareBlob?: Blob; compareError?: string };

type Recovery = { jobId: string; outputId?: string; sig?: string };

const RUN_ENDPOINT = "/api/run/reverse-3d";
const KEY_STORAGE = "unrender:comfyKey";
const KEYS_URL = "https://platform.comfy.org/profile/api-keys";
/** About how long the video job takes: Kling (own key) about four minutes, open-source VACE (free) about two and a half. */
const TYPICAL_SECONDS = { kling: 240, free: 150 };
/** Kling 4.0 Flash Edit bills about 40 to 50 credits per second of video; the Nano Banana still about 9. */
const KLING_CREDITS_PER_SECOND = 50;
const STILL_CREDITS = 9;
/** Sent with job polls and downloads when the run used the visitor's key: those jobs live on the Kling deployment. */
const KEY_HEADER = "x-comfy-key";
const POLL_LIMIT_MS = 20 * 60 * 1000;
/** The demo plays the whole un-render on the example clip with no job and no credits. */
const DEMO = {
  clip: "/examples/avengers.mp4",
  frame: "/examples/avengers.jpg",
  still: "/examples/avengers-still.jpg",
  playblast: "/examples/avengers-playblast.mp4",
};
/** The example clip is 16:9. */
const EXAMPLE_ASPECT = 16 / 9;
/** The demo's still "arrives" after this, like the real one, so the page around the shot goes first. */
const DEMO_LOOK_MS = 5000;
/** While the clip is read and its still is drawn, the page around the shot creeps up to this share of its tiles. */
const PREP_SHARE = 0.18;
/** Seconds the prep creep takes to get most of the way there (the still takes about 10–20 s). */
const PREP_SECONDS = 9;
const DEMO_RENDER_MS = 16000;
/** The grey page holds a beat before the playblast wipes in. */
const FILLED_HOLD_MS = 700;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

class RunError extends Error {
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function readJson<T>(response: Response): Promise<T | null> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function errorOf(payload: unknown, fallback: string): RunError {
  const error = payload && typeof payload === "object" && "error" in payload ? (payload as { error: unknown }).error : null;
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: string; message?: string };
    return new RunError(message || fallback, code);
  }
  if (typeof error === "string") return new RunError(error);
  return new RunError(fallback);
}

function readStoredKey(): string | null {
  try {
    return window.localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

function keyHeaders(key: string | null): Record<string, string> {
  return key ? { [KEY_HEADER]: key } : {};
}

function storeKey(key: string | null) {
  try {
    if (key) window.localStorage.setItem(KEY_STORAGE, key);
    else window.localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Private windows: the key lasts for this visit only.
  }
}

function loadImage(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

function samplesLeft(share: number): string {
  return Math.max(1, Math.round(4096 * (1 - share))).toLocaleString("en-US");
}

function PickButton({ className, children, onFile }: { className: string; children: ReactNode; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} data-b onClick={() => inputRef.current?.click()}>
        {children}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </>
  );
}

export function UnrenderApp() {
  const [stage, setStage] = useState<Stage>("idle");
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [look, setLook] = useState<{ frame: string; still: string | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [gateNote, setGateNote] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [waited, setWaited] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [split, setSplit] = useState(50);
  const [exampleSplit, setExampleSplit] = useState(50);
  const [renderedBack, setRenderedBack] = useState(false);
  const [hot, setHot] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /** The shot's shape, so the frame fits the clip with no bars. The example is 16:9. */
  const [aspect, setAspect] = useState(EXAMPLE_ASPECT);
  /** Seconds since the clip came in, while it is read and its still is drawn. */
  const [prepWaited, setPrepWaited] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PageUnrender | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** The key that started the current job: its status and video live on that key's account. */
  const runKeyRef = useRef<string | null>(null);
  /** Answers the spend confirmation: true renders with the visitor's key, false stops before anything is paid. */
  const confirmRef = useRef<((yes: boolean) => void) | null>(null);
  const [confirmSeconds, setConfirmSeconds] = useState(REVERSE_3D_MAX_SECONDS);
  const stepRef = useRef<ClientStep>("submit");
  const stageRef = useRef<Stage>("idle");
  stageRef.current = stage;

  const busy = stage === "reading" || stage === "look" || stage === "render" || stage === "finishing";
  const canRun = Boolean(key) || Boolean(access?.email && !access.used);

  // The tile engine lives for the page's lifetime.
  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    const engine = new PageUnrender(canvas, root);
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    // The stored key is read after hydration, so the server and the first client render agree.
    void Promise.resolve().then(() => setKey(readStoredKey()));
    void refreshAccess();
    // /unrender?demo plays the effect on the example straight away.
    if (new URLSearchParams(window.location.search).has("demo")) void Promise.resolve().then(() => demoRef.current());
    return () => {
      abortRef.current?.abort();
      confirmRef.current?.(false);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(timer);
  }, [toast]);

  // The job reports progress only per sampler step, so the tiles also follow the time the job has taken.
  const typical = key ? TYPICAL_SECONDS.kling : TYPICAL_SECONDS.free;
  const estimate = 1 - Math.exp(-waited / (typical / 2.5));
  const share = Math.max(progress, estimate);
  const preparing = stage === "reading" || stage === "look";
  // The page around the shot does not wait for the still: it starts as soon as the clip comes in.
  const prepShare = PREP_SHARE * (1 - Math.exp(-prepWaited / PREP_SECONDS));
  const renderShare = PREP_SHARE + (0.97 - PREP_SHARE) * share;
  const goal =
    stage === "finishing" || stage === "result"
      ? renderedBack
        ? 0
        : 1
      : stage === "render"
        ? Math.max(prepShare, renderShare)
        : preparing
          ? 0.01 + prepShare
          : 0;

  useEffect(() => {
    engineRef.current?.setGoal(goal);
  }, [goal]);

  useEffect(() => {
    if (!preparing) return;
    const started = Date.now();
    const timer = setInterval(() => setPrepWaited((Date.now() - started) / 1000), 250);
    return () => {
      clearInterval(timer);
    };
    // Counts from the clip coming in; the move from reading to look keeps counting.
  }, [preparing]);

  // Once every tile is grey after the job, hold a beat, then the playblast wipes in.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.onFilled = () => {
      if (stageRef.current !== "finishing") return;
      setTimeout(() => {
        if (stageRef.current === "finishing") setStage("result");
      }, FILLED_HOLD_MS);
    };
  }, []);

  // The grey shot is the still, or the grey frame without one.
  // The shot's tiles flip only once its still (or grey frame) has loaded.
  useEffect(() => {
    let live = true;
    if (!look) engineRef.current?.setShotReady(false);
    void Promise.all([loadImage(look?.still ?? null), loadImage(look?.frame ?? null)]).then(([still, frame]) => {
      if (!live) return;
      engineRef.current?.setImages({ still, frame });
      engineRef.current?.setShotReady(Boolean(look));
    });
    return () => {
      live = false;
    };
  }, [look]);

  // Any layout change moves the blocks.
  useEffect(() => {
    engineRef.current?.remeasure();
  }, [stage, access, key, note, error, renderedBack, clip, preview, aspect]);

  // A shot dropped anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const hasFile = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (event: DragEvent) => {
      if (!hasFile(event)) return;
      depth += 1;
      setHot(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFile(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setHot(false);
    };
    const onOver = (event: DragEvent) => {
      if (hasFile(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFile(event)) return;
      event.preventDefault();
      depth = 0;
      setHot(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) takeFileRef.current(file);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  async function refreshAccess(): Promise<AccessInfo | null> {
    try {
      const response = await fetch("/api/access", { cache: "no-store" });
      const info = await readJson<AccessInfo>(response);
      if (response.ok && info) {
        setAccess(info);
        return info;
      }
    } catch {
      // Offline or the store is down: the key path still works.
    }
    const fallback = { email: null, used: false, emailLogin: false, mock: false };
    setAccess((current) => current ?? fallback);
    return null;
  }

  function resetShot() {
    setPrepWaited(0);
    abortRef.current?.abort();
    setResult((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
    setLook((current) => {
      if (current) {
        URL.revokeObjectURL(current.frame);
        if (current.still) URL.revokeObjectURL(current.still);
      }
      return null;
    });
    setClip((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
    setError(null);
    setRecovery(null);
    setProgress(0);
    setWaited(0);
    setRenderedBack(false);
    setSplit(50);
  }

  function takeFile(file: File) {
    if (busy) {
      setNote("One shot at a time. Wait for this one to finish.");
      return;
    }
    const reason = videoTypeRejectReason(file);
    if (reason) {
      setNote(reason);
      return;
    }
    resetShot();
    setNote(null);
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
    if (!canRun) {
      setPending(file);
      setGateNote(null);
      setStage("gate");
      return;
    }
    void start(file, key);
  }
  const takeFileRef = useRef(takeFile);
  takeFileRef.current = takeFile;

  function confirmSpend(seconds: number): Promise<boolean> {
    confirmRef.current?.(false);
    return new Promise((resolve) => {
      confirmRef.current = (yes) => {
        confirmRef.current = null;
        resolve(yes);
      };
      setConfirmSeconds(seconds);
      setStage("confirm");
    });
  }

  async function start(file: File, visitorKey: string | null) {
    const controller = new AbortController();
    abortRef.current?.abort();
    confirmRef.current?.(false);
    abortRef.current = controller;
    setPending(null);
    setError(null);
    setStage("reading");
    setNote("Checking the clip…");
    try {
      const prepared = await prepareReverse3dUpload(file, REVERSE_3D_MAX_SECONDS);
      if (controller.signal.aborted) return;
      const ready: Clip = {
        file: prepared.file,
        url: URL.createObjectURL(prepared.file),
        trimmed: prepared.trimmed,
        seconds: prepared.duration,
      };
      setClip(ready);
      // The visitor's key pays for Kling: say what it will cost and wait for a yes before any paid job.
      if (visitorKey && !(await confirmSpend(ready.seconds ?? REVERSE_3D_MAX_SECONDS))) {
        if (!controller.signal.aborted) {
          setNote(null);
          setStage("idle");
        }
        return;
      }
      if (controller.signal.aborted) return;
      setStage("look");
      setNote("Drawing the playblast look…");
      const drawn = await requestPlayblastLook(prepared.file, undefined, visitorKey);
      if (controller.signal.aborted) return;
      // Without the still VACE has no mannequin to copy and renders a detailed sculpture: stop before that.
      // Kling still follows its prompt without it, as before.
      if (!drawn.still && !visitorKey) throw new Error(`Could not draw the playblast look: ${drawn.error ?? "the still job failed"}`);
      setLook({ frame: URL.createObjectURL(drawn.frame), still: drawn.still ? URL.createObjectURL(drawn.still) : null });
      setNote(ready.trimmed ? `Using the first ${REVERSE_3D_MAX_SECONDS} seconds of this clip.` : null);
      await render(ready, drawn.still, visitorKey, controller);
    } catch (err) {
      if (controller.signal.aborted) return;
      fail(err, file);
    }
  }

  function fail(err: unknown, file: File | null) {
    const code = err instanceof RunError ? err.code : undefined;
    if ((code === "sign_in" || code === "free_used" || code === "access_off") && file) {
      void refreshAccess();
      setPending(file);
      setGateNote(err instanceof Error ? err.message : null);
      setStage("gate");
      return;
    }
    setError(clientFailureMessage(stepRef.current, err));
    setStage("error");
  }

  async function render(ready: Clip, still: Blob | null, visitorKey: string | null, controller: AbortController) {
    stepRef.current = "submit";
    setStage("render");
    setProgress(0);
    setWaited(0);
    const form = new FormData();
    form.append("video", ready.file, ready.file.name);
    if (ready.seconds) form.append("seconds", ready.seconds.toFixed(3));
    if (still) form.append("reference", still, "reference.jpg");
    if (visitorKey) form.append("comfyKey", visitorKey);
    runKeyRef.current = visitorKey;
    const response = await fetch(RUN_ENDPOINT, { method: "POST", body: form, signal: controller.signal });
    const payload = await readJson<{ jobId?: string }>(response);
    if (!response.ok || !payload?.jobId) throw errorOf(payload, "The render could not start.");
    if (!visitorKey) setAccess((current) => (current ? { ...current, used: true } : current));
    await follow({ jobId: payload.jobId }, ready, controller);
  }

  async function follow(target: Recovery, ready: Clip, controller: AbortController) {
    stepRef.current = "status";
    const started = Date.now();
    let failures = 0;
    let job: JobView | null = null;
    while (!job || !TERMINAL_STATUSES.includes(job.status)) {
      const elapsed = Date.now() - started;
      setWaited(Math.round(elapsed / 1000));
      if (elapsed > POLL_LIMIT_MS) {
        setRecovery(target);
        throw new Error("This render is taking too long. Check it again in a minute.");
      }
      await sleep(job ? 2500 : 400, controller.signal);
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(target.jobId)}`, {
          signal: controller.signal,
          headers: keyHeaders(runKeyRef.current),
        });
        if (!response.ok) throw errorOf(await readJson(response), "Could not read the render's status.");
        job = (await response.json()) as JobView;
        failures = 0;
        if (typeof job.progress === "number") setProgress(job.progress);
      } catch (err) {
        if (controller.signal.aborted) throw err;
        failures += 1;
        if (failures >= 4) {
          setRecovery(target);
          throw err;
        }
      }
    }
    if (job.status !== "succeeded") {
      throw new Error(job.error?.message ? `The render failed: ${job.error.message}` : `The render ${job.status === "canceled" ? "was canceled" : "failed"}.`);
    }
    const output = job.outputs[0];
    if (!output?.sig) throw new Error("The render finished without a video.");
    await save({ jobId: target.jobId, outputId: output.id, sig: output.sig }, ready, controller);
  }

  async function save(target: Recovery, ready: Clip, controller: AbortController) {
    stepRef.current = "download";
    const url = `/api/outputs/${encodeURIComponent(target.outputId ?? "")}?sig=${encodeURIComponent(target.sig ?? "")}`;
    let read: Awaited<ReturnType<typeof fetchBlobRetrying>>;
    try {
      read = await fetchBlobRetrying(url, { signal: controller.signal, headers: keyHeaders(runKeyRef.current) }, fetch);
    } catch (err) {
      if (!controller.signal.aborted) setRecovery(target);
      throw err;
    }
    if (!read.response.ok || !read.blob) {
      setRecovery(target);
      throw errorOf(await read.response.text().then((text) => JSON.parse(text) as unknown).catch(() => null), "Could not download the playblast.");
    }
    const blob = read.blob;
    const playUrl = URL.createObjectURL(blob);
    setRecovery(null);
    setResult({ jobId: target.jobId, blob, url: playUrl });
    setProgress(1);
    setStage("finishing");
    try {
      const compareBlob = await composeSideBySide(playUrl, ready.url);
      setResult((current) => (current?.jobId === target.jobId ? { ...current, compareBlob } : current));
    } catch (err) {
      const compareError = err instanceof Error ? err.message : "Could not build the side by side.";
      setResult((current) => (current?.jobId === target.jobId ? { ...current, compareError } : current));
    }
  }

  async function retry() {
    if (!clip) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setError(null);
    try {
      if (recovery?.outputId) {
        setStage("render");
        await save(recovery, clip, controller);
      } else if (recovery) {
        setStage("render");
        await follow(recovery, clip, controller);
      } else if (look?.still) {
        // A new Kling job is a new charge on the visitor's key: ask again.
        if (key && !(await confirmSpend(clip.seconds ?? REVERSE_3D_MAX_SECONDS))) {
          if (!controller.signal.aborted) setStage("idle");
          return;
        }
        if (controller.signal.aborted) return;
        const still = await fetch(look.still).then((response) => response.blob());
        await render(clip, still, key, controller);
      } else {
        // The still never came: start over from the clip, look first.
        await start(clip.file, key);
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      fail(err, null);
    }
  }

  const onGranted = useCallback(
    (nextKey: string | null) => {
      if (pending) {
        const file = pending;
        void start(file, nextKey);
        return;
      }
      setStage("idle");
    },
    // start reads state through setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pending],
  );

  function saveKey(next: string | null) {
    storeKey(next);
    setKey(next);
  }

  async function signOut() {
    await fetch("/api/access", { method: "DELETE" }).catch(() => null);
    await refreshAccess();
  }

  async function runDemo() {
    if (busy) return;
    resetShot();
    setNote(null);
    setPreview(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const clipBlob = await fetch(DEMO.clip).then((response) => response.blob());
      const file = new File([clipBlob], "avengers.mp4", { type: "video/mp4" });
      const ready: Clip = { file, url: URL.createObjectURL(file), trimmed: false };
      setClip(ready);
      setStage("look");
      await sleep(DEMO_LOOK_MS, controller.signal);
      setLook({ frame: DEMO.frame, still: DEMO.still });
      setStage("render");
      const started = Date.now();
      for (;;) {
        const share = Math.min(1, (Date.now() - started) / DEMO_RENDER_MS);
        setProgress(share);
        if (share >= 1) break;
        await sleep(200, controller.signal);
      }
      const blob = await fetch(DEMO.playblast).then((response) => response.blob());
      const playUrl = URL.createObjectURL(blob);
      setResult({ jobId: "demo", blob, url: playUrl });
      setStage("finishing");
      const compareBlob = await composeSideBySide(playUrl, ready.url).catch(() => null);
      setResult((current) => (current?.jobId === "demo" ? { ...current, ...(compareBlob ? { compareBlob } : { compareError: "No side by side" }) } : current));
    } catch {
      if (controller.signal.aborted) return;
      setStage("idle");
    }
  }
  const demoRef = useRef(runDemo);
  demoRef.current = runDemo;

  function another() {
    confirmRef.current?.(false);
    resetShot();
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setNote(null);
    setStage("idle");
  }

  function download(kind: "playblast" | "side") {
    if (!result) return;
    const blob = kind === "side" ? result.compareBlob : result.blob;
    if (!blob) return;
    const ext = blob.type.includes("webm") ? "webm" : "mp4";
    const filename = kind === "side" ? `unrender-side-by-side.${ext}` : `unrender-playblast.${ext}`;
    downloadBlob(blob, filename);
    setToast(filename);
  }

  const covered = preparing || stage === "render" || stage === "finishing" || (stage === "result" && !renderedBack);
  const showResult = stage === "result" && result;
  const shotUrl = clip?.url ?? preview;
  const accessLabel = key
    ? "Your key"
    : access?.email
      ? access.used
        ? "Free video used"
        : "1 free video"
      : "Sign in";
  const status =
    stage === "reading"
      ? "Checking the clip…"
      : stage === "look"
        ? "Drawing the playblast look…"
        : stage === "render"
          ? `Un-rendering · ${samplesLeft(0.1 + 0.85 * share)} samples left`
          : stage === "finishing"
            ? "Un-rendered"
            : null;

  return (
    <div className={`ur${covered ? " grey" : ""}${hot ? " hot" : ""}`} ref={rootRef} data-stage={stage}>
      <div className="ur-page" aria-hidden={covered ? true : undefined}>
        <nav className="ur-nav">
          <a className="ur-logo" href="/unrender" data-b>
            Unrender
          </a>
          <button
            type="button"
            className="ur-pill"
            data-b
            disabled={busy}
            onClick={() => {
              setGateNote(null);
              setStage("gate");
            }}
          >
            <i aria-hidden="true" className={canRun ? "on" : ""} />
            {accessLabel}
          </button>
        </nav>

        <main className="ur-hero">
          <div className="ur-copy">
            <h1 data-b="t">Turn any final shot back into a playblast</h1>
            <p className="ur-sub" data-b="t">
              Drop a clip and we un-render it, all the way back to a grey clay render. Up to {REVERSE_3D_MAX_SECONDS} seconds.
            </p>
            {stage === "gate" ? (
              <Gate
                access={access}
                visitorKey={key}
                note={gateNote}
                hasShot={Boolean(pending)}
                onKey={(next) => {
                  saveKey(next);
                  if (next) onGranted(next);
                }}
                onSignedIn={(info) => {
                  setAccess((current) => ({ ...(current ?? { emailLogin: true, mock: false }), email: info.email, used: info.used }));
                  if (info.used) {
                    setGateNote("This email already made its free video. Paste your own Comfy API key to make more.");
                    return;
                  }
                  onGranted(key);
                }}
                onSignOut={() => void signOut()}
                onClose={() => {
                  setPending(null);
                  setStage("idle");
                }}
              />
            ) : stage === "confirm" ? (
              <SpendConfirm
                seconds={confirmSeconds}
                visitorKey={key}
                onAnswer={(yes) => confirmRef.current?.(yes)}
              />
            ) : showResult ? (
              <div className="ur-row ur-lift">
                <button type="button" className="ur-go" onClick={() => download("playblast")}>
                  ↓ Playblast
                </button>
                <button type="button" className="ur-ghost" disabled={!result.compareBlob} onClick={() => download("side")}>
                  {result.compareBlob ? "↓ Side by side" : result.compareError ? "No side by side" : "Side by side…"}
                </button>
                <PickButton className="ur-ghost" onFile={takeFile}>
                  Another shot
                </PickButton>
                <button type="button" className="ur-link" onClick={() => setRenderedBack((value) => !value)}>
                  {renderedBack ? "Unrender the page again" : "Render the page back"}
                </button>
              </div>
            ) : (
              <div className="ur-row">
                <PickButton className="ur-go" onFile={takeFile}>
                  Drop a shot
                </PickButton>
                <button
                  type="button"
                  className="ur-ghost"
                  data-b
                  disabled={busy}
                  onClick={() => {
                    setGateNote(null);
                    setStage("gate");
                  }}
                >
                  {key ? "Using your key" : "Use your own key"}
                </button>
              </div>
            )}
            {note && !busy && stage !== "gate" && stage !== "confirm" ? (
              <p className="ur-note" role="status">
                {note}
              </p>
            ) : null}
            {toast ? <p className="ur-note ur-lift">✓ Saved {toast}</p> : null}
          </div>

          <figure
            className={`ur-shot${showResult ? " ur-lift reveal" : ""}`}
            data-b={showResult ? undefined : "img"}
            style={{ "--ar": shotUrl ? aspect : EXAMPLE_ASPECT } as CSSProperties}
          >
            {showResult ? (
              <VideoSplit original={clip?.url ?? result.url} playblast={result.url} position={split} onChange={setSplit} />
            ) : shotUrl ? (
              <video
                className="ur-shot-media"
                src={shotUrl}
                muted
                playsInline
                loop
                autoPlay
                preload="auto"
                onLoadedMetadata={(event) => {
                  const { videoWidth, videoHeight } = event.currentTarget;
                  if (videoWidth > 0 && videoHeight > 0) setAspect(Math.min(2.4, Math.max(0.56, videoWidth / videoHeight)));
                }}
              />
            ) : (
              <>
                <VideoSplit
                  original={DEMO.clip}
                  playblast={DEMO.playblast}
                  position={exampleSplit}
                  onChange={setExampleSplit}
                />
                <figcaption className="ur-tag">Example · drag to compare</figcaption>
              </>
            )}
          </figure>
        </main>

        <section className="ur-how" aria-label="How it works">
          <div>
            <b data-b="t">1 · Drop a finished shot</b>
            <p data-b="t">
              MP4, MOV or WebM. Any length, we use the first {REVERSE_3D_MAX_SECONDS} seconds.
            </p>
          </div>
          <div>
            <b data-b="t">2 · Watch it un-render</b>
            <p data-b="t">This page turns back into clay while the GPU works. A few minutes.</p>
          </div>
          <div>
            <b data-b="t">3 · Get the playblast</b>
            <p data-b="t">The grey version nobody asked for, plus a side by side to share.</p>
          </div>
        </section>

        <footer className="ur-foot">
          <p data-b="t">
            Made by{" "}
            <a href="https://x.com/jp_costa" target="_blank" rel="noopener noreferrer">
              JP Costa
            </a>
          </p>
          <a className="ur-powered" href="https://comfy.org/" target="_blank" rel="noopener noreferrer" data-b>
            <span>Running on</span>
            <ComfyLogo className="ur-comfy" />
          </a>
        </footer>
      </div>

      <canvas ref={canvasRef} className="ur-over" aria-hidden="true" />

      {status ? (
        <div className="ur-status" role="status" aria-live="polite">
          <span className="ur-dot" aria-hidden="true" />
          {status}
          {stage === "render" ? <b>{Math.round((0.1 + 0.85 * share) * 100)}%</b> : null}
        </div>
      ) : null}

      {stage === "error" ? (
        <div className="ur-status bad" role="alert">
          <p>{error}</p>
          <div className="ur-row">
            {clip ? (
              <button type="button" className="ur-go" onClick={() => void retry()}>
                {recovery?.outputId ? "Retry the download" : recovery ? "Check again" : "Try again"}
              </button>
            ) : null}
            <PickButton className="ur-ghost" onFile={takeFile}>
              Another shot
            </PickButton>
            <button type="button" className="ur-link" onClick={another}>
              Back
            </button>
          </div>
        </div>
      ) : null}

      {hot ? (
        <div className="ur-drop" aria-hidden="true">
          <span>Drop it anywhere</span>
        </div>
      ) : null}
    </div>
  );
}

function Gate({
  access,
  visitorKey,
  note,
  hasShot,
  onKey,
  onSignedIn,
  onSignOut,
  onClose,
}: {
  access: AccessInfo | null;
  visitorKey: string | null;
  note: string | null;
  hasShot: boolean;
  onKey: (key: string | null) => void;
  onSignedIn: (info: { email: string; used: boolean }) => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/access/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = await readJson<{ challenge?: string; devCode?: string }>(response);
      if (!response.ok || !payload?.challenge) throw errorOf(payload, "Could not send the code.");
      setChallenge(payload.challenge);
      setDevCode(payload.devCode ?? null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/access/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge, code }),
      });
      const payload = await readJson<{ email?: string; used?: boolean }>(response);
      if (!response.ok || !payload?.email) throw errorOf(payload, "Could not check the code.");
      onSignedIn({ email: payload.email, used: Boolean(payload.used) });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not check the code.");
    } finally {
      setBusy(false);
    }
  }

  function useKey(event: FormEvent) {
    event.preventDefault();
    const trimmed = keyDraft.trim();
    if (!/^[\x21-\x7e]{20,256}$/.test(trimmed)) {
      setMessage("That does not look like a Comfy API key. Copy it again from your Comfy account.");
      return;
    }
    setKeyDraft("");
    onKey(trimmed);
  }

  const signedIn = access?.email ?? null;
  const freeOn = access?.emailLogin ?? false;

  return (
    <div className="ur-gate">
      <div className="ur-gate-head">
        <b>{hasShot ? "One step before the render" : "How you pay for renders"}</b>
        <button type="button" className="ur-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      {note ? <p className="ur-gate-note">{note}</p> : null}

      <div className="ur-gate-part">
        <span className="ur-gate-label">One free video per email</span>
        {signedIn ? (
          <p className="ur-gate-line">
            Signed in as <b>{signedIn}</b>
            {access?.used ? ", free video used." : ", free video ready."}{" "}
            {hasShot && !access?.used ? (
              <button type="button" className="ur-link" onClick={() => onSignedIn({ email: signedIn, used: false })}>
                Render with it
              </button>
            ) : null}{" "}
            <button type="button" className="ur-link" onClick={onSignOut}>
              Use another email
            </button>
          </p>
        ) : !freeOn ? (
          <p className="ur-gate-line">Free videos are not switched on yet. Use your own key for now.</p>
        ) : challenge ? (
          <form className="ur-gate-form" onSubmit={verify}>
            <input
              className="ur-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              aria-label="Code from the email"
              autoFocus
            />
            <button type="submit" className="ur-go" disabled={busy || code.length !== 6}>
              {hasShot ? "Start" : "Sign in"}
            </button>
            <button
              type="button"
              className="ur-link"
              onClick={() => {
                setChallenge(null);
                setCode("");
                setDevCode(null);
              }}
            >
              Other email
            </button>
            {devCode ? <span className="ur-gate-dev">Test code: {devCode}</span> : null}
          </form>
        ) : (
          <form className="ur-gate-form" onSubmit={sendCode}>
            <input
              className="ur-input"
              type="email"
              autoComplete="email"
              placeholder="you@studio.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-label="Your email"
              required
            />
            <button type="submit" className="ur-go" disabled={busy || !email}>
              Email me a code
            </button>
          </form>
        )}
      </div>

      <div className="ur-gate-part">
        <span className="ur-gate-label">Or your own Comfy API key, no limit</span>
        {visitorKey ? (
          <p className="ur-gate-line">
            Using your key ending in <b>{visitorKey.slice(-4)}</b>.{" "}
            {hasShot ? (
              <button type="button" className="ur-link" onClick={() => onKey(visitorKey)}>
                Render with it
              </button>
            ) : null}{" "}
            <button type="button" className="ur-link" onClick={() => onKey(null)}>
              Forget it
            </button>
          </p>
        ) : (
          <form className="ur-gate-form" onSubmit={useKey}>
            <input
              className="ur-input"
              type="password"
              autoComplete="off"
              placeholder="Paste your Comfy API key"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              aria-label="Your Comfy API key"
            />
            <button type="submit" className="ur-ghost" disabled={!keyDraft.trim()}>
              Use my key
            </button>
          </form>
        )}
        <p className="ur-fine">
          It stays in this browser. Renders with your key use Kling and bill your Comfy account, about 500 credits for 10 seconds. You confirm each one first.{" "}
          <a href={KEYS_URL} target="_blank" rel="noopener noreferrer">
            Get a key
          </a>
        </p>
      </div>
      {message ? (
        <p className="ur-gate-note" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** The yes before a paid render: what Kling will cost on the visitor's own Comfy account. */
function SpendConfirm({
  seconds,
  visitorKey,
  onAnswer,
}: {
  seconds: number;
  visitorKey: string | null;
  onAnswer: (yes: boolean) => void;
}) {
  const clipSeconds = Math.max(1, Math.round(seconds));
  const credits = Math.round((clipSeconds * KLING_CREDITS_PER_SECOND + STILL_CREDITS) / 10) * 10;
  return (
    <div className="ur-gate" role="dialog" aria-label="Confirm the credit spend">
      <div className="ur-gate-head">
        <b>Spend about {credits} credits?</b>
        <button type="button" className="ur-x" aria-label="Cancel" onClick={() => onAnswer(false)}>
          ×
        </button>
      </div>
      <p className="ur-gate-line">
        This {clipSeconds}-second shot renders with Kling on your own Comfy account
        {visitorKey ? (
          <>
            {" "}
            (key ending in <b>{visitorKey.slice(-4)}</b>)
          </>
        ) : null}
        . The playblast look and the video together cost about {credits} credits. Nothing is charged until you say yes.
      </p>
      <div className="ur-row ur-confirm-row">
        <button type="button" className="ur-go" onClick={() => onAnswer(true)} autoFocus>
          Render for ~{credits} credits
        </button>
        <button type="button" className="ur-ghost" onClick={() => onAnswer(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
