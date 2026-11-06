import { readFileSync } from "node:fs";
import path from "node:path";
import { getBoxPreset, insertPixels } from "@/lib/box-presets";
import type { AppConfig, ParamSpec } from "@/lib/config";
import { AppError } from "@/lib/http";
import { buildPrompt, resolutionValue, unboxingMotionPrompt, unboxingNestPrompt, type RunParams } from "@/lib/prompts";

export type WorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};

export type Workflow = Record<string, WorkflowNode>;

export type AssetRef = {
  __type: "core/ASSET";
  info: { id: string; file_path: string };
};

export type JobBody = {
  workflow: Workflow;
  extra_data?: { api_key_comfy_org: string };
};

export type UploadedAsset = {
  id: string;
  filePath: string;
};

const FILE_NAMES: Record<string, string> = {
  image: "input.png",
  person: "person.png",
  garment: "garment.png",
  hand: "hand.png",
  product: "product.png",
  scene: "scene.png",
  user: "user.png",
  empty: "box_empty.png",
  lid: "box_lid.png",
};

export function filePathFor(role: string): string {
  return FILE_NAMES[role] ?? `${role.replace(/[^a-z0-9_-]/gi, "") || "input"}.png`;
}

export function assetRef(id: string, filePath: string): AssetRef {
  return { __type: "core/ASSET", info: { id, file_path: filePath } };
}

function loadWorkflow(rel: string): Workflow {
  const prefix = "workflows/";
  if (!rel.startsWith(prefix) || rel.includes("..") || path.isAbsolute(rel)) {
    throw new AppError(500, "internal", "Workflow path is outside the workflows directory.");
  }
  // Join under workflows/ so the file tracer can see the directory. A fully
  // dynamic path.resolve(cwd, rel) either drops these JSON files or pulls in
  // the whole project.
  const resolved = path.join(process.cwd(), "workflows", rel.slice(prefix.length));
  return JSON.parse(readFileSync(resolved, "utf8")) as Workflow;
}

function writeInput(workflow: Workflow, spec: ParamSpec, value: string | number): void {
  const targets = [{ node: spec.node, input: spec.input }, ...(spec.also ?? [])];
  for (const target of targets) {
    const node = workflow[target.node];
    if (!node) throw new AppError(500, "internal", `Workflow is missing node ${target.node}.`);
    node.inputs[target.input] = value;
  }
}

function withDescription(template: string, description: string | undefined): string {
  const detail = description?.trim() ? ` ${description.trim()}` : "";
  return template.replaceAll("{description}", detail).replace(/\s{2,}/g, " ").trim();
}

const UNBOXING_EXTRAS: { role: string; node: string }[] = [
  { role: "product_2", node: "21" },
  { role: "product_3", node: "22" },
  { role: "product_4", node: "23" },
  { role: "product_5", node: "24" },
];

/** Preset geometry, FLUX reference slots, and the locked overhead prompts. */
export function applyUnboxing(workflow: Workflow, assets: Record<string, UploadedAsset>, params: RunParams): void {
  const preset = params.box ? getBoxPreset(params.box) : null;
  if (!preset) throw new AppError(400, "invalid_input", "Choose a box.");
  const box = insertPixels(preset);
  const composite = workflow["10"];
  const productScale = workflow["5"];
  const maskScale = workflow["7"];
  const flux = workflow["11"];
  const ltx = workflow["13"];
  if (!composite || !productScale || !maskScale || !flux || !ltx) {
    throw new AppError(500, "internal", "The unboxing workflow is missing a required node.");
  }
  composite.inputs.x = box.x;
  composite.inputs.y = box.y;
  productScale.inputs.width = box.width;
  productScale.inputs.height = box.height;
  maskScale.inputs.width = box.width;
  maskScale.inputs.height = box.height;

  const images: Record<string, [string, number]> = {
    image_1: ["10", 0],
    image_2: ["1", 0],
  };
  let slot = 3;
  for (const extra of UNBOXING_EXTRAS) {
    const asset = assets[extra.role];
    if (!asset) {
      delete workflow[extra.node];
      continue;
    }
    const node = workflow[extra.node];
    if (!node) throw new AppError(500, "internal", `Workflow is missing node ${extra.node}.`);
    node.inputs.image = assetRef(asset.id, asset.filePath);
    images[`image_${slot}`] = [extra.node, 0];
    slot += 1;
  }
  // Autogrow inputs must be flat "images.image_N" keys. A nested `images`
  // object is silently ignored, which made FLUX run text-only and invent a product.
  delete flux.inputs.images;
  for (const key of Object.keys(flux.inputs)) {
    if (key.startsWith("images.")) delete flux.inputs[key];
  }
  for (const [key, link] of Object.entries(images)) flux.inputs[`images.${key}`] = link;
  flux.inputs.prompt = unboxingNestPrompt(slot - 2);
  ltx.inputs.prompt = unboxingMotionPrompt();
}

