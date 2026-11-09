import { readPresetImage } from "@/lib/box-presets";
import { getApp } from "@/lib/config";
import { uploadAsset, submitJob } from "@/lib/comfy";
import { deploymentTarget } from "@/lib/deployments";
import { apiKey, isMockMode, missingKeyMessage } from "@/lib/env";
import { errorResponse, AppError } from "@/lib/http";
import { publicRouteId } from "@/lib/ids";
import { prepareImage, prepareImageBuffer } from "@/lib/images";
import { prepareVideo, VIDEO_MAX_BYTES } from "@/lib/media";
import { resolvePaparazziScene } from "@/lib/paparazzi-scene";
import { saveMockJob } from "@/lib/mock";
import { parseRunParams } from "@/lib/params";
import { applyKlingFrame, readVideoPixelSize } from "@/lib/kling-frame";
import { isPublicApp } from "@/lib/public-surface";
import { dropKlingLook, klingApp } from "@/lib/reverse-3d-kling";
import { REVERSE_3D_RENDERS_VIDEO } from "@/lib/reverse-3d-switch";
import { durationOverCap, readContainerDurationSeconds } from "@/lib/video-duration";
import { buildJobBody, filePathFor, redactJobBody, type UploadedAsset } from "@/lib/workflow";

const USER_BODY_MAX = 4_500_000;

type MediaPart = {
  bytes: Buffer;
  contentType: string;
  filePath: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ app: string }> }) {
  try {
    const { app: appId } = await context.params;
    if (!isPublicApp(appId)) throw new AppError(404, "not_found", "Unknown app.");
    const app = getApp(appId);
    if (!app) throw new AppError(404, "not_found", "Unknown app.");
    // Mock runs never reach Comfy, so they stay open for local testing.
    if (appId === "reverse-3d" && !REVERSE_3D_RENDERS_VIDEO && !isMockMode()) {
      throw new AppError(503, "video_off", "The Reverse 3D video is switched off while the 3D blockout is tested.");
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError(400, "invalid_input", "Upload the image as form data.");
    }

    const media: Record<string, MediaPart> = {};
    let incomingBytes = 0;
    for (const [role, spec] of Object.entries(app.imageInputs)) {
      if (spec.supplied) continue;
      const entries = form.getAll(role).filter((entry): entry is File => entry instanceof File && entry.size > 0);
      const maxCount = spec.maxCount ?? 1;
      if (entries.length > maxCount) {
        throw new AppError(
          400,
          "invalid_input",
          maxCount === 1 ? "Upload one image." : `Upload at most ${maxCount} product photos.`,
        );
      }
      if (entries.length === 0) {
        if (spec.optional) continue;
        if (appId === "paparazzi-me" && role === "scene") continue;
        if (appId === "paparazzi-me" && role === "user") {
          throw new AppError(400, "invalid_input", "Upload your face.");
        }
        if (appId === "open-product-swap" && role === "product") {
          throw new AppError(400, "invalid_input", "Upload a product photo.");
        }
        if (maxCount > 1) throw new AppError(400, "invalid_input", "Upload at least one product photo.");
        throw new AppError(400, "invalid_input", "Upload the required image.");
      }
      for (let index = 0; index < entries.length; index += 1) {
        incomingBytes += entries[index].size;
        const key = index === 0 ? role : `${role}_${index + 1}`;
        const png = await prepareImage(entries[index], spec.maxSide);
        media[key] = { bytes: png, contentType: "image/png", filePath: filePathFor(key) };
      }
    }
    for (const [role, spec] of Object.entries(app.videoInputs ?? {})) {
      const entry = form.get(role);
      if (!(entry instanceof File) || entry.size === 0) {
        throw new AppError(
          400,
          "invalid_input",
          appId === "reverse-3d"
            ? `Upload a video. MP4, MOV, or WebM, ${spec.maxSeconds ?? 10} seconds or less.`
            : "Upload a video of someone holding the product. MP4, MOV, or WebM, trimmed to 4 MB or less.",
        );
      }
      incomingBytes += entry.size;
      const video = await prepareVideo(entry, spec.maxBytes ?? VIDEO_MAX_BYTES);
      if (spec.maxSeconds !== undefined) {
        const seconds = readContainerDurationSeconds(video.bytes);
        if (seconds === null) {
          throw new AppError(400, "invalid_input", `Could not read that video's length. Use ${spec.maxSeconds} seconds or less.`);
        }
        if (durationOverCap(seconds, spec.maxSeconds)) {
          throw new AppError(400, "invalid_input", `That video is over ${spec.maxSeconds} seconds.`);
        }
      }
      media[role] = video;
    }
    if (incomingBytes > USER_BODY_MAX) {
      throw new AppError(400, "invalid_input", "These files are over 4.5 MB together. Trim the video or use smaller photos.");
    }
    if (appId === "paparazzi-me" && !media.scene) {
      const scene = app.imageInputs.scene;
      if (!scene) throw new AppError(500, "internal", "Paparazzi Me is missing its scene input.");
      const png = await resolvePaparazziScene(form, scene.maxSide);
      media.scene = { bytes: png, contentType: "image/png", filePath: filePathFor("scene") };
    }

    const params = parseRunParams(app, form, Boolean(media.image));
    if (app.pipeline === "unboxing" && params.box) {
      for (const [role, spec] of Object.entries(app.imageInputs)) {
        if (!spec.supplied) continue;
        const kind = spec.supplied === "preset-lid" ? "lid" : "empty";
        const png = await prepareImageBuffer(readPresetImage(params.box, kind), spec.maxSide);
        media[role] = { bytes: png, contentType: "image/png", filePath: filePathFor(role) };
      }
    }
    const mock = isMockMode();
    const key = apiKey(appId);
    if (!mock && !key) {
      throw new AppError(500, "missing_key", missingKeyMessage(appId));
    }
    // Unrender: the Nano Banana still (drawn first, sent as `reference`) and Kling 4.0 Flash on the reverse-3d deployment.
    const runApp = appId === "reverse-3d" ? klingApp(app) : app;
    const target = mock ? null : deploymentTarget(appId);

    const assets: Record<string, UploadedAsset> = {};
    const imageFiles: Record<string, Buffer> = {};
    for (const [role, part] of Object.entries(media)) {
      if (part.contentType.startsWith("image/")) imageFiles[role] = part.bytes;
      if (mock || !target) {
        assets[role] = { id: crypto.randomUUID(), filePath: part.filePath };
      } else {
        const id = await uploadAsset(target, part.bytes, part.filePath, part.contentType);
        assets[role] = { id, filePath: part.filePath };
      }
    }

    const idempotencyKey = crypto.randomUUID();
    const body = buildJobBody(runApp, assets, params, key);
    if (appId === "reverse-3d" && media.video) {
      const dims = readVideoPixelSize(media.video.bytes);
      if (!dims) throw new AppError(400, "invalid_input", "Could not read that video's dimensions.");
      applyKlingFrame(body.workflow, dims.width, dims.height);
      if (!assets.reference) dropKlingLook(body.workflow);
    }
    let jobId: string;
    if (mock || !target) {
      const saved = await saveMockJob(app, appId, params, imageFiles);
      jobId = saved.id;
    } else {
      jobId = publicRouteId(appId, await submitJob(target, body, idempotencyKey));
    }

    return Response.json({
      jobId,
      idempotencyKey,
      request: redactJobBody(body),
      deployment: target
        ? { slug: target.slug, endpointUrl: target.baseUrl, deploymentId: target.deploymentId }
        : undefined,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
