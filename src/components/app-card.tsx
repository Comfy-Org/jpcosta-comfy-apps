"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BackgroundValue, FormatValue } from "@/lib/choices";
import { downloadBlob, exportCutout } from "@/lib/composite";
import { FORM_BUDGET_BYTES, VIDEO_FORM_BUDGET_BYTES, imageRejectReason, packImages, randomSeed, shrinkForUpload, videoRejectReason, videoTypeRejectReason } from "@/lib/prepare-image";
import { clientFailureMessage, fetchBlobRetrying, type ClientStep } from "@/lib/client-fetch";
import { composeSideBySide, prepareReverse3dUpload, REVERSE_3D_MAX_SECONDS } from "@/lib/video-client";
import { requestSubjectModel, sampleSceneFrames, type SceneModel } from "@/lib/scene-client";
import { SCENE_POLYGON_DEFAULT } from "@/lib/scene-mesh";
import { LILAC, TERMINAL_STATUSES, type CatalogApp, type CatalogImage, type JobView, type RunResponse, type TextControl } from "@/lib/types";
import { AppIcon } from "@/components/app-icon";
import { SceneOrbit, type SceneOrbitHandle } from "@/components/scene-orbit";
import { DownloadMenu, DropZone, PickButton, StepNav, VideoSplit, type Step } from "@/components/reverse-3d-steps";

type SceneCandidate = {
  token: string;
  title: string;
  source: string;
  width: number;
  height: number;
};

type Shot = {
  file: File;
  source: File;
  url: string;
  sourceUrl?: string;
  name: string;
  width: number;
  height: number;
};

type UploadState = Shot & {
  shots?: Shot[];
};

type HistoryItem = {
  id: string;
  blob: Blob;
  url: string;
  before: Record<string, string>;
  label: string;
  frames: string;
  width: number;
  height: number;
  video: boolean;
  compareBlob?: Blob;
  compareUrl?: string;
  compareError?: string;
};

type Phase = "idle" | "queued" | "running" | "done" | "error";

