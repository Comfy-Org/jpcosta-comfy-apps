/**
 * Browser-side scene mesh for Reverse 3D.
 *
 * The frame score counts separate color regions. The mesh is a colored relief
 * of that still: one grid, displaced by those regions. Polygon changes only
 * rebuild this grid. Nothing here talks to a server.
 */

export const SCENE_POLYGON_MIN = 64;
export const SCENE_POLYGON_MAX = 4096;
export const SCENE_POLYGON_DEFAULT = 768;

export const SCENE_DEFAULT_YAW = 0.7;
export const SCENE_DEFAULT_PITCH = 0.38;
export const SCENE_ORBIT_RADIUS = 2.35;
export const SCENE_DRAG_YAW = 0.008;
export const SCENE_DRAG_PITCH = 0.008;
export const SCENE_PITCH_MIN = -1.05;
export const SCENE_PITCH_MAX = 1.05;

const MERGE_DISTANCE = 42;
const MIN_AREA_RATIO = 0.012;

export type SceneMesh = {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint16Array;
  /** Triangle count. This is the number the polygon slider reports. */
  polygonCount: number;
};

type Measured = {
  comp: Int32Array;
  areas: number[];
  elementCount: number;
};

function quantize(r: number, g: number, b: number): number {
  const y = (r * 2 + g * 3 + b) / 6;
  const cb = Math.max(0, Math.min(255, b - y + 128));
  const cr = Math.max(0, Math.min(255, r - y + 128));
  const yq = Math.min(3, Math.floor(y / 64));
  const cbq = Math.min(3, Math.floor(cb / 64));
  const crq = Math.min(3, Math.floor(cr / 64));
  return yq * 16 + cbq * 4 + crq;
}

function colorDistance(ar: number, ag: number, ab: number, br: number, bg: number, bb: number): number {
  const dr = ar - br;
  const dg = ag - bg;
  const db = ab - bb;
  return dr * dr + dg * dg + db * db;
}

/** Earlier index wins a tie, so the first equally busy frame stays chosen. */
export function pickBusiestIndex(scores: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index] > scores[best]) best = index;
  }
  return best;
}

/**
 * How many separate regions a frame has.
 * Pixels are quantized, flood-filled, then touching regions of a similar mean
 * color are merged. Specks under 1.2% of the frame are dropped.
 */
export function measureElements(pixels: Uint8ClampedArray | Uint8Array, width: number, height: number): Measured {
  const count = width * height;
  const labels = new Int32Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    labels[index] = quantize(pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0);
  }

  const comp = new Int32Array(count);
  comp.fill(-1);
  const sumR: number[] = [];
  const sumG: number[] = [];
  const sumB: number[] = [];
  const areas: number[] = [];
  const stack: number[] = [];
  let next = 0;
  for (let start = 0; start < count; start += 1) {
    if (comp[start] !== -1) continue;
    const label = labels[start];
    const id = next;
    next += 1;
    areas[id] = 0;
    sumR[id] = 0;
    sumG[id] = 0;
    sumB[id] = 0;
    comp[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const pixel = stack.pop() ?? 0;
      areas[id] += 1;
      const offset = pixel * 4;
      sumR[id] += pixels[offset] ?? 0;
      sumG[id] += pixels[offset + 1] ?? 0;
      sumB[id] += pixels[offset + 2] ?? 0;
      const x = pixel % width;
      const y = (pixel - x) / width;
      const neighbors = [
        x > 0 ? pixel - 1 : -1,
        x + 1 < width ? pixel + 1 : -1,
        y > 0 ? pixel - width : -1,
        y + 1 < height ? pixel + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || comp[neighbor] !== -1 || labels[neighbor] !== label) continue;
        comp[neighbor] = id;
        stack.push(neighbor);
      }
    }
  }

  const parent = areas.map((_, index) => index);
  const find = (id: number): number => {
    let cursor = id;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor] ?? cursor] ?? cursor;
      cursor = parent[cursor] ?? cursor;
    }
    return cursor;
  };
  const unite = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const limit = MERGE_DISTANCE * MERGE_DISTANCE;
  const similar = (a: number, b: number) => {
    const areaA = areas[a] || 1;
    const areaB = areas[b] || 1;
    return (
      colorDistance(
        (sumR[a] ?? 0) / areaA,
        (sumG[a] ?? 0) / areaA,
        (sumB[a] ?? 0) / areaA,
        (sumR[b] ?? 0) / areaB,
        (sumG[b] ?? 0) / areaB,
        (sumB[b] ?? 0) / areaB,
      ) < limit
    );
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (x + 1 < width && comp[pixel] !== comp[pixel + 1] && similar(comp[pixel] ?? 0, comp[pixel + 1] ?? 0)) {
        unite(comp[pixel] ?? 0, comp[pixel + 1] ?? 0);
      }
      if (y + 1 < height && comp[pixel] !== comp[pixel + width] && similar(comp[pixel] ?? 0, comp[pixel + width] ?? 0)) {
        unite(comp[pixel] ?? 0, comp[pixel + width] ?? 0);
      }
    }
  }

  const rootOf = new Map<number, number>();
  const merged = new Int32Array(count);
  const mergedAreas: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const root = find(comp[index] ?? 0);
    let id = rootOf.get(root);
    if (id === undefined) {
      id = mergedAreas.length;
      rootOf.set(root, id);
      mergedAreas[id] = 0;
    }
    merged[index] = id;
    mergedAreas[id] += 1;
  }
  const minArea = Math.max(4, Math.round(count * MIN_AREA_RATIO));
  let elementCount = 0;
  for (const area of mergedAreas) {
    if (area >= minArea) elementCount += 1;
  }
  return { comp: merged, areas: mergedAreas, elementCount };
}

