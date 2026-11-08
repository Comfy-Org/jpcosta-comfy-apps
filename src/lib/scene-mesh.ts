/**
 * Browser-side subject mesh for Reverse 3D.
 *
 * The mesh is a chunky box volume of the reduced Hunyuan model.
 * The slider only changes how big those boxes are.
 */

import type { FramePart, FramePoint, SubjectKind } from "@/lib/subject-pipeline";

export const SCENE_POLYGON_MIN = 64;
export const SCENE_POLYGON_MAX = 4096;
/** Opens on the finest boxes. Dragging down makes the boxes bigger. */
export const SCENE_POLYGON_DEFAULT = SCENE_POLYGON_MAX;

export const SCENE_DEFAULT_YAW = 1.05;
export const SCENE_DEFAULT_PITCH = 0.22;
export const SCENE_ORBIT_RADIUS = 2.35;
export const SCENE_DRAG_YAW = 0.008;
export const SCENE_DRAG_PITCH = 0.008;
export const SCENE_PITCH_MIN = -1.05;
export const SCENE_PITCH_MAX = 1.05;

/** Flat gray boxes. The still's colors are not copied onto the mesh. */
export const SCENE_CLAY: readonly [number, number, number] = [0.7, 0.7, 0.72];


export type SceneMesh = {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint16Array;
  /** Triangle count of the subject. The floor grid is not included. */
  polygonCount: number;
  /** Box cells along the subject's longer side. Lower means bigger boxes. */
  boxesLong: number;
  /** World height of the ground plane under the subject's feet. */
  floorY: number;
};


type Vec3 = [number, number, number];

function meshBounds(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] ?? 0;
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

/**
 * Chunky boxes of an already-reduced mesh. The slider only changes the box
 * size. 100% is this mesh, which is about 30% of the image-to-3D face count.
 */
type BoxGrid = {
  cols: number;
  rows: number;
  depth: number;
  filled: (x: number, y: number, z: number) => boolean;
  cube: number;
  inset: number;
  originX: number;
  originY: number;
  originZ: number;
};

function boxGrid(positions: Float32Array, indices: ArrayLike<number>, targetPolygons: number, fixedCells?: number): BoxGrid {
  if (positions.length < 9 || indices.length < 3) throw new Error("Could not build a scene mesh.");
  const faces = Math.floor(indices.length / 3);
  const finest = Math.max(6, Math.min(24, Math.round(Math.cbrt(faces) * 1.6)));
  const coarsest = Math.max(3, Math.round(finest * 0.22));
  const clamped = Math.max(SCENE_POLYGON_MIN, Math.min(SCENE_POLYGON_MAX, Math.round(targetPolygons)));
  const t = (clamped - SCENE_POLYGON_MIN) / (SCENE_POLYGON_MAX - SCENE_POLYGON_MIN);
  const cells = fixedCells ?? Math.max(coarsest, Math.round(coarsest + t * (finest - coarsest)));
  const { min, max } = meshBounds(positions);
  const span: [number, number, number] = [
    Math.max(1e-4, max[0] - min[0]),
    Math.max(1e-4, max[1] - min[1]),
    Math.max(1e-4, max[2] - min[2]),
  ];
  const long = Math.max(span[0], span[1], span[2]);
  const cols = Math.max(1, Math.round((cells * span[0]) / long));
  const rows = Math.max(1, Math.round((cells * span[1]) / long));
  const depth = Math.max(1, Math.round((cells * span[2]) / long));
  const occupied = new Uint8Array(cols * rows * depth);
  const cellOf = (x: number, y: number, z: number) => x + y * cols + z * cols * rows;
  const mark = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= cols || y >= rows || z >= depth) return;
    occupied[cellOf(x, y, z)] = 1;
  };
  const toGrid = (x: number, y: number, z: number): [number, number, number] => [
    ((x - min[0]) / span[0]) * cols - 0.5,
    ((y - min[1]) / span[1]) * rows - 0.5,
    ((z - min[2]) / span[2]) * depth - 0.5,
  ];
  for (let cursor = 0; cursor < indices.length; cursor += 3) {
    const ia = (indices[cursor] ?? 0) * 3;
    const ib = (indices[cursor + 1] ?? 0) * 3;
    const ic = (indices[cursor + 2] ?? 0) * 3;
    const a = toGrid(positions[ia] ?? 0, positions[ia + 1] ?? 0, positions[ia + 2] ?? 0);
    const b = toGrid(positions[ib] ?? 0, positions[ib + 1] ?? 0, positions[ib + 2] ?? 0);
    const c = toGrid(positions[ic] ?? 0, positions[ic + 1] ?? 0, positions[ic + 2] ?? 0);
    const steps = 7;
    for (let u = 0; u <= steps; u += 1) {
      for (let v = 0; v <= steps - u; v += 1) {
        const w = 1 - (u + v) / steps;
        const bu = u / steps;
        const bv = v / steps;
        mark(
          Math.round(a[0] * w + b[0] * bu + c[0] * bv),
          Math.round(a[1] * w + b[1] * bu + c[1] * bv),
          Math.round(a[2] * w + b[2] * bu + c[2] * bv),
        );
      }
    }
  }
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < cols; x += 1) {
      let low = -1;
      let high = -1;
      for (let y = 0; y < rows; y += 1) {
        if (!occupied[cellOf(x, y, z)]) continue;
        if (low < 0) low = y;
        high = y;
      }
      for (let y = low; y <= high; y += 1) occupied[cellOf(x, y, z)] = 1;
    }
  }
  const filled = (x: number, y: number, z: number) =>
    x >= 0 && y >= 0 && z >= 0 && x < cols && y < rows && z < depth && occupied[cellOf(x, y, z)] === 1;
  const cube = 1.55 / Math.max(rows, 1);
  const inset = cube * 0.04;
  const originX = (-cols * cube) / 2;
  const originY = -rows * cube * 0.5;
  const originZ = (-depth * cube) / 2;
  return { cols, rows, depth, filled, cube, inset, originX, originY, originZ };
}

