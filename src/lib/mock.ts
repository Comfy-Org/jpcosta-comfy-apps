import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { AppConfig } from "@/lib/config";
import { AppError } from "@/lib/http";
import { newMockJobId, newMockOutputId } from "@/lib/ids";
import type { RunParams } from "@/lib/prompts";
import type { JobView } from "@/lib/types";

const ROOT = path.join("/tmp", "comfy-api-apps");

export type MockMeta = {
  id: string;
  app: string;
  createdAt: number;
  outputId: string;
  outputNode: string;
  params: RunParams;
  roles: string[];
};

const QUEUED_MS = 700;
const RUN_MS = 2800;

function dirFor(jobId: string): string {
  return path.join(ROOT, jobId);
}

export async function saveMockJob(
  app: AppConfig,
  appId: string,
  params: RunParams,
  files: Record<string, Buffer>,
): Promise<MockMeta> {
  const meta: MockMeta = {
    id: newMockJobId(),
    app: appId,
    createdAt: Date.now(),
    outputId: newMockOutputId(),
    outputNode: app.output.node,
    params,
    roles: Object.keys(files),
  };
  const dir = dirFor(meta.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  for (const [role, buf] of Object.entries(files)) {
    await writeFile(path.join(dir, `${role}.png`), buf);
  }
  await mkdir(path.join(ROOT, "outputs"), { recursive: true });
  await writeFile(path.join(ROOT, "outputs", `${meta.outputId}.json`), JSON.stringify({ jobId: meta.id }));
  return meta;
}

export async function readMockMeta(jobId: string): Promise<MockMeta | null> {
  try {
    const raw = await readFile(path.join(dirFor(jobId), "meta.json"), "utf8");
    return JSON.parse(raw) as MockMeta;
  } catch {
    return null;
  }
}

export function mockJobView(meta: MockMeta, now = Date.now()): JobView {
  const elapsed = now - meta.createdAt;
  if (elapsed < QUEUED_MS) {
    return { id: meta.id, status: "queued", progress: 0, outputs: [], error: null };
  }
  if (elapsed < QUEUED_MS + RUN_MS) {
    const progress = (elapsed - QUEUED_MS) / RUN_MS;
    return {
      id: meta.id,
      status: "running",
      progress: Math.min(0.96, Math.max(0.05, progress)),
      outputs: [],
      error: null,
    };
  }
  return {
    id: meta.id,
    status: "succeeded",
    progress: 1,
    outputs: [{ id: meta.outputId, nodeId: meta.outputNode, name: `${meta.app}.png` }],
    error: null,
  };
}

async function readRole(jobId: string, role: string): Promise<Buffer> {
  try {
    return await readFile(path.join(dirFor(jobId), `${role}.png`));
  } catch {
    throw new AppError(404, "not_found", "That mock output is no longer available. Run it again.");
  }
}

function parseGrid(label: string): { cols: number; rows: number } {
  const match = /^(\d+)x(\d+)$/.exec(label);
  if (!match) return { cols: 2, rows: 2 };
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

async function renderRelight(input: Buffer, params: RunParams): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 512;
  const height = meta.height ?? 512;
  const preset = params.preset ?? "studio";
  const fromLeft = params.direction !== "right";
  const intensity = params.intensity ?? 70;
  const alpha = (0.18 + (intensity / 100) * 0.55).toFixed(2);
  const colors =
    preset === "neon"
      ? ["#ff3bd0", "#35e4ff"]
      : preset === "golden"
        ? ["#ffb347", "#ff7a18"]
        : ["#ffffff", "#c9c4bc"];
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="${fromLeft ? "0%" : "100%"}" y1="0%" x2="${fromLeft ? "100%" : "0%"}" y2="80%">
        <stop offset="0%" stop-color="${colors[0]}" stop-opacity="${alpha}"/>
        <stop offset="100%" stop-color="${colors[1]}" stop-opacity="0.08"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
  </svg>`);
  const modulate =
    preset === "neon"
      ? { brightness: 0.72, saturation: 1.35 }
      : preset === "golden"
        ? { brightness: 1.06, saturation: 1.28 }
        : { brightness: 1.08, saturation: 0.82 };
  return sharp(input).modulate(modulate).composite([{ input: svg, blend: "over" }]).png().toBuffer();
}

async function renderUpscale(input: Buffer, params: RunParams): Promise<Buffer> {
  const factor = params.scale === "4" ? 4 : 2;
  const meta = await sharp(input).metadata();
  const width = Math.max(1, (meta.width ?? 1) * factor);
  const height = Math.max(1, (meta.height ?? 1) * factor);
  return sharp(input)
    .resize(width, height, { kernel: "lanczos3" })
    .sharpen({ sigma: factor === 4 ? 1.2 : 0.6 })
    .png()
    .toBuffer();
}

async function mascot(): Promise<Buffer> {
  const svg = Buffer.from(`<svg width="360" height="460" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="180" cy="250" rx="92" ry="110" fill="#F2A24A"/>
    <circle cx="180" cy="150" r="78" fill="#F6B15A"/>
    <ellipse cx="118" cy="92" rx="28" ry="48" fill="#E07030"/>
    <ellipse cx="242" cy="92" rx="28" ry="48" fill="#E07030"/>
    <circle cx="150" cy="148" r="12" fill="#211927"/>
    <circle cx="210" cy="148" r="12" fill="#211927"/>
    <ellipse cx="180" cy="176" rx="14" ry="8" fill="#211927"/>
    <rect x="150" y="330" width="22" height="70" rx="10" fill="#8A5A32"/>
    <rect x="188" y="330" width="22" height="70" rx="10" fill="#8A5A32"/>
  </svg>`);
  return sharp(svg).png().toBuffer();
}

async function renderSprite(input: Buffer | null, params: RunParams, gridLabel: string): Promise<Buffer> {
  const { cols, rows } = parseGrid(gridLabel);
  const frames = cols * rows;
  const sheet =
    cols >= 6 ? { w: 1800, h: 620 } : cols >= 4 ? { w: 1600, h: 860 } : { w: 1024, h: 1024 };
  const cellW = Math.floor(sheet.w / cols);
  const cellH = Math.floor(sheet.h / rows);
  const source = input ?? (await mascot());
  const fitted = await sharp(source)
    .resize(Math.floor(cellW * 0.72), Math.floor(cellH * 0.78), { fit: "inside" })
    .png()
    .toBuffer();
  const fittedMeta = await sharp(fitted).metadata();
  const fw = fittedMeta.width ?? 1;
  const fh = fittedMeta.height ?? 1;
  const composites = [];
  for (let i = 0; i < frames; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const step = (i % 2 === 0 ? -1 : 1) * Math.round(cellW * 0.04);
    const left = Math.max(0, col * cellW + Math.round((cellW - fw) / 2) + step);
    const top = Math.max(0, row * cellH + Math.round((cellH - fh) / 2));
    composites.push({ input: fitted, left, top });
  }
  return sharp({
    create: { width: sheet.w, height: sheet.h, channels: 3, background: "#ffffff" },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

async function renderTryOn(person: Buffer, garment: Buffer): Promise<Buffer> {
  const meta = await sharp(person).metadata();
  const width = meta.width ?? 512;
  const height = meta.height ?? 512;
  const overlay = await sharp(garment)
    .resize(Math.round(width * 0.42), Math.round(height * 0.42), { fit: "inside" })
    .png()
    .toBuffer();
  const overlayMeta = await sharp(overlay).metadata();
  const ow = overlayMeta.width ?? 1;
  const oh = overlayMeta.height ?? 1;
  const left = Math.max(0, Math.round((width - ow) / 2));
  const top = Math.max(0, Math.min(height - oh, Math.round(height * 0.32)));
  return sharp(person)
    .composite([{ input: overlay, left, top, blend: "over" }])
    .png()
    .toBuffer();
}

async function renderCutout(input: Buffer): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 512;
  const height = meta.height ?? 512;
  const rx = Math.round(width * 0.34);
  const ry = Math.round(height * 0.42);
  const mask = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><ellipse cx="${Math.round(width / 2)}" cy="${Math.round(height / 2)}" rx="${rx}" ry="${ry}" fill="#fff"/></svg>`,
  );
  const maskPng = await sharp(mask).png().toBuffer();
  return sharp(input).ensureAlpha().composite([{ input: maskPng, blend: "dest-in" }]).png().toBuffer();
}