export function meshGrid(targetPolygons: number, aspect: number): { cols: number; rows: number; polygonCount: number } {
  const clamped = Math.max(SCENE_POLYGON_MIN, Math.min(SCENE_POLYGON_MAX, Math.round(targetPolygons)));
  const quads = Math.max(1, Math.round(clamped / 2));
  const safeAspect = Math.max(0.4, Math.min(2.5, aspect));
  const guess = Math.max(1, Math.round(Math.sqrt(quads * safeAspect)));
  let bestCols = guess;
  let bestRows = Math.max(1, Math.round(quads / guess));
  let bestScore = Number.POSITIVE_INFINITY;
  for (let cols = Math.max(1, guess - 12); cols <= guess + 12; cols += 1) {
    const rows = Math.max(1, Math.round(quads / cols));
    const count = cols * rows * 2;
    const score = Math.abs(count - clamped) + Math.abs(cols / rows - safeAspect) * 24;
    if (score < bestScore) {
      bestScore = score;
      bestCols = cols;
      bestRows = rows;
    }
  }
  return { cols: bestCols, rows: bestRows, polygonCount: bestCols * bestRows * 2 };
}

function boundaryDistance(comp: Int32Array, width: number, height: number): Float32Array {
  const dist = new Float32Array(comp.length);
  dist.fill(1e6);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const id = comp[index];
      const edge =
        x === 0 ||
        y === 0 ||
        x + 1 === width ||
        y + 1 === height ||
        comp[index - 1] !== id ||
        comp[index + 1] !== id ||
        comp[index - width] !== id ||
        comp[index + width] !== id;
      if (edge) dist[index] = 0;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let next = dist[index] ?? 0;
      if (x > 0) next = Math.min(next, (dist[index - 1] ?? 0) + 1);
      if (y > 0) next = Math.min(next, (dist[index - width] ?? 0) + 1);
      dist[index] = next;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      let next = dist[index] ?? 0;
      if (x + 1 < width) next = Math.min(next, (dist[index + 1] ?? 0) + 1);
      if (y + 1 < height) next = Math.min(next, (dist[index + width] ?? 0) + 1);
      dist[index] = next;
    }
  }
  return dist;
}

