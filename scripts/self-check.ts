import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { buildAssetForm } from "../src/lib/comfy";
import { getBoxPreset, insertPixels } from "../src/lib/box-presets";
import { buildCatalog } from "../src/lib/catalog";
import { getApp, listAppIds, listVisibleAppIds, type AppConfig } from "../src/lib/config";
import {
  deploymentBaseUrl,
  deploymentEnvName,
  deploymentFailureMessage,
  deploymentTarget,
  getDeployment,
  listDeploymentSlugs,
} from "../src/lib/deployments";
import { apiKey, missingKeyMessage } from "../src/lib/env";
import { parsePublicRouteId, publicRouteId } from "../src/lib/ids";
import { prepareImage } from "../src/lib/images";
import { saveMockJob, renderMockOutput } from "../src/lib/mock";
import { buildPrompt, intensityWord } from "../src/lib/prompts";
import { signAssetId, verifyAssetSignature } from "../src/lib/signing";
import { assertPublicImageUrl } from "../src/lib/fetch-image";
import {
  activeSearchProvider,
  noResultsMessage,
  normalizeCelebrityName,
  parseBing,
  parseDuckDuckGo,
  parseGoogleCse,
  parseSerpApi,
  parseWikimedia,
  selectCelebrityHits,
  type SearchHit,
} from "../src/lib/paparazzi-search";
import { easeSlide, exitOpacity, trackGap } from "../src/lib/ease-slide";
import { readSceneChoice, signSceneChoice } from "../src/lib/scene-token";
import { isAllowedVideoMime } from "../src/lib/media";
import { REVERSE_3D_MAX_SECONDS, REVERSE_3D_MIN_SECONDS } from "../src/lib/video-client";
import { applyPlayblastShape, dropLookReference, fitPlayblastFrame, playblastFrameCount } from "../src/lib/reverse-3d-look";
import { videoTypeRejectReason } from "../src/lib/prepare-image";
import { buildJobBody, redactJobBody } from "../src/lib/workflow";

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

function mustApp(id: string): AppConfig {
  const app = getApp(id);
  if (!app) throw new Error(`Missing app ${id}`);
  return app;
}

const EXPECTED_ENDPOINTS: Record<string, string> = {
  "product-relight": "https://dep-1a2d3e32-57f0-4617-8ee1-a302160f4cb8.run.comfy.app",
  "image-upscaler": "https://dep-226ed4ac-b5eb-4d8d-bb9c-51907d71718a.run.comfy.app",
  "sprite-generator": "https://dep-6e5a0ab1-8131-4ee8-acb7-ae1840160e13.run.comfy.app",
  "background-removal": "https://dep-e45cb437-0991-4689-9f7c-77d5748e3adc.run.comfy.app",
  "virtual-try-on": "https://dep-d99a045a-86e9-4251-bbae-0a88940f78d1.run.comfy.app",
  "hand-product-swap": "https://dep-9a807afc-d80c-43de-adc4-d0eee9a73655.run.comfy.app",
  "paparazzi-me": "https://dep-be6a6286-e47c-4e0f-b9fc-8fad55236367.run.comfy.app",
  "open-product-swap": "https://dep-c6eae195-e598-4f43-8928-00cb4aa3c2d7.run.comfy.app",
  "open-unboxing": "https://dep-727f285f-f3d8-4348-8378-eacd314ebb58.run.comfy.app",
  "pumpkin-carve": "https://dep-480af229-63d7-4022-9bdc-2dd20c2ffc9f.run.comfy.app",
  "reverse-3d": "https://dep-a166b403-62ba-4598-adeb-708471c20c8c.run.comfy.app",
};

const deploymentEnvNames = Object.keys(EXPECTED_ENDPOINTS).map(deploymentEnvName);
const savedDeploymentEnv = Object.fromEntries(deploymentEnvNames.map((name) => [name, process.env[name]]));
const savedCloudBase = process.env.COMFY_CLOUD_BASE_URL;
for (const name of deploymentEnvNames) delete process.env[name];
delete process.env.COMFY_CLOUD_BASE_URL;

