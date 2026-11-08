import { MESH_KEEP_FRACTION } from "@/lib/subject-pipeline";

export type TriangleMesh = {
  positions: Float32Array;
  indices: Uint32Array;
};

export type ReducedMesh = TriangleMesh & {
  sourceFaces: number;
  reducedFaces: number;
};

function boundsOf(positions: Float32Array): { min: number[]; max: number[]; diagonal: number } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] ?? 0;
      min[axis] = Math.min(min[axis] ?? 0, value);
      max[axis] = Math.max(max[axis] ?? 0, value);
    }
  }
  const diagonal = Math.hypot((max[0] ?? 0) - (min[0] ?? 0), (max[1] ?? 0) - (min[1] ?? 0), (max[2] ?? 0) - (min[2] ?? 0)) || 1;
  return { min, max, diagonal };
}

/** Merge nearby vertices and drop the collapsed triangles. */
export function clusterMesh(mesh: TriangleMesh, cell: number): TriangleMesh {
  const step = Math.max(cell, 1e-6);
  const groups = new Map<string, number>();
  const sums: number[] = [];
  const counts: number[] = [];
  const remap = new Int32Array(mesh.positions.length / 3);
  for (let index = 0; index < remap.length; index += 1) {
    const x = Math.round((mesh.positions[index * 3] ?? 0) / step);
    const y = Math.round((mesh.positions[index * 3 + 1] ?? 0) / step);
    const z = Math.round((mesh.positions[index * 3 + 2] ?? 0) / step);
    const key = `${x},${y},${z}`;
    let slot = groups.get(key);
    if (slot === undefined) {
      slot = sums.length / 3;
      groups.set(key, slot);
      sums.push(0, 0, 0);
      counts.push(0);
    }
    remap[index] = slot;
    sums[slot * 3] = (sums[slot * 3] ?? 0) + (mesh.positions[index * 3] ?? 0);
    sums[slot * 3 + 1] = (sums[slot * 3 + 1] ?? 0) + (mesh.positions[index * 3 + 1] ?? 0);
    sums[slot * 3 + 2] = (sums[slot * 3 + 2] ?? 0) + (mesh.positions[index * 3 + 2] ?? 0);
    counts[slot] = (counts[slot] ?? 0) + 1;
  }
  const positions = new Float32Array(sums.length);
  for (let slot = 0; slot < counts.length; slot += 1) {
    const count = counts[slot] || 1;
    positions[slot * 3] = (sums[slot * 3] ?? 0) / count;
    positions[slot * 3 + 1] = (sums[slot * 3 + 1] ?? 0) / count;
    positions[slot * 3 + 2] = (sums[slot * 3 + 2] ?? 0) / count;
  }
  const seen = new Set<string>();
  const indices: number[] = [];
  for (let cursor = 0; cursor < mesh.indices.length; cursor += 3) {
    const a = remap[mesh.indices[cursor] ?? 0] ?? 0;
    const b = remap[mesh.indices[cursor + 1] ?? 0] ?? 0;
    const c = remap[mesh.indices[cursor + 2] ?? 0] ?? 0;
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((left, right) => left - right).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    indices.push(a, b, c);
  }
  return { positions, indices: new Uint32Array(indices) };
}

/**
 * Keep about 30% of the faces. The browser never receives the dense model.
 * Clustering is local, so a check can prove the ratio without a paid job.
 */
export function reduceMesh(mesh: TriangleMesh, fraction = MESH_KEEP_FRACTION): ReducedMesh {
  const sourceFaces = Math.floor(mesh.indices.length / 3);
  const target = Math.max(8, Math.round(sourceFaces * fraction));
  if (sourceFaces <= target) {
    return { positions: mesh.positions, indices: mesh.indices, sourceFaces, reducedFaces: sourceFaces };
  }
  const { diagonal } = boundsOf(mesh.positions);
  let best: TriangleMesh | null = null;
  let bestScore = Infinity;
  for (let divisions = 4; divisions <= 64; divisions += 1) {
    const clustered = clusterMesh(mesh, diagonal / divisions);
    const faces = clustered.indices.length / 3;
    if (faces < 4) continue;
    const over = faces > target * 1.15 ? (faces - target) * 4 : 0;
    const score = Math.abs(faces - target) + over;
    if (score < bestScore) {
      best = clustered;
      bestScore = score;
    }
  }
  const chosen = best ?? mesh;
  return {
    positions: chosen.positions,
    indices: chosen.indices,
    sourceFaces,
    reducedFaces: Math.floor(chosen.indices.length / 3),
  };
}

function pushTri(positions: number[], indices: number[], a: [number, number, number], b: [number, number, number], c: [number, number, number]): void {
  const base = positions.length / 3;
  positions.push(...a, ...b, ...c);
  indices.push(base, base + 1, base + 2);
}

