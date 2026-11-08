"use client";

import { useEffect, useRef } from "react";
import type { BoxCells } from "@/lib/scene-mesh";

type Props = {
  /** The subject as boxes. Null while the 3D model is still being made. */
  cells: BoxCells | null;
  /** Job progress, 0 to 1. Blocks keep arriving even when this stalls. */
  progress: number;
  /** The video is ready: place the remaining blocks, then call onFinished. */
  done: boolean;
  onFinished?: () => void;
};

type Live = {
  setCells: (cells: BoxCells | null) => void;
  setProgress: (progress: number, done: boolean) => void;
  dispose: () => void;
};

const CLAY = 0xc9cbd1;
const HOT = 0xf2ff59;
const DROP_MS = 420;

/** Where blocks are in time: a slow curve so the build never sits still, sped up by real progress. */
function buildShare(elapsed: number, progress: number, done: boolean): number {
  if (done) return 1;
  const time = 0.9 * (1 - Math.exp(-elapsed / 22000));
  return Math.min(0.96, Math.max(time, progress * 0.96));
}

const easeOutBack = (t: number) => {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

/**
 * The loading screen: the subject's blocks land one by one, bottom up, while the video is made.
 * Drag to orbit, hover a block to lift it, click to knock it.
 */
export function BlockBuild({ cells, progress, done, onFinished }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<Live | null>(null);
  const finishedRef = useRef(onFinished);
  useEffect(() => {
    finishedRef.current = onFinished;
  });
  const latest = useRef({ cells, progress, done });
  useEffect(() => {
    latest.current = { cells, progress, done };
    liveRef.current?.setCells(cells);
    liveRef.current?.setProgress(progress, done);
  }, [cells, progress, done]);

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
      camera.position.set(2.6, 1.5, 3.4);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.enablePan = false;
      controls.minDistance = 2.4;
      controls.maxDistance = 7;
      controls.maxPolarAngle = Math.PI * 0.52;
      controls.autoRotate = !reduce;
      controls.autoRotateSpeed = 0.7;
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

      const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0 });
      // While the 3D model is still being made: a small grid of blocks breathing in a wave.
      const IDLE = 4;
      const idleSize = 0.2;
      const idle = new THREE.InstancedMesh(new RoundedBoxGeometry(idleSize, idleSize, idleSize, 2, idleSize * 0.14), material, IDLE * IDLE);
      idle.castShadow = true;
      for (let index = 0; index < IDLE * IDLE; index += 1) idle.setColorAt(index, new THREE.Color(CLAY));
      scene.add(idle);
      let mesh: InstanceType<typeof THREE.InstancedMesh> | null = null;
      let current: BoxCells | null = null;
      let order: number[] = [];
      /** When each block (by draw slot) started to drop. */
      let landedAt: Float64Array = new Float64Array(0);
      let placed = 0;
      let startedAt = performance.now();
      let lift = new Float32Array(0);
      let knock = new Float32Array(0);
      let hovered = -1;
      let share = 0;
      let isDone = false;
      let finishTimer = 0;
      let finished = false;
      const dummy = new THREE.Object3D();
      const clay = new THREE.Color(CLAY);
      const hot = new THREE.Color(HOT);
      const mixed = new THREE.Color();

      function setCells(next: BoxCells | null) {
        if (next === current) return;
        current = next;
        if (mesh) {
          scene.remove(mesh);
          mesh.geometry.dispose();
          mesh.dispose();
          mesh = null;
        }
        placed = 0;
        finished = false;
        startedAt = performance.now();
        if (!next) return;
        const count = next.layers.length;
        const geometry = new RoundedBoxGeometry(next.size, next.size, next.size, 2, next.size * 0.14);
        mesh = new THREE.InstancedMesh(geometry, material, count);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        order = Array.from({ length: count }, (_, index) => index);
        const jitter = order.map(() => Math.random());
        order.sort((a, b) => next.layers[a] - next.layers[b] || jitter[a] - jitter[b]);
        landedAt = new Float64Array(count).fill(-1);
        lift = new Float32Array(count);
        knock = new Float32Array(count);
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        for (let index = 0; index < count; index += 1) {
          mesh.setMatrixAt(index, dummy.matrix);
          mesh.setColorAt(index, clay);
        }
        floor.position.y = next.floorY;
        scene.add(mesh);
      }

      function setProgress(nextProgress: number, nextDone: boolean) {
        isDone = nextDone;
        share = nextProgress;
      }

      function resize() {
        const width = host!.clientWidth || 1;
        const height = host!.clientHeight || 1;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.fov = width < height ? 44 : 32;
        camera.updateProjectionMatrix();
      }
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(host);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let pointerIn = false;
      let downAt: { x: number; y: number } | null = null;
      const onMove = (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        pointerIn = true;
      };
      const onLeave = () => {
        pointerIn = false;
        hovered = -1;
      };
      const onDown = (event: PointerEvent) => {
        downAt = { x: event.clientX, y: event.clientY };
      };
      const onUp = (event: PointerEvent) => {
        if (!downAt || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 4) return;
        downAt = null;
        if (hovered >= 0) knock[hovered] = 1;
      };
      const canvas = renderer.domElement;
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
            dummy.rotation.set(0, 0, 0);
            dummy.scale.setScalar(1);
            dummy.updateMatrix();
            idle.setMatrixAt(index, dummy.matrix);
          }
          idle.instanceMatrix.needsUpdate = true;
        }
        if (mesh && current) {
          const count = order.length;
          const want = reduce ? (isDone ? count : Math.round(count * buildShare(now - startedAt, share, isDone))) : Math.round(count * buildShare(now - startedAt, share, isDone));
          // Release blocks at a steady pace, faster when far behind.
          const behind = want - placed;
          if (behind > 0) {
            const perFrame = reduce ? behind : Math.max(1, Math.ceil(behind * (isDone ? 0.16 : 0.05)));
            for (let step = 0; step < perFrame && placed < count; step += 1) {
              landedAt[order[placed]] = reduce ? now - DROP_MS : now + step * (dt / perFrame);
              placed += 1;
            }
          }
          if (pointerIn && placed > 0) {
            raycaster.setFromCamera(pointer, camera);
            const hit = raycaster.intersectObject(mesh, false)[0];
            hovered = hit?.instanceId !== undefined && landedAt[hit.instanceId] >= 0 ? hit.instanceId : -1;
          }
          let settled = placed === count;
          for (let index = 0; index < count; index += 1) {
            const start = landedAt[index];
            if (start < 0) continue;
            const t = Math.min(1, Math.max(0, (now - start) / DROP_MS));
            if (t < 1) settled = false;
            const goal = index === hovered ? 1 : 0;
            lift[index] += (goal - lift[index]) * Math.min(1, dt / 90);
            knock[index] = Math.max(0, knock[index] - dt / 700);
            const k = knock[index];
            const hop = Math.sin(k * Math.PI) * current.size * 2.2;
            const fall = (1 - easeOutBack(t)) * current.size * 6;
            const x = current.centers[index * 3];
            const y = current.centers[index * 3 + 1] + fall + lift[index] * current.size * 0.55 + hop;
            const z = current.centers[index * 3 + 2];
            dummy.position.set(x, y, z);
            dummy.rotation.set(0, k * Math.PI * 2, (1 - t) * 0.6);
            dummy.scale.setScalar(Math.min(1, t * 2.2));
            dummy.updateMatrix();
            mesh.setMatrixAt(index, dummy.matrix);
            mixed.copy(clay).lerp(hot, Math.max(lift[index], k));
            mesh.setColorAt(index, mixed);
          }
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
          if (settled && isDone && !finished && !finishTimer) {
            finishTimer = window.setTimeout(() => {
              finishTimer = 0;
              finished = true;
              finishedRef.current?.();
            }, 900);
          }
        }
        renderer.domElement.style.cursor = hovered >= 0 ? "pointer" : "grab";
        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(loop);

      liveRef.current = {
        setCells,
        setProgress,
        dispose() {
          cancelAnimationFrame(raf);
          clearTimeout(finishTimer);
          observer.disconnect();
          canvas.removeEventListener("pointermove", onMove);
          canvas.removeEventListener("pointerleave", onLeave);
          canvas.removeEventListener("pointerdown", onDown);
          canvas.removeEventListener("pointerup", onUp);
          controls.dispose();
          mesh?.geometry.dispose();
          idle.geometry.dispose();
          material.dispose();
          renderer.dispose();
          canvas.remove();
        },
      };
      setCells(latest.current.cells);
      setProgress(latest.current.progress, latest.current.done);
    })();
    return () => {
      cancelled = true;
      liveRef.current?.dispose();
      liveRef.current = null;
    };
  }, []);

  return <div className="block-build" ref={hostRef} />;
}
