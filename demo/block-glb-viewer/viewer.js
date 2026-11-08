import * as THREE from "three";
import { OrbitControls } from "./vendor/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "./vendor/jsm/loaders/GLTFLoader.js";
import { DETAIL_CELLS, simplifyMesh } from "./lod.mjs";

const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");
const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2a2e);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x222228, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(2.2, 3.4, 4.2);
scene.add(key);

const loader = new GLTFLoader();
const gray = new THREE.MeshStandardMaterial({
  color: 0xbcbcc0,
  roughness: 0.86,
  metalness: 0,
});
let current = null;
let detailSlots = [];
let showingFixture = false;
const maxDetail = DETAIL_CELLS.length - 1;

function resize() {
  const width = canvas.clientWidth || 960;
  const height = canvas.clientHeight || 540;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}

function setStatus(text) {
  statusEl.textContent = text;
}

function countGeometry(root) {
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    meshes += 1;
    const position = obj.geometry.getAttribute("position");
    if (position) vertices += position.count;
    const index = obj.geometry.getIndex();
    triangles += index ? index.count / 3 : position ? position.count / 3 : 0;
  });
  return { meshes, vertices, triangles };
}

function frame(root) {
  const bounds = new THREE.Box3().setFromObject(root);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.001) * 0.5;
  controls.target.copy(center);
  camera.near = Math.max(radius / 200, 0.001);
  camera.far = radius * 80;
  camera.position.set(center.x, center.y + radius * 0.15, center.z + radius * 2.6);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  controls.update();
  return { center, size, radius };
}

function geometryFrom(positions, indices) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function detailLevels(mesh) {
  const position = mesh.geometry.getAttribute("position");
  const index = mesh.geometry.getIndex();
  if (!position || !index) return [mesh.geometry];
  return DETAIL_CELLS.map((cell) => {
    const simplified = simplifyMesh(position.array, index.array, cell);
    return geometryFrom(simplified.positions, simplified.indices);
  });
}

function applyDetail(level) {
  const chosen = Math.max(0, Math.min(maxDetail, level));
  for (const slot of detailSlots) slot.mesh.geometry = slot.geometries[chosen];
  const detail = document.getElementById("detail");
  if (detail) detail.value = String(chosen);
  if (!showingFixture && current) {
    setStatus(
      chosen === maxDetail
        ? "Mesh original no máximo. O controle só junta vértices próximos."
        : "Menos triângulos das mesmas peças. Nada de geometria nova.",
    );
  }
  const counts = countGeometry(current);
  document.body.dataset.detail = String(chosen);
  document.body.dataset.triangles = String(counts.triangles);
  document.body.dataset.vertices = String(counts.vertices);
  if (statsEl && current) {
    statsEl.textContent = `${counts.meshes} meshes · ${counts.vertices} vertices · ${counts.triangles} triangles`;
  }
}

export function showGltf(gltf, filename) {
  if (current) scene.remove(current);
  current = gltf.scene;
  detailSlots = [];
  current.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const geometries = detailLevels(obj);
    detailSlots.push({ mesh: obj, geometries });
    obj.material = gray;
    obj.frustumCulled = false;
  });
  scene.add(current);
  applyDetail(maxDetail);
  frame(current);
  const fixture = /loader-fixture/i.test(filename);
  showingFixture = fixture;
  setStatus(
    fixture
      ? "Loader fixture only. This is not the Hunyuan scene."
      : "Mesh original no máximo. O controle só junta vértices próximos.",
  );
  document.body.dataset.ready = "1";
  return countGeometry(current);
}

function parseArrayBuffer(buffer, filename) {
  loader.parse(
    buffer,
    "",
    (gltf) => showGltf(gltf, filename),
    (error) => setStatus(error instanceof Error ? error.message : "That GLB could not be read."),
  );
}

document.getElementById("file").addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => parseArrayBuffer(reader.result, file.name);
  reader.readAsArrayBuffer(file);
});

function place(direction) {
  if (!current) return;
  const bounds = new THREE.Box3().setFromObject(current);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.001) * 0.5;
  const offset = new THREE.Vector3(direction[0], direction[1], direction[2]);
  if (offset.lengthSq() === 0) offset.set(0, 0, 1);
  offset.normalize().multiplyScalar(radius * 2.8);
  controls.target.copy(center);
  camera.position.copy(center).add(offset);
  camera.near = Math.max(radius / 200, 0.001);
  camera.far = radius * 80;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  controls.update();
}

window.__place = place;

document.getElementById("front").addEventListener("click", () => place([0, 0.15, 1]));
document.getElementById("reset").addEventListener("click", () => {
  applyDetail(maxDetail);
  place([0, 0.15, 1]);
});
document.getElementById("detail").addEventListener("input", (event) => {
  applyDetail(Number(event.target.value));
});
document.getElementById("capture").addEventListener("click", () => {
  if (!current) return;
  renderer.render(scene, camera);
  const link = document.createElement("a");
  link.href = renderer.domElement.toDataURL("image/png");
  link.download = "vista.png";
  link.click();
});

const params = new URLSearchParams(location.search);
const named = params.get("glb");
if (named) {
  setStatus("Loading the provided GLB…");
  fetch(named)
    .then((response) => {
      if (!response.ok) throw new Error("The GLB file is not available yet.");
      return response.arrayBuffer();
    })
    .then((buffer) => parseArrayBuffer(buffer, named.split("/").pop() || named))
    .catch((error) => setStatus(error instanceof Error ? error.message : "The GLB file is not available yet."));
} else if (typeof window.__EMBEDDED_GLB === "string" && window.__EMBEDDED_GLB) {
  const bytes = Uint8Array.from(atob(window.__EMBEDDED_GLB), (char) => char.charCodeAt(0));
  parseArrayBuffer(bytes.buffer, "whole-scene.glb");
} else {
  setStatus("Waiting for the Hunyuan GLB. No geometry is invented.");
  statsEl.textContent = "No mesh loaded.";
}

const reference = document.getElementById("reference");
if (reference && typeof window.__EMBEDDED_REF === "string" && window.__EMBEDDED_REF) {
  reference.src = `data:image/jpeg;base64,${window.__EMBEDDED_REF}`;
  reference.hidden = false;
}

function animate() {
  requestAnimationFrame(animate);
  resize();
  controls.update();
  renderer.render(scene, camera);
}
animate();
