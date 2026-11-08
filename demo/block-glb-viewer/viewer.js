import * as THREE from "three";
import { OrbitControls } from "./vendor/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "./vendor/jsm/loaders/GLTFLoader.js";
import { PRESET_LABELS, PRESETS, buildVideoReferencePayload } from "./presets.mjs";

const statusEl = document.getElementById("status");
const canvas = document.getElementById("view");
const referenceView = document.getElementById("style-reference");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2a2e);
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
const referenceCamera = new THREE.PerspectiveCamera(40, 16 / 9, 0.01, 1000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2a30, 0.85);
const key = new THREE.DirectionalLight(0xffffff, 1.35);
key.position.set(2.4, 4.2, 3.2);
scene.add(hemi, key);

const loader = new GLTFLoader();
const referenceTarget = new THREE.WebGLRenderTarget(960, 540);
let current = null;
let style = "blocos-cinza";
let pieceColors = null;

const PALETTE = [
  new THREE.Color(0xb7c3d0),
  new THREE.Color(0xd2b48c),
  new THREE.Color(0x8eaea4),
  new THREE.Color(0xd0a097),
  new THREE.Color(0x8d9098),
];

function resize() {
  const width = canvas.clientWidth || 960;
  const height = canvas.clientHeight || 540;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}

function componentIds(geometry) {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const count = position.count;
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i += 1) parent[i] = i;
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
  if (!index) return parent;
  for (let i = 0; i < index.count; i += 3) {
    unite(index.getX(i), index.getX(i + 1));
    unite(index.getX(i), index.getX(i + 2));
  }
  const sizes = new Map();
  for (let vertex = 0; vertex < count; vertex += 1) {
    const root = find(vertex);
    sizes.set(root, (sizes.get(root) || 0) + 1);
  }
  const rank = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
  const colorOf = new Map(rank.map(([root], order) => [root, PALETTE[Math.min(order, PALETTE.length - 1)]]));
  const colors = new Float32Array(count * 3);
  for (let vertex = 0; vertex < count; vertex += 1) {
    const color = colorOf.get(find(vertex));
    colors[vertex * 3] = color.r;
    colors[vertex * 3 + 1] = color.g;
    colors[vertex * 3 + 2] = color.b;
  }
  return colors;
}

function applyStyle() {
  if (!current) return;
  const clay = style === "clay";
  hemi.color.set(clay ? 0xfff1e4 : 0xffffff);
  hemi.groundColor.set(clay ? 0x6a5648 : 0x2a2a30);
  hemi.intensity = clay ? 1.15 : 0.85;
  key.intensity = clay ? 0.55 : 1.35;
  key.color.set(clay ? 0xfff6ee : 0xffffff);
  current.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (!obj.geometry.getAttribute("normal")) obj.geometry.computeVertexNormals();
    if (style === "blocos-coloridos" && !obj.geometry.getAttribute("color") && pieceColors) {
      obj.geometry.setAttribute("color", new THREE.BufferAttribute(pieceColors, 3));
    }
    obj.material = new THREE.MeshStandardMaterial({
      color: clay ? 0xd7c6b8 : 0xc5c6ca,
      roughness: clay ? 0.95 : 0.72,
      metalness: 0,
      flatShading: !clay,
      vertexColors: style === "blocos-coloridos",
    });
  });
  document.body.dataset.style = style;
  const label = PRESET_LABELS[style];
  statusEl.textContent = `${label}. A exploração não muda a referência do vídeo.`;
  document.getElementById("chosen").textContent = label;
  renderReference();
}

function frameObject(targetCamera, direction) {
  const bounds = new THREE.Box3().setFromObject(current);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.001) * 0.5;
  const offset = new THREE.Vector3(direction[0], direction[1], direction[2]);
  if (offset.lengthSq() === 0) offset.set(0, 0.15, 1);
  offset.normalize().multiplyScalar(radius * 2.8);
  targetCamera.near = Math.max(radius / 200, 0.001);
  targetCamera.far = radius * 80;
  targetCamera.position.copy(center).add(offset);
  targetCamera.lookAt(center);
  targetCamera.updateProjectionMatrix();
  return center;
}

function place(direction) {
  if (!current) return;
  const center = frameObject(camera, direction);
  controls.target.copy(center);
  controls.update();
  document.body.dataset.camera = direction.map((value) => Number(value).toFixed(2)).join(",");
}

function renderReference() {
  if (!current) return;
  frameObject(referenceCamera, [0, 0.15, 1]);
  const previousTarget = renderer.getRenderTarget();
  const previousSize = new THREE.Vector2();
  renderer.getSize(previousSize);
  renderer.setRenderTarget(referenceTarget);
  renderer.setSize(960, 540, false);
  renderer.render(scene, referenceCamera);
  renderer.setRenderTarget(previousTarget);
  renderer.setSize(previousSize.x, previousSize.y, false);
  const pixels = new Uint8Array(960 * 540 * 4);
  renderer.readRenderTargetPixels(referenceTarget, 0, 0, 960, 540, pixels);
  const copy = document.createElement("canvas");
  copy.width = 960;
  copy.height = 540;
  const ctx = copy.getContext("2d");
  const image = ctx.createImageData(960, 540);
  const row = 960 * 4;
  for (let y = 0; y < 540; y += 1) image.data.set(pixels.subarray((539 - y) * row, (540 - y) * row), y * row);
  ctx.putImageData(image, 0, 0);
  referenceView.src = copy.toDataURL("image/png");
  document.body.dataset.reference = referenceView.src.slice(-64);
}

