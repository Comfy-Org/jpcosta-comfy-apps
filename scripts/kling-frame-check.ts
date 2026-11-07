import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApp } from "../src/lib/config";
import {
  KLING_FRAME_MAX_PIXELS,
  KLING_FRAME_MAX_SIDE,
  KLING_MAX_ASPECT,
  KLING_MIN_ASPECT,
  KLING_MIN_SIDE,
  WEBM_HEADER_SCAN_BYTES,
  applyKlingFrame,
  fitKlingFrame,
  readVideoPixelSize,
  type KlingFrame,
} from "../src/lib/kling-frame";
import { buildJobBody } from "../src/lib/workflow";

function assertLegal(frame: KlingFrame) {
  assert.ok(frame.width >= KLING_MIN_SIDE && frame.height >= KLING_MIN_SIDE);
  assert.ok(frame.width <= KLING_FRAME_MAX_SIDE && frame.height <= KLING_FRAME_MAX_SIDE);
  assert.ok(frame.width % 2 === 0 && frame.height % 2 === 0);
  const aspect = frame.width / frame.height;
  assert.ok(aspect >= KLING_MIN_ASPECT - 1e-9 && aspect <= KLING_MAX_ASPECT + 1e-9);
  assert.ok(frame.width * frame.height <= KLING_FRAME_MAX_PIXELS);
  assert.ok(frame.contentWidth <= frame.width && frame.contentHeight <= frame.height);
  assert.ok(frame.contentWidth >= 2 && frame.contentHeight >= 2);
}

function assertUniform(srcW: number, srcH: number, frame: KlingFrame) {
  const scaleX = frame.contentWidth / srcW;
  const scaleY = frame.contentHeight / srcH;
  assert.ok(Math.abs(scaleX - scaleY) <= 1 / Math.min(srcW, srcH) + 0.01);
}