export type BoxCells = {
  /** Box centres, x y z per box. */
  centers: Float32Array;
  /** Grid layer of each box, 0 at the bottom. */
  layers: Uint16Array;
  /** Edge length of one box, without the gap between boxes. */
  size: number;
  /** World height of the ground under the subject. */
  floorY: number;
};

/** The same boxes as buildBoxMesh, as a list of centres, for drawing each box on its own. */
export function buildBoxCells(positions: Float32Array, indices: ArrayLike<number>, targetPolygons: number): BoxCells {
  const { cols, rows, depth, filled, cube, inset, originX, originY, originZ } = boxGrid(positions, indices, targetPolygons);
  const centers: number[] = [];
  const layers: number[] = [];
  let low = Number.POSITIVE_INFINITY;
  for (let y = 0; y < rows; y += 1) {
    for (let z = 0; z < depth; z += 1) {
      for (let x = 0; x < cols; x += 1) {
        if (!filled(x, y, z)) continue;
        centers.push(originX + (x + 0.5) * cube, originY + (y + 0.5) * cube, originZ + (z + 0.5) * cube);
        layers.push(y);
        low = Math.min(low, originY + y * cube + inset);
      }
    }
  }
  if (centers.length === 0) throw new Error("Could not build a scene mesh.");
  return { centers: new Float32Array(centers), layers: new Uint16Array(layers), size: cube - inset * 2, floorY: low };
}

