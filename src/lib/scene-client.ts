import { layoutFrameScene, partBoxesMesh, type PartBoxes } from "@/lib/scene-mesh";
import {
  assembleScene,
  boxInCrop,
  closeUpCrop,
  parseSceneFind,
  parseSceneMarks,
  selectTextOutput,
  SUBJECT_FRAME_CAP,
  type FrameBox,
  type FramePart,
  type SceneFind,
  type SubjectKind,
  type SubjectScene,
} from "@/lib/subject-pipeline";
import { loadVideoElement, seekTo } from "@/lib/video-client";

export const SCENE_SAMPLE_LONG_SIDE = 512;
/** The frame shown behind the blocks is grabbed again at this size, so it stays sharp on a big screen. */
export const SCENE_PLATE_LONG_SIDE = 1280;
/** The chosen frame as the marking job sees it, next to the close-ups. */
export const SCENE_MARK_FRAME_SIDE = 1024;
/** Longer side of each subject's close-up. */
export const SCENE_CLOSE_UP_SIDE = 768;
/** The chosen frame is grabbed once at up to this size, and the plate, the frame and the close-ups are cut from it. */
const SCENE_GRAB_LONG_SIDE = 1920;

export type SceneModel = {
  /** The shot as named blocks, placed for the loading build. */
  parts: PartBoxes;
  /** The same blocks as one mesh, for the orbit view. */
  positions: Float32Array;
  indices: Uint32Array;
  sourceFaces: number;
  reducedFaces: number;
  time: number;
  /** Index of the chosen frame in the sampled frames. */
  frame: number;
  subject: string;
  /** The chosen frame, shown behind the blocks. */
  plate?: Blob | null;
  /** How many of each kind were found, such as "3 people and a bench". */
  found?: string;
  /** The poses could not be marked, so each subject is one block over where it stands. */
  rough?: boolean;
  /** Set only when the server returned the sample reply. Not a model result. */
  mock?: boolean;
};

type SubjectPayload = {
  mock?: boolean;
  step?: string;
  jobId?: string;
  frame?: number;
  subject?: string;
  time?: number;
  /** Mock mode only: the sample reply, read exactly like a model's. */
  reply?: string;
  error?: { code?: string; message?: string } | string;
};

type JobPayload = {
  status?: string;
  error?: { message?: string } | null;
  outputs?: { id: string; name: string; sig?: string; type?: string; contentType?: string }[];
};

/**
 * Encode the canvas right away. `toBlob` waits for a free main-thread task, and while the
 * loading build animates that took about a second per frame, so it held the 3D toy back.
 */
function jpegFrame(canvas: HTMLCanvasElement, quality = 0.72): Blob {
  const url = canvas.toDataURL("image/jpeg", quality);
  const comma = url.indexOf(",");
  if (!url.startsWith("data:image/jpeg") || comma < 0) throw new Error("Could not read that video.");
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/jpeg" });
}

/**
 * Sample up to 12 frames across the accepted clip. The model, not this
 * function, decides which frame is the subject.
 */
