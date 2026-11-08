/**
 * Fewer triangles by welding nearby vertices inside each separate piece.
 * Pieces are never joined, so the four bodies cannot melt into one column.
 * cell <= 0 returns the same arrays, which is the untouched source mesh.
 */

export const DETAIL_CELLS = [0.042, 0.03, 0.018, 0.008, 0];

function findGroups(vertexCount, indices) {
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) parent[i] = i;
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== root) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const unite = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < indices.length; i += 3) {
    unite(indices[i], indices[i + 1]);
    unite(indices[i], indices[i + 2]);
  }
  const groups = new Map();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const root = find(vertex);
    const list = groups.get(root);
    if (list) list.push(vertex);
    else groups.set(root, [vertex]);
  }
  return [...groups.values()];
}

function simplifyGroup(positions, indices, members, cell) {
  const memberSet = new Set(members);
  const keyToNew = new Map();
  const remap = new Map();
  const next = [];
  for (const vertex of members) {
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    const key = `${Math.round(x / cell)}|${Math.round(y / cell)}|${Math.round(z / cell)}`;
    let id = keyToNew.get(key);
    if (id === undefined) {
      id = next.length / 3;
      keyToNew.set(key, id);
      next.push(x, y, z);
    }
    remap.set(vertex, id);
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    if (!memberSet.has(a)) continue;
    const ra = remap.get(a);
    const rb = remap.get(indices[i + 1]);
    const rc = remap.get(indices[i + 2]);
    if (ra === rb || rb === rc || ra === rc) continue;
    const key = ra < rb && ra < rc ? `${ra},${Math.min(rb, rc)},${Math.max(rb, rc)}` : rb < rc ? `${rb},${Math.min(ra, rc)},${Math.max(ra, rc)}` : `${rc},${Math.min(ra, rb)},${Math.max(ra, rb)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ra, rb, rc);
  }
  return { positions: next, indices: out };
}

export function simplifyMesh(positions, indices, cell) {
  const sourcePositions = positions instanceof Float32Array ? positions : new Float32Array(positions);
  const sourceIndices = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
  if (!(cell > 0)) {
    return { positions: sourcePositions, indices: sourceIndices, triangles: sourceIndices.length / 3 };
  }
  const groups = findGroups(sourcePositions.length / 3, sourceIndices);
  const allPositions = [];
  const allIndices = [];
  let offset = 0;
  for (const members of groups) {
    const piece = simplifyGroup(sourcePositions, sourceIndices, members, cell);
    if (piece.indices.length < 3) continue;
    allPositions.push(...piece.positions);
    for (const index of piece.indices) allIndices.push(index + offset);
    offset += piece.positions.length / 3;
  }
  return {
    positions: new Float32Array(allPositions),
    indices: new Uint32Array(allIndices),
    triangles: allIndices.length / 3,
  };
}

export function largePieceTriangles(positions, indices, minimumVertices = 40) {
  const groups = findGroups(positions.length / 3, indices);
  return groups
    .filter((group) => group.length >= minimumVertices)
    .map((group) => {
      const set = new Set(group);
      let triangles = 0;
      for (let i = 0; i < indices.length; i += 3) {
        if (set.has(indices[i]) && set.has(indices[i + 1]) && set.has(indices[i + 2])) triangles += 1;
      }
      return triangles;
    })
    .filter((count) => count > 0)
    .sort((a, b) => b - a);
}