export function buildBoxMesh(positions: Float32Array, indices: ArrayLike<number>, targetPolygons: number): SceneMesh {
  const { cols, rows, depth, filled, cube, inset, originX, originY, originZ } = boxGrid(positions, indices, targetPolygons);
  const outPositions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indexList: number[] = [];
  const pushFace = (quad: Vec3[], normal: Vec3) => {
    const base = outPositions.length / 3;
    for (const point of quad) {
      outPositions.push(point[0], point[1], point[2]);
      normals.push(normal[0], normal[1], normal[2]);
      colors.push(SCENE_CLAY[0], SCENE_CLAY[1], SCENE_CLAY[2]);
    }
    indexList.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let z = 0; z < depth; z += 1) {
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        if (!filled(x, y, z)) continue;
        const x0 = originX + x * cube + inset;
        const x1 = originX + (x + 1) * cube - inset;
        const y0 = originY + y * cube + inset;
        const y1 = originY + (y + 1) * cube - inset;
        const z0 = originZ + z * cube + inset;
        const z1 = originZ + (z + 1) * cube - inset;
        if (!filled(x, y, z + 1)) {
          pushFace(
            [
              [x0, y1, z1],
              [x0, y0, z1],
              [x1, y0, z1],
              [x1, y1, z1],
            ],
            [0, 0, 1],
          );
        }
        if (!filled(x, y, z - 1)) {
          pushFace(
            [
              [x0, y1, z0],
              [x1, y1, z0],
              [x1, y0, z0],
              [x0, y0, z0],
            ],
            [0, 0, -1],
          );
        }
        if (!filled(x, y - 1, z)) {
          pushFace(
            [
              [x0, y0, z0],
              [x1, y0, z0],
              [x1, y0, z1],
              [x0, y0, z1],
            ],
            [0, -1, 0],
          );
        }
        if (!filled(x, y + 1, z)) {
          pushFace(
            [
              [x0, y1, z1],
              [x1, y1, z1],
              [x1, y1, z0],
              [x0, y1, z0],
            ],
            [0, 1, 0],
          );
        }
        if (!filled(x + 1, y, z)) {
          pushFace(
            [
              [x1, y0, z1],
              [x1, y1, z1],
              [x1, y1, z0],
              [x1, y0, z0],
            ],
            [1, 0, 0],
          );
        }
        if (!filled(x - 1, y, z)) {
          pushFace(
            [
              [x0, y0, z0],
              [x0, y1, z0],
              [x0, y1, z1],
              [x0, y0, z1],
            ],
            [-1, 0, 0],
          );
        }
      }
    }
  }
  if (indexList.length === 0 || indexList.some((index) => index > 65535)) {
    throw new Error("Could not build a scene mesh.");
  }
  let floorY = Number.POSITIVE_INFINITY;
  for (let index = 1; index < outPositions.length; index += 3) floorY = Math.min(floorY, outPositions[index] ?? 0);
  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint16Array(indexList),
    polygonCount: indexList.length / 3,
    boxesLong: Math.max(cols, rows, depth),
    floorY,
  };
}

export type { Vec3 };

export function orbitEye(yaw: number, pitch: number, radius = SCENE_ORBIT_RADIUS): Vec3 {
  const cp = Math.cos(pitch);
  return [radius * cp * Math.sin(yaw), radius * Math.sin(pitch), radius * cp * Math.cos(yaw)];
}

export function orbitFromDrag(
  startYaw: number,
  startPitch: number,
  dx: number,
  dy: number,
): { yaw: number; pitch: number } {
  const pitch = Math.max(SCENE_PITCH_MIN, Math.min(SCENE_PITCH_MAX, startPitch + dy * SCENE_DRAG_PITCH));
  return { yaw: startYaw + dx * SCENE_DRAG_YAW, pitch };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Column-major view matrix. The orbit canvas and the projection test share this. */
export function sceneViewMatrix(yaw: number, pitch: number): Float32Array {
  const eye = orbitEye(yaw, pitch);
  const z = normalize(sub(eye, [0, 0, 0]));
  const x = normalize(cross([0, 1, 0], z));
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0];
  m[1] = y[0];
  m[2] = z[0];
  m[4] = x[1];
  m[5] = y[1];
  m[6] = z[1];
  m[8] = x[2];
  m[9] = y[2];
  m[10] = z[2];
  m[12] = -dot(x, eye);
  m[13] = -dot(y, eye);
  m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}

export function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        (a[row] ?? 0) * (b[col * 4] ?? 0) +
        (a[4 + row] ?? 0) * (b[col * 4 + 1] ?? 0) +
        (a[8 + row] ?? 0) * (b[col * 4 + 2] ?? 0) +
        (a[12 + row] ?? 0) * (b[col * 4 + 3] ?? 0);
    }
  }
  return out;
}

export function sceneMvp(yaw: number, pitch: number, aspect: number): Float32Array {
  return multiplyMat4(perspective(Math.PI / 4, aspect, 0.08, 20), sceneViewMatrix(yaw, pitch));
}

export function mat3FromMat4(m: Float32Array): Float32Array {
  return new Float32Array([m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[4] ?? 0, m[5] ?? 0, m[6] ?? 0, m[8] ?? 0, m[9] ?? 0, m[10] ?? 0]);
}