type Recovery = {
  kind: "status" | "download";
  jobId: string;
  label: string;
  before: Record<string, string>;
  frames: string;
  outputId?: string;
  sig?: string;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

function controlValue(values: Record<string, string>, key: string): string {
  return values[key] ?? "";
}

export function AppCard({ app, layout = "card" }: { app: CatalogApp; layout?: "card" | "steps" }) {
  const defaults = useMemo(() => {
    const next: Record<string, string> = {};
    for (const control of app.controls) next[control.key] = String(control.default);
    return next;
  }, [app.controls]);

  const [values, setValues] = useState<Record<string, string>>(defaults);
  const [uploads, setUploads] = useState<Record<string, UploadState | undefined>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [need, setNeed] = useState<string | null>(null);
  const [seed, setSeed] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState(0);
  const [compare, setCompare] = useState(50);
  const [toast, setToast] = useState<string | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<SceneCandidate[]>([]);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [searchProvider, setSearchProvider] = useState("");
  const [searching, setSearching] = useState(false);
  const [findingScene, setFindingScene] = useState(false);
  const [waited, setWaited] = useState(0);
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [scene, setScene] = useState<SceneModel | null>(null);
  const [sceneState, setSceneState] = useState<"idle" | "building" | "ready" | "error">("idle");
  const [polygonCount, setPolygonCount] = useState(0);
  /** Steps layout: a step the person went back to, over the one the state implies. */
  const [pick, setPick] = useState<Step | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sceneToken = useRef(0);
  const sceneOrbitRef = useRef<SceneOrbitHandle | null>(null);
  const stepRef = useRef<ClientStep>("submit");
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [previewWidth, setPreviewWidth] = useState(640);

  const active = history.find((item) => item.id === activeId) ?? null;
  const busy = phase === "queued" || phase === "running";

  useEffect(() => {
    const node = previewRef.current;
    if (!node) return;
    const measure = () => setPreviewWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, view]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(timer);
  }, [toast]);

  function setControl(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    if (key === "celebrity") {
      setCandidates([]);
      setSelectedToken(null);
      setSearchProvider("");
      setNeed(null);
    }
  }

  async function findPhotos() {
    if (app.kind !== "paparazzi" || searching || busy) return;
    const name = controlValue(values, "celebrity").trim();
    if (name.length < 2) {
      setNeed("Enter a celebrity name.");
      return;
    }
    setSearching(true);
    setNeed(null);
    setError(null);
    try {
      const response = await fetch(`/api/paparazzi/search?q=${encodeURIComponent(name)}`);
      const payload = (await response.json()) as {
        provider?: string;
        candidates?: SceneCandidate[];
        error?: { message?: string };
      };
      if (!response.ok) {
        setCandidates([]);
        setSelectedToken(null);
        setSearchProvider("");
        setNeed(payload.error?.message || "Image search failed.");
        return;
      }
      const next = payload.candidates ?? [];
      setSearchProvider(payload.provider ?? "");
      setCandidates(next);
      setSelectedToken(next[0]?.token ?? null);
      if (next.length === 0) setNeed("No paparazzi photos found. Try another spelling, or upload a scene photo.");
    } catch {
      setNeed("Image search is unavailable right now. Try again or upload a scene photo.");
    } finally {
      setSearching(false);
    }
  }

  function imageSpec(role: string): CatalogImage | undefined {
    return app.images.find((image) => image.key === role);
  }

  function revokeUpload(upload: UploadState | undefined) {
    if (!upload) return;
    const urls = new Set<string>([upload.url]);
    if (upload.sourceUrl) urls.add(upload.sourceUrl);
    for (const shot of upload.shots ?? []) {
      urls.add(shot.url);
      if (shot.sourceUrl) urls.add(shot.sourceUrl);
    }
    for (const url of urls) URL.revokeObjectURL(url);
  }

  function rememberShots(role: string, sources: File[], prepared: { file: File; width: number; height: number }[]) {
    setUploads((current) => {
      revokeUpload(current[role]);
      const shots: Shot[] = prepared.map((item, index) => ({
        file: item.file,
        source: sources[index],
        url: URL.createObjectURL(item.file),
        name: sources[index]?.name || item.file.name,
        width: item.width,
        height: item.height,
      }));
      const first = shots[0];
      if (!first) {
        const next = { ...current };
        delete next[role];
        return next;
      }
      return { ...current, [role]: shots.length > 1 || imageSpec(role)?.multiple ? { ...first, shots } : first };
    });
  }

  async function takeFiles(role: string, incoming: File[]) {
    if (incoming.length === 0) return;
    const spec = imageSpec(role);
    setNeed(null);
    setError(null);
    try {
      if (spec?.accept === "video") {
        const file = incoming[0];
        if (app.kind === "reverse-3d") {
          const reason = file ? videoTypeRejectReason(file) : "Upload a video.";
          if (reason || !file) {
            setNeed(reason);
            return;
          }
          const token = ++sceneToken.current;
          setScene(null);
          setPolygonCount(0);
          setSceneState("building");
          setNeed("Checking the clip…");
          try {
            const prepared = await prepareReverse3dUpload(file);
            if (token !== sceneToken.current) return;
            setUploads((current) => {
              revokeUpload(current[role]);
              return {
                ...current,
                [role]: {
                  file: prepared.file,
                  source: file,
                  url: URL.createObjectURL(prepared.file),
                  sourceUrl: URL.createObjectURL(file),
                  name: file.name,
                  width: prepared.width,
                  height: prepared.height,
                },
              };
            });
            setNeed("Asking which frame shows the subject…");
            const sampled = await sampleSceneFrames(prepared.file, prepared.duration);
            if (token !== sceneToken.current) return;
            const picked = await requestSubjectModel(sampled.frames, sampled.times);
            if (token !== sceneToken.current) return;
            setScene(picked);
            setSceneState("ready");
            setNeed(
              prepared.trimmed
                ? `Using the first ${REVERSE_3D_MAX_SECONDS} seconds of this clip.`
                : null,
            );
          } catch (err) {
            if (token !== sceneToken.current) return;
            setScene(null);
            setSceneState("error");
            setNeed(err instanceof Error ? err.message : "Could not read that video.");
          }
          return;
        }
        const reason = file ? videoRejectReason(file) : "Upload a video.";
        if (reason || !file) {
          setNeed(reason);
          return;
        }
        setUploads((current) => {
          revokeUpload(current[role]);
          return {
            ...current,
            [role]: {
              file,
              source: file,
              url: URL.createObjectURL(file),
              name: file.name,
              width: 0,
              height: 0,
            },
          };
        });
        return;
      }
      const accepted: File[] = [];
      for (const file of incoming) {
        const reason = imageRejectReason(file);
        if (reason) {
          setNeed(reason);
          if (accepted.length === 0) return;
          continue;
        }
        accepted.push(file);
      }
      if (accepted.length === 0) return;
      if (spec?.multiple) {
        const maxCount = spec.maxCount ?? 5;
        const existing = uploads[role]?.shots?.map((shot) => shot.source) ?? [];
        const overflow = existing.length + accepted.length > maxCount;
        const sources = [...existing, ...accepted].slice(0, maxCount);
        if (overflow) setNeed(`Use at most ${maxCount} product photos.`);
        const prepared = await packImages(sources, FORM_BUDGET_BYTES, 1280);
        rememberShots(role, sources, prepared);
        return;
      }
      const sharesVideo = app.images.some((image) => image.accept === "video");
      const prepared = await shrinkForUpload(accepted[0], sharesVideo ? 1280 : 2048, sharesVideo ? 280_000 : undefined);
      rememberShots(role, [accepted[0]], [prepared]);
    } catch (err) {
      setNeed(err instanceof Error ? err.message : "Could not read that image.");
    }
  }

  async function removeShot(role: string, index: number) {
    const shots = uploads[role]?.shots;
    if (!shots) return;
    const sources = shots.filter((_, shotIndex) => shotIndex !== index).map((shot) => shot.source);
    setNeed(null);
    try {
      if (sources.length === 0) {
        setUploads((current) => {
          revokeUpload(current[role]);
          const next = { ...current };
          delete next[role];
          return next;
        });
        return;
      }
      const prepared = await packImages(sources, FORM_BUDGET_BYTES, 1280);
      rememberShots(role, sources, prepared);
    } catch (err) {
      setNeed(err instanceof Error ? err.message : "Could not read that image.");
    }
  }

  function missingMessage(): string | null {
    if (app.kind === "paparazzi") {
      if (!uploads.user) return "Upload your face.";
      const name = controlValue(values, "celebrity").trim();
      if (!uploads.scene && !selectedToken && name.length < 2) return "Enter a celebrity name or upload a scene photo.";
      return null;
    }
    for (const image of app.images) {
      if (!image.optional && !uploads[image.key]) {
        if (app.kind === "tryon") return "Upload a person and a garment.";
        if (app.kind === "swap") return "Upload a hand photo and a product.";
        if (app.kind === "sprite") return "Upload a character image.";
        if (app.kind === "product-swap") return "Upload a clip and a product photo.";
        if (app.kind === "unboxing") return "Add at least one product photo.";
        if (app.kind === "carve") return "Upload an image to carve.";
        if (app.kind === "reverse-3d") return "Upload a finished clip.";
        return "Upload an image first.";
      }
    }
    if (app.kind === "reverse-3d") {
      if (sceneState === "building") return "Building the 3D subject…";
      if (sceneState !== "ready" || !scene) return "Could not build a 3D subject from that clip.";
    }
    return null;
  }

  function formBytes(): number {
    let total = 0;
    for (const image of app.images) {
      const upload = uploads[image.key];
      if (!upload) continue;
      const shots = upload.shots ?? [upload];
      for (const shot of shots) total += shot.file.size;
    }
    return total;
  }

  function labelFor(next = values): string {
    if (app.kind === "relight") {
      const preset = controlValue(next, "preset");
      return `${preset[0]?.toUpperCase()}${preset.slice(1)} · light ${controlValue(next, "direction")} · ${controlValue(next, "intensity")}%`;
    }
    if (app.kind === "upscale") return `${controlValue(next, "scale")}×`;
    if (app.kind === "sprite") {
      const frames = controlValue(next, "frames") || Object.keys(app.grids ?? {})[0] || "8";
      const grid = app.grids?.[frames];
      const gridLabel = grid ? `${grid.cols}×${grid.rows}` : frames;
      const style = controlValue(next, "style");
      return `${frames} frames · ${gridLabel} · ${style === "3d" ? "3D" : style}`;
    }
    if (app.kind === "tryon") return `${controlValue(next, "fit")} fit`;
    if (app.kind === "swap") return controlValue(next, "resolution") || "2K";
    if (app.kind === "product-swap") {
      const note = controlValue(next, "description").trim();
      const size = controlValue(next, "videoSize") || "480p";
      return note ? `${size} · ${note}` : size;
    }
    if (app.kind === "unboxing") {
      const box = controlValue(next, "box");
      const option = app.controls.find((control) => control.key === "box");
      const label = option && option.type === "cards" ? option.options.find((item) => item.value === box)?.label : box;
      return label || "Box";
    }
    if (app.kind === "carve") return "9:16 timelapse";
    if (app.kind === "reverse-3d") {
      return polygonCount > 0 ? `Blocky playblast · ${polygonCount} polygons` : "Blocky playblast";
    }
    if (app.kind === "paparazzi") {
      const name = controlValue(next, "celebrity").trim();
      const resolution = controlValue(next, "resolution") || "2K";
      return name ? `${resolution} · ${name}` : resolution;
    }
    return `${controlValue(next, "format").toUpperCase()} · ${controlValue(next, "background")}`;
  }

  function shotContext(): Pick<Recovery, "label" | "before" | "frames"> {
    const before: Record<string, string> = {};
    for (const image of app.images) {
      const upload = uploads[image.key];
      if (upload) before[image.key] = upload.sourceUrl || upload.url;
    }
    return {
      label: labelFor(),
      before,
      frames: controlValue(values, "frames") || Object.keys(app.grids ?? {})[0] || "8",
    };
  }

  function rememberResult(item: HistoryItem) {
    setHistory((current) => [...current.filter((entry) => entry.id !== item.id), item].slice(-5));
    setActiveId(item.id);
    setView(0);
    setPhase("done");
    setProgress(1);
    setWaited(0);
    setRecovery(null);
    setError(null);
    setNeed(null);
  }

  async function attachCompare(id: string, playUrl: string, originalUrl: string) {
    try {
      const compareBlob = await composeSideBySide(playUrl, originalUrl);
      const compareUrl = URL.createObjectURL(compareBlob);
      setHistory((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, compareBlob, compareUrl, compareError: undefined } : entry)),
      );
    } catch (compareErr) {
      const message = compareErr instanceof Error ? compareErr.message : "Could not build the comparison video.";
      setHistory((current) => current.map((entry) => (entry.id === id ? { ...entry, compareError: message } : entry)));
    }
  }

  async function saveOutput(target: Recovery, signal: AbortSignal) {
    if (!target.outputId || !target.sig) {
      throw new Error(app.output === "video" ? "The job finished without a video." : "The job finished without an image.");
    }
    stepRef.current = "download";
    const outputUrl = `/api/outputs/${encodeURIComponent(target.outputId)}?sig=${encodeURIComponent(target.sig)}`;
    let response: Awaited<ReturnType<typeof fetchBlobRetrying>>["response"];
    let blob: Blob | null = null;
    try {
      const read = await fetchBlobRetrying(outputUrl, { signal }, fetch);
      response = read.response;
      blob = read.blob;
    } catch (error) {
      if (signal.aborted) throw error;
      setRecovery({ ...target, kind: "download" });
      throw error;
    }
    if (!response.ok || !blob) {
      setRecovery({ ...target, kind: "download" });
      const body = await readJsonBody(response).catch(() => null);
      throw new Error(httpErrorMessage(response.status, body, "Could not download the result."));
    }
    const url = URL.createObjectURL(blob);
    const video = blob.type.startsWith("video/");
    const dims = await measureBlob(url, video);
    const item: HistoryItem = {
      id: target.jobId,
      blob,
      url,
      before: target.before,
      label: target.label,
      frames: target.frames,
      width: dims.width,
      height: dims.height,
      video,
    };
    rememberResult(item);
    const originalUrl = target.before.video;
    if (app.kind === "reverse-3d" && video && originalUrl) await attachCompare(item.id, url, originalUrl);
  }

  async function followJob(target: Recovery, controller: AbortController) {
    stepRef.current = "status";
    const started = Date.now();
    const limit = app.pollMs;
    let failures = 0;
    let job: JobView | null = null;
    while (!job || !TERMINAL_STATUSES.includes(job.status)) {
      const elapsed = Date.now() - started;
      setWaited(Math.round(elapsed / 1000));
      if (elapsed > limit) {
        setRecovery({ ...target, kind: "status" });
        const minutes = Math.round(limit / 60000);
        throw new Error(
          app.output === "video"
            ? `Timed out after about ${minutes} minutes. If the deployment is stopped, start it (3 active max). If it is still cold-starting, wait and run again.`
            : "Timed out waiting for this deployment. If it is stopped, start it (3 active max). If it is still cold-starting, wait and run again.",
        );
      }
      await sleep(job ? (app.output === "video" ? 2500 : 1750) : 400, controller.signal);
      let statusRes: Response;
      try {
        statusRes = await fetch(`/api/jobs/${target.jobId}`, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        failures += 1;
        if (failures >= 4) {
          setRecovery({ ...target, kind: "status" });
          throw error;
        }
        continue;
      }
      if (!statusRes.ok) {
        failures += 1;
        if (failures >= 4) {
          setRecovery({ ...target, kind: "status" });
          const body = await readJsonBody(statusRes).catch(() => null);
          throw new Error(httpErrorMessage(statusRes.status, body, "Could not read job status."));
        }
        continue;
      }
      let next: JobView;
      try {
        next = (await statusRes.json()) as JobView;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        failures += 1;
        if (failures >= 4) {
          setRecovery({ ...target, kind: "status" });
          throw error;
        }
        continue;
      }
      failures = 0;
      job = next;
      if (job.status === "queued") setPhase("queued");
      if (job.status === "running" || job.status === "canceling") setPhase("running");
      if (typeof job.progress === "number") setProgress(job.progress);
    }

    if (job.status !== "succeeded") {
      const detail = job.error?.message || statusMessage(job.status);
      throw new Error(detail.startsWith("HTTP ") ? detail : `Job ${job.status}: ${detail}`);
    }
    const output = job.outputs[0];
    if (!output?.sig) throw new Error(app.output === "video" ? "The job finished without a video." : "The job finished without an image.");
    await saveOutput({ ...target, kind: "download", outputId: output.id, sig: output.sig }, controller.signal);
  }

  async function resume() {
    if (!recovery || busy) return;
    const current = recovery;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setError(null);
    setNeed(null);
    setPhase(current.kind === "download" ? "running" : "queued");
    stepRef.current = current.kind;
    try {
      if (current.kind === "download") await saveOutput(current, controller.signal);
      else await followJob(current, controller);
    } catch (err) {
      setFindingScene(false);
      if (controller.signal.aborted) return;
      setPhase("error");
      setWaited(0);
      setError(clientFailureMessage(stepRef.current, err));
    }
  }

  async function run() {
    const missing = missingMessage();
    if (missing) {
      setNeed(missing);
      return;
    }
    const budget = app.images.some((image) => image.accept === "video") ? VIDEO_FORM_BUDGET_BYTES : FORM_BUDGET_BYTES;
    let sceneFile: File | null = null;
    if (app.kind === "reverse-3d") {
      try {
        const blob = await sceneOrbitRef.current?.capture();
        if (!blob) {
          setNeed("The 3D scene is not ready yet.");
          return;
        }
        sceneFile = new File([blob], "scene.png", { type: "image/png" });
      } catch (err) {
        setNeed(err instanceof Error ? err.message : "Could not read the 3D scene.");
        return;
      }
    }
    if (formBytes() + (sceneFile?.size ?? 0) > budget) {
      setNeed("These files are over the upload limit. Trim the video or use smaller photos.");
      return;
    }
    if (busy) return;
    setError(null);
    setNeed(null);
    setRecovery(null);
    setWaited(0);
    const nextSeed = app.hasSeed ? randomSeed() : null;
    setSeed(nextSeed);
    setPhase("queued");
    setProgress(0);
    setFindingScene(app.kind === "paparazzi" && !uploads.scene);

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    stepRef.current = "submit";

    try {
      const form = new FormData();
      for (const image of app.images) {
        const upload = uploads[image.key];
        if (!upload) continue;
        const shots = upload.shots ?? [upload];
        for (const shot of shots) form.append(image.key, shot.file, shot.file.name);
      }
      for (const control of app.controls) {
        if ("clientOnly" in control && control.clientOnly) continue;
        form.append(control.key, controlValue(values, control.key));
      }
      if (app.kind === "sprite" && app.grids && !app.controls.some((control) => control.key === "frames")) {
        form.append("frames", Object.keys(app.grids)[0] ?? "8");
      }
      if (nextSeed !== null) form.append("seed", String(nextSeed));
      if (app.kind === "paparazzi" && !uploads.scene && selectedToken) form.append("sceneToken", selectedToken);
      if (sceneFile) form.append("scene", sceneFile, sceneFile.name);

      const response = await fetch(app.endpoint, { method: "POST", body: form, signal: controller.signal });
      setFindingScene(false);
      const payload = await readJsonBody<RunResponse>(response);
      if (!response.ok || !payload?.jobId) throw new Error(httpErrorMessage(response.status, payload, "The run failed."));
      await followJob({ kind: "status", jobId: payload.jobId, ...shotContext() }, controller);
    } catch (err) {
      setFindingScene(false);
      if (controller.signal.aborted) return;
      setPhase("error");
      setWaited(0);
      setError(clientFailureMessage(stepRef.current, err));
    }
  }

  async function onDownload() {
    if (!active) return;
    try {
      if (app.kind === "cutout") {
        const background = controlValue(values, "background") as BackgroundValue;
        const format = controlValue(values, "format") as FormatValue;
        const blob =
          background === "transparent" && format === "png"
            ? active.blob
            : await exportCutout(active.url, background, format);
        const filename = `${app.id}.${format}`;
        downloadBlob(blob, filename);
        setToast(filename);
        return;
      }
      const type = active.blob.type;
      const ext = type.startsWith("video/")
        ? type.includes("webm")
          ? "webm"
          : "mp4"
        : type.includes("jpeg")
          ? "jpg"
          : type.includes("webp")
            ? "webp"
            : "png";
      if (app.kind === "reverse-3d") {
        if (view === 1 && active.compareBlob) {
          const compareType = active.compareBlob.type;
          const compareExt = compareType.includes("mp4") ? "mp4" : "webm";
          const filename = `${app.id}-compare.${compareExt}`;
          downloadBlob(active.compareBlob, filename);
          setToast(filename);
          return;
        }
        const filename = `${app.id}-playblast.${ext}`;
        downloadBlob(active.blob, filename);
        setToast(filename);
        return;
      }
      const filename = `${app.id}.${ext}`;
      downloadBlob(active.blob, filename);
      setToast(filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not download that result.");
    }
  }

  const background = controlValue(values, "background");
  const stageStyle =
    app.kind === "cutout" && active
      ? background === "white"
        ? { background: "#fff" }
        : background === "lilac"
          ? { background: LILAC }
          : undefined
      : undefined;
  const checker = app.kind === "cutout" && active && background === "transparent";
  const primaryKey = app.images[0]?.key;
  const primaryUpload = primaryKey ? uploads[primaryKey] : undefined;
  const beforeUrl = (primaryKey && active?.before[primaryKey]) || "";
  const showCompare = view === 1 && app.views[1] === "Compare" && active && beforeUrl && app.kind !== "reverse-3d";
  const showVideoCompare = view === 1 && app.kind === "reverse-3d" && active;
  const showSprite = view === 1 && app.kind === "sprite" && active;
  const grid = app.grids?.[active?.frames || Object.keys(app.grids ?? {})[0] || "8"] ?? { cols: 4, rows: 2 };
  const polygonValue = Number(controlValue(values, "polygons")) || SCENE_POLYGON_DEFAULT;
  const showScenePreview = app.kind === "reverse-3d" && scene && !active;
  const sceneCaption = scene
    ? `Drag to orbit · ${scene.time.toFixed(1)}s · ${polygonCount > 0 ? `${polygonCount} polygons` : "mesh"}`
    : "Picking the subject…";
  const sceneView =
    app.kind === "reverse-3d" && scene ? (
      <SceneOrbit
        ref={sceneOrbitRef}
        positions={scene.positions}
        indices={scene.indices}
        polygons={polygonValue}
        onPolygonCount={setPolygonCount}
      />
    ) : null;

  const selectedScene = selectedToken ? `/api/paparazzi/scene?token=${encodeURIComponent(selectedToken)}` : "";
  const status = findingScene
    ? "Searching for a paparazzi photo"
    : statusLine(phase, progress, error, primaryUpload, active, waited, app.output);
  const bar = phase === "idle" ? 0 : phase === "done" ? 1 : phase === "error" ? 0 : progress || (phase === "queued" ? 0.08 : 0.2);
  const pillClass = phase === "running" || phase === "queued" ? "run" : phase === "done" ? "done" : phase === "error" ? "err" : "";
  const pillText = findingScene
    ? "Searching"
    : phase === "queued"
      ? "Queued"
      : phase === "running"
        ? `Running ${Math.round(progress * 100)}%`
        : phase === "done"
          ? "Done"
          : phase === "error"
            ? errorHttpLabel(error)
            : "Idle";

  const rmeta = active
    ? app.kind === "upscale"
      ? `${active.width} × ${active.height} · ${active.label}`
      : active.label
    : "";

  if (layout === "steps" && app.kind === "reverse-3d") {
    const video = uploads.video;
    const slider = app.controls.find((control) => control.key === "polygons");
    const reached: Step = active ? 3 : video ? 2 : 1;
    const implied: Step = phase === "error" && video ? 2 : reached;
    const step: Step = busy ? 3 : (pick ?? implied);
    const message = phase === "error" && error ? error : need;
    const takeVideo = (file: File) => {
      setPick(null);
      setActiveId(null);
      setPhase("idle");
      setError(null);
      setRecovery(null);
      void takeFiles("video", [file]);
    };
    const saveCompare = () => {
      if (!active?.compareBlob) return;
      const ext = active.compareBlob.type.includes("mp4") ? "mp4" : "webm";
      const filename = `${app.id}-side-by-side.${ext}`;
      downloadBlob(active.compareBlob, filename);
      setToast(filename);
    };
    const fill =
      slider && slider.type === "slider" && slider.max !== slider.min
        ? ((polygonValue - slider.min) / (slider.max - slider.min)) * 100
        : 0;
    return (
      <article className="card r3d" data-step={step}>
        <StepNav
          step={step}
          reached={busy ? 3 : reached}
          onPick={(next) => {
            if (busy) return;
            setPick(next === implied ? null : next);
          }}
        />
        {step === 1 ? (
          <div className="r3d-one">
            <DropZone
              title="Which shot should we un‑render?"
              sub={`MP4, MOV or WebM · 3 to ${REVERSE_3D_MAX_SECONDS} s`}
              hot={hot === "video"}
              onHot={(on) => setHot(on ? "video" : null)}
              onFile={takeVideo}
            />
            <div className="need" role="status">
              {sceneState === "building" && !video ? <span className="r3d-wait">{need || "Checking the clip…"}</span> : message}
            </div>
            {video ? (
              <button type="button" className="btn r3d-keep" onClick={() => setPick(null)}>
                Keep {video.name} <span className="arrow" aria-hidden="true">→</span>
              </button>
            ) : null}
          </div>
        ) : null}
        {step === 2 && video ? (
          <div className="r3d-two">
            <div
              className="preview r3d-view"
              data-hud={scene ? "persp · drag to orbit" : sceneState === "building" ? "persp · building the blockout" : "persp"}
            >
              {scene ? (
                sceneView
              ) : (
                <div className="shot-wrap">
                  <video className="shot" src={video.url} muted playsInline loop autoPlay />
                </div>
              )}
            </div>
            <div className="r3d-side">
              <h2>How blocky?</h2>
              <p>Fewer polygons make bigger, sillier blocks.</p>
              {slider && slider.type === "slider" ? (
                <div className="r3d-amount">
                  <div className="slider">
                    <input
                      type="range"
                      min={slider.min}
                      max={slider.max}
                      step={slider.step}
                      value={polygonValue}
                      aria-label="How blocky"
                      aria-valuetext={polygonCount > 0 ? `${polygonCount} polygons` : undefined}
                      disabled={!scene}
                      style={{ ["--fill" as string]: `${fill}%` }}
                      onChange={(event) => setControl("polygons", event.target.value)}
                    />
                  </div>
                  <div className="r3d-ends" aria-hidden="true">
                    <span>LEGO</span>
                    <span>almost real</span>
                  </div>
                </div>
              ) : null}
              <div className="need" role="status">
                {sceneState === "building" && !(phase === "error" && error) ? <span className="r3d-wait">{need || "Building the blockout…"}</span> : message}
              </div>
              {sceneState === "error" ? (
                <PickButton className="btn" onFile={takeVideo}>
                  Try another video
                </PickButton>
              ) : (
                <button
                  className="run"
                  type="button"
                  onClick={() => {
                    setPick(null);
                    void (recovery && phase === "error" ? resume() : run());
                  }}
                  disabled={busy || sceneState !== "ready"}
                >
                  <span className="label">
                    {recovery && phase === "error" ? (
                      recovery.kind === "download" ? "Retry download" : "Check job"
                    ) : (
                      <>
                        Make playblast <span className="arrow" aria-hidden="true">→</span>
                      </>
                    )}
                  </span>
                </button>
              )}
            </div>
          </div>
        ) : null}
        {step === 3 ? (
          <div className="r3d-three">
            {busy ? (
              <div className="preview r3d-busy" aria-live="polite">
                {video ? (
                  <div className="shot-wrap">
                    <video className="shot" src={video.url} muted playsInline loop autoPlay />
                  </div>
                ) : null}
                <div className="r3d-busy-card">
                  <b>{phase === "queued" ? "Queued…" : `Un-rendering · ${Math.round(progress * 100)}%`}</b>
                  <span className="track" aria-hidden="true">
                    <i style={{ width: `${Math.round(bar * 100)}%` }} />
                  </span>
                </div>
              </div>
            ) : active ? (
              <VideoSplit
                original={active.before.video || video?.url || active.url}
                playblast={active.url}
                position={compare}
                onChange={setCompare}
              />
            ) : null}
            <div className="r3d-row">
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setPick(2)}>
                <span className="arrow" aria-hidden="true">←</span> Tweak again
              </button>
              {toast ? (
                <span className="toast r3d-toast">
                  ✓ Saved <b>{toast}</b>
                </span>
              ) : null}
              {active && !busy ? (
                <DownloadMenu
                  compareReady={Boolean(active.compareBlob)}
                  compareNote={active.compareBlob ? "Final and playblast together" : active.compareError ? "Could not build it" : "Getting it ready…"}
                  onPlayblast={() => void onDownload()}
                  onCompare={saveCompare}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <article className="card">
      <header className="hd">
        <span className={`icon${app.icon === "hanger" ? " hanger" : ""}`} aria-hidden>
          <AppIcon name={app.icon} />
        </span>
        {app.tagline ? <p className="tagline">{app.tagline}</p> : <span className="sp" />}
        <span className="chip endpoint" title={`POST ${app.endpoint}`}>
          <span className="m">POST</span>
          <span className="path">{app.endpoint}</span>
        </span>
        <div className={`pill ${pillClass}`} aria-live="polite">
          <i />
          {pillText}
        </div>
      </header>
      <div className="body">
        <div className="panel">
          <div className="panel-scroll">
          {app.controls
            .filter((control): control is TextControl => control.type === "text" && control.key === "celebrity")
            .map((control) => (
              <ControlField
                key={control.key}
                control={control}
                value={controlValue(values, control.key)}
                searching={searching}
                onChange={(next) => setControl(control.key, next)}
                onFind={() => void findPhotos()}
              />
            ))}
          {candidates.length > 0 ? (
            <div>
              <div className="lab">
                Scenes
                <b>{searchProvider ? `from ${searchProvider}` : "pick one"}</b>
              </div>
              <div className="scene-pick" role="listbox" aria-label="Paparazzi scenes">
                {candidates.map((candidate) => (
                  <button
                    key={candidate.token}
                    type="button"
                    role="option"
                    aria-selected={candidate.token === selectedToken}
                    className={candidate.token === selectedToken ? "on" : ""}
                    title={candidate.title}
                    onClick={() => setSelectedToken(candidate.token)}
                  >
                    <img src={`/api/paparazzi/scene?token=${encodeURIComponent(candidate.token)}`} alt="" />
                  </button>
                ))}
              </div>
              <p className="field-note">The first scene is used unless you pick another. An uploaded scene overrides this.</p>
            </div>
          ) : null}
          {app.images
            .filter((image) => image.key !== "scene")
            .map((image) => (
              <UploadField
                key={image.key}
                image={image}
                upload={uploads[image.key]}
                hot={hot === image.key}
                onFiles={(files) => void takeFiles(image.key, files)}
                onRemove={(index) => void removeShot(image.key, index)}
                onHot={(on) => setHot(on ? image.key : null)}
              />
            ))}
          {app.controls
            .filter((control) => control.key !== "celebrity")
            .map((control) => (
            <div key={control.key}>
              <div className="lab">
                {control.label}
                {control.type === "slider" ? (
                  <b>{control.key === "polygons" && polygonCount > 0 ? polygonCount : controlValue(values, control.key)}</b>
                ) : null}
                {control.type === "text" && control.optional ? <b>optional</b> : null}
              </div>
              {control.type === "seg" ? (
                <div className="seg" role="radiogroup" aria-label={control.label}>
                  {control.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={controlValue(values, control.key) === option.value ? "on" : ""}
                      aria-checked={controlValue(values, control.key) === option.value}
                      role="radio"
                      onClick={() => setControl(control.key, option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {control.type === "select" ? (
                <select className="select" value={controlValue(values, control.key)} aria-label={control.label} onChange={(event) => setControl(control.key, event.target.value)}>
                  {control.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : null}
              {control.type === "slider" ? (
                <div className="slider">
                  <input
                    type="range"
                    min={control.min}
                    max={control.max}
                    step={control.step}
                    value={controlValue(values, control.key)}
                    aria-label={control.label}
                    style={{
                      ["--fill" as string]: `${control.max === control.min ? 0 : ((Number(controlValue(values, control.key)) - control.min) / (control.max - control.min)) * 100}%`,
                    }}
                    onChange={(event) => setControl(control.key, event.target.value)}
                  />
                </div>
              ) : null}
              {control.type === "slider" && control.key === "polygons" && scene ? (
                <p className="field-note">
                  {scene.subject} at {scene.time.toFixed(1)}s. Drag left for bigger boxes. Changes stay in the browser.
                </p>
              ) : null}
              {control.type === "text" ? (
                <>
                  {control.multiline === false ? (
                    <input
                      className="text"
                      placeholder={control.placeholder}
                      value={controlValue(values, control.key)}
                      aria-label={control.label}
                      maxLength={400}
                      onChange={(event) => setControl(control.key, event.target.value)}
                    />
                  ) : (
                    <textarea
                      className="text"
                      placeholder={control.placeholder}
                      value={controlValue(values, control.key)}
                      aria-label={control.label}
                      maxLength={800}
                      onChange={(event) => setControl(control.key, event.target.value)}
                    />
                  )}
                  {control.hint ? <p className="field-note">{control.hint}</p> : null}
                </>
              ) : null}
              {control.type === "cards" ? (
                <>
                  <div className="box-pick" role="radiogroup" aria-label={control.label}>
                    {control.options.map((option) => {
                      const selected = controlValue(values, control.key) === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={selected ? "on" : ""}
                          onClick={() => setControl(control.key, option.value)}
                        >
                          <img src={option.image} alt="" />
                          <span>{option.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  {control.hint ? <p className="field-note">{control.hint}</p> : null}
                </>
              ) : null}
            </div>
          ))}
          {app.images
            .filter((image) => image.key === "scene")
            .map((image) => (
              <UploadField
                key={image.key}
                image={image}
                upload={uploads[image.key]}
                hot={hot === image.key}
                onFiles={(files) => void takeFiles(image.key, files)}
                onRemove={(index) => void removeShot(image.key, index)}
                onHot={(on) => setHot(on ? image.key : null)}
              />
            ))}
          {app.kind === "reverse-3d" && scene && active ? (
            <div className="scene-dock">
              {sceneView}
              <div className="scene-caption">{sceneCaption}</div>
            </div>
          ) : null}
          {app.hasSeed ? (
            <div className="seedline">
              Seed <b>{seed ?? "—"}</b>
            </div>
          ) : null}
          </div>
          <div className="need" role="status">
            {phase === "error" && error ? error : need}
          </div>
          <button className="run" type="button" onClick={() => void (recovery && phase === "error" ? resume() : run())} disabled={busy || searching || (app.kind === "reverse-3d" && Boolean(uploads.video) && sceneState !== "ready")}>
            <span className="label">
              {busy ? (
                findingScene ? "Searching…" : phase === "queued" ? "Queued…" : "Running…"
              ) : recovery && phase === "error" ? (
                recovery.kind === "download" ? "Retry download" : "Check job"
              ) : active ? (
                "↻ Run again"
              ) : (
                <>
                  {app.runLabel} <span className="arrow" aria-hidden="true">→</span>
                </>
              )}
            </span>
            <span className="bar" style={{ width: `${Math.round(bar * 100)}%` }} />
          </button>
        </div>
        <div className="main">
          <div className="toolbar">
            {app.views.length > 1 ? (
              <div className="seg" role="tablist" aria-label="Result view">
                {app.views.map((name, index) => (
                  <button key={name} type="button" role="tab" aria-selected={view === index} className={view === index ? "on" : ""} onClick={() => setView(index)}>
                    {name}
                  </button>
                ))}
              </div>
            ) : null}
            <span className="rmeta">{rmeta}</span>
            <span className="sp" />
            <button className="btn" type="button" disabled={busy || (!active && !(recovery && phase === "error"))} onClick={() => void run()}>
              {recovery && phase === "error" ? "↻ Run again" : "↻ Retry"}
            </button>
            <button className="btn dark" type="button" disabled={!active} onClick={() => void onDownload()}>
              <span className="arrow" aria-hidden="true">↓</span>
              {app.kind === "reverse-3d" && view === 1 ? "Download compare" : app.kind === "reverse-3d" ? "Download playblast" : "Download"}
            </button>
            {app.kind === "reverse-3d" && active?.compareBlob && view === 0 ? (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  const compareType = active.compareBlob?.type ?? "";
                  const compareExt = compareType.includes("mp4") ? "mp4" : "webm";
                  const filename = `${app.id}-compare.${compareExt}`;
                  downloadBlob(active.compareBlob!, filename);
                  setToast(filename);
                }}
              >
                <span className="arrow" aria-hidden="true">↓</span>
                Download compare
              </button>
            ) : null}
          </div>
          <div className={`preview ${checker ? "checker" : ""}`} ref={previewRef} style={stageStyle}>
            {!active && !app.images.some((image) => uploads[image.key]) && !selectedScene ? (
              <div className="pv-empty">
                <div className="big">✦</div>
                {app.empty}
              </div>
            ) : null}
            {active && !showCompare && !showSprite && !showVideoCompare ? (
              <div className="shot-wrap">
                <ResultMedia url={active.url} video={active.video} alt={`${app.name} result`} />
              </div>
            ) : null}
            {showVideoCompare && active ? (
              <div className="shot-wrap">
                {active.compareUrl ? (
                  <ResultMedia
                    url={active.compareUrl}
                    video
                    alt="Original on the left, playblast on the right"
                  />
                ) : (
                  <p className="pv-empty">
                    {active.compareError || "The comparison video could not be built. You can still download the playblast."}
                  </p>
                )}
              </div>
            ) : null}
            {showScenePreview ? (
              <div className="shot-wrap scene-stage">
                {sceneView}
                <div className="scene-caption">{sceneCaption}</div>
              </div>
            ) : null}
            {!active && primaryUpload && !showScenePreview ? (
              <div className="shot-wrap">
                <ResultMedia
                  url={primaryUpload.url}
                  video={imageSpec(primaryKey ?? "")?.accept === "video"}
                  alt="Uploaded file"
                />
                {app.kind === "reverse-3d" && sceneState === "building" ? <div className="scene-caption">{sceneCaption}</div> : null}
              </div>
            ) : null}
            {!active && !primaryUpload && selectedScene ? (
              <div className="shot-wrap">
                <img className="shot" src={selectedScene} alt="Selected paparazzi scene" />
              </div>
            ) : null}
            {showCompare ? (
              <Compare before={beforeUrl} after={active.url} position={compare} width={previewWidth} onChange={setCompare} />
            ) : null}
            {showSprite && active ? (
              <SpritePlayer
                key={active.url}
                url={active.url}
                frames={Number(active.frames)}
                cols={grid.cols}
                rows={grid.rows}
                sheetWidth={active.width}
                sheetHeight={active.height}
              />
            ) : null}
            {toast ? (
              <div className="toast">
                ✓ Saved <b>{toast}</b>
              </div>
            ) : null}
          </div>
          <div className="foot">
            <div>
              <div className="lab">History</div>
              <div className="slots">
                {Array.from({ length: 5 }, (_, index) => history[index] ?? null).map((item, index) => (
                  <button
                    key={item?.id ?? `empty-${index}`}
                    className={`slot ${item && item.id === activeId ? "on" : ""}`}
                    type="button"
                    disabled={!item}
                    onClick={() => item && setActiveId(item.id)}
                    aria-label={item ? `Result ${index + 1}` : "Empty history slot"}
                  >
                    {item ? (
                      item.video ? <video src={item.url} muted playsInline preload="metadata" /> : <img src={item.url} alt="" />
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
            <div className="status">
              <div className="st">
                {status}
              </div>
              <div className="track" aria-hidden>
                <i style={{ width: `${Math.round(bar * 100)}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function serverErrorText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as { error?: unknown; message?: unknown };
  const nested = record.error;
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  if (nested && typeof nested === "object" && typeof (nested as { message?: unknown }).message === "string") {
    const message = (nested as { message: string }).message.trim();
    if (message) return message;
  }
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  return undefined;
}

async function readJsonBody<T = unknown>(response: { text(): Promise<string> }): Promise<T | null> {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function httpErrorMessage(status: number, payload: unknown, fallback: string): string {
  const server = serverErrorText(payload);
  if (server) return `HTTP ${status}: ${server}`;
  if (status === 413) return "HTTP 413: The upload was over the server limit of about 4.5 MB. Trim the clip or wait for it to compress.";
  return `HTTP ${status}: ${fallback}`;
}

function errorHttpLabel(error: string | null): string {
  const match = error?.match(/^HTTP\s+(\d{3})\b/);
  return match ? `Error ${match[1]}` : "Error";
}

function statusMessage(status: string): string {
  if (status === "canceled") return "This job was canceled.";
  if (status === "expired") return "This job expired before it finished.";
  return "The job failed.";
}

function statusLine(
  phase: Phase,
  progress: number,
  error: string | null,
  primary: UploadState | undefined,
  active: HistoryItem | null,
  waited: number,
  output: "image" | "video",
): string {
  if (error && phase === "error") return error;
  if (phase === "queued") {
    const clock = waited > 0 ? ` · ${waited}s` : "";
    return `Queued${clock} · the deployment may be cold-starting`;
  }
  if (phase === "running") {
    const pct = Math.round(progress * 100);
    if (output === "video") return `Running · ${pct}% · ${waited}s · video jobs take several minutes`;
    return `Running · ${pct}%`;
  }
  if (phase === "done" && active) {
    if (active.video && active.width > 0 && active.height > 0) return `Done · ${active.width} × ${active.height}`;
    if (active.video) return "Done · video";
    return `Done · ${active.width} × ${active.height}`;
  }
  if (primary) return `Ready · ${primary.name}`;
  return "Waiting for input";
}

function measureBlob(url: string, video: boolean): Promise<{ width: number; height: number }> {
  if (video) {
    // Detached <video> elements may never fire loadedmetadata (Safari/iOS, background tabs),
    // which used to leave a finished job stuck on "running". Never wait more than a few seconds.
    return new Promise((resolve) => {
      let settled = false;
      const done = (size: { width: number; height: number }) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(size);
      };
      const timer = window.setTimeout(() => done({ width: 0, height: 0 }), 4000);
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.preload = "metadata";
      el.onloadedmetadata = () => done({ width: el.videoWidth, height: el.videoHeight });
      el.onerror = () => done({ width: 0, height: 0 });
      el.src = url;
      el.load();
    });
  }
  return new Promise((resolve) => {
    window.setTimeout(() => resolve({ width: 0, height: 0 }), 8000);
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

function ResultMedia({ url, video, alt }: { url: string; video: boolean; alt: string }) {
  if (video) return <video className="shot" src={url} controls loop playsInline />;
  return <img className="shot" src={url} alt={alt} />;
}

function fileSizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function ControlField({
  control,
  value,
  searching,
  onChange,
  onFind,
}: {
  control: TextControl;
  value: string;
  searching: boolean;
  onChange: (value: string) => void;
  onFind: () => void;
}) {
  return (
    <div>
      <div className="lab">{control.label}</div>
      <div className="find-row">
        <input
          className="text"
          placeholder={control.placeholder}
          value={value}
          aria-label={control.label}
          maxLength={80}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onFind();
            }
          }}
        />
        <button className="btn dark" type="button" onClick={onFind} disabled={searching}>
          {searching ? "Searching…" : "Find photos"}
        </button>
      </div>
      {control.hint ? <p className="field-note">{control.hint}</p> : null}
    </div>
  );
}

function UploadField({
  image,
  upload,
  hot,
  onFiles,
  onRemove,
  onHot,
}: {
  image: CatalogImage;
  upload?: UploadState;
  hot: boolean;
  onFiles: (files: File[]) => void;
  onRemove: (index: number) => void;
  onHot: (on: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const video = image.accept === "video";
  const multiple = Boolean(image.multiple);
  const shots = upload?.shots ?? (upload ? [upload] : []);
  const accept = video
    ? "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
    : "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp";

  function openPicker() {
    inputRef.current?.click();
  }

  function takeList(list: FileList | null | undefined) {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    onFiles(multiple ? files : files.slice(0, 1));
  }

  return (
    <div>
      <div className="lab">
        {image.label}
        {image.optional ? <b>optional</b> : null}
        {multiple && shots.length > 0 ? <b>{shots.length}</b> : null}
      </div>
      <div
        className={`upload ${hot ? "hot" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={video ? `Upload ${image.label}` : `Upload ${image.label}`}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openPicker();
          }
        }}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          onHot(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          onHot(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) onHot(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          onHot(false);
          takeList(event.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          tabIndex={-1}
          aria-hidden="true"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            takeList(event.target.files);
            event.target.value = "";
          }}
        />
        {upload && !multiple ? (
          <div className="up-done">
            <div className="thumb">
              {video ? <video src={upload.url} muted playsInline preload="metadata" /> : <img src={upload.url} alt="" />}
            </div>
            <div className="up-meta">
              <div className="up-copy">
                <div className="fn">{upload.name}</div>
                <div className="dim">{video ? fileSizeLabel(upload.file.size) : `${upload.width} × ${upload.height}`}</div>
              </div>
              <span className="btn">↻ Replace</span>
            </div>
          </div>
        ) : (
          <div className="up-empty">
            <span className="hint">
              {video ? "Drop a clip or" : multiple && shots.length > 0 ? "Drop another photo or" : "Drop an image or"}
            </span>
            <span className="btn dark">
              <span className="arrow" aria-hidden="true">↑</span>
              {video ? "Upload video" : multiple && shots.length > 0 ? "Add photo" : "Upload image"}
            </span>
          </div>
        )}
      </div>
      {image.hint ? <p className="field-note">{image.hint}</p> : null}
      {multiple && shots.length > 0 ? (
        <div className="shot-row">
          {shots.map((shot, index) => (
            <div className="mini" key={`${shot.name}-${index}`}>
              <img src={shot.url} alt="" />
              <button type="button" aria-label={`Remove ${shot.name}`} onClick={() => onRemove(index)}>
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Compare({
  before,
  after,
  position,
  width,
  onChange,
}: {
  before: string;
  after: string;
  position: number;
  width: number;
  onChange: (value: number) => void;
}) {
  function move(clientX: number, box: HTMLDivElement) {
    const rect = box.getBoundingClientRect();
    const next = ((clientX - rect.left) / rect.width) * 100;
    onChange(Math.min(96, Math.max(4, next)));
  }
  return (
    <div
      className="compare"
      onPointerDown={(event) => {
        const box = event.currentTarget;
        box.setPointerCapture(event.pointerId);
        move(event.clientX, box);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event.clientX, event.currentTarget);
      }}
    >
      <img className="shot" src={after} alt="After" />
      <div className="clip" style={{ width: `${position}%` }}>
        <img className="shot" src={before} alt="Before" style={{ width }} />
      </div>
      <div className="handle" style={{ left: `${position}%` }}>
        <div className="knob">⇆</div>
      </div>
      <span className="tag b">Before</span>
      <span className="tag a">After</span>
    </div>
  );
}

function SpritePlayer({
  url,
  frames,
  cols,
  rows,
  sheetWidth,
  sheetHeight,
}: {
  url: string;
  frames: number;
  cols: number;
  rows: number;
  sheetWidth: number;
  sheetHeight: number;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const sheetW = sheetWidth > 0 ? sheetWidth : (measured?.width ?? 0);
  const sheetH = sheetHeight > 0 ? sheetHeight : (measured?.height ?? 0);
  const cellW = sheetW / Math.max(1, cols);
  const cellH = sheetH / Math.max(1, rows);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % Math.max(1, frames));
    }, 111);
    return () => window.clearInterval(timer);
  }, [frames, url]);

  useEffect(() => {
    if (sheetWidth > 0 && sheetHeight > 0) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setMeasured({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url, sheetWidth, sheetHeight]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || cellW <= 0 || cellH <= 0) return;
    const fit = () => {
      const style = getComputedStyle(el);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const availW = Math.max(1, el.clientWidth - padX);
      const availH = Math.max(1, el.clientHeight - padY);
      const aspect = cellW / cellH;
      let width = availW;
      let height = width / aspect;
      if (height > availH) {
        height = availH;
        width = height * aspect;
      }
      setBox({ width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [cellW, cellH]);

  const col = index % cols;
  const row = Math.floor(index / cols);
  const x = cols <= 1 ? 0 : (col / (cols - 1)) * 100;
  const y = rows <= 1 ? 0 : (row / (rows - 1)) * 100;
  return (
    <div className="sprite-stage" ref={stageRef}>
      {box ? (
        <div
          className="sprite-frame"
          style={{
            width: box.width,
            height: box.height,
            backgroundImage: `url("${url}")`,
            backgroundSize: `${cols * 100}% ${rows * 100}%`,
            backgroundPosition: `${x}% ${y}%`,
          }}
        />
      ) : null}
      <div className="cap">
        frame {index + 1} / {frames} · 9 fps
      </div>
    </div>
  );
}
