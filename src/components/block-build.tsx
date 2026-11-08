"use client";

import { useEffect, useRef } from "react";
import type { PartBoxes } from "@/lib/scene-mesh";

type Props = {
  /** The subject as a few big blocks. Null while the model is still marking it. */
  parts: PartBoxes | null;
  /** The chosen frame, hung behind the blocks so they line up with it. */
  plate?: Blob | null;
  /** The video is ready: once every block has landed, call onFinished. */
  done: boolean;
  onFinished?: () => void;
};

type Live = {
  setParts: (parts: PartBoxes | null) => void;
  setPlate: (plate: Blob | null) => void;
  setDone: (done: boolean) => void;
  dispose: () => void;
};

const CLAY = 0xc9cbd1;
/** Things around the subject, a shade darker so the subject reads first. */
const PROP_CLAY = 0xa6aab4;
const HOT = 0xf2ff59;
/** Time between two blocks landing, for a single subject's dozen blocks. */
const GAP_MS = 650;
/** A shot with many subjects lands all its blocks in about this long, but never faster than GAP_MIN_MS apart. */
const BUILD_MS = 6500;
const GAP_MIN_MS = 70;
const DROP_MS = 560;
/** From the waiting view to the shot's camera. */
const FLY_MS = 900;
/** Once a few blocks are down, the camera sways off the shot's angle to show they are 3D. */
const SWAY_YAW = 0.42;
const SWAY_PITCH = 0.2;
/**
 * How far a subject may slide off its picture at the far end of a sway, in radians. The frame stands on the plane the
 * camera turns around; a subject in front of it or behind it slides as the camera turns, so a deep scene sways less.
 */
const SWAY_SLIP = 0.07;
const SWAY_PERIOD_MS = 12_000;
/** After a drag, the camera stays where it was left for this long. */
const SWAY_REST_MS = 2500;
/** The frame behind the blocks is faded a little, so the grey blocks read first. */
const PLATE_GREY = 0.35;
const PLATE_DIM = 0.84;
const PLATE_LIFT = 12;
const PLATE_FADE_MS = 500;