function addFaceGrid(
  positions: number[],
  indices: number[],
  origin: [number, number, number],
  axisU: [number, number, number],
  axisV: [number, number, number],
  divU: number,
  divV: number,
): void {
  for (let v = 0; v < divV; v += 1) {
    for (let u = 0; u < divU; u += 1) {
      const at = (uu: number, vv: number): [number, number, number] => [
        origin[0] + axisU[0] * (uu / divU) + axisV[0] * (vv / divV),
        origin[1] + axisU[1] * (uu / divU) + axisV[1] * (vv / divV),
        origin[2] + axisU[2] * (uu / divU) + axisV[2] * (vv / divV),
      ];
      const p00 = at(u, v);
      const p10 = at(u + 1, v);
      const p01 = at(u, v + 1);
      const p11 = at(u + 1, v + 1);
      pushTri(positions, indices, p00, p10, p11);
      pushTri(positions, indices, p00, p11, p01);
    }
  }
}

/** A tall block person, subdivided so there is a real face count to reduce. */
export function blockFigureMesh(): TriangleMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const box = (min: [number, number, number], max: [number, number, number], div: [number, number, number]) => {
    const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    addFaceGrid(positions, indices, min, [size[0], 0, 0], [0, size[1], 0], div[0], div[1]);
    addFaceGrid(positions, indices, [min[0], min[1], max[2]], [size[0], 0, 0], [0, size[1], 0], div[0], div[1]);
    addFaceGrid(positions, indices, min, [size[0], 0, 0], [0, 0, size[2]], div[0], div[2]);
    addFaceGrid(positions, indices, [min[0], max[1], min[2]], [size[0], 0, 0], [0, 0, size[2]], div[0], div[2]);
    addFaceGrid(positions, indices, min, [0, size[1], 0], [0, 0, size[2]], div[1], div[2]);
    addFaceGrid(positions, indices, [max[0], min[1], min[2]], [0, size[1], 0], [0, 0, size[2]], div[1], div[2]);
  };
  box([-0.28, 0, -0.16], [0.28, 1.15, 0.16], [6, 10, 2]);
  box([-0.22, 1.15, -0.16], [0.22, 1.62, 0.16], [4, 4, 2]);
  box([0.28, 0.72, -0.1], [0.92, 0.96, 0.1], [6, 2, 2]);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

