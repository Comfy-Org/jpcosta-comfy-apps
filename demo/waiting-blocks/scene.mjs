/**
 * Blocks for one relative-depth frame.
 * Bright is nearer. The 40° field is only a scale for the relief.
 * The source camera reprojects each block onto its own pixels.
 * The back of the scene was never photographed, so the orbit stays short.
 */

export const DEPTH_VFOV_RAD = (40 * Math.PI) / 180;
export const DEPTH_Z_NEAR = 1.15;
export const DEPTH_Z_FAR = 7.4;
export const BLOCK = 8;
export const SKETCH_MS = 24;
export const FILL_MS = 5600;
export const ZOOM_MIN = 0.78;
export const ZOOM_MAX = 1.48;
/** About ±11° yaw and ±6° pitch. Further around, this relief splits into a shell. */
export const ORBIT_YAW_LIMIT = 0.2;
export const ORBIT_PITCH_LIMIT = 0.11;

export function focalLength(height, vfov = DEPTH_VFOV_RAD) {
  return height / 2 / Math.tan(vfov / 2);
}

/** 8-bit relative depth. 255 is nearest, 0 is farthest. Not meters. */
export function depthToZ(value, zNear = DEPTH_Z_NEAR, zFar = DEPTH_Z_FAR) {
  const near = Math.min(1, Math.max(0, value / 255));
  return zFar + near * (zNear - zFar);
}

export function unproject(px, py, z, width, height, focal) {
  return [((px - width / 2) / focal) * z, ((height / 2 - py) / focal) * z, -z];
}

export function clampOrbit(yaw, pitch) {
  return {
    yaw: Math.min(ORBIT_YAW_LIMIT, Math.max(-ORBIT_YAW_LIMIT, yaw)),
    pitch: Math.min(ORBIT_PITCH_LIMIT, Math.max(-ORBIT_PITCH_LIMIT, pitch)),
  };
}

export function clampZoom(zoom) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** yaw = pitch = 0 and zoom = 1 is the camera that took the frame. */
export function orbitCamera(yaw, pitch, zoom = 1, zFocus = (DEPTH_Z_NEAR + DEPTH_Z_FAR) * 0.42) {
  const clamped = clampOrbit(yaw, pitch);
  const scale = clampZoom(zoom);
  const target = [0, 0, -zFocus];
  const radius = zFocus / scale;
  const cy = Math.cos(clamped.yaw);
  const sy = Math.sin(clamped.yaw);
  const cp = Math.cos(clamped.pitch);
  const sp = Math.sin(clamped.pitch);
  const eye = [
    target[0] + radius * sy * cp,
    target[1] + radius * sp,
    target[2] + radius * cy * cp,
  ];
  return { eye, target, up: [0, 1, 0], yaw: clamped.yaw, pitch: clamped.pitch, zoom: scale };
}

export function buildCells(depth, rgba, width, height, blockSize = BLOCK) {
  const block = Math.max(4, Math.round(blockSize));
  const focal = focalLength(height);
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const cells = [];
  for (let iy = 0; iy < rows; iy += 1) {
    const y0 = iy * block;
    const y1 = Math.min(height, y0 + block);
    for (let ix = 0; ix < cols; ix += 1) {
      const x0 = ix * block;
      const x1 = Math.min(width, x0 + block);
      let nearest = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) nearest = Math.max(nearest, depth[y * width + x] || 0);
      }
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const sample = depth[y * width + x] || 0;
          if (sample < nearest - 24) continue;
          const pixel = (y * width + x) * 4;
          red += rgba[pixel];
          green += rgba[pixel + 1];
          blue += rgba[pixel + 2];
          count += 1;
        }
      }
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const z = depthToZ(nearest);
      const p00 = unproject(x0, y0, z, width, height, focal);
      const p10 = unproject(x1, y0, z, width, height, focal);
      const p01 = unproject(x0, y1, z, width, height, focal);
      const sx = Math.abs(p10[0] - p00[0]) * 1.04;
      const sy = Math.abs(p00[1] - p01[1]) * 1.04;
      const sz = Math.max(sx, sy) * 1.25;
      cells.push({
        ix,
        iy,
        x: (p00[0] + p10[0]) / 2,
        y: (p00[1] + p01[1]) / 2,
        z: p00[2] - sz / 2,
        sx,
        sy,
        sz,
        r: (count ? red / count : 0) / 255,
        g: (count ? green / count : 0) / 255,
        b: (count ? blue / count : 0) / 255,
      });
    }
  }
  return { cells, cols, rows, block, focal, width, height };
}

function spreadRank(cell) {
  let hash = Math.imul(cell.ix + 1, 0x9e3779b1) ^ Math.imul(cell.iy + 1, 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 16), 0xc2b2ae35);
  return hash >>> 0;
}

/** Sparse lattice first, sprinkled over the whole frame, then the gaps. */
export function assemblyOrder(cells) {
  const waves = [[], [], [], []];
  for (const cell of cells) {
    const lattice = cell.ix % 3 === 0 && cell.iy % 3 === 0;
    const second = cell.ix % 3 === 1 && cell.iy % 3 === 1;
    const third = cell.ix % 3 === 2 && cell.iy % 3 === 2;
    waves[lattice ? 0 : second ? 1 : third ? 2 : 3].push(cell);
  }
  for (const wave of waves) {
    wave.sort((a, b) => spreadRank(a) - spreadRank(b));
  }
  return { order: waves.flat(), sparse: waves[0].length };
}

/**
 * How many blocks exist at this moment.
 * The first lattice arrives one block at a time. Later gaps arrive in a short fill.
 * This number is the scene, not the video job.
 */
export function targetCount(elapsedMs, total, sparse) {
  const elapsed = Math.max(0, elapsedMs);
  const sketchMs = sparse * SKETCH_MS;
  if (elapsed <= 0) return 0;
  if (elapsed < sketchMs) return Math.min(sparse, Math.floor(elapsed / SKETCH_MS));
  const fill = Math.max(1, total - sparse);
  const t = Math.min(1, (elapsed - sketchMs) / FILL_MS);
  const eased = 1 - (1 - t) * (1 - t);
  return Math.min(total, sparse + Math.floor(eased * fill));
}

/** Elapsed time at which this block index becomes visible. */
export function appearTime(index, total, sparse) {
  if (index < sparse) return (index + 1) * SKETCH_MS;
  const fill = Math.max(1, total - sparse);
  const u = Math.min(1, (index + 1 - sparse) / fill);
  const t = 1 - Math.sqrt(Math.max(0, 1 - u));
  return sparse * SKETCH_MS + t * FILL_MS;
}