assert.deepEqual([...listAppIds()].sort(), Object.keys(EXPECTED_ENDPOINTS).sort());
assert.deepEqual(listVisibleAppIds(), [
  "sprite-generator",
  "virtual-try-on",
  "hand-product-swap",
  "paparazzi-me",
  "background-removal",
  "open-product-swap",
  "open-unboxing",
  "pumpkin-carve",
  "reverse-3d",
]);
assert.deepEqual(
  buildCatalog().map((app) => app.id),
  [
    "sprite-generator",
    "virtual-try-on",
    "hand-product-swap",
    "paparazzi-me",
    "background-removal",
    "open-product-swap",
    "open-unboxing",
    "pumpkin-carve",
    "reverse-3d",
  ],
);
const swapCatalog = buildCatalog().find((app) => app.id === "hand-product-swap");
assert.equal(swapCatalog?.name, "Hand product swap");
assert.equal(swapCatalog?.tagline, "Same hand & grip, new product");
assert.equal(swapCatalog?.kind, "swap");
assert.deepEqual(
  swapCatalog?.images.map((image) => image.key),
  ["hand", "product"],
);
assert.equal(swapCatalog?.hasSeed, true);
assert.equal(swapCatalog?.output, "image");
assert.equal(swapCatalog?.pollMs, 8 * 60 * 1000);
assert.equal(swapCatalog?.controls.some((control) => control.key === "resolution"), true);
const openSwapCatalog = buildCatalog().find((app) => app.id === "open-product-swap");
assert.equal(openSwapCatalog?.name, "Open Product Swap");
assert.equal(openSwapCatalog?.kind, "product-swap");
assert.equal(openSwapCatalog?.output, "video");
assert.equal(openSwapCatalog?.pollMs, 15 * 60 * 1000);
assert.equal(openSwapCatalog?.images.find((image) => image.key === "video")?.accept, "video");
assert.deepEqual(
  openSwapCatalog?.images.map((image) => image.key),
  ["video", "product"],
);
const openSwapNote = openSwapCatalog?.controls.find((control) => control.key === "description");
assert.equal(openSwapNote?.type, "text");
assert.equal(openSwapNote && openSwapNote.type === "text" ? openSwapNote.multiline : true, false);
assert.equal(openSwapCatalog?.controls.some((control) => control.key === "videoSize"), true);
const unboxingCatalog = buildCatalog().find((app) => app.id === "open-unboxing");
assert.equal(unboxingCatalog?.name, "Open Unboxing");
assert.equal(unboxingCatalog?.kind, "unboxing");
assert.equal(unboxingCatalog?.output, "video");
assert.equal(unboxingCatalog?.pollMs, 15 * 60 * 1000);
assert.equal(unboxingCatalog?.images[0]?.multiple, true);
assert.equal(unboxingCatalog?.images[0]?.maxCount, 5);
const boxControl = unboxingCatalog?.controls.find((control) => control.key === "box");
assert.equal(boxControl?.type, "cards");
assert.equal(boxControl && boxControl.type === "cards" ? boxControl.options.length : 0, 3);
const carveCatalog = buildCatalog().find((app) => app.id === "pumpkin-carve");
assert.equal(carveCatalog?.name, "Pumpkin Carve");
assert.equal(carveCatalog?.tagline, "Carve a photo into a Halloween timelapse");
assert.equal(carveCatalog?.kind, "carve");
assert.equal(carveCatalog?.icon, "pumpkin");
assert.equal(carveCatalog?.output, "video");
assert.equal(carveCatalog?.pollMs, 15 * 60 * 1000);
assert.equal(carveCatalog?.runLabel, "Carve");
assert.equal(carveCatalog?.views.join(","), "Result");
assert.deepEqual(
  carveCatalog?.images.map((image) => image.key),
  ["image"],
);
assert.equal(carveCatalog?.hasSeed, true);
const reverseCatalog = buildCatalog().find((app) => app.id === "reverse-3d");
assert.equal(reverseCatalog?.name, "Reverse 3D");
assert.equal(reverseCatalog?.tagline, "Turn a final shot into a blocky playblast");
assert.equal(reverseCatalog?.kind, "reverse-3d");
assert.equal(reverseCatalog?.icon, "cube");
assert.equal(reverseCatalog?.output, "video");
assert.equal(reverseCatalog?.pollMs, 15 * 60 * 1000);
assert.equal(reverseCatalog?.runLabel, "Make playblast");
assert.equal(reverseCatalog?.views.join(","), "Playblast,Compare");
assert.deepEqual(
  reverseCatalog?.images.map((image) => image.key),
  ["video"],
);
assert.equal(reverseCatalog?.images[0]?.accept, "video");
assert.equal(reverseCatalog?.hasSeed, true);
assert.equal(carveCatalog?.controls.length, 0);
const paparazziCatalog = buildCatalog().find((app) => app.id === "paparazzi-me");
assert.equal(paparazziCatalog?.name, "Paparazzi Me");
assert.equal(paparazziCatalog?.tagline, "Insert yourself into a paparazzi shot");
assert.equal(paparazziCatalog?.kind, "paparazzi");
assert.equal(paparazziCatalog?.runLabel, "Insert me");
assert.equal(paparazziCatalog?.empty, "Enter a celebrity and upload your face");
assert.deepEqual(
  paparazziCatalog?.images.map((image) => image.key),
  ["user", "scene"],
);
assert.equal(paparazziCatalog?.images.find((image) => image.key === "user")?.optional, false);
assert.equal(paparazziCatalog?.images.find((image) => image.key === "scene")?.optional, true);
assert.equal(paparazziCatalog?.images.find((image) => image.key === "scene")?.label, "Scene override");
assert.equal(paparazziCatalog?.hasSeed, true);
const celebrity = paparazziCatalog?.controls.find((control) => control.key === "celebrity");
assert.equal(celebrity?.type, "text");
assert.equal(celebrity && celebrity.type === "text" ? celebrity.multiline : true, false);
assert.equal(celebrity && "clientOnly" in celebrity ? celebrity.clientOnly : false, false);
assert.equal(paparazziCatalog?.controls.some((control) => control.key === "resolution"), true);
assert.equal(getApp("paparazzi-me")?.enabled, true);
assert.equal(getApp("paparazzi-me")?.partnerNodes, true);
assert.equal(getApp("product-relight")?.enabled, false);
assert.equal(getApp("image-upscaler")?.enabled, false);
assert.equal(getApp("sprite-generator")?.enabled, true);
assert.equal(getApp("open-product-swap")?.enabled, true);
assert.equal(getApp("open-unboxing")?.enabled, true);
assert.equal(getApp("open-unboxing")?.partnerNodes, true);
assert.equal(getApp("pumpkin-carve")?.enabled, true);
assert.equal(getApp("pumpkin-carve")?.partnerNodes, true);
assert.equal(getApp("pumpkin-carve")?.output.node, "50");
assert.equal(getApp("pumpkin-carve")?.output.media, "video");
assert.equal(getApp("reverse-3d")?.enabled, true);
assert.equal(getApp("reverse-3d")?.partnerNodes, false);
assert.equal(getApp("reverse-3d")?.output.node, "21");
assert.equal(getApp("reverse-3d")?.output.media, "video");
assert.equal(getApp("reverse-3d")?.videoInputs?.video.node, "10");
assert.equal(getApp("reverse-3d")?.videoInputs?.video.maxSeconds, undefined);
assert.equal(getApp("reverse-3d")?.imageInputs.scene, undefined);
assert.deepEqual(getApp("reverse-3d")?.imageInputs.reference, { node: "30", input: "image", maxSide: 1280, optional: true });
assert.equal(REVERSE_3D_MAX_SECONDS, 10);
assert.match(reverseCatalog?.images[0]?.hint ?? "", /10 seconds/);
assert.equal(reverseCatalog?.images.length, 1, "the still goes up with the run, it is not an upload slot");
assert.equal(reverseCatalog?.controls.length, 0, "no polygon slider: the 3D blockout is gone from the page");
assert.equal(REVERSE_3D_MIN_SECONDS, 3);
assert.equal(isAllowedVideoMime("video/webm;codecs=vp9"), true);
assert.equal(isAllowedVideoMime("video/mp4;codecs=avc1.42E01E"), true);
assert.equal(isAllowedVideoMime("video/webm"), true);
assert.equal(isAllowedVideoMime("image/png"), false);
assert.equal(videoTypeRejectReason(new File([new Uint8Array([1])], "clip.webm", { type: "video/webm;codecs=vp8" })), null);
assert.equal(getDeployment("open-product-swap")?.keyEnv, "COMFY_API_KEY_WORK_PERSONAL");
assert.equal(getDeployment("open-unboxing")?.keyEnv, "COMFY_API_KEY_WORK_PERSONAL");
assert.equal(getDeployment("pumpkin-carve")?.keyEnv, "COMFY_API_KEY_TEAM");
assert.equal(getDeployment("reverse-3d")?.keyEnv, "COMFY_API_KEY_TEAM");
assert.equal(getDeployment("pumpkin-carve")?.releaseId, "87486a19-62f1-40e4-a423-3563387e31d4");
assert.equal(getDeployment("open-unboxing")?.releaseId, "69e82472-1206-473f-851e-286c5fcb2480");
assert.equal(getDeployment("hand-product-swap")?.keyEnv, undefined);
assert.equal(getDeployment("open-product-swap")?.releaseId, "f709c8b1-b6a6-49c3-980b-114a03f160ba");
assert.deepEqual([...listDeploymentSlugs()].sort(), Object.keys(EXPECTED_ENDPOINTS).sort());
for (const [slug, url] of Object.entries(EXPECTED_ENDPOINTS)) {
  assert.equal(deploymentEnvName(slug).startsWith("COMFY_BASE_URL_"), true);
  assert.equal(deploymentBaseUrl(slug), url);
  assert.equal(deploymentTarget(slug).baseUrl, url);
  assert.equal(url.includes("cloud.comfy.org"), false);
}
process.env.COMFY_CLOUD_BASE_URL = "https://cloud.comfy.org";
assert.equal(deploymentBaseUrl("product-relight"), EXPECTED_ENDPOINTS["product-relight"]);
delete process.env.COMFY_CLOUD_BASE_URL;
process.env.COMFY_BASE_URL_IMAGE_UPSCALER = "https://dep-override.stg.run.comfy.app";
assert.equal(deploymentBaseUrl("image-upscaler"), "https://dep-override.stg.run.comfy.app");
assert.equal(deploymentBaseUrl("sprite-generator"), EXPECTED_ENDPOINTS["sprite-generator"]);
assert.throws(() => {
  process.env.COMFY_BASE_URL_PRODUCT_RELIGHT = "https://cloud.comfy.org";
  deploymentBaseUrl("product-relight");
}, /run\.comfy\.app/);
delete process.env.COMFY_BASE_URL_PRODUCT_RELIGHT;
delete process.env.COMFY_BASE_URL_IMAGE_UPSCALER;