export function encodeGlb(mesh: TriangleMesh): Buffer {
  const positionBytes = Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength);
  const indexBytes = Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength);
  const bin = Buffer.concat([positionBytes, indexBytes]);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[index + axis] ?? 0;
      min[axis] = Math.min(min[axis] ?? 0, value);
      max[axis] = Math.max(max[axis] ?? 0, value);
    }
  }
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ byteLength: bin.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
        { buffer: 0, byteOffset: positionBytes.length, byteLength: indexBytes.length, target: 34963 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: mesh.positions.length / 3, type: "VEC3", min, max },
        { bufferView: 1, componentType: 5125, count: mesh.indices.length, type: "SCALAR" },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    }),
  );
  const jsonPad = (4 - (json.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

type GltfAccessor = {
  bufferView?: number;
  byteOffset?: number;
  componentType?: number;
  count?: number;
  type?: string;
};

type GltfBufferView = {
  buffer?: number;
  byteOffset?: number;
  byteLength?: number;
  byteStride?: number;
};

type GltfPrimitive = {
  attributes?: { POSITION?: number };
  indices?: number;
};

type GltfDocument = {
  buffers?: { byteLength?: number; uri?: string }[];
  bufferViews?: GltfBufferView[];
  accessors?: GltfAccessor[];
  meshes?: { primitives?: GltfPrimitive[] }[];
};

function notAMesh(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "Hunyuan returned an image, not a 3D mesh.";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "Hunyuan returned an image, not a 3D mesh.";
  }
  return "Hunyuan returned a file that is not a GLB mesh.";
}

function componentBytes(componentType: number | undefined): number {
  if (componentType === 5126 || componentType === 5125) return 4;
  if (componentType === 5123) return 2;
  if (componentType === 5121) return 1;
  return 0;
}

function elementWidth(type: string | undefined, component: number): number {
  if (type === "SCALAR") return component;
  if (type === "VEC3") return component * 3;
  return 0;
}

/** Packed copy. Honors accessor.byteOffset and a bufferView byteStride wider than the element. */
function tightElements(bin: Buffer, start: number, count: number, stride: number, width: number): Buffer {
  const out = Buffer.alloc(count * width);
  if (stride === width) {
    bin.copy(out, 0, start, start + count * width);
    return out;
  }
  for (let index = 0; index < count; index += 1) {
    const from = start + index * stride;
    bin.copy(out, index * width, from, from + width);
  }
  return out;
}

function readAccessor(json: GltfDocument, bin: Buffer, accessorIndex: number): { accessor: GltfAccessor; bytes: Buffer } {
  const accessor = json.accessors?.[accessorIndex];
  const view = accessor?.bufferView !== undefined ? json.bufferViews?.[accessor.bufferView] : undefined;
  if (!accessor || !view || (view.buffer ?? 0) !== 0) {
    throw new Error("Hunyuan returned a GLB with no triangle mesh.");
  }
  if (json.buffers?.[0]?.uri) throw new Error("Hunyuan returned a file that is not a GLB mesh.");
  const component = componentBytes(accessor.componentType);
  const width = elementWidth(accessor.type, component);
  const count = accessor.count ?? 0;
  if (!component || !width || count < 1) throw new Error("Hunyuan returned a GLB with no triangle mesh.");
  const declaredStride = view.byteStride ?? 0;
  const stride = declaredStride > width ? declaredStride : width;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const need = (count - 1) * stride + width;
  if (start < 0 || start + need > bin.length) throw new Error("Hunyuan returned a GLB with no triangle mesh.");
  return { accessor, bytes: tightElements(bin, start, count, stride, width) };
}

function indicesFrom(accessor: GltfAccessor, packed: Buffer): Uint32Array {
  const count = accessor.count ?? 0;
  if (accessor.componentType === 5125) {
    const copy = Buffer.alloc(packed.length);
    packed.copy(copy);
    return new Uint32Array(copy.buffer, copy.byteOffset, count);
  }
  if (accessor.componentType === 5123) {
    const copy = Buffer.alloc(packed.length);
    packed.copy(copy);
    return new Uint32Array(new Uint16Array(copy.buffer, copy.byteOffset, count));
  }
  if (accessor.componentType === 5121) {
    const indices = new Uint32Array(count);
    for (let index = 0; index < count; index += 1) indices[index] = packed[index] ?? 0;
    return indices;
  }
  throw new Error("Hunyuan returned a GLB with no triangle mesh.");
}

function readPrimitive(json: GltfDocument, bin: Buffer, primitive: GltfPrimitive): TriangleMesh | null {
  const positionIndex = primitive.attributes?.POSITION;
  const indexIndex = primitive.indices;
  if (positionIndex === undefined || indexIndex === undefined) return null;
  const position = readAccessor(json, bin, positionIndex);
  if (position.accessor.componentType !== 5126 || position.accessor.type !== "VEC3") {
    throw new Error("Hunyuan returned a GLB with no triangle mesh.");
  }
  const index = readAccessor(json, bin, indexIndex);
  if (index.accessor.type !== "SCALAR") throw new Error("Hunyuan returned a GLB with no triangle mesh.");
  return { positions: floatsFrom(position.bytes), indices: indicesFrom(index.accessor, index.bytes) };
}

function mergeMeshes(parts: TriangleMesh[]): TriangleMesh {
  if (parts.length === 1) return parts[0];
  const positions = new Float32Array(parts.reduce((sum, part) => sum + part.positions.length, 0));
  const indices = new Uint32Array(parts.reduce((sum, part) => sum + part.indices.length, 0));
  let vertexCursor = 0;
  let indexCursor = 0;
  let baseVertex = 0;
  for (const part of parts) {
    positions.set(part.positions, vertexCursor);
    for (let index = 0; index < part.indices.length; index += 1) {
      indices[indexCursor + index] = part.indices[index] + baseVertex;
    }
    vertexCursor += part.positions.length;
    indexCursor += part.indices.length;
    baseVertex += part.positions.length / 3;
  }
  return { positions, indices };
}

/**
 * Read every POSITION primitive in an embedded GLB.
 * An image or any other file is an error. This does not invent a mesh.
 */
export function decodeGlb(bytes: Buffer): TriangleMesh {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) throw new Error(notAMesh(bytes));
  const jsonLength = bytes.readUInt32LE(12);
  const jsonType = bytes.readUInt32LE(16);
  const jsonEnd = 20 + jsonLength;
  if (jsonType !== 0x4e4f534a || jsonEnd + 8 > bytes.length) throw new Error(notAMesh(bytes));
  let json: GltfDocument;
  try {
    json = JSON.parse(bytes.subarray(20, jsonEnd).toString("utf8")) as GltfDocument;
  } catch {
    throw new Error(notAMesh(bytes));
  }
  const binLength = bytes.readUInt32LE(jsonEnd);
  const binType = bytes.readUInt32LE(jsonEnd + 4);
  const binStart = jsonEnd + 8;
  if (binType !== 0x004e4942 || binStart + binLength > bytes.length) {
    throw new Error("Hunyuan returned a file that is not a GLB mesh.");
  }
  const bin = bytes.subarray(binStart, binStart + binLength);
  const parts: TriangleMesh[] = [];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const part = readPrimitive(json, bin, primitive);
      if (part && part.positions.length >= 9 && part.indices.length >= 3) parts.push(part);
    }
  }
  if (parts.length === 0) throw new Error("Hunyuan returned a GLB with no triangle mesh.");
  return mergeMeshes(parts);
}

function floatsFrom(view: Buffer): Float32Array {
  const copy = Buffer.alloc(view.length);
  view.copy(copy);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4);
}