function mappedValue(spec: ParamSpec, params: RunParams): string | number {
  const map = spec.map ?? {};
  if (params.scale !== undefined && String(params.scale) in map && spec.input === "scale_by") {
    return map[String(params.scale)];
  }
  if (params.frames !== undefined && String(params.frames) in map) {
    return map[String(params.frames)];
  }
  throw new AppError(400, "invalid_input", `Missing a value for ${spec.input}.`);
}

export function applyParams(workflow: Workflow, app: AppConfig, params: RunParams): void {
  for (const [name, spec] of Object.entries(app.params)) {
    if (!workflow[spec.node]) {
      throw new AppError(500, "internal", `Workflow is missing node ${spec.node}.`);
    }
    if (name === "prompt") {
      writeInput(workflow, spec, buildPrompt(app, params));
    } else if (name === "positive") {
      writeInput(workflow, spec, withDescription(spec.template ?? "", params.description));
    } else if (name === "seed") {
      writeInput(workflow, spec, params.seed ?? 0);
    } else if (name === "resolution") {
      writeInput(workflow, spec, resolutionValue(params.resolution, spec.default ?? "2K"));
    } else if (name === "videoSize") {
      const map = spec.map ?? {};
      const key = params.videoSize || spec.default || "";
      if (!(key in map)) throw new AppError(400, "invalid_input", "Choose 480p or 720p.");
      writeInput(workflow, spec, map[key]);
    } else if (spec.map) {
      writeInput(workflow, spec, mappedValue(spec, params));
    } else if (spec.default !== undefined) {
      writeInput(workflow, spec, spec.default);
    }
  }
}

export function buildJobBody(
  app: AppConfig,
  assets: Record<string, UploadedAsset>,
  params: RunParams,
  keyForPartner: string | null,
): JobBody {
  const promptOnly = Boolean(app.workflowPromptOnly && !assets.image);
  const workflow = loadWorkflow(promptOnly ? app.workflowPromptOnly! : app.workflow);

  for (const [role, spec] of Object.entries(app.imageInputs)) {
    const asset = assets[role];
    if (!asset) {
      if (spec.optional || promptOnly) continue;
      throw new AppError(400, "invalid_input", "Upload the required image.");
    }
    const node = workflow[spec.node];
    if (!node) throw new AppError(500, "internal", `Workflow is missing node ${spec.node}.`);
    node.inputs[spec.input] = assetRef(asset.id, asset.filePath);
  }

  for (const [role, spec] of Object.entries(app.videoInputs ?? {})) {
    const asset = assets[role];
    if (!asset) {
      throw new AppError(
        400,
        "invalid_input",
        app.title === "Reverse 3D" ? "Upload a video." : "Upload a video of someone holding the product.",
      );
    }
    const node = workflow[spec.node];
    if (!node) throw new AppError(500, "internal", `Workflow is missing node ${spec.node}.`);
    node.inputs[spec.input] = assetRef(asset.id, asset.filePath);
  }

  applyParams(workflow, app, params);
  if (app.pipeline === "unboxing") applyUnboxing(workflow, assets, params);

  const body: JobBody = { workflow };
  if (app.partnerNodes) {
    body.extra_data = { api_key_comfy_org: keyForPartner ?? "" };
  }
  return body;
}

export function redactJobBody(body: JobBody): JobBody {
  const clone = structuredClone(body);
  if (clone.extra_data && "api_key_comfy_org" in clone.extra_data) {
    clone.extra_data.api_key_comfy_org = "<redacted>";
  }
  return clone;
}