function geometryStamp() {
  let stamp = 2166136261;
  let triangles = 0;
  let vertices = 0;
  current.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const position = obj.geometry.getAttribute("position");
    const index = obj.geometry.getIndex();
    if (!position) return;
    vertices += position.count;
    triangles += index ? index.count / 3 : position.count / 3;
    const array = position.array;
    for (let i = 0; i < array.length; i += 29) stamp = Math.imul(stamp ^ Math.round(array[i] * 1000), 16777619);
    if (index) {
      const ids = index.array;
      for (let i = 0; i < ids.length; i += 41) stamp = Math.imul(stamp ^ ids[i], 16777619);
    }
  });
  document.body.dataset.triangles = String(triangles);
  document.body.dataset.vertices = String(vertices);
  document.body.dataset.geometry = String(stamp >>> 0);
}

export function showGltf(gltf, filename) {
  if (current) scene.remove(current);
  current = gltf.scene;
  pieceColors = null;
  current.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (!obj.geometry.getAttribute("normal")) obj.geometry.computeVertexNormals();
    if (!pieceColors) pieceColors = componentIds(obj.geometry);
    obj.frustumCulled = false;
  });
  scene.add(current);
  geometryStamp();
  const fixture = /loader-fixture/i.test(filename);
  document.body.dataset.ready = "1";
  document.body.dataset.fixture = fixture ? "1" : "0";
  applyStyle();
  place([0, 0.15, 1]);
  if (fixture) statusEl.textContent = "Loader fixture only. This is not the Hunyuan scene.";
}

function parseArrayBuffer(buffer, filename) {
  loader.parse(
    buffer,
    "",
    (gltf) => showGltf(gltf, filename),
    (error) => {
      statusEl.textContent = error instanceof Error ? error.message : "Esse ficheiro não pôde ser lido.";
    },
  );
}

function chooseStyle(next) {
  if (!PRESETS.includes(next)) return;
  style = next;
  for (const button of document.querySelectorAll("[data-style]")) {
    button.setAttribute("aria-pressed", button.dataset.style === style ? "true" : "false");
  }
  applyStyle();
}

document.getElementById("file").addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => parseArrayBuffer(reader.result, file.name);
  reader.readAsArrayBuffer(file);
});
for (const button of document.querySelectorAll("[data-style]")) {
  button.addEventListener("click", () => chooseStyle(button.dataset.style));
}
document.getElementById("reset").addEventListener("click", () => place([0, 0.15, 1]));
document.getElementById("capture").addEventListener("click", () => {
  if (!current || !referenceView.src.startsWith("data:image/png")) return;
  const payload = buildVideoReferencePayload({
    style,
    referencePng: Uint8Array.from(atob(referenceView.src.split(",")[1]), (char) => char.charCodeAt(0)),
  });
  document.body.dataset.payload = `${payload.called}:${payload.fields.style}:${payload.fields.camera}:${payload.fields.video}`;
  const link = document.createElement("a");
  link.href = referenceView.src;
  link.download = `referencia-${style}.png`;
  link.click();
});

const params = new URLSearchParams(location.search);
const named = params.get("glb");
if (named) {
  statusEl.textContent = "A carregar…";
  fetch(named)
    .then((response) => {
      if (!response.ok) throw new Error("O modelo ainda não está disponível.");
      return response.arrayBuffer();
    })
    .then((buffer) => parseArrayBuffer(buffer, named.split("/").pop() || named))
    .catch((error) => {
      statusEl.textContent = error instanceof Error ? error.message : "O modelo ainda não está disponível.";
    });
} else if (typeof window.__EMBEDDED_GLB === "string" && window.__EMBEDDED_GLB) {
  const bytes = Uint8Array.from(atob(window.__EMBEDDED_GLB), (char) => char.charCodeAt(0));
  parseArrayBuffer(bytes.buffer, "whole-scene.glb");
} else {
  statusEl.textContent = "À espera do modelo. Nada é inventado.";
}

const sourcePhoto = document.getElementById("source-photo");
if (sourcePhoto && typeof window.__EMBEDDED_REF === "string" && window.__EMBEDDED_REF) {
  sourcePhoto.src = `data:image/jpeg;base64,${window.__EMBEDDED_REF}`;
  sourcePhoto.hidden = false;
}

function animate() {
  requestAnimationFrame(animate);
  resize();
  controls.update();
  renderer.render(scene, camera);
}
animate();