export function projectPoint(
  mvp: Float32Array,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
): { x: number; y: number; visible: boolean } {
  const cx = (mvp[0] ?? 0) * x + (mvp[4] ?? 0) * y + (mvp[8] ?? 0) * z + (mvp[12] ?? 0);
  const cy = (mvp[1] ?? 0) * x + (mvp[5] ?? 0) * y + (mvp[9] ?? 0) * z + (mvp[13] ?? 0);
  const cz = (mvp[2] ?? 0) * x + (mvp[6] ?? 0) * y + (mvp[10] ?? 0) * z + (mvp[14] ?? 0);
  const cw = (mvp[3] ?? 0) * x + (mvp[7] ?? 0) * y + (mvp[11] ?? 0) * z + (mvp[15] ?? 0);
  if (cw <= 0.0001) return { x: 0, y: 0, visible: false };
  const nx = cx / cw;
  const ny = cy / cw;
  const nz = cz / cw;
  return {
    x: (nx * 0.5 + 0.5) * width,
    y: (1 - (ny * 0.5 + 0.5)) * height,
    visible: nz > -1 && nz < 1,
  };
}

export type PartBox = {
  /** Centre in world units. */
  center: [number, number, number];
  /** Edge lengths in world units. */
  size: [number, number, number];
  /** What the block is, such as "head" or "table". Shown when the pointer is over it. */
  name?: string;
  /** A piece of the subject, or something next to it. */
  kind?: "part" | "prop";
  /** Turn about the camera's axis (z), in radians, so a limb follows the pose. */
  rotation?: number;
  /** Drawn as a round wheel: "z" faces the camera, "x" is seen edge on, round side to the side. */
  wheel?: "z" | "x";
  /** Which subject of the shot the block belongs to, in the order they were found. */
  subject?: number;
};

/**
 * Where the chosen frame stands, so it lines up with the blocks from the starting camera.
 * It is drawn first and never hides a block, so it can stand on the plane the camera turns around.
 */
export type PlatePlacement = {
  center: [number, number, number];
  size: [number, number];
};

export type PartBoxes = {
  boxes: PartBox[];
  /** World height of the ground under the subject. */
  floorY: number;
  /** The chosen frame behind the blocks. */
  plate?: PlatePlacement;
  /** The starting camera: level and straight on, like the shot. */
  camera?: { target: [number, number, number]; distance: number };
  /** The subject runs off the bottom of the frame, so there is no ground under it. */
  cropped?: boolean;
};

/** Grid cells along the subject's longer side for the part split. Coarse on purpose. */
const PART_CELLS = 24;
const PART_MAX = 12;
/** A part may cover some empty cells, so it reads as one block instead of a staircase. */
const PART_FILL = 0.9;
const PART_SLICE = 0.8;

/**
 * Split the subject into a few big blocks: a head, a body, arms, legs.
 * Greedy: take the biggest mostly-filled box of the voxel volume, mark it used, repeat.
 */