function main() {
  const landscape = fitKlingFrame(720, 406);
  assert.deepEqual(
    { width: landscape.width, height: landscape.height },
    { width: 1242, height: 700 },
  );
  assertLegal(landscape);
  assertUniform(720, 406, landscape);
  assert.ok(Math.abs(landscape.width / landscape.height - 720 / 406) < 0.01);

  const portrait = fitKlingFrame(406, 720);
  assert.deepEqual(
    { width: portrait.width, height: portrait.height },
    { width: 700, height: 1242 },
  );
  assertLegal(portrait);
  assertUniform(406, 720, portrait);

  const square = fitKlingFrame(512, 512);
  assert.deepEqual({ width: square.width, height: square.height, padded: square.padded }, { width: 700, height: 700, padded: false });
  assertLegal(square);

  for (const [width, height] of [
    [1280, 720],
    [1920, 1080],
    [720, 1280],
    [1080, 1080],
  ] as const) {
    const frame = fitKlingFrame(width, height);
    assert.deepEqual(
      { width: frame.width, height: frame.height, padded: frame.padded },
      { width, height, padded: false },
      `${width}x${height}`,
    );
    assertLegal(frame);
  }

  const huge = fitKlingFrame(3840, 2160);
  assert.deepEqual({ width: huge.width, height: huge.height, padded: huge.padded }, { width: 1920, height: 1080, padded: false });
  assertLegal(huge);
  assertUniform(3840, 2160, huge);

  const tall = fitKlingFrame(200, 2000);
  assert.equal(tall.padded, true);
  assert.deepEqual({ width: tall.width, height: tall.height }, { width: 700, height: 1750 });
  assertLegal(tall);
  assertUniform(200, 2000, tall);
  assert.ok(tall.contentWidth < tall.width);

  const wide = fitKlingFrame(2000, 200);
  assert.equal(wide.padded, true);
  assert.deepEqual({ width: wide.width, height: wide.height }, { width: 1750, height: 700 });
  assertLegal(wide);
  assertUniform(2000, 200, wide);

  assert.throws(() => fitKlingFrame(8000, 1), /too thin/);

  const app = getApp("reverse-3d");
  if (!app) throw new Error("missing reverse-3d");
  const job = buildJobBody(
    app,
    { video: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", filePath: "input.mp4" } },
    { seed: 9, hasImage: true },
    "team-key",
  );
  const fitted = applyKlingFrame(job.workflow, 720, 406);
  assert.equal(fitted.width, 1242);
  assert.equal(fitted.height, 700);
  assert.equal(job.workflow["17"].class_type, "ResizeAndPadImage");
  assert.deepEqual(job.workflow["17"].inputs.image, ["15", 0]);
  assert.equal(job.workflow["17"].inputs.target_width, 1242);
  assert.equal(job.workflow["17"].inputs.target_height, 700);
  assert.equal(job.workflow["17"].inputs.padding_color, "black");
  assert.equal(job.workflow["17"].inputs.interpolation, "lanczos");
  assert.deepEqual(job.workflow["16"].inputs.images, ["17", 0]);
  assert.deepEqual(job.workflow["16"].inputs.audio, ["15", 1]);
  assert.equal(job.workflow["16"].inputs.fps, 24);
  assert.deepEqual(job.workflow["20"].inputs["model.video_1"], ["16", 0]);
  assert.equal(job.workflow["20"].class_type, "Kling4EditVideoNode");

  const dir = mkdtempSync(path.join(tmpdir(), "kling-frame-"));
  const samples: Array<{ name: string; args: string[]; width: number; height: number }> = [
    { name: "land.mp4", args: ["-c:v", "libx264", "-pix_fmt", "yuv420p"], width: 720, height: 406 },
    { name: "port.mp4", args: ["-c:v", "libx264", "-pix_fmt", "yuv420p"], width: 406, height: 720 },
    { name: "square.mp4", args: ["-c:v", "libx264", "-pix_fmt", "yuv420p"], width: 512, height: 512 },
    { name: "hd.mp4", args: ["-c:v", "libx264", "-pix_fmt", "yuv420p"], width: 1280, height: 720 },
    { name: "land.webm", args: ["-c:v", "libvpx-vp9"], width: 720, height: 406 },
    { name: "port.mov", args: ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mov"], width: 406, height: 720 },
  ];
  for (const sample of samples) {
    const file = path.join(dir, sample.name);
    execFileSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", `color=c=black:s=${sample.width}x${sample.height}:r=24`, "-t", "0.2", ...sample.args, file],
      { stdio: "ignore" },
    );
    const read = readVideoPixelSize(readFileSync(file));
    assert.deepEqual(read, { width: sample.width, height: sample.height }, sample.name);
    const frame = fitKlingFrame(read.width, read.height);
    assertLegal(frame);
    if (sample.width === 720 && sample.height === 406) assert.deepEqual({ width: frame.width, height: frame.height }, { width: 1242, height: 700 });
  }

  const chrome = readVideoPixelSize(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/chrome-media-recorder-720x406.webm")),
  );
  assert.deepEqual(chrome, { width: 720, height: 406 });
  const chromeFrame = fitKlingFrame(chrome?.width ?? 0, chrome?.height ?? 0);
  assert.deepEqual({ width: chromeFrame.width, height: chromeFrame.height }, { width: 1242, height: 700 });

  assert.deepEqual(readVideoPixelSize(unknownSegmentWebm(720, 406)), { width: 720, height: 406 });
  assert.deepEqual(readVideoPixelSize(finiteSegmentWebm(640, 360)), { width: 640, height: 360 });
  assert.equal(readVideoPixelSize(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01])), null);
  assert.equal(readVideoPixelSize(Buffer.alloc(32, 0xff)), null);
  assert.equal(readVideoPixelSize(unknownSegmentWebm(720, 406).subarray(0, 12)), null);
  assert.equal(readVideoPixelSize(Buffer.concat([ebmlHeader(), Buffer.from([0x18, 0x53, 0x80, 0x67])])), null);

  const codedPath = path.join(dir, "coded.mp4");
  execFileSync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", "color=c=red:s=1280x720:r=24", "-frames:v", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", codedPath],
    { stdio: "ignore" },
  );
  const coded = readFileSync(codedPath);
  assert.deepEqual(readVideoPixelSize(coded), { width: 1280, height: 720 });
  const turned = writeDisplayMatrix(coded, 0, 65536, -65536, 0);
  assert.deepEqual(readVideoPixelSize(turned), { width: 720, height: 1280 });
  const turnedFrame = fitKlingFrame(720, 1280);
  assert.deepEqual(
    { width: turnedFrame.width, height: turnedFrame.height, padded: turnedFrame.padded },
    { width: 720, height: 1280, padded: false },
  );
  const half = writeDisplayMatrix(coded, -65536, 0, 0, -65536);
  assert.deepEqual(readVideoPixelSize(half), { width: 1280, height: 720 });

  const wideFinite = largeFiniteWebm(720, 406);
  assert.ok(wideFinite.length > WEBM_HEADER_SCAN_BYTES);
  assert.deepEqual(readVideoPixelSize(wideFinite), { width: 720, height: 406 });

  const big = extendFiniteWebm(readFileSync(path.join(dir, "land.webm")), WEBM_HEADER_SCAN_BYTES + 64 * 1024);
  assert.ok(big.length > WEBM_HEADER_SCAN_BYTES, `big webm was ${big.length}`);
  const segmentAt = big.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  assert.ok(segmentAt >= 0);
  assert.notDeepEqual(
    [...big.subarray(segmentAt + 4, segmentAt + 12)],
    [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  );
  assert.deepEqual(readVideoPixelSize(big), { width: 720, height: 406 });

  console.log("kling-frame-check ok");
}