export async function sampleSceneFrames(file: File, duration: number): Promise<{ frames: Blob[]; times: number[]; aspect: number }> {
  if (!(duration > 0)) throw new Error("Could not read that video.");
  const url = URL.createObjectURL(file);
  try {
    const video = await loadVideoElement(url);
    if (!video.videoWidth || !video.videoHeight) throw new Error("Could not read that video.");
    const playable = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
    const limit = Math.min(duration, playable);
    // Read before the element is emptied below: an emptied video reports 0 by 0.
    const aspect = video.videoWidth / video.videoHeight;
    const long = Math.max(video.videoWidth, video.videoHeight);
    const scale = Math.min(1, SCENE_SAMPLE_LONG_SIDE / long);
    const width = Math.max(8, Math.round(video.videoWidth * scale));
    const height = Math.max(8, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not read that video.");
    const sampleCount = Math.min(SUBJECT_FRAME_CAP, Math.max(4, Math.round(limit * 2)));
    const frames: Blob[] = [];
    const times: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const time = Math.min(((index + 0.5) / sampleCount) * limit, Math.max(limit - 0.001, 0));
      await seekTo(video, time);
      ctx.drawImage(video, 0, 0, width, height);
      frames.push(jpegFrame(canvas));
      times.push(time);
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    return { frames, times, aspect };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One frame of the clip on a canvas, at up to `longSide`. */
async function grabCanvas(file: File, time: number, longSide: number): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const video = await loadVideoElement(url);
    if (!video.videoWidth || !video.videoHeight) throw new Error("Could not read that video.");
    const scale = Math.min(1, longSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(8, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(8, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not read that video.");
    await seekTo(video, Math.max(0, time));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    video.pause();
    video.removeAttribute("src");
    video.load();
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Part of `source` (x, y, width, height in its pixels) as a JPEG whose longer side is `longSide`, scaled evenly. */
function cutJpeg(source: HTMLCanvasElement, x: number, y: number, width: number, height: number, longSide: number, quality: number): Blob {
  const scale = longSide / Math.max(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(8, Math.round(width * scale));
  canvas.height = Math.max(8, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not read that video.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return jpegFrame(canvas, quality);
}

/** One frame of the clip as a JPEG, for the backdrop behind the blocks. */
export async function grabFrame(file: File, time: number, longSide = SCENE_PLATE_LONG_SIDE): Promise<Blob> {
  const canvas = await grabCanvas(file, time, longSide);
  return jpegFrame(canvas);
}

type CloseUp = { crop: FrameBox; image: Blob };

/**
 * One close-up per subject, cut from the full-size frame: its box with a margin, scaled up evenly.
 * The crop comes back rounded to whole pixels, exactly as it was cut, so the marks map back onto the frame.
 */
function closeUps(source: HTMLCanvasElement, find: SceneFind): CloseUp[] {
  const width = source.width;
  const height = source.height;
  return find.subjects.map((subject) => {
    const wanted = closeUpCrop(subject.box, width / height);
    const x = Math.round((wanted[1] / 1000) * width);
    const y = Math.round((wanted[0] / 1000) * height);
    const cutWidth = Math.max(8, Math.min(width - x, Math.round(((wanted[3] - wanted[1]) / 1000) * width)));
    const cutHeight = Math.max(8, Math.min(height - y, Math.round(((wanted[2] - wanted[0]) / 1000) * height)));
    const crop: FrameBox = [(y / height) * 1000, (x / width) * 1000, ((y + cutHeight) / height) * 1000, ((x + cutWidth) / width) * 1000];
    return { crop, image: cutJpeg(source, x, y, cutWidth, cutHeight, SCENE_CLOSE_UP_SIDE, 0.86) };
  });
}

const KIND_WORDS: Record<SubjectKind, [string, string]> = {
  person: ["person", "people"],
  animal: ["animal", "animals"],
  vehicle: ["vehicle", "vehicles"],
  object: ["object", "objects"],
};

/** "3 people, 1 vehicle and 1 object", in the order the kinds were first found. */
export function describeFound(find: Pick<SceneFind, "subjects">): string {
  const counts = new Map<SubjectKind, number>();
  for (const subject of find.subjects) counts.set(subject.kind, (counts.get(subject.kind) ?? 0) + 1);
  const words = [...counts].map(([kind, count]) => `${count} ${KIND_WORDS[kind][count === 1 ? 0 : 1]}`);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "nobody");
}

function asModel(scene: SubjectScene, aspect: number, times: number[], extra: Partial<SceneModel>): SceneModel {
  const parts = layoutFrameScene(scene, aspect);
  const mesh = partBoxesMesh(parts);
  const faces = mesh.indices.length / 3;
  return {
    parts,
    ...mesh,
    sourceFaces: faces,
    reducedFaces: faces,
    time: times[scene.frame] ?? 0,
    frame: scene.frame,
    subject: scene.subject,
    ...extra,
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function pollJob(jobId: string): Promise<JobPayload> {
  const started = Date.now();
  while (Date.now() - started < 3 * 60 * 1000) {
    const response = await fetch(`/api/jobs/${jobId}`);
    const payload = await readJson<JobPayload>(response);
    if (!response.ok) throw new Error(payload.error?.message || "Could not build a 3D blockout from that clip.");
    if (payload.status === "succeeded") return payload;
    if (payload.status === "failed" || payload.status === "canceled" || payload.status === "expired") {
      throw new Error(payload.error?.message || "Could not build a 3D blockout from that clip.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The 3D blockout is taking too long.");
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
    if (!response.ok) throw new Error(errorMessage(payload, "Could not build a 3D blockout from that clip."));
    return payload;
  }
}

async function postFrames(frames: Blob[], times: number[], onStatus?: (message: string) => void): Promise<SubjectPayload> {
  const form = new FormData();
  form.set("step", "pick");
  form.set("times", times.join(","));
  frames.forEach((frame, index) => form.append("frame", frame, `frame_${index + 1}.jpg`));
  return postSubject(form, onStatus);
}

/** The model's text reply: given at once by a mock server, otherwise read from the finished job. */
async function replyText(payload: SubjectPayload, missing: string): Promise<string> {
  if (typeof payload.reply === "string") return payload.reply;
  if (!payload.jobId) throw new Error("Could not build a 3D blockout from that clip.");
  const job = await pollJob(payload.jobId);
  const textOutput = selectTextOutput(job.outputs ?? []);
  if (!textOutput?.sig) throw new Error(missing);
  const textResponse = await fetch(`/api/outputs/${textOutput.id}?sig=${textOutput.sig}`);
  if (!textResponse.ok) throw new Error(missing);
  return textResponse.text();
}

/**
 * Two Gemini jobs build the 3D blockout. The first looks at the sampled frames, picks one and finds everyone in it.
 * The second gets that frame at full size and a close-up of each subject, and marks their parts on the joints.
 * No image-to-3D model runs, so the blockout is ready in well under a minute.
 * `onQueued` fires once the second job is on the deployment, so a video job can queue behind both.
 * `onStatus` gets a line for the status card and how far along the build is, 0 to 1.
 * A mock server answers each job with a sample reply and does not call Comfy.
 */
export async function requestSubjectModel(
  file: File,
  frames: Blob[],
  times: number[],
  aspect: number,
  onStatus?: (message: string, progress: number) => void,
  onQueued?: () => void,
): Promise<SceneModel> {
  onStatus?.("Finding everyone in the shot…", 0.12);
  const picked = await postFrames(frames, times, (message) => onStatus?.(message, 0.12));
  const find = parseSceneFind(await replyText(picked, "The model did not find anyone in the shot."), frames.length);
  const found = describeFound(find);
  const time = times[find.frame] ?? 0;
  onStatus?.(`Found ${found}. Marking every pose…`, 0.45);

  // The chosen frame is grabbed once at full size: the plate behind the blocks and every close-up come from it.
  const shot = await grabCanvas(file, time, SCENE_GRAB_LONG_SIDE).catch(() => null);
  const plate = shot
    ? cutJpeg(shot, 0, 0, shot.width, shot.height, Math.min(SCENE_PLATE_LONG_SIDE, Math.max(shot.width, shot.height)), 0.8)
    : (frames[find.frame] ?? null);
  const mock = picked.mock === true;
  const extra = { plate, found, mock };
  if (!shot) {
    onQueued?.();
    return asModel(assembleScene(find, [], [], aspect), aspect, times, { ...extra, rough: true });
  }
  const cuts = closeUps(shot, find);
  const form = new FormData();
  form.set("step", "mark");
  form.append("frame", cutJpeg(shot, 0, 0, shot.width, shot.height, Math.min(SCENE_MARK_FRAME_SIDE, Math.max(shot.width, shot.height)), 0.86), "frame.jpg");
  cuts.forEach((cut, index) => form.append("crop", cut.image, `subject_${index + 1}.jpg`));
  form.set("kinds", find.subjects.map((subject) => subject.kind).join(","));
  form.set(
    "boxes",
    find.subjects
      .flatMap((subject, index) => boxInCrop(subject.box, cuts[index]!.crop))
      .map((value) => Math.round(value))
      .join(","),
  );

  let marks: (FramePart[] | null)[] = [];
  try {
    const marking = await postSubject(form, (message) => onStatus?.(message, 0.5));
    onQueued?.();
    onStatus?.(`Found ${found}. Marking every pose…`, 0.6);
    marks = parseSceneMarks(await replyText(marking, "The model did not mark any parts."), find.subjects.length);
  } catch (error) {
    onQueued?.();
    // Everyone was found, so they still stand where they are, one block each.
    console.warn("Could not mark the poses:", error);
  }
  const rough = marks.every((mark) => !mark);
  return asModel(
    assembleScene(
      find,
      marks,
      cuts.map((cut) => cut.crop),
      aspect,
    ),
    aspect,
    times,
    { ...extra, rough },
  );
}