export function buildPartBoxes(positions: Float32Array, indices: ArrayLike<number>): PartBoxes {
  const { cols, rows, depth, filled, cube, originX, originY, originZ } = boxGrid(positions, indices, SCENE_POLYGON_MAX, PART_CELLS);
  const idx = (x: number, y: number, z: number) => x + y * cols + z * cols * rows;
  const free = new Uint8Array(cols * rows * depth);
  let total = 0;
  for (let z = 0; z < depth; z += 1)
    for (let y = 0; y < rows; y += 1)
      for (let x = 0; x < cols; x += 1)
        if (filled(x, y, z)) {
          free[idx(x, y, z)] = 1;
          total += 1;
        }
  if (total === 0) throw new Error("Could not build a scene mesh.");
  const W = cols + 1;
  const H = rows + 1;
  const sums = new Int32Array(W * H * (depth + 1));
  const sIdx = (x: number, y: number, z: number) => x + y * W + z * W * H;
  const rebuild = () => {
    for (let z = 1; z <= depth; z += 1)
      for (let y = 1; y <= rows; y += 1)
        for (let x = 1; x <= cols; x += 1)
          sums[sIdx(x, y, z)] =
            free[idx(x - 1, y - 1, z - 1)] +
            sums[sIdx(x - 1, y, z)] + sums[sIdx(x, y - 1, z)] + sums[sIdx(x, y, z - 1)] -
            sums[sIdx(x - 1, y - 1, z)] - sums[sIdx(x - 1, y, z - 1)] - sums[sIdx(x, y - 1, z - 1)] +
            sums[sIdx(x - 1, y - 1, z - 1)];
  };
  const count = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
    sums[sIdx(x1, y1, z1)] - sums[sIdx(x0, y1, z1)] - sums[sIdx(x1, y0, z1)] - sums[sIdx(x1, y1, z0)] +
    sums[sIdx(x0, y0, z1)] + sums[sIdx(x0, y1, z0)] + sums[sIdx(x1, y0, z0)] - sums[sIdx(x0, y0, z0)];

  /** Every horizontal and vertical slice must be mostly filled, so a narrow head or a gap between legs splits the box. */
  const slicesFull = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const across = (x1 - x0) * (z1 - z0);
    for (let y = y0; y < y1; y += 1) if (count(x0, y, z0, x1, y + 1, z1) < across * PART_SLICE) return false;
    const side = (y1 - y0) * (z1 - z0);
    for (let x = x0; x < x1; x += 1) if (count(x, y0, z0, x + 1, y1, z1) < side * PART_SLICE) return false;
    return true;
  };
  const boxes: PartBox[] = [];
  let left = total;
  while (boxes.length < PART_MAX && left > total * 0.06) {
    rebuild();
    let best = { score: 0, box: [0, 0, 0, 0, 0, 0] };
    for (let z0 = 0; z0 < depth; z0 += 1)
      for (let y0 = 0; y0 < rows; y0 += 1)
        for (let x0 = 0; x0 < cols; x0 += 1) {
          if (!free[idx(x0, y0, z0)]) continue;
          for (let x1 = x0 + 1; x1 <= cols; x1 += 1)
            for (let y1 = y0 + 1; y1 <= rows; y1 += 1)
              for (let z1 = z0 + 1; z1 <= depth; z1 += 1) {
                const volume = (x1 - x0) * (y1 - y0) * (z1 - z0);
                if (volume <= best.score) continue;
                const inside = count(x0, y0, z0, x1, y1, z1);
                if (inside < volume * PART_FILL) break;
                if (inside > best.score && slicesFull(x0, y0, z0, x1, y1, z1)) best = { score: inside, box: [x0, y0, z0, x1, y1, z1] };
              }
        }
    if (best.score < Math.max(2, total * 0.015)) break;
    const [x0, y0, z0, x1, y1, z1] = best.box;
    for (let z = z0; z < z1; z += 1)
      for (let y = y0; y < y1; y += 1)
        for (let x = x0; x < x1; x += 1) {
          if (free[idx(x, y, z)]) left -= 1;
          free[idx(x, y, z)] = 0;
        }
    boxes.push({
      center: [originX + ((x0 + x1) / 2) * cube, originY + ((y0 + y1) / 2) * cube, originZ + ((z0 + z1) / 2) * cube],
      size: [(x1 - x0) * cube, (y1 - y0) * cube, (z1 - z0) * cube],
    });
  }
  if (boxes.length === 0) throw new Error("Could not build a scene mesh.");
  const floorY = Math.min(...boxes.map((box) => box.center[1] - box.size[1] / 2));
  return { boxes, floorY };
}

/** World height of the whole shot's subjects in the loading build, the same as the old mesh volume. */
const LAYOUT_SUBJECT_HEIGHT = 1.55;
/** Starting camera distance. The view is fitted with the lens, so this never changes and the frame stays lined up. */
const SHOT_DISTANCE = 4.6;
/** Aim a little below the middle so the subjects sit above the status card. */
const SHOT_TARGET_Y = -0.18;
/** Parts are drawn a little longer than joint to joint, so neighbours meet. */
const PART_OVERLAP = 1.08;
/** An object's axis this close to level or plumb is straightened: about 12 degrees. People never are. */
const PROP_STRAIGHTEN = 0.21;
/** A vehicle's only within about 3 degrees: a car seen at an angle slants for real. Wheels never are. */
const VEHICLE_STRAIGHTEN = 0.05;
/**
 * How far subjects may stand from the middle one, as a share of its distance: nearer at most 0.75, farther at most 1.4.
 * Kept narrow on purpose. The real-height guesses are rough, and a subject far off the frame's plane
 * slides away from where it shows on the frame as soon as the camera turns.
 */
const DEPTH_RANGE: [number, number] = [0.75, 1.4];
/** Distances are squeezed toward the middle one by this power before the range applies. */
const DEPTH_SQUEEZE = 0.6;
/** An object over this share of the frame is the background, not something someone holds. */
const BACKGROUND_SHARE = 0.45;
/**
 * A wheel seen this narrow (width over height) is seen edge on: only the tire shows, so its round side faces sideways.
 * Any wider and it is drawn round, facing the camera, as on a car or bike seen from the side or at an angle.
 */