const easeOutBack = (t: number) => {
  const c = 1.7;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Vertical field of view for the level, straight-on shot view of `parts`.
 * The frame behind the blocks fills the view when it can, but every block always stays in view,
 * and a small subject is zoomed in on rather than left tiny in the middle of its frame.
 */
function shotFov(parts: PartBoxes, aspect: number): number {
  const shot = parts.camera;
  if (!shot) return 32;
  const wide = Math.max(aspect, 0.2);
  const [tx, ty, tz] = shot.target;
  let needX = 0.15;
  let needY = 0.15;
  for (const box of parts.boxes) {
    const cos = Math.abs(Math.cos(box.rotation ?? 0));
    const sin = Math.abs(Math.sin(box.rotation ?? 0));
    const halfX = (cos * box.size[0] + sin * box.size[1]) / 2;
    const halfY = (sin * box.size[0] + cos * box.size[1]) / 2;
    const near = Math.max(0.5, shot.distance - (box.center[2] + box.size[2] / 2 - tz));
    needX = Math.max(needX, (Math.abs(box.center[0] - tx) + halfX) / near);
    needY = Math.max(needY, (Math.abs(box.center[1] - ty) + halfY) / near);
  }
  const fit = Math.max(needY, needX / wide);
  let half = fit * 1.16;
  const plate = parts.plate;
  if (plate) {
    const away = shot.distance - (plate.center[2] - tz);
    const [px, py] = plate.center;
    const [pw, ph] = plate.size;
    const room = Math.min(ty - (py - ph / 2), py + ph / 2 - ty, (tx - (px - pw / 2)) / wide, (px + pw / 2 - tx) / wide);
    const cover = away > 0 ? room / away : 0;
    half = Math.min(half, Math.max(fit * 1.02, cover));
  }
  return Math.min(72, Math.max(20, (Math.atan(half) * 2 * 180) / Math.PI));
}

/** The frame as a canvas, faded and a little desaturated. */
async function plateCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("No 2D canvas.");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const grey = data[index]! * 0.299 + data[index + 1]! * 0.587 + data[index + 2]! * 0.114;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = data[index + channel]!;
      data[index + channel] = (value + (grey - value) * PLATE_GREY) * PLATE_DIM + PLATE_LIFT;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * The loading screen: while the video renders, the subject is assembled from big blocks
 * (head, torso, arms…) dropping in one by one over the shot's own frame, seen from the shot's camera.
 * Then the camera sways to show they are 3D. Drag to orbit, hover a block to lift it and see its name, click to knock it.
 */
export function BlockBuild({ parts, plate = null, done, onFinished }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<Live | null>(null);
  const finishedRef = useRef(onFinished);
  const latest = useRef({ parts, plate, done });
  useEffect(() => {
    finishedRef.current = onFinished;
  });
  useEffect(() => {
    latest.current = { parts, plate, done };
    liveRef.current?.setPlate(plate);
    liveRef.current?.setParts(parts);
    liveRef.current?.setDone(done);
  }, [parts, plate, done]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    void (async () => {
      const THREE = await import("three");
      const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
      const { RoundedBoxGeometry } = await import("three/examples/jsm/geometries/RoundedBoxGeometry.js");
      if (cancelled) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch {
        host.dataset.failed = "1";
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.className = "block-build-canvas";
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      // The frame is drawn first, on its own, so it never hides a block that stands behind its plane.
      const backdrop = new THREE.Scene();
      renderer.autoClear = false;
      const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 80);
      camera.position.set(2.6, 1.4, 3.4);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.enablePan = false;
      controls.minDistance = 2.4;
      controls.maxDistance = 7;
      controls.maxPolarAngle = Math.PI * 0.52;
      controls.autoRotate = !reduce;
      controls.autoRotateSpeed = 0.6;
      controls.target.set(0, -0.05, 0);

      scene.add(new THREE.HemisphereLight(0xf4f1ff, 0x5a5f6e, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 2.4);
      sun.position.set(2.2, 4, 2.6);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.left = -2.5;
      sun.shadow.camera.right = 2.5;
      sun.shadow.camera.top = 2.5;
      sun.shadow.camera.bottom = -2.5;
      sun.shadow.radius = 5;
      sun.shadow.bias = -0.0008;
      scene.add(sun);

      const floor = new THREE.Group();
      const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.22 }));
      shadowPlane.rotation.x = -Math.PI / 2;
      shadowPlane.receiveShadow = true;
      floor.add(shadowPlane);
      const grid = new THREE.GridHelper(8, 28, 0xffffff, 0xffffff);
      const gridMat = grid.material as InstanceType<typeof THREE.Material>;
      gridMat.transparent = true;
      gridMat.opacity = 0.16;
      grid.position.y = 0.002;
      floor.add(grid);
      floor.position.y = -0.8;
      scene.add(floor);

      // While the model is still marking the subject: a small grid of blocks breathing in a wave.
      const IDLE = 4;
      const idleSize = 0.2;
      const idleMat = new THREE.MeshStandardMaterial({ color: CLAY, roughness: 0.82 });
      const idle = new THREE.InstancedMesh(new RoundedBoxGeometry(idleSize, idleSize, idleSize, 2, idleSize * 0.14), idleMat, IDLE * IDLE);
      idle.castShadow = true;
      scene.add(idle);

      type Block = {
        mesh: InstanceType<typeof THREE.Mesh>;
        material: InstanceType<typeof THREE.MeshStandardMaterial>;
        base: InstanceType<typeof THREE.Color>;
        name: string;
        home: InstanceType<typeof THREE.Vector3>;
        /** The block's turn about the camera's axis, so a limb follows the pose. */
        turn: number;
        startAt: number;
        lift: number;
        knock: number;
        spin: number;
      };
      const group = new THREE.Group();
      scene.add(group);
      let blocks: Block[] = [];
      let current: PartBoxes | null = null;
      let isDone = false;
      let finishTimer = 0;
      let finished = false;
      let hovered: Block | null = null;
      let disposed = false;
      const clay = new THREE.Color(CLAY);
      const propClay = new THREE.Color(PROP_CLAY);
      const hot = new THREE.Color(HOT);
      const dummy = new THREE.Object3D();
      const label = document.createElement("span");
      label.className = "block-build-label";
      label.setAttribute("aria-hidden", "true");
      host.appendChild(label);
      const labelBox = new THREE.Box3();
      const labelAt = new THREE.Vector3();

      // The shot's camera: level, straight on, and the same distance the layout lined the frame up for.
      let shot: { target: InstanceType<typeof THREE.Vector3>; position: InstanceType<typeof THREE.Vector3>; fov: number } | null = null;
      let fly: { from: InstanceType<typeof THREE.Vector3>; fromTarget: InstanceType<typeof THREE.Vector3>; fromFov: number; start: number } | null = null;
      let swayStart = 0;
      /** Share of the full sway this layout gets: 1 for one subject just in front of the frame, less for a deep scene. */
      let swayShare = 1;
      let dragging = false;
      let draggedAt = -Infinity;
      const offset = new THREE.Vector3();
      const spherical = new THREE.Spherical();
      controls.addEventListener("start", () => {
        dragging = true;
        fly = null;
      });
      controls.addEventListener("end", () => {
        dragging = false;
        draggedAt = performance.now();
      });

      // The chosen frame behind the blocks.
      let plateBlob: Blob | null = null;
      let plateMesh: InstanceType<typeof THREE.Mesh> | null = null;
      let plateMaterial: InstanceType<typeof THREE.MeshBasicMaterial> | null = null;
      let plateBorn = 0;
      let plateToken = 0;
      /** The faded frame, made once per blob: a new layout and a new frame often arrive together. */
      let plateFaded: { blob: Blob; canvas: Promise<HTMLCanvasElement> } | null = null;

      function removePlate() {
        plateToken += 1;
        if (plateMesh) {
          backdrop.remove(plateMesh);
          plateMesh.geometry.dispose();
          plateMaterial?.map?.dispose();
          plateMaterial?.dispose();
        }
        plateMesh = null;
        plateMaterial = null;
        grid.visible = true;
      }

      async function buildPlate() {
        removePlate();
        const placement = current?.plate;
        const blob = plateBlob;
        if (!placement || !blob) return;
        const token = plateToken;
        if (plateFaded?.blob !== blob) plateFaded = { blob, canvas: plateCanvas(blob) };
        let canvas: HTMLCanvasElement;
        try {
          canvas = await plateFaded.canvas;
        } catch {
          return;
        }
        if (disposed || token !== plateToken) return;
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        mesh.position.set(placement.center[0], placement.center[1], placement.center[2]);
        mesh.scale.set(placement.size[0], placement.size[1], 1);
        backdrop.add(mesh);
        plateMesh = mesh;
        plateMaterial = material;
        plateBorn = performance.now();
        // The frame already shows the ground, so the grid would only clutter it.
        grid.visible = false;
      }

      function setPlate(next: Blob | null) {
        if (next === plateBlob) return;
        plateBlob = next;
        void buildPlate();
      }

      function clearBlocks() {
        for (const block of blocks) {
          group.remove(block.mesh);
          block.mesh.geometry.dispose();
          block.material.dispose();
        }
        blocks = [];
        hovered = null;
      }

      function setParts(next: PartBoxes | null) {
        if (next === current) return;
        current = next;
        clearBlocks();
        finished = false;
        void buildPlate();
        if (!next) return;
        const now = performance.now();
        // Bottom up, and the bigger block first when two start at the same height.
        const gapMs = Math.min(GAP_MS, Math.max(GAP_MIN_MS, BUILD_MS / Math.max(1, next.boxes.length)));
        const order = next.boxes
          .map((box) => {
            const sin = Math.abs(Math.sin(box.rotation ?? 0));
            const cos = Math.abs(Math.cos(box.rotation ?? 0));
            return { box, bottom: box.center[1] - (sin * box.size[0] + cos * box.size[1]) / 2, volume: box.size[0] * box.size[1] * box.size[2] };
          })
          .sort((a, b) => a.bottom - b.bottom || b.volume - a.volume);
        order.forEach(({ box }, slot) => {
          const [w, h, d] = box.size;
          const gap = Math.min(w, h, d) * 0.03;
          const radius = Math.min(w, h, d) * 0.12;
          const base = box.kind === "prop" ? propClay : clay;
          const material = new THREE.MeshStandardMaterial({ color: base, roughness: 0.8 });
          const geometry = box.wheel ? new THREE.CylinderGeometry(0.5, 0.5, 1, 28) : new RoundedBoxGeometry(w - gap, h - gap, d - gap, 3, radius);
          if (box.wheel) {
            // A wheel is a drum: its axle points at the camera ("z"), or sideways when it is seen edge on ("x").
            if (box.wheel === "z") geometry.rotateX(Math.PI / 2);
            else geometry.rotateZ(Math.PI / 2);
            geometry.scale(w - gap, h - gap, d - gap);
          }
          const mesh = new THREE.Mesh(geometry, material);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.visible = false;
          group.add(mesh);
          blocks.push({
            mesh,
            material,
            base,
            name: box.name ?? "",
            home: new THREE.Vector3(box.center[0], box.center[1], box.center[2]),
            turn: box.rotation ?? 0,
            startAt: reduce ? now - DROP_MS : now + 250 + slot * gapMs,
            lift: 0,
            knock: 0,
            spin: 0,
          });
        });
        floor.position.y = next.floorY;
        // A subject cut off by the bottom of the frame has no ground under it.
        floor.visible = !next.cropped;
        if (next.camera) {
          const target = new THREE.Vector3(...next.camera.target);
          shot = { target, position: target.clone().add(new THREE.Vector3(0, 0, next.camera.distance)), fov: shotFov(next, camera.aspect) };
          controls.autoRotate = false;
          controls.minAzimuthAngle = -1.15;
          controls.maxAzimuthAngle = 1.15;
          controls.minPolarAngle = 0.55;
          controls.maxPolarAngle = Math.PI / 2;
          controls.minDistance = next.camera.distance * 0.55;
          controls.maxDistance = next.camera.distance * 1.5;
          swayStart = now + 250 + Math.min(order.length * gapMs, 6 * GAP_MS);
          // Turning by an angle slides a subject off its picture by about angle × its distance from the frame's plane / distance.
          const depths = new Map<number, number[]>();
          for (const box of next.boxes) depths.set(box.subject ?? 0, [...(depths.get(box.subject ?? 0) ?? []), box.center[2] - next.camera.target[2]]);
          const spread = Math.max(0, ...[...depths.values()].map((list) => Math.abs(list.reduce((sum, z) => sum + z, 0) / list.length)));
          swayShare = spread > 0 ? Math.min(1, (SWAY_SLIP * next.camera.distance) / (SWAY_YAW * spread)) : 1;
          if (reduce) {
            fly = null;
            controls.target.copy(shot.target);
            camera.position.copy(shot.position);
            camera.fov = shot.fov;
            camera.updateProjectionMatrix();
          } else {
            fly = { from: camera.position.clone(), fromTarget: controls.target.clone(), fromFov: camera.fov, start: now };
          }
        } else {
          shot = null;
          frame(next);
        }
      }

      /** Without a shot camera: keep the whole layout in view from the three-quarter angle. */
      function frame(layout: PartBoxes) {
        let radius = 0;
        for (const box of layout.boxes) {
          const [x, y, z] = box.center;
          const [w, h, d] = box.size;
          radius = Math.max(radius, Math.hypot(Math.abs(x) + w / 2, Math.abs(y) + h / 2, Math.abs(z) + d / 2));
        }
        const fit = radius || 0.9;
        const half = THREE.MathUtils.degToRad(camera.fov / 2);
        const narrow = Math.min(half, Math.atan(Math.tan(half) * camera.aspect));
        const distance = Math.min(9, Math.max(3.8, (fit / Math.sin(narrow)) * 0.9));
        const dir = camera.position.clone().sub(controls.target).normalize();
        controls.target.set(0, -0.05 - fit * 0.12, 0);
        camera.position.copy(controls.target).addScaledVector(dir, distance);
        controls.minDistance = distance * 0.6;
        controls.maxDistance = distance * 1.7;
      }

      function setDone(next: boolean) {
        isDone = next;
      }

      function resize() {
        const width = host!.clientWidth || 1;
        const height = host!.clientHeight || 1;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        if (shot && current) {
          shot.fov = shotFov(current, camera.aspect);
          if (!fly) camera.fov = shot.fov;
        } else {
          camera.fov = width < height ? 44 : 32;
          if (current) frame(current);
        }
        camera.updateProjectionMatrix();
      }
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(host);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let pointerIn = false;
      let downAt: { x: number; y: number } | null = null;
      const canvas = renderer.domElement;
      const onMove = (event: PointerEvent) => {
        const rect = canvas.getBoundingClientRect();
        pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        pointerIn = true;
      };
      const onLeave = () => {
        pointerIn = false;
        hovered = null;
      };
      const onDown = (event: PointerEvent) => {
        downAt = { x: event.clientX, y: event.clientY };
      };
      const onUp = (event: PointerEvent) => {
        const start = downAt;
        downAt = null;
        if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 || !hovered) return;
        hovered.knock = 1;
        hovered.spin = Math.random() < 0.5 ? -1 : 1;
      };
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerleave", onLeave);
      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointerup", onUp);

      let raf = 0;
      let last = performance.now();
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        const elapsed = Math.min(1000, now - last);
        const dt = Math.min(64, elapsed);
        last = now;

        if (fly && shot) {
          // From the waiting view to the shot's camera.
          const k = Math.min(1, (now - fly.start) / FLY_MS);
          const eased = easeInOut(k);
          controls.target.lerpVectors(fly.fromTarget, shot.target, eased);
          camera.position.lerpVectors(fly.from, shot.position, eased);
          camera.fov = fly.fromFov + (shot.fov - fly.fromFov) * eased;
          camera.updateProjectionMatrix();
          if (k >= 1) fly = null;
        } else if (shot && !reduce && !dragging && now - draggedAt > SWAY_REST_MS) {
          // Hold the shot's angle while the first blocks land, then sway to either side and a little above.
          const wave = Math.sin((Math.max(0, now - swayStart) / SWAY_PERIOD_MS) * Math.PI * 2);
          offset.copy(camera.position).sub(controls.target);
          spherical.setFromVector3(offset);
          // Follows the wave at the same pace on a slow device as on a fast one.
          const ease = 1 - Math.exp(-elapsed / 700);
          spherical.theta += (SWAY_YAW * swayShare * wave - spherical.theta) * ease;
          spherical.phi += (Math.PI / 2 - SWAY_PITCH * swayShare * wave * wave - spherical.phi) * ease;
          offset.setFromSpherical(spherical);
          camera.position.copy(controls.target).add(offset);
        }
        controls.update();

        idle.visible = !current;
        if (!current) {
          const gap = idleSize * 1.12;
          for (let index = 0; index < IDLE * IDLE; index += 1) {
            const gx = (index % IDLE) - (IDLE - 1) / 2;
            const gz = Math.floor(index / IDLE) - (IDLE - 1) / 2;
            const wave = reduce ? 0 : Math.max(0, Math.sin(now / 260 - (gx + gz) * 0.9));
            dummy.position.set(gx * gap, floor.position.y + idleSize / 2 + wave * idleSize * 1.4, gz * gap);
            dummy.updateMatrix();
            idle.setMatrixAt(index, dummy.matrix);
          }
          idle.instanceMatrix.needsUpdate = true;
        }

        if (plateMaterial) plateMaterial.opacity = reduce ? 1 : Math.min(1, (now - plateBorn) / PLATE_FADE_MS);

        if (pointerIn && blocks.length) {
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects(blocks.filter((block) => block.mesh.visible).map((block) => block.mesh), false)[0];
          hovered = hit ? (blocks.find((block) => block.mesh === hit.object) ?? null) : null;
        }

        let settled = blocks.length > 0;
        for (const block of blocks) {
          const t = (now - block.startAt) / DROP_MS;
          if (t < 1) settled = false;
          if (t <= 0) {
            block.mesh.visible = false;
            continue;
          }
          const k = Math.min(1, t);
          block.mesh.visible = true;
          block.lift += ((block === hovered ? 1 : 0) - block.lift) * Math.min(1, dt / 90);
          block.knock = Math.max(0, block.knock - dt / 800);
          const hop = Math.sin(block.knock * Math.PI) * 0.45;
          const fall = (1 - easeOutBack(k)) * 1.6;
          block.mesh.position.set(block.home.x, block.home.y + fall + block.lift * 0.08 + hop, block.home.z);
          block.mesh.rotation.set(0, block.spin * block.knock * Math.PI * 2, block.turn + (1 - k) * 0.35);
          block.mesh.scale.setScalar(Math.min(1, k * 1.8));
          block.material.color.copy(block.base).lerp(hot, Math.max(block.lift, block.knock));
        }

        // The hovered block's name, floating just above it.
        if (hovered?.name && hovered.mesh.visible) {
          labelBox.setFromObject(hovered.mesh);
          labelAt.set((labelBox.min.x + labelBox.max.x) / 2, labelBox.max.y, (labelBox.min.z + labelBox.max.z) / 2).project(camera);
          const x = (labelAt.x * 0.5 + 0.5) * host!.clientWidth;
          const y = (1 - (labelAt.y * 0.5 + 0.5)) * host!.clientHeight;
          if (label.textContent !== hovered.name) label.textContent = hovered.name;
          label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -140%)`;
          label.dataset.on = "1";
        } else if (label.dataset.on) {
          delete label.dataset.on;
        }

        if (settled && isDone && !finished && !finishTimer) {
          finishTimer = window.setTimeout(() => {
            finishTimer = 0;
            finished = true;
            finishedRef.current?.();
          }, 1200);
        }
        canvas.style.cursor = hovered ? "pointer" : "grab";
        renderer.clear();
        renderer.render(backdrop, camera);
        renderer.clearDepth();
        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(loop);

      liveRef.current = {
        setParts,
        setPlate,
        setDone,
        dispose() {
          disposed = true;
          cancelAnimationFrame(raf);
          clearTimeout(finishTimer);
          observer.disconnect();
          canvas.removeEventListener("pointermove", onMove);
          canvas.removeEventListener("pointerleave", onLeave);
          canvas.removeEventListener("pointerdown", onDown);
          canvas.removeEventListener("pointerup", onUp);
          controls.dispose();
          clearBlocks();
          removePlate();
          idle.geometry.dispose();
          idleMat.dispose();
          renderer.dispose();
          canvas.remove();
          label.remove();
        },
      };
      setPlate(latest.current.plate);
      setParts(latest.current.parts);
      setDone(latest.current.done);
    })();
    return () => {
      cancelled = true;
      liveRef.current?.dispose();
      liveRef.current = null;
    };
  }, []);

  return <div className="block-build" ref={hostRef} />;
}
