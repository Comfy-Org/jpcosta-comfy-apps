// @ts-nocheck
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  BLOCK_DEFAULT,
  BLOCK_MAX,
  BLOCK_MIN,
  buildDepthBoxes,
  depthToZ,
  lookAt,
  orbitCamera,
  ORBIT_YAW_LIMIT,
  projectToPixel,
} from "../demo/depth-blocks/depth-scene.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../demo/depth-blocks/assets");

async function loadDepth(name: string) {
  const { data, info } = await sharp(path.join(root, name)).greyscale().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 512);
  assert.equal(info.height, 288);
  assert.equal(info.channels, 1);
  return data;
}

function sourceError(mesh: ReturnType<typeof buildDepthBoxes>) {
  const camera = orbitCamera(0, 0);
  const view = lookAt(camera.eye, camera.target, camera.up);
  let worst = 0;
  for (const cell of mesh.cells) {
    const corners = [
      [cell.x0, cell.y0],
      [cell.x1, cell.y0],
      [cell.x1, cell.y1],
      [cell.x0, cell.y1],
    ];
    for (const [px, py] of corners) {
      const point = [
        ((px - 512 / 2) / mesh.focal) * cell.z,
        ((288 / 2 - py) / mesh.focal) * cell.z,
        -cell.z,
      ];
      const projected = projectToPixel(point, view, 512, 288, mesh.focal);
      worst = Math.max(worst, Math.hypot(projected.x - px, projected.y - py));
    }
  }
  return worst;
}

async function main() {
  const depth = await loadDepth("main-depth.png");
  assert.ok(depthToZ(255) < depthToZ(0), "bright depth is nearer than black");
  const fine = buildDepthBoxes(depth, 512, 288, BLOCK_MIN);
  const mid = buildDepthBoxes(depth, 512, 288, BLOCK_DEFAULT);
  const coarse = buildDepthBoxes(depth, 512, 288, BLOCK_MAX);
  assert.ok(fine.cells.length > mid.cells.length);
  assert.ok(mid.cells.length > coarse.cells.length);
  assert.equal(fine.block, 4);
  assert.equal(coarse.block, 32);
  const fineSpan = fine.cells[0].x1 - fine.cells[0].x0;
  const coarseSpan = coarse.cells[0].x1 - coarse.cells[0].x0;
  assert.ok(coarseSpan > fineSpan * 4, "coarse blocks cover more source pixels");

  const error = sourceError(mid);
  assert.ok(error < 0.6, `source camera reprojection error ${error}`);

  const ranked = [...mid.cells].sort((a, b) => a.z - b.z);
  const take = Math.max(8, Math.floor(ranked.length * 0.15));
  const near = ranked.slice(0, take);
  const far = ranked.slice(-take);
  assert.ok(near[0].z < far[0].z);
  const yawed = orbitCamera(ORBIT_YAW_LIMIT, 0);
  const view = lookAt(yawed.eye, yawed.target, yawed.up);
  const shift = (cells: typeof near) => {
    let total = 0;
    for (const cell of cells) {
      const point = [((cell.cx - 256) / mid.focal) * cell.z, ((144 - cell.cy) / mid.focal) * cell.z, -cell.z];
      const atSource = projectToPixel(point, lookAt(orbitCamera(0, 0).eye, orbitCamera(0, 0).target, [0, 1, 0]), 512, 288, mid.focal);
      const atOrbit = projectToPixel(point, view, 512, 288, mid.focal);
      total += atOrbit.x - atSource.x;
    }
    return total / cells.length;
  };
  const nearShift = shift(near);
  const farShift = shift(far);
  assert.ok(nearShift * farShift < 0, `near ${nearShift} and far ${farShift} move the same way`);
  assert.ok(Math.abs(nearShift - farShift) > 40, `parallax separation ${nearShift} vs ${farShift} is too flat`);
  assert.ok(Math.abs(orbitCamera(2, 2).yaw) <= ORBIT_YAW_LIMIT);

  const positions = mid.positions;
  let finite = true;
  for (const value of positions) if (!Number.isFinite(value)) finite = false;
  assert.equal(finite, true);
  assert.ok(mid.indices.length === mid.cells.length * 36);
  let varied = 0;
  for (let box = 0; box < mid.cells.length; box += 1) {
    const nx = mid.normals[box * 72] ?? 0;
    const ny = mid.normals[box * 72 + 1] ?? 0;
    if (Math.abs(nx) > 0.08 || Math.abs(ny) > 0.08) varied += 1;
  }
  assert.ok(varied > mid.cells.length * 0.2, "front faces stay flat, so the source view cannot show the figures");
  console.log(
    `depth-blocks-check ok blocks ${fine.cells.length}/${mid.cells.length}/${coarse.cells.length} reprojection ${error.toFixed(3)}px parallax near ${nearShift.toFixed(1)} far ${farShift.toFixed(1)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