export async function renderMockOutput(outputId: string, grids: Record<string, string> | undefined): Promise<Buffer> {
  let pointer: { jobId: string };
  try {
    pointer = JSON.parse(await readFile(path.join(ROOT, "outputs", `${outputId}.json`), "utf8")) as { jobId: string };
  } catch {
    throw new AppError(404, "not_found", "That output was not found.");
  }
  const meta = await readMockMeta(pointer.jobId);
  if (!meta) throw new AppError(404, "not_found", "That output was not found.");

  const cached = path.join(dirFor(meta.id), "output.png");
  try {
    return await readFile(cached);
  } catch {
    /* generate once */
  }

  const params = meta.params;
  let png: Buffer;
  if (meta.app === "product-relight") {
    png = await renderRelight(await readRole(meta.id, "image"), params);
  } else if (meta.app === "image-upscaler") {
    png = await renderUpscale(await readRole(meta.id, "image"), params);
  } else if (meta.app === "sprite-generator") {
    const image = meta.roles.includes("image") ? await readRole(meta.id, "image") : null;
    const grid = grids?.[params.frames ?? "4"] ?? "2x2";
    png = await renderSprite(image, params, grid);
  } else if (meta.app === "virtual-try-on") {
    png = await renderTryOn(await readRole(meta.id, "person"), await readRole(meta.id, "garment"));
  } else if (meta.app === "hand-product-swap") {
    png = await renderTryOn(await readRole(meta.id, "hand"), await readRole(meta.id, "product"));
  } else if (meta.app === "paparazzi-me") {
    png = await renderTryOn(await readRole(meta.id, "scene"), await readRole(meta.id, "user"));
  } else if (meta.app === "background-removal") {
    png = await renderCutout(await readRole(meta.id, "image"));
  } else if (meta.app === "open-product-swap") {
    png = await renderTryOn(await readRole(meta.id, "product"), await readRole(meta.id, "product"));
  } else if (meta.app === "open-unboxing") {
    const plate = meta.roles.includes("empty") ? await readRole(meta.id, "empty") : await readRole(meta.id, "product");
    png = await renderTryOn(plate, await readRole(meta.id, "product"));
  } else if (meta.app === "pumpkin-carve") {
    png = await renderTryOn(await readRole(meta.id, "image"), await readRole(meta.id, "image"));
  } else if (meta.app === "reverse-3d") {
    png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 176, g: 176, b: 176 } },
    })
      .png()
      .toBuffer();
  } else {
    throw new AppError(404, "not_found", "That output was not found.");
  }
  await writeFile(cached, png);
  return png;
}