const WHEEL_EDGE_ON = 0.35;
/** Tire thickness over its height, for a wheel seen from the side. */
const WHEEL_THICKNESS = 0.38;

const WHEEL = /\b(wheel|tire|tyre)s?\b/i;
/** A vehicle with a cabin is a car, van or truck: four wheels, so the two hidden behind it are added. */
const CABIN = /\b(cabin|cab|roof|windows?)\b/i;
/** A vehicle's body and cabin end where the vehicle ends, so they are not drawn longer to meet a neighbour. */
const VEHICLE_SHELL = /\b(body|chassis|hull|cabin|cab|roof|windows?)\b/i;

/** Real height in meters for a subject the model gave none for. */
const DEFAULT_REAL_HEIGHT: Record<SubjectKind, number> = { person: 1.7, animal: 0.6, vehicle: 1.5, object: 0.8 };

/**
 * Share of a standing person's height that a part spans, chin to crown for a head, joint to joint for a limb.
 * A person cut off by the frame, or sitting, still shows a few parts, and these give their whole height.
 */
const PERSON_SPAN: readonly [RegExp, number][] = [
  [/head/i, 0.13],
  [/torso|chest|upper body/i, 0.3],
  [/upper arm/i, 0.19],
  [/forearm|lower arm/i, 0.15],
  [/thigh|upper leg/i, 0.245],
  [/shin|calf|lower leg/i, 0.25],
];

/** A subject to build: what it is, how tall it really is, and its parts on the frame. */
export type LayoutSubject = { name: string; kind?: SubjectKind; m?: number; parts: readonly FramePart[] };

/**
 * Build the blocks over the chosen frame.
 * Each part is a box along the axis the model marked, turned to follow the pose. Every subject is first drawn on one
 * plane, where it covers itself in the frame from the starting camera (level, straight on). Then each subject slides
 * along the camera's rays to its own distance, guessed from how big it looks against how big it really is, and is
 * scaled with the rays, so from the starting camera nothing moves. The frame stands on the plane the camera turns around,
 * where the middle subject is, so that subject stays on its picture while the camera sways.
 */
