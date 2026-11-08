/**
 * Browser-side subject mesh for Reverse 3D.
 *
 * The frame score looks for one foreground object that stands apart from the
 * border color. The mesh is an untextured clay volume of that silhouette only:
 * front and back shells inflated by distance from the outline. The background
 * is not in the mesh. Polygon changes only rebuild this volume.
 */

export const SCENE_POLYGON_MIN = 64;
export const SCENE_POLYGON_MAX = 4096;
export const SCENE_POLYGON_DEFAULT = 768;

export const SCENE_DEFAULT_YAW = 1.05;
export const SCENE_DEFAULT_PITCH = 0.22;
export const SCENE_ORBIT_RADIUS = 2.35;
export const SCENE_DRAG_YAW = 0.008;
export const SCENE_DRAG_PITCH = 0.008;
export const SCENE_PITCH_MIN = -1.05;
export const SCENE_PITCH_MAX = 1.05;

/** Untextured clay. The still's colors are not copied onto the mesh. */
export const SCENE_CLAY: readonly [number, number, number] = [0.93, 0.91, 0.87];

const SUBJECT_MIN_RATIO = 0.015;
const CLEAR_SCORE = 0.35;

export type SceneMesh = {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint16Array;
  /** Triangle count of the subject. The floor grid is not included. */
  polygonCount: number;
  /** World height of the ground plane under the subject's feet. */
  floorY: number;
};

export type SubjectRead = {
  mask: Uint8Array;
  score: number;
  areaRatio: number;
  /** Foreground objects large enough to count, including the one that was kept. */
  rivals: number;
  clear: boolean;
};

type Vec3 = [number, number, number];

function rgbAt(pixels: Uint8ClampedArray | Uint8Array, index: number): [number, number, number] {
  const offset = index * 4;
  return [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0];
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.hypot(dr, dg, db);
}

function median(values: Float64Array): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function areaTerm(ratio: number): number {
  const peak = 0.24;
  const spread = 0.16;
  const bell = Math.exp(-((ratio - peak) ** 2) / (2 * spread * spread));
  if (ratio < 0.05 || ratio > 0.7) return bell * 0.15;
  return bell;
}

/**
 * Separate the main subject from a still.
 * Border pixels close to the border's own color are the background and flood
 * inward. Everything they cannot reach is foreground. The largest foreground
 * object is the subject; the rest is dropped. A tie between frames is not
 * decided here.
 */
export function readSubject(pixels: Uint8ClampedArray | Uint8Array, width: number, height: number): SubjectRead {
  const count = width * height;
  const empty = (): SubjectRead => ({
    mask: new Uint8Array(count),
    score: 0,
    areaRatio: 0,
    rivals: 0,
    clear: false,
  });
  if (width < 2 || height < 2 || pixels.length < count * 4) return empty();

  const border: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x === 0 || y === 0 || x + 1 === width || y + 1 === height) border.push(y * width + x);
    }
  }
  const reds = new Float64Array(border.length);
  const greens = new Float64Array(border.length);
  const blues = new Float64Array(border.length);
  for (let index = 0; index < border.length; index += 1) {
    const [r, g, b] = rgbAt(pixels, border[index] ?? 0);
    reds[index] = r;
    greens[index] = g;
    blues[index] = b;
  }
  const background: [number, number, number] = [median(reds), median(greens), median(blues)];
  const spread = new Float64Array(border.length);
  for (let index = 0; index < border.length; index += 1) {
    spread[index] = colorDistance(rgbAt(pixels, border[index] ?? 0), background);
  }
  const sortedSpread = Float64Array.from(spread).sort();
  const typical = sortedSpread[Math.floor(sortedSpread.length * 0.75)] ?? 0;
  const threshold = Math.max(28, Math.min(80, typical + 24));

  const isBackground = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  const push = (index: number) => {
    if (isBackground[index]) return;
    if (colorDistance(rgbAt(pixels, index), background) > threshold) return;
    isBackground[index] = 1;
    queue[tail] = index;
    tail += 1;
  };
  for (const index of border) push(index);
  while (head < tail) {
    const pixel = queue[head] ?? 0;
    head += 1;
    const x = pixel % width;
    const y = (pixel - x) / width;
    if (x > 0) push(pixel - 1);
    if (x + 1 < width) push(pixel + 1);
    if (y > 0) push(pixel - width);
    if (y + 1 < height) push(pixel + width);
  }

  const comp = new Int32Array(count);
  comp.fill(-1);
  const areas: number[] = [];
  const touchLeft: boolean[] = [];
  const touchRight: boolean[] = [];
  const touchTop: boolean[] = [];
  let next = 0;
  const stack: number[] = [];
  for (let start = 0; start < count; start += 1) {
    if (isBackground[start] || comp[start] !== -1) continue;
    const id = next;
    next += 1;
    areas[id] = 0;
    touchLeft[id] = false;
    touchRight[id] = false;
    touchTop[id] = false;
    comp[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const pixel = stack.pop() ?? 0;
      areas[id] = (areas[id] ?? 0) + 1;
      const x = pixel % width;
      const y = (pixel - x) / width;
      if (x === 0) touchLeft[id] = true;
      if (x + 1 === width) touchRight[id] = true;
      if (y === 0) touchTop[id] = true;
      const neighbors = [
        x > 0 ? pixel - 1 : -1,
        x + 1 < width ? pixel + 1 : -1,
        y > 0 ? pixel - width : -1,
        y + 1 < height ? pixel + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || isBackground[neighbor] || comp[neighbor] !== -1) continue;
        comp[neighbor] = id;
        stack.push(neighbor);
      }
    }
  }

  const minArea = Math.max(8, Math.round(count * SUBJECT_MIN_RATIO));
  let chosen = -1;
  let rivals = 0;
  for (let id = 0; id < areas.length; id += 1) {
    if ((areas[id] ?? 0) < minArea) continue;
    rivals += 1;
    if (chosen < 0 || (areas[id] ?? 0) > (areas[chosen] ?? 0)) chosen = id;
  }
  if (chosen < 0) return empty();

  const mask = new Uint8Array(count);
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let contrastSum = 0;
  for (let index = 0; index < count; index += 1) {
    if (comp[index] !== chosen) continue;
    mask[index] = 1;
    const x = index % width;
    const y = (index - x) / width;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    contrastSum += colorDistance(rgbAt(pixels, index), background);
  }
  const area = areas[chosen] ?? 0;
  const areaRatio = area / count;
  const significant = areas.reduce((sum, value) => sum + ((value ?? 0) >= minArea ? (value ?? 0) : 0), 0);
  const dominance = area / Math.max(1, significant);
  const touches = Number(touchLeft[chosen]) + Number(touchRight[chosen]) + Number(touchTop[chosen]);
  const isolation = 1 - touches / 3;
  const contrast = Math.max(0, Math.min(1, contrastSum / area / 90));
  const boxArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
  const fill = area / boxArea;
  const compact = fill < 0.12 ? 0.45 : fill > 0.93 && areaRatio > 0.55 ? 0.55 : 1;
  const score =
    areaTerm(areaRatio) * (0.35 + 0.65 * dominance) * (0.4 + 0.6 * isolation) * (0.45 + 0.55 * contrast) * compact;
  const clear = score >= CLEAR_SCORE && rivals <= 2 && areaRatio >= 0.06 && areaRatio <= 0.62 && isolation >= 0.34;
  return { mask, score, areaRatio, rivals, clear };
}