function sample(map: Float32Array, width: number, height: number, u: number, v: number): number {
  const x = Math.max(0, Math.min(width - 1, u * (width - 1)));
  const y = Math.max(0, Math.min(height - 1, v * (height - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = map[y0 * width + x0] ?? 0;
  const b = map[y0 * width + x1] ?? 0;
  const c = map[y1 * width + x0] ?? 0;
  const d = map[y1 * width + x1] ?? 0;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

function sampleColor(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  u: number,
  v: number,
): [number, number, number] {
  const x = Math.max(0, Math.min(width - 1, u * (width - 1)));
  const y = Math.max(0, Math.min(height - 1, v * (height - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const offset = (y0 * width + x0) * 4;
  return [(pixels[offset] ?? 0) / 255, (pixels[offset + 1] ?? 0) / 255, (pixels[offset + 2] ?? 0) / 255];
}

function depthMap(measured: Measured, width: number, height: number): Float32Array {
  const { comp, areas } = measured;
  let backdrop = 0;
  for (let index = 1; index < areas.length; index += 1) {
    if ((areas[index] ?? 0) > (areas[backdrop] ?? 0)) backdrop = index;
  }
  const edge = boundaryDistance(comp, width, height);
  let maxEdge = 1;
  for (let index = 0; index < comp.length; index += 1) {
    if (comp[index] !== backdrop && (edge[index] ?? 0) > maxEdge) maxEdge = edge[index] ?? 1;
  }
  const depth = new Float32Array(comp.length);
  for (let index = 0; index < comp.length; index += 1) {
    const y = Math.floor(index / width) / Math.max(height - 1, 1);
    if (comp[index] === backdrop) {
      depth[index] = 0.02 + 0.06 * (1 - y);
      continue;
    }
    const bulge = (edge[index] ?? 0) / maxEdge;
    const closeness = 0.35 + 0.65 * (1 - y);
    depth[index] = 0.2 + 0.8 * closeness * (0.4 + 0.6 * bulge);
  }
  return depth;
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Grid resolution follows the slider. Vertex colors and height come from the still. */
export function buildSceneMesh(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  targetPolygons: number,
): SceneMesh {
  if (width < 2 || height < 2 || pixels.length < width * height * 4) {
    throw new Error("Could not build a scene mesh.");
  }
  const measured = measureElements(pixels, width, height);
  const depth = depthMap(measured, width, height);
  const aspect = width / height;
  const grid = meshGrid(targetPolygons, aspect);
  const { cols, rows } = grid;
  const vertCols = cols + 1;
  const vertRows = rows + 1;
  const spanX = aspect >= 1 ? 1.7 : 1.7 * aspect;
  const spanY = aspect >= 1 ? 1.7 / aspect : 1.7;
  const depthSpan = 0.62;
  const positions = new Float32Array(vertCols * vertRows * 3);
  const colors = new Float32Array(vertCols * vertRows * 3);
  const vid = (c: number, r: number) => r * vertCols + c;
  for (let r = 0; r < vertRows; r += 1) {
    for (let c = 0; c < vertCols; c += 1) {
      const u = c / cols;
      const v = r / rows;
      const offset = vid(c, r) * 3;
      positions[offset] = (u - 0.5) * spanX;
      positions[offset + 1] = (0.5 - v) * spanY;
      positions[offset + 2] = sample(depth, width, height, u, v) * depthSpan;
      const color = sampleColor(pixels, width, height, u, v);
      colors[offset] = color[0];
      colors[offset + 1] = color[1];
      colors[offset + 2] = color[2];
    }
  }
  const normals = new Float32Array(positions.length);
  const at = (c: number, r: number): [number, number, number] => {
    const cc = Math.max(0, Math.min(cols, c));
    const rr = Math.max(0, Math.min(rows, r));
    const offset = vid(cc, rr) * 3;
    return [positions[offset] ?? 0, positions[offset + 1] ?? 0, positions[offset + 2] ?? 0];
  };
  for (let r = 0; r < vertRows; r += 1) {
    for (let c = 0; c < vertCols; c += 1) {
      const left = at(c - 1, r);
      const right = at(c + 1, r);
      const down = at(c, r + 1);
      const up = at(c, r - 1);
      const tx: [number, number, number] = [right[0] - left[0], right[1] - left[1], right[2] - left[2]];
      const ty: [number, number, number] = [up[0] - down[0], up[1] - down[1], up[2] - down[2]];
      let normal = cross(tx, ty);
      const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
      if (normal[2] < 0) normal = [-normal[0], -normal[1], -normal[2]];
      const offset = vid(c, r) * 3;
      normals[offset] = normal[0] / length;
      normals[offset + 1] = normal[1] / length;
      normals[offset + 2] = normal[2] / length;
    }
  }
  const indices = new Uint16Array(cols * rows * 6);
  let cursor = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const a = vid(c, r);
      const b = vid(c + 1, r);
      const d = vid(c, r + 1);
      const e = vid(c + 1, r + 1);
      indices[cursor] = a;
      indices[cursor + 1] = d;
      indices[cursor + 2] = b;
      indices[cursor + 3] = b;
      indices[cursor + 4] = d;
      indices[cursor + 5] = e;
      cursor += 6;
    }
  }
  return { positions, normals, colors, indices, polygonCount: grid.polygonCount };
}

export type Vec3 = [number, number, number];

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
