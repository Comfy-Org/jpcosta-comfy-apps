import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getApp } from "../src/lib/config";
import {
  KLING_FRAME_MAX_PIXELS,
  KLING_FRAME_MAX_SIDE,
  KLING_MAX_ASPECT,
  KLING_MIN_ASPECT,
  KLING_MIN_SIDE,
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

  console.log("kling-frame-check ok");
}

main();
