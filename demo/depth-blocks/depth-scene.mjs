/**
 * Partial 2.5D blocks from one relative depth image.
 * Bright is nearer. There is no calibrated focal length; DEPTH_VFOV_RAD is
 * only so orbit parallax has a scale. The source camera still reprojects
 * each block onto its own pixels with that same assumption.
 */

export const DEPTH_VFOV_RAD = (40 * Math.PI) / 180;
export const DEPTH_Z_NEAR = 1.15;
export const DEPTH_Z_FAR = 7.4;
export const BLOCK_MIN = 4;
export const BLOCK_MAX = 32;
export const BLOCK_DEFAULT = 8;
/** About ±14° yaw and ±8° pitch. The back of the scene was never seen. */
export const ORBIT_YAW_LIMIT = 0.24;
export const ORBIT_PITCH_LIMIT = 0.14;

const CLAY = [0.73, 0.73, 0.75];

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

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Camera on a short arc around the mid-depth point. yaw = pitch = 0 is the source camera. */
export function orbitCamera(yaw, pitch, zFocus = (DEPTH_Z_NEAR + DEPTH_Z_FAR) * 0.42) {
  const clamped = clampOrbit(yaw, pitch);
  const target = [0, 0, -zFocus];
  const radius = zFocus;
  const cy = Math.cos(clamped.yaw);
  const sy = Math.sin(clamped.yaw);
  const cp = Math.cos(clamped.pitch);
  const sp = Math.sin(clamped.pitch);
  const eye = [target[0] + radius * sy * cp, target[1] + radius * sp, target[2] + radius * cy * cp];
  return { eye, target, up: [0, 1, 0], yaw: clamped.yaw, pitch: clamped.pitch };
}

export function lookAt(eye, target, up) {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function perspective(width, height, focal, near = 0.15, far = 40) {
  const m = new Float32Array(16);
  m[0] = (2 * focal) / width;
  m[5] = (2 * focal) / height;
  m[10] = -(far + near) / (far - near);
  m[11] = -1;
  m[14] = (-2 * far * near) / (far - near);
  return m;
}

export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[row] * b[col * 4] +
        a[4 + row] * b[col * 4 + 1] +
        a[8 + row] * b[col * 4 + 2] +
        a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

export function projectToPixel(point, view, width, height, focal) {
  const x = view[0] * point[0] + view[4] * point[1] + view[8] * point[2] + view[12];
  const y = view[1] * point[0] + view[5] * point[1] + view[9] * point[2] + view[13];
  const z = view[2] * point[0] + view[6] * point[1] + view[10] * point[2] + view[14];
  const w = view[3] * point[0] + view[7] * point[1] + view[11] * point[2] + view[15];
  const inv = w === 0 ? 0 : 1 / w;
  const camX = x * inv;
  const camY = y * inv;
  const camZ = z * inv;
  const depth = -camZ;
  return {
    x: width / 2 + (camX / depth) * focal,
    y: height / 2 - (camY / depth) * focal,
    depth,
  };
}

function pushFace(positions, normals, indices, quad, normal) {
  const base = positions.length / 3;
  for (const point of quad) {
    positions.push(point[0], point[1], point[2]);
    normals.push(normal[0], normal[1], normal[2]);
  }
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function depthNormal(depth, width, height, focal, x, y, block) {
  const at = (px, py) => {
    const sx = Math.min(width - 1, Math.max(0, px));
    const sy = Math.min(height - 1, Math.max(0, py));
    return unproject(sx, sy, depthToZ(depth[sy * width + sx] ?? 0), width, height, focal);
  };
  const dx = sub(at(x + block, y), at(x - block, y));
  const dy = sub(at(x, y + block), at(x, y - block));
  let normal = normalize(cross(dx, dy));
  if (normal[2] < 0) normal = [-normal[0], -normal[1], -normal[2]];
  if (!Number.isFinite(normal[0])) return [0, 0, 1];
  return normal;
}

/**
 * One thin box per depth cell. The front face is the cell's pixel rectangle
 * unprojected at that cell's depth, so the source camera sees the silhouette.
 * The box is not a filled volume and does not invent the unseen back of a person.
 */
export function buildDepthBoxes(depth, width, height, blockSize) {
  const block = Math.max(BLOCK_MIN, Math.min(BLOCK_MAX, Math.round(blockSize)));
  const focal = focalLength(height);
  const positions = [];
  const normals = [];
  const indices = [];
  const cells = [];
  for (let y0 = 0; y0 < height; y0 += block) {
    const y1 = Math.min(height, y0 + block);
    for (let x0 = 0; x0 < width; x0 += block) {
      const x1 = Math.min(width, x0 + block);
      const cx = Math.min(width - 1, Math.floor((x0 + x1) / 2));
      const cy = Math.min(height - 1, Math.floor((y0 + y1) / 2));
      const sample = depth[cy * width + cx] ?? 0;
      const z = depthToZ(sample);
      const front = [
        unproject(x0, y0, z, width, height, focal),
        unproject(x1, y0, z, width, height, focal),
        unproject(x1, y1, z, width, height, focal),
        unproject(x0, y1, z, width, height, focal),
      ];
      const thick = Math.max(0.05, (x1 - x0) * (z / focal) * 1.15);
      const back = front.map((point) => [point[0], point[1], point[2] - thick]);
      const facing = depthNormal(depth, width, height, focal, cx, cy, block);
      pushFace(positions, normals, indices, [front[0], front[3], front[2], front[1]], facing);
      pushFace(positions, normals, indices, [back[0], back[1], back[2], back[3]], [0, 0, -1]);
      pushFace(positions, normals, indices, [front[0], front[1], back[1], back[0]], [0, 1, 0]);
      pushFace(positions, normals, indices, [front[3], back[3], back[2], front[2]], [0, -1, 0]);
      pushFace(positions, normals, indices, [front[0], back[0], back[3], front[3]], [-1, 0, 0]);
      pushFace(positions, normals, indices, [front[1], front[2], back[2], back[1]], [1, 0, 0]);
      cells.push({ x0, y0, x1, y1, z, sample, cx, cy });
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    cells,
    block,
    focal,
    color: CLAY,
  };
}
