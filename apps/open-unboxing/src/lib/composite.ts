import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { BoxPreset, InsertRect } from "./types";

export type MagentaMask = {
  rect: InsertRect;
  maskPng: Buffer;
};

/** Magenta well (#FF00FF ± tolerance) → white-on-black mask + bounding rect. */
export async function maskFromMagenta(emptyPath: string): Promise<MagentaMask> {
  const img = sharp(emptyPath);
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const mask = Buffer.alloc(w * h);
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  let hits = 0;
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const magenta = r > 180 && g < 110 && r - g > 90 && b > 90;
    if (magenta) {
      mask[i] = 255;
      hits += 1;
      const x = i % w;
      const y = Math.floor(i / w);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const maskPng = await sharp(mask, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
  if (hits < 200) {
    return {
      maskPng,
      rect: { x: 0.28, y: 0.34, w: 0.44, h: 0.28 },
    };
  }
  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  return {
    maskPng,
    rect: {
      x: minX / w,
      y: minY / h,
      w: (maxX - minX) / w,
      h: (maxY - minY) / h,
    },
  };
}

export async function fillMagentaWithCardboard(emptyPath: string, dest: string): Promise<void> {
  const img = sharp(emptyPath);
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    if (r > 180 && g < 110 && r - g > 90 && b > 90) {
      data[i * 4] = 214;
      data[i * 4 + 1] = 196;
      data[i * 4 + 2] = 168;
    }
  }
  await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toFile(dest);
}

export async function nestProduct(opts: {
  emptyPath: string;
  productCutoutPath: string;
  dest: string;
  insert: InsertRect;
  logoPath?: string;
}): Promise<void> {
  const empty = sharp(opts.emptyPath);
  const meta = await empty.metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1365;
  const wellW = Math.round(opts.insert.w * W);
  const wellH = Math.round(opts.insert.h * H);
  const wellX = Math.round(opts.insert.x * W);
  const wellY = Math.round(opts.insert.y * H);
  const pad = 0.12;
  const maxW = Math.max(8, Math.round(wellW * (1 - pad)));
  const maxH = Math.max(8, Math.round(wellH * (1 - pad)));

  const product = sharp(opts.productCutoutPath).ensureAlpha();
  const pmeta = await product.metadata();
  const pw = pmeta.width ?? maxW;
  const ph = pmeta.height ?? maxH;
  const scale = Math.min(maxW / pw, maxH / ph);
  const tw = Math.max(1, Math.round(pw * scale));
  const th = Math.max(1, Math.round(ph * scale));
  const px = wellX + Math.round((wellW - tw) / 2);
  const py = wellY + Math.round((wellH - th) / 2);

  const resized = await product.resize(tw, th, { fit: "inside" }).png().toBuffer();

  const composites: sharp.OverlayOptions[] = [{ input: resized, left: px, top: py }];

  if (opts.logoPath) {
    const sticker = await sharp(opts.logoPath)
      .ensureAlpha()
      .resize(Math.round(W * 0.12), Math.round(W * 0.12), { fit: "inside" })
      .png()
      .toBuffer();
    composites.push({
      input: sticker,
      left: Math.round(W * 0.62),
      top: Math.round(H * 0.22),
    });
  }

  await empty.composite(composites).png().toFile(opts.dest);
}

export async function applyLogoToLid(opts: {
  lidPath: string;
  logoPath: string;
  dest: string;
}): Promise<void> {
  const lid = sharp(opts.lidPath);
  const meta = await lid.metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1365;
  const sticker = await sharp(opts.logoPath)
    .ensureAlpha()
    .resize(Math.round(W * 0.14), Math.round(W * 0.14), { fit: "inside" })
    .png()
    .toBuffer();
  await lid
    .composite([{ input: sticker, left: Math.round(W * 0.43), top: Math.round(H * 0.42) }])
    .png()
    .toFile(opts.dest);
}

export async function padTo916(src: string, dest: string, color = "#d7c7a8"): Promise<void> {
  const img = sharp(src);
  const meta = await img.metadata();
  const w = meta.width ?? 1024;
  const h = meta.height ?? 1365;
  const targetW = w;
  const targetH = Math.round((targetW * 16) / 9);
  if (h >= targetH) {
    await img
      .resize(targetW, targetH, { fit: "cover", position: "centre" })
      .png()
      .toFile(dest);
    return;
  }
  const y = Math.round((targetH - h) / 2);
  await sharp({
    create: { width: targetW, height: targetH, channels: 3, background: color },
  })
    .composite([{ input: await img.png().toBuffer(), top: y, left: 0 }])
    .png()
    .toFile(dest);
}

export async function publicPresetPath(rel: string): Promise<string> {
  const clean = rel.replace(/^\//, "");
  return path.join(process.cwd(), "public", clean);
}

export async function writeMaskPng(dest: string, buf: Buffer): Promise<void> {
  await writeFile(dest, buf);
}

export async function readPng(file: string): Promise<Buffer> {
  return readFile(file);
}
