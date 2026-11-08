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
  componentType?: number;
  count?: number;
  type?: string;
};

type GltfDocument = {
  buffers?: { byteLength?: number }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number }[];
  accessors?: GltfAccessor[];
  meshes?: { primitives?: { attributes?: { POSITION?: number }; indices?: number }[] }[];
};

/** Read the first POSITION primitive. Hunyuan returns a GLB; this is how the server reduces it. */
export function decodeGlb(bytes: Buffer): TriangleMesh {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) {
    throw new Error("That 3D model could not be read.");
  }
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as GltfDocument;
  const binStart = 20 + jsonLength + 8;
  const primitive = json.meshes?.[0]?.primitives?.[0];
  const positionIndex = primitive?.attributes?.POSITION;
  const indexIndex = primitive?.indices;
  if (positionIndex === undefined || indexIndex === undefined) throw new Error("That 3D model could not be read.");
  const readView = (accessorIndex: number): { accessor: GltfAccessor; bytes: Buffer } => {
    const accessor = json.accessors?.[accessorIndex];
    const view = accessor?.bufferView !== undefined ? json.bufferViews?.[accessor.bufferView] : undefined;
    if (!accessor || !view) throw new Error("That 3D model could not be read.");
    const start = binStart + (view.byteOffset ?? 0);
    return { accessor, bytes: bytes.subarray(start, start + (view.byteLength ?? 0)) };
  };
  const position = readView(positionIndex);
  if (position.accessor.componentType !== 5126 || position.accessor.type !== "VEC3") {
    throw new Error("That 3D model could not be read.");
  }
  const positions = floatsFrom(position.bytes);
  const index = readView(indexIndex);
  const count = index.accessor.count ?? 0;
  let indices: Uint32Array;
  if (index.accessor.componentType === 5125) {
    indices = uintsFrom(index.bytes, count);
  } else if (index.accessor.componentType === 5123) {
    const copy = Buffer.alloc(index.bytes.length);
    index.bytes.copy(copy);
    indices = new Uint32Array(new Uint16Array(copy.buffer, copy.byteOffset, count));
  } else {
    throw new Error("That 3D model could not be read.");
  }
  return { positions, indices };
}

function floatsFrom(view: Buffer): Float32Array {
  const copy = Buffer.alloc(view.length);
  view.copy(copy);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4);
}

function uintsFrom(view: Buffer, count: number): Uint32Array {
  const copy = Buffer.alloc(view.length);
  view.copy(copy);
  return new Uint32Array(copy.buffer, copy.byteOffset, count);
}
