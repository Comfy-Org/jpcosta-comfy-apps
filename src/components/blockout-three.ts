import * as THREE from "three";
import { hash, type Shape } from "@/lib/blockout-shapes";

/**
 * The Reverse 3D blockout as a real 3D scene.
 * Every control on the page becomes a clay box at the same place on screen, every line of text a row of raised bars,
 * lit from the top left with soft shadows. A final pass erases the scene in the buckets the cursor has rendered,
 * so the real UI shows through the canvas there.
 */

/** Box height above whatever it sits on, in CSS pixels. */
const HEIGHT: Record<Exclude<Shape["kind"], "bar">, number> = {
  strip: 6,
  slab: 18,
  block: 12,
  well: 1,
  screen: 1,
  media: 2,
  dashed: 0,
};
const BAR_HEIGHT = 3;
const FOV = 40;

type Rect = { x: number; y: number; w: number; h: number; top: number };

export type Blockout = {
  resize(vw: number, vh: number, dpr: number, cols: number, rows: number, cell: number): void;
  setShapes(shapes: Shape[]): void;
  /** heat is one byte per bucket, row by row from the top left. 255 is fully rendered. */
  /** Where the cursor is. The scene tilts around this point, so the blocks under the cursor stay lined up with the page. */
  setPointer(x: number, y: number): void;
  /** Returns true while the camera tilt is still easing, so the caller keeps drawing. */
  render(heat: Uint8Array): boolean;
  dispose(): void;
};

function backdropTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 512;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, "#b4b6ba");
  grad.addColorStop(0.58, "#8e9196");
  grad.addColorStop(1, "#6a6d72");
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A soft dark square used as baked ambient occlusion under each box. */
function aoTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.filter = "blur(14px)";
  g.fillStyle = "#000";
  g.fillRect(28, 28, size - 56, size - 56);
  return new THREE.CanvasTexture(c);
}

