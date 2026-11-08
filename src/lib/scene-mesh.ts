/**
 * Browser-side subject mesh for Reverse 3D.
 *
 * The mesh is a chunky box volume of the reduced Hunyuan model.
 * The slider only changes how big those boxes are.
 */

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

function boxGrid(positions: Float32Array, indices: ArrayLike<number>, targetPolygons: number): BoxGrid {
  if (positions.length < 9 || indices.length < 3) throw new Error("Could not build a scene mesh.");
  const faces = Math.floor(indices.length / 3);
  const finest = Math.max(6, Math.min(24, Math.round(Math.cbrt(faces) * 1.6)));
  const coarsest = Math.max(3, Math.round(finest * 0.22));
  const clamped = Math.max(SCENE_POLYGON_MIN, Math.min(SCENE_POLYGON_MAX, Math.round(targetPolygons)));
  const t = (clamped - SCENE_POLYGON_MIN) / (SCENE_POLYGON_MAX - SCENE_POLYGON_MIN);
  const cells = Math.max(coarsest, Math.round(coarsest + t * (finest - coarsest)));
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