const stopped = deploymentFailureMessage("Product Relight", "deployment_stopped", null);
assert.match(stopped ?? "", /stopped/);
assert.match(stopped ?? "", /3/);
const cold = deploymentFailureMessage("Image Upscaler", "deployment_not_ready", "45");
assert.match(cold ?? "", /cold-starting/);
assert.match(cold ?? "", /45 seconds/);
assert.equal(deploymentFailureMessage("Sprite Generator", "invalid_workflow", null), null);
assert.equal(deploymentFailureMessage("Sprite Generator", "queue_full", null), null);

const routed = publicRouteId("virtual-try-on", "11111111-1111-4111-8111-111111111111");
assert.equal(parsePublicRouteId(routed)?.app, "virtual-try-on");
assert.equal(parsePublicRouteId(routed)?.id, "11111111-1111-4111-8111-111111111111");
assert.equal(parsePublicRouteId("11111111-1111-4111-8111-111111111111"), null);

for (const [name, value] of Object.entries(savedDeploymentEnv)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
if (savedCloudBase === undefined) delete process.env.COMFY_CLOUD_BASE_URL;
else process.env.COMFY_CLOUD_BASE_URL = savedCloudBase;

const relight = mustApp("product-relight");
const upscale = mustApp("image-upscaler");
const sprite = mustApp("sprite-generator");
const tryon = mustApp("virtual-try-on");
const swap = mustApp("hand-product-swap");
const paparazzi = mustApp("paparazzi-me");
const cutout = mustApp("background-removal");
const productSwap = mustApp("open-product-swap");
const unboxing = mustApp("open-unboxing");
const carve = mustApp("pumpkin-carve");

const words = relight.intensityWords!;
assert.equal(intensityWord(0, words), "subtle");
assert.equal(intensityWord(33, words), "subtle");
assert.equal(intensityWord(34, words), "balanced");
assert.equal(intensityWord(66, words), "balanced");
assert.equal(intensityWord(67, words), "strong, dramatic");
assert.equal(intensityWord(100, words), "strong, dramatic");

const neon = buildPrompt(relight, { preset: "neon", direction: "right", intensity: 90, hasImage: true });
assert.ok(neon.startsWith("重新照明,"));
assert.ok(neon.includes("strong, dramatic"));
assert.ok(neon.includes("from the right"));
assert.ok(neon.includes("magenta"));
assert.equal(neon.includes("{direction}"), false);
assert.equal(neon.includes("{intensity}"), false);
assert.equal(neon.includes("{preset}"), false);

const relightBody = buildJobBody(
  relight,
  { image: { id: "11111111-1111-4111-8111-111111111111", filePath: "input.png" } },
  { preset: "neon", direction: "right", intensity: 90, seed: 424242, hasImage: true },
  null,
);
assert.equal(relightBody.extra_data, undefined);
assert.equal(relightBody.workflow["10"].inputs.prompt, neon);
assert.equal(relightBody.workflow["13"].inputs.seed, 424242);
assert.deepEqual(relightBody.workflow["1"].inputs.image, {
  __type: "core/ASSET",
  info: { id: "11111111-1111-4111-8111-111111111111", file_path: "input.png" },
});
assert.equal(relightBody.workflow["1"].class_type, "LoadImage");
assert.equal(relightBody.workflow["15"].class_type, "SaveImage");

const up4 = buildJobBody(upscale, { image: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", filePath: "input.png" } }, { scale: "4", hasImage: true }, null);
assert.equal(up4.workflow["4"].inputs.scale_by, 1);
assert.equal(up4.workflow["2"].inputs.model_name, "4x-UltraSharp.pth");
assert.equal(up4.extra_data, undefined);
const up2 = buildJobBody(upscale, { image: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", filePath: "input.png" } }, { scale: "2", hasImage: true }, null);
assert.equal(up2.workflow["4"].inputs.scale_by, 0.5);

const secret = "super-secret-key";
assert.throws(
  () =>
    buildJobBody(
      sprite,
      {},
      { style: "pixel", motion: "jump", frames: "8", description: "a small friendly robot", seed: 7, hasImage: false },
      secret,
    ),
  /required image/i,
);

const withImage = buildJobBody(
  sprite,
  { image: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", filePath: "input.png" } },
  { style: "pixel", motion: "jump", frames: "8", description: "a small friendly robot", seed: 7, hasImage: true },
  secret,
);
assert.equal(withImage.workflow["1"].class_type, "LoadImage");
assert.equal(withImage.workflow["2"].class_type, "GeminiNanoBanana2");
assert.equal(withImage.workflow["2"].inputs.aspect_ratio, "16:9");
assert.equal(withImage.workflow["2"].inputs.resolution, "2K");
assert.equal(withImage.workflow["2"].inputs.thinking_level, "HIGH");
assert.equal(withImage.workflow["2"].inputs.seed, 7);
assert.equal(withImage.workflow["2"].inputs.model, "Nano Banana 2 (Gemini 3.1 Flash Image)");
const spritePrompt = String(withImage.workflow["2"].inputs.prompt);
assert.ok(spritePrompt.includes("a small friendly robot"));
assert.ok(spritePrompt.includes("4 x 2"));
assert.ok(spritePrompt.includes("pixelart, 32x32 pixels"));
assert.ok(spritePrompt.includes("jump sequence"));
assert.ok(spritePrompt.startsWith("pixelart, 32x32 pixels sprite sheet of the character in the reference image"));
assert.deepEqual(withImage.workflow["2"].inputs.images, ["1", 0]);
assert.equal(withImage.extra_data?.api_key_comfy_org, secret);
const redacted = JSON.stringify(redactJobBody(withImage));
assert.equal(redacted.includes(secret), false);
assert.ok(redacted.includes("<redacted>"));

const vto = buildJobBody(
  tryon,
  {
    person: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", filePath: "person.png" },
    garment: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", filePath: "garment.png" },
  },
  { fit: "slim", seed: 9, hasImage: false },
  secret,
);
assert.equal(vto.workflow["3"].inputs.prompt, "Replace the outfit with the reference garment, slim fit");
assert.equal(vto.workflow["3"].class_type, "FluxVTONode");
assert.equal(vto.workflow["3"].inputs.seed, 9);
assert.equal((vto.workflow["1"].inputs.image as { info: { file_path: string } }).info.file_path, "person.png");
assert.equal((vto.workflow["2"].inputs.image as { info: { file_path: string } }).info.file_path, "garment.png");
assert.ok(vto.extra_data);

const swapPrompt =
  "Swap the product the subject is holding in image 1 with the product in image 2. Keep the same hand, grip, pose, camera angle, and lighting. Only replace the held object with product Y from image 2.";
assert.equal(buildPrompt(swap, { hasImage: true }), swapPrompt);
const swapped = buildJobBody(
  swap,
  {
    hand: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", filePath: "hand.png" },
    product: { id: "99999999-9999-4999-8999-999999999999", filePath: "product.png" },
  },
  { resolution: "2K", seed: 11, hasImage: false },
  secret,
);
assert.equal(swapped.workflow["17"].class_type, "GeminiImage2Node");
assert.equal(swapped.workflow["17"].inputs.prompt, swapPrompt);
assert.equal(swapped.workflow["17"].inputs.seed, 11);
assert.equal(swapped.workflow["17"].inputs.resolution, "2K");
assert.equal(swapped.workflow["17"].inputs.model, "gemini-3-pro-image-preview");
assert.equal(swapped.workflow["10"].class_type, "LoadImage");
assert.equal(swapped.workflow["11"].class_type, "LoadImage");
assert.equal(swapped.workflow["15"].class_type, "SaveImage");
assert.equal((swapped.workflow["10"].inputs.image as { info: { file_path: string } }).info.file_path, "hand.png");
assert.equal((swapped.workflow["11"].inputs.image as { info: { file_path: string } }).info.file_path, "product.png");
assert.equal(swapped.extra_data?.api_key_comfy_org, secret);
assert.equal(swap.partnerNodes, true);
assert.equal(swap.enabled, true);

const paparazziPrompt =
  "Create a realistic paparazzi-style photograph. Image 1 is the celebrity/paparazzi scene reference — keep the same location, background, camera angle, flash lighting, grain, and candid paparazzi vibe. Image 2 is the user — reproduce their face and identity EXACTLY (facial features, skin tone, hair). Insert the person from image 2 into the scene from image 1 so they appear together with the celebrity (standing beside or near them, same depth of field, matching shadows and flash highlights). Keep clothing on the user natural for the scene unless image 2 already shows appropriate attire. Photorealistic paparazzi photojournalism look: harsh on-camera flash, slight motion, nightlife/event energy. Do not change the celebrity's face. No text overlays, no watermarks, no logos.";
assert.equal(buildPrompt(paparazzi, { hasImage: true }), paparazziPrompt);
assert.equal(paparazzi.imageInputs.scene?.node, "11");
assert.equal(paparazzi.imageInputs.user?.node, "12");
assert.equal(paparazzi.imageInputs.scene?.maxSide, 1536);
assert.equal(paparazzi.imageInputs.user?.maxSide, 1536);
assert.equal(paparazzi.params.prompt?.node, "35");
assert.equal(paparazzi.params.seed?.node, "35");
assert.equal(paparazzi.params.resolution?.node, "35");
assert.equal(paparazzi.output.node, "30");
assert.equal(paparazzi.cloudWorkflowId, "205a6275-4330-48db-9177-63746095b7b5");
const inserted = buildJobBody(
  paparazzi,
  {
    scene: { id: "12121212-1212-4121-8121-121212121212", filePath: "scene.png" },
    user: { id: "34343434-3434-4434-8434-343434343434", filePath: "user.png" },
  },
  { resolution: "2K", seed: 21, hasImage: false },
  secret,
);
assert.equal(inserted.workflow["35"].class_type, "GeminiImage2Node");
assert.equal(inserted.workflow["35"].inputs.prompt, paparazziPrompt);
assert.equal(inserted.workflow["35"].inputs.seed, 21);
assert.equal(inserted.workflow["35"].inputs.resolution, "2K");
assert.equal(inserted.workflow["35"].inputs.model, "gemini-3-pro-image-preview");
assert.equal(inserted.workflow["11"].class_type, "LoadImage");
assert.equal(inserted.workflow["12"].class_type, "LoadImage");
assert.equal(inserted.workflow["36"].class_type, "BatchImagesNode");
assert.equal(inserted.workflow["30"].class_type, "SaveImage");
assert.equal((inserted.workflow["11"].inputs.image as { info: { file_path: string } }).info.file_path, "scene.png");
assert.equal((inserted.workflow["12"].inputs.image as { info: { file_path: string } }).info.file_path, "user.png");
assert.equal(inserted.extra_data?.api_key_comfy_org, secret);
assert.equal(JSON.stringify(inserted).includes("cloud.comfy.org"), false);
assert.throws(
  () =>
    buildJobBody(
      paparazzi,
      { scene: { id: "12121212-1212-4121-8121-121212121212", filePath: "scene.png" } },
      { resolution: "2K", seed: 21, hasImage: false },
      secret,
    ),
  /required image/i,
);
assert.throws(
  () =>
    buildJobBody(
      swap,
      { hand: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", filePath: "hand.png" } },
      { resolution: "2K", seed: 11, hasImage: false },
      secret,
    ),
  /required image/i,
);

const bg = buildJobBody(
  cutout,
  { image: { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", filePath: "input.png" } },
  { hasImage: true },
  secret,
);
assert.equal(bg.extra_data, undefined);
assert.equal(bg.workflow["2"].inputs.bg_removal_name, "birefnet.safetensors");
assert.equal(bg.workflow["6"].class_type, "SaveImage");

const kraft = getBoxPreset("kraft_mailer");
assert.ok(kraft);
assert.deepEqual(insertPixels(kraft), { x: 243, y: 639, width: 413, height: 322 });

const swapJob = buildJobBody(
  productSwap,
  {
    video: { id: "44444444-4444-4444-8444-444444444444", filePath: "input.mp4" },
    product: { id: "55555555-5555-4555-8555-555555555555", filePath: "product.png" },
  },
  { videoSize: "720p", description: "matte ginger bottle", seed: 7, hasImage: true },
  "work-key",
);
assert.equal(swapJob.workflow["1"].class_type, "LoadVideo");
assert.deepEqual(swapJob.workflow["1"].inputs.file, {
  __type: "core/ASSET",
  info: { id: "44444444-4444-4444-8444-444444444444", file_path: "input.mp4" },
});
assert.equal(swapJob.workflow["4"].inputs.width, 720);
assert.equal(swapJob.workflow["4"].inputs.height, 720);
assert.equal(swapJob.workflow["20"].inputs.width, 720);
assert.equal(swapJob.workflow["20"].inputs.height, 720);
assert.equal(swapJob.workflow["21"].inputs.seed, 7);
assert.equal(swapJob.workflow["8"].inputs.seed, 7);
assert.match(String(swapJob.workflow["8"].inputs.prompt), /matte ginger bottle/);
assert.match(String(swapJob.workflow["18"].inputs.text), /matte ginger bottle/);
assert.equal(swapJob.workflow["26"].class_type, "SaveVideo");
assert.equal(swapJob.workflow["27"], undefined);
assert.equal(swapJob.extra_data?.api_key_comfy_org, "work-key");

const hero = { id: "88888888-8888-4888-8888-888888888888", filePath: "product.png" };
const empty = { id: "66666666-6666-4666-8666-666666666666", filePath: "box_empty.png" };
const lid = { id: "77777777-7777-4777-8777-777777777777", filePath: "box_lid.png" };
const angle = { id: "99999999-9999-4999-8999-999999999999", filePath: "product_2.png" };
const boxJob = buildJobBody(
  unboxing,
  { product: hero, product_2: angle, empty, lid },
  { box: "kraft_mailer", seed: 9, hasImage: true },
  "work-key",
);
assert.equal(boxJob.workflow["10"].inputs.x, 243);
assert.equal(boxJob.workflow["10"].inputs.y, 639);
assert.equal(boxJob.workflow["5"].inputs.width, 413);
assert.equal(boxJob.workflow["5"].inputs.height, 322);
assert.equal(boxJob.workflow["7"].inputs.width, 413);
assert.equal(boxJob.workflow["7"].inputs.height, 322);
assert.equal(boxJob.workflow["11"].inputs.images, undefined);
assert.deepEqual(boxJob.workflow["11"].inputs["images.image_1"], ["10", 0]);
assert.deepEqual(boxJob.workflow["11"].inputs["images.image_2"], ["1", 0]);
assert.deepEqual(boxJob.workflow["11"].inputs["images.image_3"], ["21", 0]);
assert.equal(boxJob.workflow["11"].inputs["images.image_4"], undefined);
assert.equal(boxJob.workflow["22"], undefined);
assert.equal(boxJob.workflow["23"], undefined);
assert.equal(boxJob.workflow["24"], undefined);
assert.match(String(boxJob.workflow["11"].inputs.prompt), /Images 3/);
assert.match(String(boxJob.workflow["13"].inputs.prompt), /static/);
assert.equal(boxJob.workflow["15"].inputs.model_name, "rife_v4.26.safetensors");
assert.equal(boxJob.workflow["16"].inputs.multiplier, 2);
assert.equal(boxJob.workflow["18"].class_type, "SaveVideo");
assert.equal(boxJob.extra_data?.api_key_comfy_org, "work-key");
assert.equal(redactJobBody(boxJob).extra_data?.api_key_comfy_org, "<redacted>");
assert.equal(boxJob.extra_data?.api_key_comfy_org, "work-key");

const solo = buildJobBody(
  unboxing,
  { product: hero, empty, lid },
  { box: "kraft_mailer", seed: 1, hasImage: true },
  null,
);
assert.equal(solo.workflow["11"].inputs["images.image_3"], undefined);
assert.equal(solo.workflow["21"], undefined);
assert.equal(solo.extra_data?.api_key_comfy_org, "");
assert.equal(String(solo.workflow["11"].inputs.prompt).includes("Images 3"), false);

const carveJob = buildJobBody(
  carve,
  { image: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", filePath: "input.png" } },
  { seed: 11, hasImage: true },
  "team-key",
);
assert.equal(carveJob.workflow["10"].class_type, "LoadImage");
assert.deepEqual(carveJob.workflow["10"].inputs.image, {
  __type: "core/ASSET",
  info: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", file_path: "input.png" },
});
assert.equal(carveJob.workflow["30"].inputs.seed, 11);
assert.equal(carveJob.workflow["40"].inputs.seed, 11);
assert.equal(carveJob.workflow["20"].inputs["model.seed"], 11);
assert.deepEqual(carveJob.workflow["30"].inputs.images, ["10", 0]);
assert.equal(carveJob.workflow["21"].class_type, "SaveSVGNode");
assert.equal(carveJob.workflow["40"].class_type, "ByteDance2FirstLastFrameNode");
assert.equal(carveJob.workflow["40"].inputs.model, "Seedance 2.0");
assert.equal(carveJob.workflow["40"].inputs["model.resolution"], "720p");
assert.equal(carveJob.workflow["40"].inputs["model.duration"], 8);
assert.equal(carveJob.workflow["40"].inputs["model.generate_audio"], false);
assert.equal(carveJob.workflow["40"].inputs["model.ratio"], "9:16");
assert.equal(carveJob.workflow["40"].inputs.watermark, false);
assert.deepEqual(carveJob.workflow["40"].inputs.first_frame, ["32", 0]);
assert.deepEqual(carveJob.workflow["40"].inputs.last_frame, ["30", 0]);
assert.equal(carveJob.workflow["50"].class_type, "SaveVideo");
assert.deepEqual(carveJob.workflow["50"].inputs.video, ["40", 0]);
assert.equal(carveJob.extra_data?.api_key_comfy_org, "team-key");

const reverse3d = mustApp("reverse-3d");
const reverseJob = buildJobBody(
  reverse3d,
  {
    video: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", filePath: "input.mp4" },
    reference: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", filePath: "reference.png" },
  },
  { seed: 42, hasImage: true },
  "team-key",
);
assert.equal(reverseJob.workflow["10"].class_type, "LoadVideo");
assert.deepEqual(reverseJob.workflow["10"].inputs.file, {
  __type: "core/ASSET",
  info: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", file_path: "input.mp4" },
});
assert.equal(reverseJob.workflow["11"].class_type, "Video Slice");
assert.deepEqual(reverseJob.workflow["11"].inputs.video, ["10", 0]);
assert.equal(reverseJob.workflow["11"].inputs.duration, 10);
assert.equal(reverseJob.workflow["12"].class_type, "VideoFrameSample");
assert.equal(reverseJob.workflow["12"].inputs.strategy, "uniform");
assert.equal(reverseJob.workflow["15"].class_type, "GetVideoComponents");
assert.deepEqual(reverseJob.workflow["15"].inputs.video, ["12", 0]);
assert.equal(reverseJob.workflow["17"].class_type, "ImageScale");
assert.deepEqual(reverseJob.workflow["17"].inputs.image, ["15", 0]);
assert.deepEqual(reverseJob.workflow["40"].inputs.image, ["17", 0]);
assert.equal(reverseJob.workflow["49"].class_type, "WanVaceToVideo");
assert.deepEqual(reverseJob.workflow["49"].inputs.control_video, ["40", 0]);
assert.deepEqual(reverseJob.workflow["49"].inputs.reference_image, ["32", 0]);
assert.equal(reverseJob.workflow["3"].inputs.seed, 42);
assert.equal(reverseJob.workflow["16"].inputs.fps, 16);
assert.equal(JSON.stringify(reverseJob.workflow).includes("Kling"), false);
// The run route fits the graph to the clip: a 1920x1080, 10 second clip renders 161 frames at 832x464.
assert.deepEqual(applyPlayblastShape(reverseJob.workflow, 1920, 1080, 10), { width: 832, height: 464, frames: 161 });
assert.equal(reverseJob.workflow["32"].inputs.width, 832);
assert.deepEqual(fitPlayblastFrame(1080, 1920), { width: 464, height: 832 });
assert.deepEqual(fitPlayblastFrame(960, 720), { width: 832, height: 624 });
assert.equal(playblastFrameCount(3), 49);
assert.equal(playblastFrameCount(null), 161);
assert.equal(playblastFrameCount(30), 161);
// No still came with the run: nodes 30-32 go and VACE gets no reference image.
dropLookReference(reverseJob.workflow);
assert.equal(reverseJob.workflow["30"], undefined);
assert.equal(reverseJob.workflow["31"], undefined);
assert.equal(reverseJob.workflow["32"], undefined);
assert.equal(reverseJob.workflow["49"].inputs.reference_image, undefined);
assert.equal(reverseJob.workflow["21"].class_type, "SaveVideo");
assert.equal(reverseJob.extra_data, undefined);


const stillPrompt = String(carveJob.workflow["30"].inputs.prompt);
const blankPrompt = String(carveJob.workflow["32"].inputs.prompt);
const videoPrompt = String(carveJob.workflow["40"].inputs["model.prompt"]);
assert.match(stillPrompt, /pumpkin/i);
assert.match(stillPrompt, /dark empty voids/i);
assert.match(stillPrompt, /no candle, no flame, no fire/i);
assert.match(blankPrompt, /no candle, no flame, no fire/i);
assert.match(blankPrompt, /no internal glow/i);
assert.match(videoPrompt, /hyperlapse/i);
assert.match(videoPrompt, /no candle, no flame, no fire, no torch, no internal glow/i);
assert.equal(/glowing warm candlelight|candle glow|candle flicker/i.test(`${stillPrompt}\n${blankPrompt}\n${videoPrompt}`), false);
assert.equal(JSON.stringify(carveJob.workflow["30"].inputs).includes("21"), false);

assert.throws(() => buildPrompt(relight, { preset: "nope", direction: "left", intensity: 10 }), /preset/i);

const assetForm = buildAssetForm(Buffer.from("png"), "input.png");
assert.deepEqual([...assetForm.keys()], ["content_type", "file_path", "tags", "file"]);
assert.equal(assetForm.get("content_type"), "image/png");
assert.equal(assetForm.get("file_path"), "input.png");
assert.equal(assetForm.get("tags"), '["input"]');
const videoForm = buildAssetForm(Buffer.from("mp4"), "input.mp4", "video/mp4");
assert.deepEqual([...videoForm.keys()], ["content_type", "file_path", "tags", "file"]);
assert.equal(videoForm.get("content_type"), "video/mp4");

const savedSecret = process.env.OUTPUT_SIGNING_SECRET;
const savedKey = process.env.COMFY_CLOUD_API_KEY;
const savedPreferredKey = process.env.COMFY_API_KEY;
process.env.OUTPUT_SIGNING_SECRET = "test-output-secret";
const assetId = "11111111-1111-4111-8111-111111111111";
const goodSig = signAssetId(assetId);
assert.equal(verifyAssetSignature(assetId, goodSig), true);
assert.equal(verifyAssetSignature(assetId, goodSig.slice(0, -1) + (goodSig.endsWith("a") ? "b" : "a")), false);
assert.equal(verifyAssetSignature("22222222-2222-4222-8222-222222222222", goodSig), false);
assert.equal(verifyAssetSignature(assetId, null), false);
delete process.env.OUTPUT_SIGNING_SECRET;
delete process.env.COMFY_API_KEY;
process.env.COMFY_CLOUD_API_KEY = "key-a";
assert.equal(apiKey(), "key-a");
const fromKeyA = signAssetId(assetId);
process.env.COMFY_CLOUD_API_KEY = "key-b";
assert.notEqual(signAssetId(assetId), fromKeyA);
assert.equal(verifyAssetSignature(assetId, fromKeyA), false);
process.env.COMFY_API_KEY = "preferred-key";
assert.equal(apiKey(), "preferred-key");
assert.notEqual(signAssetId(assetId), fromKeyA);

const savedWorkKey = process.env.COMFY_API_KEY_WORK_PERSONAL;
process.env.COMFY_API_KEY = "shared-key";
process.env.COMFY_API_KEY_WORK_PERSONAL = "work-key";
assert.equal(apiKey("open-product-swap"), "work-key");
assert.equal(apiKey("open-unboxing"), "work-key");
assert.equal(apiKey("hand-product-swap"), "shared-key");
assert.equal(apiKey(), "shared-key");
const savedTeamKey = process.env.COMFY_API_KEY_TEAM;
process.env.COMFY_API_KEY_TEAM = "team-key";
assert.equal(apiKey("pumpkin-carve"), "team-key");
assert.equal(apiKey("reverse-3d"), "team-key");
assert.equal(apiKey("hand-product-swap"), "shared-key");
delete process.env.COMFY_API_KEY_TEAM;
assert.equal(apiKey("pumpkin-carve"), null);
assert.equal(apiKey("reverse-3d"), null);
assert.match(missingKeyMessage("pumpkin-carve"), /COMFY_API_KEY_TEAM/);
assert.match(missingKeyMessage("reverse-3d"), /COMFY_API_KEY_TEAM/);
assert.equal(missingKeyMessage("pumpkin-carve").includes("COMFY_API_KEY or"), false);
if (savedTeamKey === undefined) delete process.env.COMFY_API_KEY_TEAM;
else process.env.COMFY_API_KEY_TEAM = savedTeamKey;
delete process.env.COMFY_API_KEY_WORK_PERSONAL;
assert.equal(apiKey("open-product-swap"), null);
assert.equal(apiKey("hand-product-swap"), "shared-key");
assert.match(missingKeyMessage("open-product-swap"), /COMFY_API_KEY_WORK_PERSONAL/);
assert.equal(missingKeyMessage("open-product-swap").includes("COMFY_API_KEY or"), false);
process.env.COMFY_API_KEY_WORK_PERSONAL = "work-key";
const swapAsset = publicRouteId("open-product-swap", "33333333-3333-4333-8333-333333333333");
const handAsset = publicRouteId("hand-product-swap", "33333333-3333-4333-8333-333333333333");
const swapSig = signAssetId(swapAsset);
const handSig = signAssetId(handAsset);
process.env.COMFY_API_KEY_WORK_PERSONAL = "other-work";
assert.equal(verifyAssetSignature(swapAsset, swapSig), false);
assert.equal(verifyAssetSignature(handAsset, handSig), true);
process.env.COMFY_API_KEY_WORK_PERSONAL = "work-key";
assert.equal(verifyAssetSignature(swapAsset, swapSig), true);
process.env.COMFY_API_KEY = "changed-shared";
assert.equal(verifyAssetSignature(handAsset, handSig), false);
assert.equal(verifyAssetSignature(swapAsset, swapSig), true);
process.env.COMFY_API_KEY = "shared-key";
if (savedWorkKey === undefined) delete process.env.COMFY_API_KEY_WORK_PERSONAL;
else process.env.COMFY_API_KEY_WORK_PERSONAL = savedWorkKey;

if (savedSecret === undefined) delete process.env.OUTPUT_SIGNING_SECRET;
else process.env.OUTPUT_SIGNING_SECRET = savedSecret;
if (savedKey === undefined) delete process.env.COMFY_CLOUD_API_KEY;
else process.env.COMFY_CLOUD_API_KEY = savedKey;
if (savedPreferredKey === undefined) delete process.env.COMFY_API_KEY;
else process.env.COMFY_API_KEY = savedPreferredKey;

async function main() {
const wide = await sharp({
  create: { width: 3000, height: 1000, channels: 3, background: { r: 20, g: 40, b: 200 } },
}).png().toBuffer();
const prepared = await prepareImage(new File([new Uint8Array(wide)], "wide.png", { type: "image/png" }), 1024);
const preparedMeta = await sharp(prepared).metadata();
assert.equal(preparedMeta.width, 1024);
assert.ok((preparedMeta.height ?? 0) <= 1024);
assert.equal(preparedMeta.format, "png");

const turned = await sharp({
  create: { width: 80, height: 20, channels: 3, background: { r: 200, g: 20, b: 20 } },
})
  .jpeg()
  .withMetadata({ orientation: 6 })
  .toBuffer();
const oriented = await prepareImage(new File([new Uint8Array(turned)], "turn.jpg", { type: "image/jpeg" }), 1536);
const orientedMeta = await sharp(oriented).metadata();
assert.ok((orientedMeta.height ?? 0) > (orientedMeta.width ?? 0));

await assert.rejects(
  () => prepareImage(new File([Buffer.from("hello")], "nope.png", { type: "image/png" }), 512),
  /PNG, JPG, or WebP/,
);

const sample = await sharp({
  create: { width: 64, height: 48, channels: 3, background: { r: 180, g: 190, b: 200 } },
}).png().toBuffer();
const garment = await sharp({
  create: { width: 40, height: 30, channels: 3, background: { r: 240, g: 180, b: 20 } },
}).png().toBuffer();

const studio = await saveMockJob(relight, "product-relight", { preset: "studio", direction: "left", intensity: 20 }, { image: sample });
const neonJob = await saveMockJob(relight, "product-relight", { preset: "neon", direction: "right", intensity: 100 }, { image: sample });
const studioPng = await renderMockOutput(studio.outputId, undefined);
const neonPng = await renderMockOutput(neonJob.outputId, undefined);
assert.ok(studioPng[0] === 0x89);
assert.notDeepEqual(studioPng, neonPng);

const upJob = await saveMockJob(upscale, "image-upscaler", { scale: "2" }, { image: sample });
const upPng = await renderMockOutput(upJob.outputId, undefined);
const upMeta = await sharp(upPng).metadata();
assert.equal(upMeta.width, 128);
assert.equal(upMeta.height, 96);

const sheet = await saveMockJob(
  sprite,
  "sprite-generator",
  { style: "3d", motion: "walk", frames: "8", description: "robot" },
  {},
);
const sheetPng = await renderMockOutput(sheet.outputId, sprite.grids);
const sheetMeta = await sharp(sheetPng).metadata();
assert.equal(sheetMeta.width, 1600);
assert.equal(sheetMeta.height, 860);

const vtoJob = await saveMockJob(tryon, "virtual-try-on", { fit: "regular" }, { person: sample, garment });
const vtoPng = await renderMockOutput(vtoJob.outputId, undefined);
assert.ok(vtoPng.byteLength > 100);

const swapJob = await saveMockJob(swap, "hand-product-swap", { resolution: "2K", seed: 3 }, { hand: sample, product: garment });
const swapPng = await renderMockOutput(swapJob.outputId, undefined);
assert.ok(swapPng.byteLength > 100);

const paparazziJob = await saveMockJob(
  paparazzi,
  "paparazzi-me",
  { resolution: "2K", seed: 5 },
  { scene: sample, user: garment },
);
const paparazziPng = await renderMockOutput(paparazziJob.outputId, undefined);
assert.ok(paparazziPng.byteLength > 100);

assert.equal(normalizeCelebrityName("  Zendaya  "), "Zendaya");
assert.throws(() => normalizeCelebrityName("https://example.com"), /celebrity name/i);
assert.equal(noResultsMessage("Zendaya"), "No paparazzi photos found for “Zendaya”. Try another spelling, or upload a scene photo.");
const ranked = selectCelebrityHits("Zendaya", [
  {
    title: "Zendaya poster art",
    imageUrl: "https://cdn.example.com/poster.jpg",
    thumbUrl: "https://cdn.example.com/poster-t.jpg",
    pageUrl: "https://example.com/poster",
    width: 2000,
    height: 1200,
    source: "example.com",
  },
  {
    title: "Zendaya candid paparazzi",
    imageUrl: "https://cdn.example.com/candid.jpg",
    thumbUrl: "https://cdn.example.com/candid-t.jpg",
    pageUrl: "https://example.com/candid",
    width: 1200,
    height: 1600,
    source: "example.com",
  },
  {
    title: "Unrelated cat",
    imageUrl: "https://cdn.example.com/cat.jpg",
    thumbUrl: "https://cdn.example.com/cat-t.jpg",
    pageUrl: "https://example.com/cat",
    width: 1200,
    height: 1600,
    source: "example.com",
  },
  {
    title: "Zendaya paparazzi",
    imageUrl: "http://cdn.example.com/insecure.jpg",
    thumbUrl: "https://cdn.example.com/insecure-t.jpg",
    pageUrl: "https://example.com/insecure",
    width: 1200,
    height: 1600,
    source: "example.com",
  },
]);
assert.equal(ranked[0]?.title, "Zendaya candid paparazzi");
assert.equal(ranked.some((hit) => hit.title.includes("cat")), false);
assert.equal(ranked.some((hit) => hit.imageUrl.startsWith("http://")), false);
assert.deepEqual(
  parseDuckDuckGo({
    results: [
      {
        title: "Zendaya <b>paparazzi</b>",
        image: "https://cdn.example.com/a.jpg",
        thumbnail: "https://tse.mm.bing.net/th/a",
        url: "https://photos.example.com/p",
        width: 1200,
        height: 1600,
      },
    ],
  }).map((hit: SearchHit) => hit.source),
  ["photos.example.com"],
);
assert.equal(parseSerpApi({ images_results: [{ title: "A", original: "https://cdn.example.com/a.jpg", source: "example.com" }] })[0]?.imageUrl, "https://cdn.example.com/a.jpg");
assert.equal(
  parseGoogleCse({
    items: [{ title: "A", link: "https://cdn.example.com/a.jpg", displayLink: "example.com", image: { thumbnailLink: "https://cdn.example.com/t.jpg", width: 10, height: 20 } }],
  })[0]?.thumbUrl,
  "https://cdn.example.com/t.jpg",
);
assert.equal(parseBing({ value: [{ name: "A", contentUrl: "https://cdn.example.com/a.jpg", thumbnailUrl: "https://cdn.example.com/t.jpg", width: 8, height: 9 }] })[0]?.width, 8);
assert.equal(parseDuckDuckGo({}).length, 0);
const wikiHits = parseWikimedia({
  items: [
    {
      title: "File:Signature_of_Zendaya.svg",
      type: "image",
      srcset: [
        {
          src: "//upload.wikimedia.org/wikipedia/commons/thumb/4/44/Signature_of_Zendaya.svg/500px-Signature_of_Zendaya.svg.png",
          scale: "1x",
        },
      ],
    },
    {
      title: "File:Zendaya_by_Gage_Skidmore.jpg",
      type: "image",
      caption: { text: "Zendaya at San Diego Comic-Con in 2016" },
      srcset: [
        {
          src: "//thumb.wikimedia.org/wikipedia/commons/thumb/e/eb/Zendaya_by_Gage_Skidmore.jpg/500px-Zendaya_by_Gage_Skidmore.jpg?utm_source=en.wikipedia.org",
          scale: "1x",
        },
        {
          src: "//thumb.wikimedia.org/wikipedia/commons/thumb/e/eb/Zendaya_by_Gage_Skidmore.jpg/1280px-Zendaya_by_Gage_Skidmore.jpg?utm_source=en.wikipedia.org",
          scale: "2x",
        },
      ],
    },
    { title: "File:Interview.ogg", type: "audio" },
  ],
});
assert.equal(wikiHits.length, 1);
assert.equal(wikiHits[0]?.imageUrl, "https://upload.wikimedia.org/wikipedia/commons/e/eb/Zendaya_by_Gage_Skidmore.jpg");
assert.equal(
  wikiHits[0]?.thumbUrl,
  "https://thumb.wikimedia.org/wikipedia/commons/thumb/e/eb/Zendaya_by_Gage_Skidmore.jpg/1280px-Zendaya_by_Gage_Skidmore.jpg",
);
assert.equal(wikiHits[0]?.source, "commons.wikimedia.org");
assert.equal(selectCelebrityHits("Zendaya", wikiHits).length, 1);
assert.equal(parseWikimedia({}).length, 0);

const savedSearchEnv = {
  SERPAPI_API_KEY: process.env.SERPAPI_API_KEY,
  GOOGLE_CSE_API_KEY: process.env.GOOGLE_CSE_API_KEY,
  GOOGLE_CSE_CX: process.env.GOOGLE_CSE_CX,
  BING_IMAGE_SEARCH_KEY: process.env.BING_IMAGE_SEARCH_KEY,
};
delete process.env.SERPAPI_API_KEY;
delete process.env.GOOGLE_CSE_API_KEY;
delete process.env.GOOGLE_CSE_CX;
delete process.env.BING_IMAGE_SEARCH_KEY;
assert.equal(activeSearchProvider(), "wikimedia");
process.env.BING_IMAGE_SEARCH_KEY = "bing-key";
assert.equal(activeSearchProvider(), "bing");
process.env.GOOGLE_CSE_API_KEY = "google-key";
assert.throws(() => activeSearchProvider(), /GOOGLE_CSE_CX/);
process.env.GOOGLE_CSE_CX = "cx";
assert.equal(activeSearchProvider(), "google-cse");
process.env.SERPAPI_API_KEY = "serp-key";
assert.equal(activeSearchProvider(), "serpapi");
for (const [name, value] of Object.entries(savedSearchEnv)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

assert.throws(() => assertPublicImageUrl("http://cdn.example.com/a.jpg"), /not allowed/);
assert.throws(() => assertPublicImageUrl("https://127.0.0.1/a.jpg"), /not allowed/);
assert.throws(() => assertPublicImageUrl("https://169.254.169.254/latest"), /not allowed/);
assert.throws(() => assertPublicImageUrl("https://user:pass@cdn.example.com/a.jpg"), /not allowed/);
assert.equal(assertPublicImageUrl("https://cdn.example.com/a.jpg").hostname, "cdn.example.com");
const sceneToken = signSceneChoice({
  imageUrl: "https://cdn.example.com/a.jpg",
  thumbUrl: "https://cdn.example.com/t.jpg",
  source: "example.com",
});
assert.equal(readSceneChoice(sceneToken).imageUrl, "https://cdn.example.com/a.jpg");
assert.throws(() => readSceneChoice(`${sceneToken}x`), /not valid/);
assert.throws(() => signSceneChoice({ imageUrl: "https://127.0.0.1/a.jpg", thumbUrl: "https://cdn.example.com/t.jpg", source: "local" }), /not allowed/);

const carveMock = await saveMockJob(carve, "pumpkin-carve", { seed: 11 }, { image: sample });
const carvePng = await renderMockOutput(carveMock.outputId, undefined);
assert.ok(carvePng[0] === 0x89);

const cutJob = await saveMockJob(cutout, "background-removal", {}, { image: sample });
const cutPng = await renderMockOutput(cutJob.outputId, undefined);
const cutMeta = await sharp(cutPng).metadata();
assert.equal(cutMeta.hasAlpha, true);

assert.equal(easeSlide(0), 0);
assert.equal(easeSlide(1), 1);
assert.equal(easeSlide(-0.2), 0);
assert.equal(easeSlide(1.2), 1);
let slidePrev = 0;
for (let i = 1; i <= 400; i++) {
  const y = easeSlide(i / 400);
  assert.ok(y + 1e-12 >= slidePrev, `ease.slide went backwards at ${i / 400}`);
  assert.ok(y <= 1 + 1e-12);
  slidePrev = y;
}
assert.ok(easeSlide(0.2) < 0.08, "launch stays slow");
assert.ok(Math.abs(easeSlide(0.365) - 0.829763) < 1e-4, "position at the velocity peak");
assert.ok(easeSlide(0.5) > 0.7, "most of the travel is past the velocity peak");
assert.ok(easeSlide(0.99) > 0.99, "tail arrives before the end");
assert.equal(exitOpacity(0), 1);
assert.equal(exitOpacity(1), 0);
assert.equal(exitOpacity(0.25), 0.75);
assert.equal(exitOpacity(-0.2), 1);
assert.equal(exitOpacity(1.2), 0);
assert.equal(trackGap(12), 32);
assert.equal(trackGap(0), 32);
assert.equal(trackGap(130), 131);
assert.equal(trackGap(130.2), 132);

console.log("self-check ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