export function createBlockout(canvas: HTMLCanvasElement): Blockout {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 10, 10000);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4a4a, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  sun.shadow.radius = 4;
  scene.add(sun);
  scene.add(sun.target);

  // A backdrop well behind the UI, so the card and blocks have something to cast shadows on.
  const backdropMat = new THREE.MeshStandardMaterial({ map: backdropTexture(), roughness: 1 });
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), backdropMat);
  backdrop.receiveShadow = true;
  // Everything tilts together around the cursor: pivot sits at the cursor, world is offset back by the same amount.
  const pivot = new THREE.Group();
  const world = new THREE.Group();
  pivot.add(world);
  scene.add(pivot);
  world.add(backdrop);
  const floorGrid = new THREE.GridHelper(1, 1, 0xffffff, 0xffffff);
  (floorGrid.material as THREE.Material).transparent = true;
  (floorGrid.material as THREE.Material).opacity = 0.12;
  world.add(floorGrid);

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.translate(0, 0, 0.5);
  const unitEdges = new THREE.EdgesGeometry(unitBox);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x1c1c20, transparent: true, opacity: 0.45 });
  const mats = {
    strip: new THREE.MeshStandardMaterial({ color: 0xb9babd, roughness: 0.9 }),
    slab: new THREE.MeshStandardMaterial({ color: 0xc2c3c6, roughness: 0.9 }),
    block: new THREE.MeshStandardMaterial({ color: 0xdcdddf, roughness: 0.8 }),
    run: new THREE.MeshStandardMaterial({ color: 0xeaeaec, roughness: 0.75 }),
    well: new THREE.MeshStandardMaterial({ color: 0x8f9094, roughness: 1 }),
    screen: new THREE.MeshStandardMaterial({ color: 0x54575c, roughness: 1 }),
    media: new THREE.MeshStandardMaterial({ color: 0x6b6e73, roughness: 1 }),
    bar: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
  };
  const screenLineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 });
  const dashMat = new THREE.LineDashedMaterial({ color: 0x1c1c20, dashSize: 5, gapSize: 4, transparent: true, opacity: 0.6 });

  let content = new THREE.Group();
  world.add(content);

  const aoMat = new THREE.MeshBasicMaterial({ color: 0x000000, map: aoTexture(), transparent: true, opacity: 0.38, depthWrite: false });
  const unitPlane = new THREE.PlaneGeometry(1, 1);

  // Tilt state, eased towards its target every frame.
  const tilt = { px: 0, py: 0, rx: 0, ry: 0 };
  const goal = { px: 0, py: 0, rx: 0, ry: 0 };
  let hasPointer = false;
  const aimAt = (x: number, y: number) => {
    goal.px = x;
    goal.py = y;
    // Lean the scene a little towards the cursor, like orbiting a viewport camera.
    goal.ry = (x / Math.max(1, vw) - 0.5) * 0.22 - 0.08;
    goal.rx = (0.5 - y / Math.max(1, vh)) * 0.14 + 0.07;
  };

  // Full-screen pass that erases rendered buckets: dst *= 1 - heat, for colour and alpha alike.
  let heatTex = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat);
  const eraseMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      heat: { value: heatTex },
      dpr: { value: 1 },
      height: { value: 1 },
      cell: { value: 24 },
    },
    vertexShader: "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      precision highp float;
      uniform sampler2D heat;
      uniform float dpr;
      uniform float height;
      uniform float cell;
      out vec4 color;
      void main() {
        vec2 px = vec2(gl_FragCoord.x, height - gl_FragCoord.y) / dpr;
        ivec2 size = textureSize(heat, 0);
        ivec2 c = clamp(ivec2(floor(px / cell)), ivec2(0), size - 1);
        color = vec4(0.0, 0.0, 0.0, texelFetch(heat, c, 0).r);
      }
    `,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
  });
  const eraseScene = new THREE.Scene();
  eraseScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), eraseMat));
  const eraseCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let vw = 1;
  let vh = 1;

  function disposeGroup(group: THREE.Group) {
    group.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) obj.dispose();
      if ((obj instanceof THREE.Line || obj instanceof THREE.LineSegments) && obj.geometry !== unitEdges) obj.geometry.dispose();
    });
  }

  function addBox(group: THREE.Group, r: Rect, height: number, mat: THREE.Material, edges = true, shadow = true, ao = false) {
    const mesh = new THREE.Mesh(unitBox, mat);
    mesh.position.set(r.x + r.w / 2, -(r.y + r.h / 2), r.top);
    mesh.scale.set(r.w, r.h, Math.max(0.5, height));
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    // Baked contact shadow under anything with real height.
    if (ao && height >= 5) {
      const pad = height * 0.5 + 4;
      const shade = new THREE.Mesh(unitPlane, aoMat);
      shade.position.set(r.x + r.w / 2 + height * 0.25, -(r.y + r.h / 2) - height * 0.25, r.top + 0.15);
      shade.scale.set((r.w + pad * 2) / 0.56, (r.h + pad * 2) / 0.56, 1);
      shade.renderOrder = -1;
      group.add(shade);
    }
    if (edges) {
      const line = new THREE.LineSegments(unitEdges, edgeMat);
      line.position.copy(mesh.position);
      line.scale.copy(mesh.scale);
      group.add(line);
    }
  }

  function screenGrid(group: THREE.Group, r: Rect, z: number) {
    const pts: number[] = [];
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    for (let x = cx - Math.floor((cx - r.x) / 32) * 32; x <= r.x + r.w; x += 32) pts.push(x, -r.y, z, x, -(r.y + r.h), z);
    for (let y = cy - Math.floor((cy - r.y) / 32) * 32; y <= r.y + r.h; y += 32) pts.push(r.x, -y, z, r.x + r.w, -y, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    group.add(new THREE.LineSegments(geo, screenLineMat));
  }

  function cross(group: THREE.Group, r: Rect, z: number) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([r.x, -r.y, z, r.x + r.w, -(r.y + r.h), z, r.x + r.w, -r.y, z, r.x, -(r.y + r.h), z], 3),
    );
    group.add(new THREE.LineSegments(geo, screenLineMat));
  }

  function dashed(group: THREE.Group, r: Rect, z: number) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(r.x, -r.y, z),
      new THREE.Vector3(r.x + r.w, -r.y, z),
      new THREE.Vector3(r.x + r.w, -(r.y + r.h), z),
      new THREE.Vector3(r.x, -(r.y + r.h), z),
      new THREE.Vector3(r.x, -r.y, z),
    ]);
    const line = new THREE.Line(geo, dashMat);
    line.computeLineDistances();
    group.add(line);
  }

  return {
    resize(nextW, nextH, dpr, cols, rows, cell) {
      vw = nextW;
      vh = nextH;
      renderer.setPixelRatio(dpr);
      renderer.setSize(vw, vh, false);

      // A camera whose z = 0 plane lines up pixel for pixel with the page.
      const dist = vh / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      camera.aspect = vw / vh;
      camera.position.set(vw / 2, -vh / 2, dist);
      camera.lookAt(vw / 2, -vh / 2, 0);
      camera.near = dist * 0.2;
      camera.far = dist * 3;
      camera.updateProjectionMatrix();

      const back = -60;
      const scale = (dist - back) / dist;
      backdrop.position.set(vw / 2, -vh / 2, back);
      backdrop.scale.set(vw * scale * 1.8, vh * scale * 1.8, 1);
      const size = Math.max(vw, vh) * scale * 1.8;
      floorGrid.scale.set(size, 1, size);
      floorGrid.position.set(vw / 2, -vh / 2, back + 0.5);
      floorGrid.rotation.set(Math.PI / 2, 0, 0);
      const gridMat = floorGrid.material as THREE.LineBasicMaterial;
      gridMat.opacity = 0.1;
      floorGrid.geometry.dispose();
      floorGrid.geometry = new THREE.GridHelper(1, Math.round(size / 64)).geometry;

      sun.position.set(vw * 0.32, -vh * 0.28, dist);
      sun.target.position.set(vw / 2, -vh / 2, 0);
      const cam = sun.shadow.camera;
      const span = Math.max(vw, vh) * 0.9;
      cam.left = -span;
      cam.right = span;
      cam.top = span;
      cam.bottom = -span;
      cam.near = 1;
      cam.far = dist * 3;
      cam.updateProjectionMatrix();

      if (!hasPointer) {
        aimAt(vw / 2, vh / 2);
        Object.assign(tilt, goal);
      }

      heatTex.dispose();
      heatTex = new THREE.DataTexture(new Uint8Array(cols * rows), cols, rows, THREE.RedFormat, THREE.UnsignedByteType);
      heatTex.magFilter = THREE.NearestFilter;
      heatTex.minFilter = THREE.NearestFilter;
      heatTex.needsUpdate = true;
      eraseMat.uniforms.heat.value = heatTex;
      eraseMat.uniforms.dpr.value = dpr;
      eraseMat.uniforms.height.value = Math.round(vh * dpr);
      eraseMat.uniforms.cell.value = cell;
    },

    setShapes(shapes) {
      disposeGroup(content);
      world.remove(content);
      content = new THREE.Group();

      // Stack each shape on the tallest box under its centre, so text sits on its button and buttons on the card.
      const placed: Rect[] = [];
      const baseAt = (x: number, y: number) => {
        let base = 0;
        for (const p of placed) {
          if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) base = Math.max(base, p.top);
        }
        return base;
      };

      const bars: { r: Rect; light: boolean }[] = [];
      for (const s of shapes) {
        const base = baseAt(s.x + s.w / 2, s.y + s.h / 2);
        if (s.kind === "bar") {
          const h = Math.max(4, Math.min(s.h * 0.5, 22));
          const y = s.y + (s.h - h) / 2;
          let x = s.x;
          const end = s.x + s.w;
          const unit = Math.max(16, s.h * 2.4);
          while (x < end) {
            const w = Math.min(end - x, unit * (0.55 + hash(x, s.y) * 0.9));
            bars.push({ r: { x, y, w, h, top: base }, light: s.light });
            x += w + Math.max(4, s.h * 0.35);
          }
          continue;
        }
        const r: Rect = { x: s.x, y: s.y, w: s.w, h: s.h, top: base };
        const height = HEIGHT[s.kind];
        switch (s.kind) {
          case "strip":
            addBox(content, r, height, mats.strip, true, false);
            break;
          case "slab":
            addBox(content, r, height, mats.slab);
            break;
          case "block":
            // Only blocks standing on the card cast shadows. Header blocks would throw them far onto the backdrop.
            addBox(content, r, s.face >= 230 ? height + 6 : height, s.face >= 230 ? mats.run : mats.block, true, base >= 10, true);
            break;
          case "well":
            addBox(content, r, height, mats.well, true, false);
            break;
          case "screen":
            addBox(content, r, height, mats.screen, true, false);
            screenGrid(content, r, base + height + 0.2);
            break;
          case "media":
            addBox(content, r, height, mats.media, false, false);
            cross(content, r, base + height + 0.2);
            break;
          case "dashed":
            dashed(content, r, base + 0.4);
            break;
        }
        if (s.kind !== "dashed") placed.push({ ...r, top: base + (s.kind === "block" && s.face >= 230 ? height + 6 : height) });
      }

      // Text on the card and on buttons casts small shadows. Text on the backdrop or header would only cast far-off smears.
      const dark = new THREE.Color(0x6a6b70);
      const light = new THREE.Color(0xe2e3e6);
      for (const cast of [true, false]) {
        const group = bars.filter((b) => (b.r.top >= 10) === cast);
        if (!group.length) continue;
        const inst = new THREE.InstancedMesh(unitBox, mats.bar, group.length);
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        group.forEach(({ r, light: isLight }, i) => {
          m.compose(new THREE.Vector3(r.x + r.w / 2, -(r.y + r.h / 2), r.top), q, new THREE.Vector3(r.w, r.h, BAR_HEIGHT));
          inst.setMatrixAt(i, m);
          inst.setColorAt(i, isLight ? light : dark);
        });
        inst.castShadow = cast;
        inst.receiveShadow = true;
        content.add(inst);
      }
      world.add(content);
    },

    setPointer(x, y) {
      hasPointer = true;
      aimAt(x, y);
    },

    render(heat) {
      const ease = 0.12;
      let moving = false;
      for (const key of ["px", "py", "rx", "ry"] as const) {
        const d = goal[key] - tilt[key];
        const settle = key === "px" || key === "py" ? 0.5 : 0.0005;
        if (Math.abs(d) > settle) {
          tilt[key] += d * ease;
          moving = true;
        } else {
          tilt[key] = goal[key];
        }
      }
      pivot.position.set(tilt.px, -tilt.py, 0);
      pivot.rotation.set(tilt.rx, tilt.ry, 0, "YXZ");
      world.position.set(-tilt.px, tilt.py, 0);

      (heatTex.image.data as Uint8Array).set(heat.subarray(0, heatTex.image.data!.length));
      heatTex.needsUpdate = true;
      renderer.clear();
      renderer.render(scene, camera);
      renderer.render(eraseScene, eraseCam);
      return moving;
    },

    dispose() {
      disposeGroup(content);
      unitBox.dispose();
      unitPlane.dispose();
      aoMat.map?.dispose();
      unitEdges.dispose();
      heatTex.dispose();
      backdropMat.map?.dispose();
      for (const mat of [...Object.values(mats), edgeMat, screenLineMat, dashMat, eraseMat, backdropMat, aoMat]) mat.dispose();
      renderer.dispose();
    },
  };
}
