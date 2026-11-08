import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  appearTime,
  assemblyOrder,
  buildCells,
  clampOrbit,
  depthToZ,
  focalLength,
  orbitCamera,
  ORBIT_PITCH_LIMIT,
  ORBIT_YAW_LIMIT,
  targetCount,
  unproject,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../demo/waiting-blocks/scene.mjs";

const width = 12;
const height = 9;
const depth = new Uint8Array(width * height);
const rgba = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const i = y * width + x;
    depth[i] = x < 4 ? 220 : 20;
    rgba[i * 4] = 10;
    rgba[i * 4 + 1] = 20;
    rgba[i * 4 + 2] = 30;
    rgba[i * 4 + 3] = 255;
  }
}
const built = buildCells(depth, rgba, width, height, 4);
const arranged = assemblyOrder(built.cells);
assert.equal(arranged.order.length, built.cells.length);
assert.ok(arranged.sparse > 0 && arranged.sparse < arranged.order.length);
assert.ok(arranged.order.slice(0, arranged.sparse).every((cell) => cell.ix % 3 === 0 && cell.iy % 3 === 0));
assert.ok(depthToZ(255) < depthToZ(0));
const near = arranged.order.find((cell) => cell.ix === 0);
const far = arranged.order.find((cell) => cell.ix === 2);
assert.ok(Math.abs(near.z) < Math.abs(far.z));

const total = 100;
const sparse = 10;
assert.equal(targetCount(0, total, sparse), 0);
assert.equal(targetCount(24, total, sparse), 1);
const mid = targetCount(sparse * 24 + 1000, total, sparse);
assert.ok(mid > sparse && mid < total);
assert.equal(targetCount(1e9, total, sparse), total);
let previous = 0;
for (let t = 0; t < sparse * 24 + 5600; t += 24) {
  const count = targetCount(t, total, sparse);
  assert.ok(count >= previous && count <= total);
  previous = count;
}
assert.ok(appearTime(0, total, sparse) > 0);
assert.ok(appearTime(sparse, total, sparse) >= appearTime(sparse - 1, total, sparse));

const pose = orbitCamera(2, 2, 8);
assert.equal(pose.yaw, ORBIT_YAW_LIMIT);
assert.equal(pose.pitch, ORBIT_PITCH_LIMIT);
assert.equal(pose.zoom, ZOOM_MAX);
const source = orbitCamera(0, 0, 1);
assert.deepEqual(source.eye.map((value) => Math.round(value * 1000)), [0, 0, 0]);
const pulled = clampOrbit(-1, -1);
assert.equal(pulled.yaw, -ORBIT_YAW_LIMIT);
assert.ok(orbitCamera(0, 0, 0.01).zoom === ZOOM_MIN);

const focal = focalLength(288);
const z = depthToZ(180);
const point = unproject(256, 144, z, 512, 288, focal);
assert.ok(Math.abs(point[0]) < 1e-6);
assert.ok(Math.abs(point[1]) < 1e-6);

const page = readFileSync(new URL("../demo/waiting-blocks/index.html", import.meta.url), "utf8");
const viewer = readFileSync(new URL("../demo/waiting-blocks/viewer.js", import.meta.url), "utf8");
assert.match(page, /Demonstração — vídeo já gerado/);
assert.match(page, /Gerando vídeo/);
assert.match(page, /Simular vídeo pronto/);
assert.match(page, /Assistir vídeo/);
const visible = page.replace(/<style[\s\S]*?<\/style>/u, "").replace(/<[^>]+>/g, " ");
assert.doesNotMatch(visible, /\d+\s*%/);
assert.doesNotMatch(visible, /estimado|tris|vértices|blocos de/i);
assert.equal(viewer.includes("fetch("), false);
assert.equal(viewer.includes("/api/"), false);
assert.equal(page.includes("/opt/cursor"), false);
assert.equal(page.includes("/tmp/"), false);

console.log("waiting-blocks-check ok", arranged.order.length, "cells");
