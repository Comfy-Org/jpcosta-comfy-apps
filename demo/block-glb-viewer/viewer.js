import * as THREE from "three";
import { OrbitControls } from "./vendor/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "./vendor/jsm/loaders/GLTFLoader.js";

const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");
const canvas = document.getElementById("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
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

export function showGltf(gltf, filename) {
  if (current) {
    scene.remove(current);
    current.traverse((obj) => {
      if (obj.isMesh) obj.material = null;
    });
  }
  current = gltf.scene;
  current.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.material = gray;
    obj.frustumCulled = false;
  });
  scene.add(current);
  const counts = countGeometry(current);
  const framed = frame(current);
  const fixture = /loader-fixture/i.test(filename);
  setStatus(
    fixture
      ? "Loader fixture only. This is not the Hunyuan scene."
      : `Showing ${filename}. Source triangles, gray material, no column fill.`,
  );
  statsEl.textContent = `${counts.meshes} meshes · ${counts.vertices} vertices · ${counts.triangles} triangles · size ${framed.size.x.toFixed(2)} × ${framed.size.y.toFixed(2)} × ${framed.size.z.toFixed(2)}`;
  document.body.dataset.ready = "1";
  document.body.dataset.triangles = String(counts.triangles);
  document.body.dataset.vertices = String(counts.vertices);
  return counts;
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

document.getElementById("front").addEventListener("click", () => {
  if (current) frame(current);
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
} else {
  setStatus("Waiting for the Hunyuan GLB. No geometry is invented.");
  statsEl.textContent = "No mesh loaded.";
}

function animate() {
  requestAnimationFrame(animate);
  resize();
  controls.update();
  renderer.render(scene, camera);
}
animate();