function ebmlHeader(): Buffer {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]);
}

function sizeVint(value: number): Buffer {
  if (value < 127) return Buffer.from([0x80 | value]);
  return Buffer.from([0x40 | (value >> 8), value & 0xff]);
}

function element(id: Buffer, data: Buffer): Buffer {
  return Buffer.concat([id, sizeVint(data.length), data]);
}

function videoTrack(width: number, height: number): Buffer {
  const dims = Buffer.from([0xb0, 0x82, (width >> 8) & 0xff, width & 0xff, 0xba, 0x82, (height >> 8) & 0xff, height & 0xff]);
  const video = element(Buffer.from([0xe0]), dims);
  const entry = element(Buffer.from([0xae]), video);
  return element(Buffer.from([0x16, 0x54, 0xae, 0x6b]), entry);
}

function unknownSegmentWebm(width: number, height: number): Buffer {
  return Buffer.concat([
    ebmlHeader(),
    Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    videoTrack(width, height),
  ]);
}

function finiteSegmentWebm(width: number, height: number): Buffer {
  const tracks = videoTrack(width, height);
  return Buffer.concat([ebmlHeader(), element(Buffer.from([0x18, 0x53, 0x80, 0x67]), tracks)]);
}

/** Finite Segment whose declared size is past the header scan budget. Dimensions stay in the header. */
function largeFiniteWebm(width: number, height: number): Buffer {
  const tracks = videoTrack(width, height);
  const payloadSize = WEBM_HEADER_SCAN_BYTES + 64 * 1024;
  const payload = Buffer.alloc(payloadSize);
  tracks.copy(payload);
  const size = Buffer.from([0x20 | ((payloadSize >> 16) & 0x1f), (payloadSize >> 8) & 0xff, payloadSize & 0xff]);
  return Buffer.concat([ebmlHeader(), Buffer.from([0x18, 0x53, 0x80, 0x67]), size, payload]);
}

/** Keep ffmpeg's real header and stretch the finite Segment past the scan budget. */
function extendFiniteWebm(source: Buffer, minPayload: number): Buffer {
  const id = Buffer.from([0x18, 0x53, 0x80, 0x67]);
  const at = source.indexOf(id);
  if (at < 0) throw new Error("segment missing");
  const first = source[at + 4] ?? 0;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8) throw new Error("unexpected segment size width");
  let declared = first & (mask - 1);
  for (let index = 1; index < length; index += 1) declared = declared * 256 + (source[at + 4 + index] ?? 0);
  const data = at + 4 + length;
  if (data + declared > source.length) throw new Error("segment payload is truncated");
  const payload = source.subarray(data, data + declared);
  const grown = Buffer.concat([payload, Buffer.alloc(Math.max(0, minPayload - payload.length))]);
  const size = Buffer.alloc(8);
  size[0] = 0x01;
  let remaining = grown.length;
  for (let index = 7; index >= 1; index -= 1) {
    size[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.concat([source.subarray(0, at), id, size, grown]);
}

function writeDisplayMatrix(mp4: Buffer, a: number, b: number, c: number, d: number): Buffer {
  const copy = Buffer.from(mp4);
  const typeAt = copy.indexOf("tkhd");
  if (typeAt < 4) throw new Error("tkhd missing");
  const start = typeAt - 4;
  const version = copy[start + 8] ?? 0;
  const matrix = start + 8 + (version === 1 ? 52 : 40);
  copy.writeInt32BE(a, matrix);
  copy.writeInt32BE(b, matrix + 4);
  copy.writeInt32BE(0, matrix + 8);
  copy.writeInt32BE(c, matrix + 12);
  copy.writeInt32BE(d, matrix + 16);
  return copy;
}

main();
