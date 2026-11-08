import * as THREE from "three";
import {
  BLOCK,
  appearTime,
  assemblyOrder,
  buildCells,
  orbitCamera,
  targetCount,
} from "./scene.mjs";

const statusEl = document.getElementById("status");
const statusLabel = document.getElementById("status-label");
const canvas = document.getElementById("view");
const film = document.getElementById("film");
const watch = document.getElementById("watch");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x17171b);
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 40);
const hemi = new THREE.HemisphereLight(0xf4f1ea, 0x2a2724, 0.72);
const key = new THREE.DirectionalLight(0xffffff, 1.15);
key.position.set(0.4, 1.2, 2.4);
scene.add(hemi, key);

let yaw = 0;
let pitch = 0;
let zoom = 1;
let mesh = null;
let order = [];
let sparse = 0;
let settled = 0;
let started = performance.now();
let frozen = null;
let job = "pending";
const POP_MS = 180;

function resize() {
  const width = canvas.clientWidth || 960;
  const height = canvas.clientHeight || 540;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}

function placeCamera() {
  const pose = orbitCamera(yaw, pitch, zoom);
  yaw = pose.yaw;
  pitch = pose.pitch;
  zoom = pose.zoom;
  camera.position.set(pose.eye[0], pose.eye[1], pose.eye[2]);
  camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
  document.body.dataset.camera = `${yaw.toFixed(3)},${pitch.toFixed(3)},${zoom.toFixed(3)}`;
}

function elapsed() {
  return frozen == null ? performance.now() - started : frozen;
}

const blockMatrix = new THREE.Matrix4();
const blockPosition = new THREE.Vector3();
const blockQuaternion = new THREE.Quaternion();
const blockScale = new THREE.Vector3();

function writeBlock(index, scale) {
  const cell = order[index];
  const amount = Math.max(0.001, scale);
  blockPosition.set(cell.x, cell.y, cell.z);
  blockScale.set(cell.sx * amount, cell.sy * amount, cell.sz * amount);
  blockMatrix.compose(blockPosition, blockQuaternion, blockScale);
  mesh.setMatrixAt(index, blockMatrix);
}

function popScale(index, now) {
  const age = now - appearTime(index, order.length, sparse);
  if (age >= POP_MS) return 1;
  const t = Math.max(0, age / POP_MS);
  const eased = t * t * (3 - 2 * t);
  return 0.04 + 0.96 * eased;
}

function syncBlocks() {
  if (!mesh) return;
  const now = elapsed();
  const goal = targetCount(now, order.length, sparse);
  if (goal < settled) settled = goal;
  for (let index = settled; index < goal; index += 1) writeBlock(index, popScale(index, now));
  while (settled < goal && popScale(settled, now) >= 1) settled += 1;
  mesh.count = goal;
  mesh.instanceMatrix.needsUpdate = true;
  document.body.dataset.instances = String(goal);
  document.body.dataset.assembly = goal >= order.length && order.length > 0 ? "done" : "building";
  document.body.dataset.job = job;
}

function restart() {
  frozen = null;
  started = performance.now();
  settled = 0;
  if (mesh) mesh.count = 0;
  syncBlocks();
}

function setJobReady() {
  if (job === "ready") return;
  job = "ready";
  statusEl.dataset.job = "ready";
  statusLabel.textContent = "Vídeo pronto";
  watch.hidden = false;
  document.body.dataset.job = "ready";
}

function showFilm() {
  if (job !== "ready") return;
  if (!film.getAttribute("src")) film.src = "avengers-kling-cached.mp4";
  film.hidden = false;
  document.body.dataset.playing = "1";
  const played = film.play();
  if (played && typeof played.catch === "function") played.catch(() => {});
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("A imagem da cena não abriu."));
    image.src = url;
  });
}

function pixelsOf(image) {
  const scratch = document.createElement("canvas");
  scratch.width = image.naturalWidth;
  scratch.height = image.naturalHeight;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, scratch.width, scratch.height);
}

async function loadScene() {
  const rgbUrl = window.__WAITING_RGB || "assets/main-rgb.png";
  const depthUrl = window.__WAITING_DEPTH || "assets/main-depth.png";
  const [rgbImage, depthImage] = await Promise.all([loadImage(rgbUrl), loadImage(depthUrl)]);
  const rgb = pixelsOf(rgbImage);
  const depthImageData = pixelsOf(depthImage);
  const depth = new Uint8Array(rgb.width * rgb.height);
  for (let i = 0; i < depth.length; i += 1) depth[i] = depthImageData.data[i * 4];
  const built = buildCells(depth, rgb.data, rgb.width, rgb.height, BLOCK);
  const arranged = assemblyOrder(built.cells);
  order = arranged.order;
  sparse = arranged.sparse;
  mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshLambertMaterial(),
    order.length,
  );
  mesh.count = 0;
  mesh.frustumCulled = false;
  const color = new THREE.Color();
  for (let index = 0; index < order.length; index += 1) {
    const cell = order[index];
    color.setRGB(cell.r, cell.g, cell.b, THREE.SRGBColorSpace);
    mesh.setColorAt(index, color);
  }
  mesh.instanceColor.needsUpdate = true;
  scene.add(mesh);
  document.body.dataset.blocks = String(order.length);
  document.body.dataset.sparse = String(sparse);
  document.body.dataset.meshes = String(scene.children.filter((child) => child.isMesh).length);
  document.body.dataset.ready = "1";
  started = performance.now();
  syncBlocks();
}

let dragging = false;
let lastX = 0;
let lastY = 0;
canvas.addEventListener("pointerdown", (event) => {
  dragging = true;
  lastX = event.clientX;
  lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  yaw += (event.clientX - lastX) * 0.0052;
  pitch += (event.clientY - lastY) * 0.0034;
  lastX = event.clientX;
  lastY = event.clientY;
});
canvas.addEventListener("pointerup", () => {
  dragging = false;
});
canvas.addEventListener("pointercancel", () => {
  dragging = false;
});
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    zoom *= Math.exp(-event.deltaY * 0.0011);
  },
  { passive: false },
);

document.getElementById("reset").addEventListener("click", () => {
  yaw = 0;
  pitch = 0;
  zoom = 1;
});
document.getElementById("restart").addEventListener("click", restart);
document.getElementById("simulate").addEventListener("click", setJobReady);
watch.addEventListener("click", showFilm);

window.__waiting = {
  jump(ms) {
    frozen = ms;
    syncBlocks();
  },
  play() {
    if (frozen != null) started = performance.now() - frozen;
    frozen = null;
  },
  restart,
  elapsed,
};

function frame() {
  resize();
  syncBlocks();
  placeCamera();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

loadScene().catch((error) => {
  statusEl.textContent = error instanceof Error ? error.message : "A cena não abriu.";
});
requestAnimationFrame(frame);
