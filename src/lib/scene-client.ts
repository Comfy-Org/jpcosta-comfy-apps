import { parseSubjectChoice, selectMeshOutput, selectTextOutput, SUBJECT_FRAME_CAP } from "@/lib/subject-pipeline";
import { loadVideoElement, seekTo } from "@/lib/video-client";

export const SCENE_SAMPLE_LONG_SIDE = 512;

export type SceneModel = {
  positions: Float32Array;
  indices: Uint32Array;
  sourceFaces: number;
  reducedFaces: number;
  time: number;
  subject: string;
  /** Set only when the server returned the sample block figure. Not a Hunyuan result. */
  mock?: boolean;
};

type SubjectPayload = {
  mock?: boolean;
  step?: string;
  jobId?: string;
  frame?: number;
  subject?: string;
  time?: number;
  sourceFaces?: number;
  reducedFaces?: number;
  positions?: number[];
  indices?: number[];
  status?: string;
  cutout?: string;
  sig?: string;
  error?: { code?: string; message?: string } | string;
};

type JobPayload = {
  status?: string;
  error?: { message?: string } | null;
  outputs?: { id: string; name: string; sig?: string; type?: string; contentType?: string }[];
};

/**
 * Sample up to 12 frames across the accepted clip. The model, not this
 * function, decides which frame is the subject.
 */