export function layoutFrameScene(scene: { subjects: readonly LayoutSubject[] }, aspect: number): PartBoxes {
  const wide = Number.isFinite(aspect) && aspect >= 0.25 && aspect <= 4 ? aspect : 16 / 9;
  // Frame units: the frame is 1 tall and `wide` wide, centred on 0, with y up.
  const toFrame = (point: FramePoint): [number, number] => [(point[1] / 1000 - 0.5) * wide, 0.5 - point[0] / 1000];
  type Flat = { cx: number; cy: number; length: number; width: number; long: number; depth: number; angle: number; halfX: number; halfY: number };
  /**
   * A box on the frame along the axis from a to b. Its own y axis runs along the axis.
   * An axis within `straighten` (radians) of level or plumb is straightened, as tables and chairs are.
   */
  const alongAxis = (a: FramePoint, b: FramePoint, w: number, d: number, stretch: number, straighten = 0): Flat => {
    const [ax, ay] = toFrame(a);
    const [bx, by] = toFrame(b);
    const length = Math.hypot(bx - ax, by - ay);
    const width = length * w;
    const long = length * stretch;
    let angle = Math.atan2(-(bx - ax), by - ay);
    const square = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(angle - square) < straighten) angle = square || 0;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    return {
      cx: (ax + bx) / 2,
      cy: (ay + by) / 2,
      length,
      width,
      long,
      depth: width * d,
      angle,
      halfX: (cos * width + sin * long) / 2,
      halfY: (sin * width + cos * long) / 2,
    };
  };

  type Built = {
    subject: LayoutSubject;
    kind: SubjectKind;
    /** `twinOf` is the flat a hidden far wheel copies. */
    flats: (Flat & { part: FramePart; wheel: boolean; twinOf?: number })[];
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    /** Its whole height on the frame, also the parts the frame cuts off. */
    whole: number;
  };
  const built: Built[] = [];
  for (const subject of scene.subjects) {
    if (subject.parts.length === 0) continue;
    const kind = subject.kind ?? "person";
    // One block alone has no neighbour to meet, so it is drawn exactly over what it covers.
    const single = subject.parts.length === 1;
    const flats: Built["flats"] = subject.parts.map((part) => {
      const wheel = WHEEL.test(part.name);
      const straighten = kind === "object" ? PROP_STRAIGHTEN : kind === "vehicle" && !wheel ? VEHICLE_STRAIGHTEN : 0;
      const exact = wheel || single || (kind === "vehicle" && VEHICLE_SHELL.test(part.name));
      return { part, wheel, ...alongAxis(part.a, part.b, part.w, part.d, exact ? 1 : PART_OVERLAP, straighten) };
    });
    // A car seen from one side shows two wheels. The other two are behind them, on the far side.
    const wheels = flats.filter((flat) => flat.wheel);
    if (kind === "vehicle" && flats.some((flat) => CABIN.test(flat.part.name)) && wheels.length > 0 && wheels.length < 4 && wheels.every((flat) => flat.part.z >= 0)) {
      for (const flat of wheels.slice(0, 4 - wheels.length)) {
        flat.part = { ...flat.part, z: 1 };
        flats.push({ ...flat, part: { ...flat.part, name: `far ${flat.part.name}`, z: -1 }, twinOf: flats.indexOf(flat) });
      }
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const flat of flats) {
      minX = Math.min(minX, flat.cx - flat.halfX);
      maxX = Math.max(maxX, flat.cx + flat.halfX);
      minY = Math.min(minY, flat.cy - flat.halfY);
      maxY = Math.max(maxY, flat.cy + flat.halfY);
    }
    // Something covering most of the frame is the room behind, not a thing someone holds.
    if (kind === "object" && ((maxX - minX) * (maxY - minY)) / wide > BACKGROUND_SHARE) continue;
    let whole = maxY - minY;
    if (kind === "person") {
      // Parts seen end-on look short, so the second-longest guess is kept: one long mistake does not win.
      const guesses = flats
        .flatMap((flat) => {
          const rule = PERSON_SPAN.find(([pattern]) => pattern.test(flat.part.name));
          return rule ? [flat.length / rule[1]] : [];
        })
        .sort((a, b) => b - a);
      const guess = guesses.length >= 3 ? guesses[1] : guesses[0];
      if (guess) whole = Math.max(whole, guess);
    }
    built.push({ subject, kind, flats, minX, maxX, minY, maxY, whole: Math.max(whole, 1e-3) });
  }
  if (built.length === 0) throw new Error("The model did not mark any parts.");

  // One scale for the whole frame: all the subjects together are as big as one subject used to be.
  const minX = Math.min(...built.map((item) => item.minX));
  const maxX = Math.max(...built.map((item) => item.maxX));
  const minY = Math.min(...built.map((item) => item.minY));
  const maxY = Math.max(...built.map((item) => item.maxY));
  const scale = LAYOUT_SUBJECT_HEIGHT / Math.max(maxY - minY, (maxX - minX) / 1.8, 1e-3);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const worldX = (x: number) => (x - midX) * scale;
  const worldY = (y: number) => (y - midY) * scale;

  // How far each subject is, relative to the others: as tall as it really is over as tall as it looks.
  // The middle one stands on the camera's target, so the camera sways around the middle of the shot.
  const reach = built.map((item) => (item.subject.m ?? DEFAULT_REAL_HEIGHT[item.kind]) / item.whole);
  const living = built.map((item, index) => (item.kind === "object" ? null : Math.log(reach[index]!))).filter((value): value is number => value !== null);
  const pool = (living.length > 0 ? living : reach.map((value) => Math.log(value))).sort((a, b) => a - b);
  const middle = pool[Math.floor((pool.length - 1) / 2)]!;
  const away = reach.map((value) => Math.min(DEPTH_RANGE[1], Math.max(DEPTH_RANGE[0], Math.exp((Math.log(value) - middle) * DEPTH_SQUEEZE))));
  const pivot = away.reduce((best, value, index) => (Math.abs(Math.log(value)) < Math.abs(Math.log(away[best]!)) ? index : best), 0);

  // Everything is first drawn on one plane (z = 0), where it lines up with the frame from the starting camera.
  // A block moved off that plane slides along the camera's rays and is scaled with them, so from the starting
  // camera it still covers exactly what it covered on the frame. Only when the camera moves does the depth show.
  // What the camera sees of a block is its front face, so that is the face sized and placed to cover the frame:
  // sized for its middle, a deep block (a car's body) would look a tenth bigger than what it stands for.
  const target: [number, number, number] = [0, SHOT_TARGET_Y, 0];
  const many = built.length > 1;
  const boxes: PartBox[] = [];
  built.forEach((item, index) => {
    const k = away[index]!;
    const subjectZ = SHOT_DISTANCE * (1 - k);
    const core = item.flats.reduce((best, flat) => (flat.width * flat.long > best.width * best.long ? flat : best));
    const coreDepth = core.depth * scale * k;
    const own: PartBox[] = [];
    for (const flat of item.flats) {
      const z = subjectZ + (flat.part.z * coreDepth) / 2;
      const name = many ? `${item.subject.name} · ${flat.part.name}` : flat.part.name;
      const original = flat.twinOf === undefined ? undefined : own[flat.twinOf];
      if (original) {
        // A hidden wheel is the same wheel across the car: as big and as high, on the far side, and slid
        // sideways to stay straight behind the near one from the camera, so it only shows when the view turns.
        const slide = (SHOT_DISTANCE - z - original.size[2] / 2) / (SHOT_DISTANCE - original.center[2] - original.size[2] / 2);
        own.push({ ...original, center: [target[0] + (original.center[0] - target[0]) * slide, original.center[1], z], name });
        continue;
      }
      const along = (SHOT_DISTANCE - z) / SHOT_DISTANCE;
      let width = flat.width * scale * along;
      const long = flat.long * scale * along;
      let depth = flat.depth * scale * along;
      let wheel: PartBox["wheel"];
      if (flat.wheel) {
        // A wheel facing the camera is a short drum; one seen edge on shows its tread, and is round in depth.
        wheel = flat.width / Math.max(flat.length, 1e-6) < WHEEL_EDGE_ON ? "x" : "z";
        // As wide as it looks: round from the side, an oval at an angle. Never wider than tall.
        if (wheel === "z") width = Math.min(width, long);
        depth = wheel === "x" ? long : long * WHEEL_THICKNESS;
        width = Math.max(width, 1e-4);
      }
      const front = (SHOT_DISTANCE - z - depth / 2) / SHOT_DISTANCE;
      const fit = front / along;
      own.push({
        center: [target[0] + (worldX(flat.cx) - target[0]) * front, target[1] + (worldY(flat.cy) - target[1]) * front, z],
        size: [width * fit, long * fit, depth],
        rotation: flat.angle,
        name,
        kind: item.kind === "object" ? "prop" : "part",
        subject: index,
        ...(wheel ? { wheel } : {}),
      });
    }
    boxes.push(...own);
  });

  // The frame is the first plane itself (z = 0), through the camera's target. The view draws it before the blocks,
  // so blocks behind it still show, and the middle subject, which stands on this plane, does not slide off it.
  const plate: PlatePlacement = {
    center: [worldX(0), worldY(0), target[2]],
    size: [wide * scale, scale],
  };
  // The ground is under the middle subject, the one the camera turns around: under its lowest block.
  const ground = built[pivot]!;
  const bottom = (box: PartBox) =>
    box.center[1] - (Math.abs(Math.sin(box.rotation ?? 0)) * box.size[0] + Math.abs(Math.cos(box.rotation ?? 0)) * box.size[1]) / 2;
  return {
    boxes,
    floorY: Math.min(...boxes.filter((box) => box.subject === pivot).map(bottom)),
    plate,
    camera: { target, distance: SHOT_DISTANCE },
    cropped: ground.minY < -0.5 + 0.02,
  };
}

/** The blocks as one triangle mesh, for views that draw a mesh instead of separate boxes. */
export function partBoxesMesh(parts: PartBoxes): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  const corners: Vec3[] = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [3, 7, 6, 2],
    [0, 4, 7, 3],
    [1, 2, 6, 5],
  ];
  for (const box of parts.boxes) {
    const base = positions.length / 3;
    const cos = Math.cos(box.rotation ?? 0);
    const sin = Math.sin(box.rotation ?? 0);
    for (const corner of corners) {
      const x = (corner[0] * box.size[0]) / 2;
      const y = (corner[1] * box.size[1]) / 2;
      positions.push(box.center[0] + x * cos - y * sin, box.center[1] + x * sin + y * cos, box.center[2] + (corner[2] * box.size[2]) / 2);
    }
    for (const [a, b, c, d] of faces) indices.push(base + a!, base + b!, base + c!, base + a!, base + c!, base + d!);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
