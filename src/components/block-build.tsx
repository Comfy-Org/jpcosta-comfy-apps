"use client";

import { useEffect, useRef } from "react";
import type { PartBoxes } from "@/lib/scene-mesh";

type Props = {
  /** The subject as a few big blocks. Null while the 3D model is still being made. */
  parts: PartBoxes | null;
  /** The video is ready: once every block has landed, call onFinished. */
  done: boolean;
  onFinished?: () => void;
};

type Live = {
  setParts: (parts: PartBoxes | null) => void;
  setDone: (done: boolean) => void;
  dispose: () => void;
};

const CLAY = 0xc9cbd1;
/** Things around the subject, a shade darker so the subject reads first. */
const PROP_CLAY = 0xa6aab4;
const HOT = 0xf2ff59;
/** Time between two blocks landing. */
const GAP_MS = 650;
const DROP_MS = 560;

const easeOutBack = (t: number) => {
  const c = 1.7;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

/**
 * The loading screen: while the video renders, the subject is assembled from big blocks
 * (body, head, arms…) dropping in one by one. Drag to orbit, hover a block to lift it and see its name, click to knock it.
 */
export function BlockBuild({ parts, done, onFinished }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<Live | null>(null);
  const finishedRef = useRef(onFinished);
  const latest = useRef({ parts, done });
  useEffect(() => {
    finishedRef.current = onFinished;
  });
  useEffect(() => {
    latest.current = { parts, done };
    liveRef.current?.setParts(parts);
    liveRef.current?.setDone(done);
  }, [parts, done]);

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
      const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
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
      sun.shadow.camera.left = -2;
      sun.shadow.camera.right = 2;
      sun.shadow.camera.top = 2;
      sun.shadow.camera.bottom = -2;
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

      // While the 3D model is still being made: a small grid of blocks breathing in a wave.
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
        height: number;
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
      const clay = new THREE.Color(CLAY);
      const propClay = new THREE.Color(PROP_CLAY);
      const hot = new THREE.Color(HOT);
      const dummy = new THREE.Object3D();
      const label = document.createElement("span");
      label.className = "block-build-label";
      label.setAttribute("aria-hidden", "true");
      host.appendChild(label);
      const labelAt = new THREE.Vector3();

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
        if (!next) return;
        const now = performance.now();
        // Bottom up, and the bigger block first when two start at the same height.
        const order = next.boxes
          .map((box, index) => ({ box, index, bottom: box.center[1] - box.size[1] / 2, volume: box.size[0] * box.size[1] * box.size[2] }))
          .sort((a, b) => a.bottom - b.bottom || b.volume - a.volume);
        order.forEach(({ box }, slot) => {
          const [w, h, d] = box.size;
          const gap = Math.min(w, h, d) * 0.03;
          const radius = Math.min(w, h, d) * 0.12;
          const base = box.kind === "prop" ? propClay : clay;
          const material = new THREE.MeshStandardMaterial({ color: base, roughness: 0.8 });
          const mesh = new THREE.Mesh(new RoundedBoxGeometry(w - gap, h - gap, d - gap, 3, radius), material);
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
            height: h,
            startAt: reduce ? now - DROP_MS : now + 250 + slot * GAP_MS,
            lift: 0,
            knock: 0,
            spin: 0,
          });
        });
        floor.position.y = next.floorY;
        // Frame the whole layout: a lone figure stays close, a figure with a wall behind it pulls back.
        let radius = 0;
        for (const box of next.boxes) {
          const [x, y, z] = box.center;
          const [w, h, d] = box.size;
          radius = Math.max(radius, Math.hypot(Math.abs(x) + w / 2, Math.abs(y) + h / 2, Math.abs(z) + d / 2));
        }
        fit = radius || 0.9;
        frame();
      }

      /** Distance at which a sphere of radius `fit` fills the view, measured along the narrower side. */
      let fit = 0.9;
      const viewDir = new THREE.Vector3(2.6, 1.45, 3.4).normalize();
      function frame() {
        const half = THREE.MathUtils.degToRad(camera.fov / 2);
        const narrow = Math.min(half, Math.atan(Math.tan(half) * camera.aspect));
        const distance = Math.min(9, Math.max(3.8, (fit / Math.sin(narrow)) * 0.9));
        const offset = camera.position.clone().sub(controls.target);
        const dir = offset.lengthSq() > 0 ? offset.normalize() : viewDir.clone();
        // Aim a little low so the blocks sit above the status card.
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
        camera.fov = width < height ? 44 : 32;
        camera.updateProjectionMatrix();
        frame();
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
        const dt = Math.min(64, now - last);
        last = now;
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
          block.mesh.rotation.set(0, block.spin * block.knock * Math.PI * 2, (1 - k) * 0.35);
          block.mesh.scale.setScalar(Math.min(1, k * 1.8));
          block.material.color.copy(block.base).lerp(hot, Math.max(block.lift, block.knock));
        }

        // The hovered block's name, floating just above it.
        if (hovered?.name && hovered.mesh.visible) {
          labelAt.set(hovered.mesh.position.x, hovered.mesh.position.y + hovered.height / 2, hovered.mesh.position.z).project(camera);
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
        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(loop);

      liveRef.current = {
        setParts,
        setDone,
        dispose() {
          cancelAnimationFrame(raf);
          clearTimeout(finishTimer);
          observer.disconnect();
          canvas.removeEventListener("pointermove", onMove);
          canvas.removeEventListener("pointerleave", onLeave);
          canvas.removeEventListener("pointerdown", onDown);
          canvas.removeEventListener("pointerup", onUp);
          controls.dispose();
          clearBlocks();
          idle.geometry.dispose();
          idleMat.dispose();
          renderer.dispose();
          canvas.remove();
          label.remove();
        },
      };
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