export async function sampleSceneFrames(file: File, duration: number): Promise<{ frames: Blob[]; times: number[] }> {
  if (!(duration > 0)) throw new Error("Could not read that video.");
  const url = URL.createObjectURL(file);
  try {
    const video = await loadVideoElement(url);
    if (!video.videoWidth || !video.videoHeight) throw new Error("Could not read that video.");
    const playable = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
    const limit = Math.min(duration, playable);
    const long = Math.max(video.videoWidth, video.videoHeight);
    const scale = Math.min(1, SCENE_SAMPLE_LONG_SIDE / long);
    const width = Math.max(8, Math.round(video.videoWidth * scale));
    const height = Math.max(8, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not read that video.");
    const sampleCount = Math.min(SUBJECT_FRAME_CAP, Math.max(4, Math.round(limit * 2)));
    const frames: Blob[] = [];
    const times: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const time = Math.min(((index + 0.5) / sampleCount) * limit, Math.max(limit - 0.001, 0));
      await seekTo(video, time);
      ctx.drawImage(video, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("Could not read that video."))), "image/jpeg", 0.72);
      });
      frames.push(blob);
      times.push(time);
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    return { frames, times };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function asModel(payload: SubjectPayload, fallbackTime: number): SceneModel {
  if (!payload.positions || !payload.indices || !payload.subject) {
    throw new Error("Could not build a 3D subject from that clip.");
  }
  return {
    positions: new Float32Array(payload.positions),
    indices: new Uint32Array(payload.indices),
    sourceFaces: payload.sourceFaces ?? 0,
    reducedFaces: payload.reducedFaces ?? 0,
    time: payload.time ?? fallbackTime,
    subject: payload.subject,
    mock: payload.mock === true,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function pollJob(jobId: string): Promise<JobPayload> {
  const started = Date.now();
  while (Date.now() - started < 12 * 60 * 1000) {
    const response = await fetch(`/api/jobs/${jobId}`);
    const payload = await readJson<JobPayload>(response);
    if (!response.ok) throw new Error(payload.error?.message || "Could not build a 3D subject from that clip.");
    if (payload.status === "succeeded") return payload;
    if (payload.status === "failed" || payload.status === "canceled" || payload.status === "expired") {
      throw new Error(payload.error?.message || "Could not build a 3D subject from that clip.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("The 3D subject is taking too long.");
}

function errorMessage(payload: SubjectPayload, fallback: string): string {
  if (typeof payload.error === "string" && payload.error) return payload.error;
  if (payload.error && typeof payload.error === "object" && payload.error.message) return payload.error.message;
  return fallback;
}

const COLD_START = new Set(["deployment_not_ready", "timeout"]);

async function postSubject(form: FormData, onStatus?: (message: string) => void): Promise<SubjectPayload> {
  const started = Date.now();
  for (;;) {
    const response = await fetch("/api/reverse-3d/subject", { method: "POST", body: form });
    const payload = await readJson<SubjectPayload>(response);
    const code = payload.error && typeof payload.error === "object" ? payload.error.code : undefined;
    if (!response.ok && code && COLD_START.has(code) && Date.now() - started < 3 * 60 * 1000) {
      onStatus?.("The GPU worker is cold-starting. Waiting for it…");
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      continue;
    }
    if (!response.ok) throw new Error(errorMessage(payload, "Could not build a 3D subject from that clip."));
    return payload;
  }
}

async function postFrames(
  step: "pick" | "cutout",
  frames: Blob[],
  times: number[],
  onStatus?: (message: string) => void,
): Promise<SubjectPayload> {
  const form = new FormData();
  form.set("step", step);
  form.set("times", times.join(","));
  frames.forEach((frame, index) => form.append("frame", frame, `frame_${index + 1}.jpg`));
  return postSubject(form, onStatus);
}

async function pollCutout(jobId: string, onStatus?: (message: string) => void): Promise<{ cutout: string; sig: string }> {
  const started = Date.now();
  while (Date.now() - started < 12 * 60 * 1000) {
    const response = await fetch(`/api/reverse-3d/subject?cutoutJob=${encodeURIComponent(jobId)}`, { cache: "no-store" });
    const payload = await readJson<SubjectPayload>(response);
    if (!response.ok) throw new Error(errorMessage(payload, "The background cut-out failed."));
    if (payload.status === "succeeded" && payload.cutout && payload.sig) return { cutout: payload.cutout, sig: payload.sig };
    if (payload.status === "failed" || payload.status === "canceled" || payload.status === "expired") {
      throw new Error(errorMessage(payload, "The background cut-out failed."));
    }
    onStatus?.("Removing the background…");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("The background cut-out is taking too long.");
}

/**
 * Ask Gemini which frame to keep, cut that frame out, then load the Hunyuan mesh.
 * A mock server returns the block figure on the first response and does not call Comfy.
 * That figure is marked `mock` and is not a generated model.
 */
export async function requestSubjectModel(
  frames: Blob[],
  times: number[],
  onStatus?: (message: string) => void,
): Promise<SceneModel> {
  onStatus?.("Asking Gemini which frame shows the subject…");
  const picked = await postFrames("pick", frames, times, onStatus);
  if (picked.positions) return asModel(picked, times[picked.frame ?? 0] ?? 0);
  if (!picked.jobId) throw new Error("Could not build a 3D subject from that clip.");
  const choiceJob = await pollJob(picked.jobId);
  const textOutput = selectTextOutput(choiceJob.outputs ?? []);
  if (!textOutput?.sig) throw new Error("The model did not choose a frame.");
  const textResponse = await fetch(`/api/outputs/${textOutput.id}?sig=${textOutput.sig}`);
  if (!textResponse.ok) throw new Error("The model did not choose a frame.");
  const choice = parseSubjectChoice(await textResponse.text(), frames.length);
  const frame = frames[choice.frame];
  if (!frame) throw new Error("The model chose a frame that was not sampled.");
  onStatus?.("Removing the background…");
  const cutoutJob = await postFrames("cutout", [frame], [times[choice.frame] ?? 0], onStatus);
  if (cutoutJob.positions) {
    return asModel({ ...cutoutJob, subject: choice.subject, time: times[choice.frame] ?? 0 }, times[choice.frame] ?? 0);
  }
  let meshJob: SubjectPayload;
  if (cutoutJob.step === "hunyuan") {
    // The server skipped the cut-out (Background Removal is off) and started Hunyuan on the frame.
    meshJob = cutoutJob;
    onStatus?.("Building the 3D model…");
  } else {
    if (!cutoutJob.jobId || cutoutJob.jobId.includes("~")) {
      throw new Error("Could not build a 3D subject from that clip.");
    }
    const cutout = await pollCutout(cutoutJob.jobId, onStatus);
    onStatus?.("Building the 3D model…");
    const hunyuanForm = new FormData();
    hunyuanForm.set("step", "hunyuan");
    hunyuanForm.set("cutout", cutout.cutout);
    hunyuanForm.set("sig", cutout.sig);
    meshJob = await postSubject(hunyuanForm, onStatus);
  }
  if (meshJob.positions) {
    return asModel({ ...meshJob, subject: choice.subject, time: times[choice.frame] ?? 0 }, times[choice.frame] ?? 0);
  }
  if (!meshJob.jobId) throw new Error("Could not build a 3D subject from that clip.");
  const done = await pollJob(meshJob.jobId);
  const output = selectMeshOutput(done.outputs ?? []);
  if (!output?.sig) {
    throw new Error("Hunyuan finished without a committed GLB file, so this job cannot be downloaded.");
  }
  onStatus?.("Loading the mesh…");
  const reducedResponse = await fetch(`/api/reverse-3d/subject?output=${encodeURIComponent(output.id)}&sig=${output.sig}`);
  const reduced = await readJson<SubjectPayload>(reducedResponse);
  if (!reducedResponse.ok) throw new Error(errorMessage(reduced, "Could not build a 3D subject from that clip."));
  return asModel({ ...reduced, subject: choice.subject, time: times[choice.frame] ?? 0 }, times[choice.frame] ?? 0);
}