/** Earlier index wins a tie, so the first equally good frame stays chosen. */
export function pickBestSubjectIndex(scores: readonly number[]): number {
  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index] > scores[best]) best = index;
  }
  return best;
}

function ellipseMask(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const rx = Math.max(2, width * 0.14);
  const ry = Math.max(2, height * 0.32);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) mask[y * width + x] = 1;
    }
  }
  return mask;
}

function maskDistance(mask: Uint8Array, width: number, height: number): Float32Array {
  const dist = new Float32Array(mask.length);
  dist.fill(1e6);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) {
        dist[index] = 0;
        continue;
      }
      const edge =
        x === 0 ||
        y === 0 ||
        x + 1 === width ||
        y + 1 === height ||
        !mask[index - 1] ||
        !mask[index + 1] ||
        !mask[index - width] ||
        !mask[index + width];
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

function maskBounds(mask: Uint8Array, width: number, height: number): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Clay volume of the subject silhouette. Grid resolution follows the slider. */
export function buildSceneMesh(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  targetPolygons: number,
): SceneMesh {
  if (width < 2 || height < 2 || pixels.length < width * height * 4) {
    throw new Error("Could not build a scene mesh.");
  }
  const read = readSubject(pixels, width, height);
  const mask = read.mask.some((value) => value === 1) ? read.mask : ellipseMask(width, height);
  const dist = maskDistance(mask, width, height);
  const bounds = maskBounds(mask, width, height);
  if (!bounds) throw new Error("Could not build a scene mesh.");
  let { minX, minY, maxX, maxY } = bounds;
  if (maxX - minX < 2) {
    minX = Math.max(0, minX - 1);
    maxX = Math.min(width - 1, maxX + 1);
  }
  if (maxY - minY < 2) {
    minY = Math.max(0, minY - 1);
    maxY = Math.min(height - 1, maxY + 1);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const inside = (col: number, row: number, cols: number, rows: number) => {
    const x = Math.round(minX + ((col + 0.5) / cols) * spanX);
    const y = Math.round(minY + ((row + 0.5) / rows) * spanY);
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    return mask[cy * width + cx] === 1;
  };

  const clamped = Math.max(SCENE_POLYGON_MIN, Math.min(SCENE_POLYGON_MAX, Math.round(targetPolygons)));
  let cols = 2;
  let rows = 2;
  let bestErr = Number.POSITIVE_INFINITY;
  let bestCount = -1;
  for (let guess = 2; guess <= 96; guess += 1) {
    const nextRows = Math.max(2, Math.round((guess * spanY) / spanX));
    let quads = 0;
    for (let row = 0; row < nextRows; row += 1) {
      for (let col = 0; col < guess; col += 1) {
        if (inside(col, row, guess, nextRows)) quads += 1;
      }
    }
    const count = quads * 4;
    const err = Math.abs(count - clamped);
    if (count > 0 && (err < bestErr || (err === bestErr && count > bestCount))) {
      bestErr = err;
      bestCount = count;
      cols = guess;
      rows = nextRows;
    }
  }

  let maxDist = 1;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] && (dist[index] ?? 0) > maxDist) maxDist = dist[index] ?? 1;
  }
  const vertCols = cols + 1;
  const vertRows = rows + 1;
  const shell = vertCols * vertRows;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const scale = 1.55 / spanY;
  const depth = Math.min(spanX, spanY) * scale * 0.46;
  const positions = new Float32Array(shell * 2 * 3);
  const colors = new Float32Array(shell * 2 * 3);
  const atPixel = (col: number, row: number) => {
    const x = minX + (col / cols) * spanX;
    const y = minY + (row / rows) * spanY;
    const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
    const on = mask[iy * width + ix] === 1;
    const rise = on ? Math.pow((dist[iy * width + ix] ?? 0) / maxDist, 0.7) : 0;
    return {
      x: (x - midX) * scale,
      y: (midY - y) * scale,
      half: rise * depth,
    };
  };
  for (let row = 0; row < vertRows; row += 1) {
    for (let col = 0; col < vertCols; col += 1) {
      const point = atPixel(col, row);
      const front = (row * vertCols + col) * 3;
      const back = (shell + row * vertCols + col) * 3;
      positions[front] = point.x;
      positions[front + 1] = point.y;
      positions[front + 2] = point.half;
      positions[back] = point.x;
      positions[back + 1] = point.y;
      positions[back + 2] = -point.half;
      colors[front] = SCENE_CLAY[0];
      colors[front + 1] = SCENE_CLAY[1];
      colors[front + 2] = SCENE_CLAY[2];
      colors[back] = SCENE_CLAY[0];
      colors[back + 1] = SCENE_CLAY[1];
      colors[back + 2] = SCENE_CLAY[2];
    }
  }

  const frontOf = (col: number, row: number) => row * vertCols + col;
  const backOf = (col: number, row: number) => shell + row * vertCols + col;
  const indexList: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!inside(col, row, cols, rows)) continue;
      const a = frontOf(col, row);
      const b = frontOf(col + 1, row);
      const d = frontOf(col, row + 1);
      const e = frontOf(col + 1, row + 1);
      indexList.push(a, d, e, a, e, b);
      const ba = backOf(col, row);
      const bb = backOf(col + 1, row);
      const bd = backOf(col, row + 1);
      const be = backOf(col + 1, row + 1);
      indexList.push(ba, be, bd, ba, bb, be);
    }
  }
  if (indexList.length === 0) throw new Error("Could not build a scene mesh.");
  const indices = new Uint16Array(indexList);
  const normals = new Float32Array(positions.length);
  for (let cursor = 0; cursor < indices.length; cursor += 3) {
    const ia = (indices[cursor] ?? 0) * 3;
    const ib = (indices[cursor + 1] ?? 0) * 3;
    const ic = (indices[cursor + 2] ?? 0) * 3;
    const p0: Vec3 = [positions[ia] ?? 0, positions[ia + 1] ?? 0, positions[ia + 2] ?? 0];
    const p1: Vec3 = [positions[ib] ?? 0, positions[ib + 1] ?? 0, positions[ib + 2] ?? 0];
    const p2: Vec3 = [positions[ic] ?? 0, positions[ic + 1] ?? 0, positions[ic + 2] ?? 0];
    const normal = cross([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]);
    for (const offset of [ia, ib, ic]) {
      normals[offset] = (normals[offset] ?? 0) + normal[0];
      normals[offset + 1] = (normals[offset + 1] ?? 0) + normal[1];
      normals[offset + 2] = (normals[offset + 2] ?? 0) + normal[2];
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset] ?? 0, normals[offset + 1] ?? 0, normals[offset + 2] ?? 0) || 1;
    normals[offset] = (normals[offset] ?? 0) / length;
    normals[offset + 1] = (normals[offset + 1] ?? 0) / length;
    normals[offset + 2] = (normals[offset + 2] ?? 0) / length;
  }

  let floorY = Number.POSITIVE_INFINITY;
  const seen = new Uint8Array(shell * 2);
  for (const index of indices) seen[index] = 1;
  for (let index = 0; index < seen.length; index += 1) {
    if (!seen[index]) continue;
    const y = positions[index * 3 + 1] ?? 0;
    if (y < floorY) floorY = y;
  }
  return { positions, normals, colors, indices, polygonCount: indices.length / 3, floorY };
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
