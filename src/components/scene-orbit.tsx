"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  buildBoxMesh,
  mat3FromMat4,
  orbitFromDrag,
  SCENE_DEFAULT_PITCH,
  SCENE_DEFAULT_YAW,
  sceneMvp,
  sceneViewMatrix,
  type SceneMesh,
} from "@/lib/scene-mesh";

export type SceneOrbitHandle = {
  /** PNG of the mesh as it is on screen, including the current orbit and polygon count. */
  capture: () => Promise<Blob>;
};

type Props = {
  positions: Float32Array;
  indices: Uint32Array;
  polygons: number;
  onPolygonCount?: (count: number) => void;
};

type GlState = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  pos: WebGLBuffer;
  nor: WebGLBuffer;
  col: WebGLBuffer;
  idx: WebGLBuffer;
  uMvp: WebGLUniformLocation;
  uNormal: WebGLUniformLocation;
  lineProgram: WebGLProgram;
  linePos: WebGLBuffer;
  lineMvp: WebGLUniformLocation;
};

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uMvp;
uniform mat3 uNormal;
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  vNormal = uNormal * aNormal;
  vColor = aColor;
  gl_Position = uMvp * vec4(aPos, 1.0);
}
`;

const FRAG = `
precision mediump float;
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 key = normalize(vec3(0.32, 0.78, 0.48));
  vec3 fill = normalize(vec3(-0.55, 0.25, 0.35));
  float shade = clamp(0.52 + 0.55 * max(dot(n, key), 0.0) + 0.08 * max(dot(n, fill), 0.0), 0.0, 1.05);
  gl_FragColor = vec4(vColor * shade, 1.0);
}
`;

const LINE_VERT = `
attribute vec3 aPos;
uniform mat4 uMvp;
void main() {
  gl_Position = uMvp * vec4(aPos, 1.0);
}
`;

const LINE_FRAG = `
precision mediump float;
void main() {
  gl_FragColor = vec4(0.45, 0.46, 0.49, 1.0);
}
`;

function floorPositions(floorY: number): Float32Array {
  const y = floorY - 0.015;
  const extent = 2.2;
  const step = 0.28;
  const coords: number[] = [];
  for (let x = -extent; x <= extent + 0.001; x += step) {
    coords.push(x, y, -extent, x, y, extent);
  }
  for (let z = -extent; z <= extent + 0.001; z += step) {
    coords.push(-extent, y, z, extent, y, z);
  }
  return new Float32Array(coords);
}

function shader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const item = gl.createShader(type);
  if (!item) throw new Error("Could not show the 3D scene.");
  gl.shaderSource(item, source);
  gl.compileShader(item);
  if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(item) || "Could not show the 3D scene.";
    gl.deleteShader(item);
    throw new Error(message);
  }
  return item;
}

function createGl(canvas: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  const program = gl.createProgram();
  if (!program) return null;
  const vs = shader(gl, gl.VERTEX_SHADER, VERT);
  const fs = shader(gl, gl.FRAGMENT_SHADER, FRAG);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "aPos");
  gl.bindAttribLocation(program, 1, "aNormal");
  gl.bindAttribLocation(program, 2, "aColor");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const lineProgram = gl.createProgram();
  if (!lineProgram) return null;
  const lineVs = shader(gl, gl.VERTEX_SHADER, LINE_VERT);
  const lineFs = shader(gl, gl.FRAGMENT_SHADER, LINE_FRAG);
  gl.attachShader(lineProgram, lineVs);
  gl.attachShader(lineProgram, lineFs);
  gl.bindAttribLocation(lineProgram, 0, "aPos");
  gl.linkProgram(lineProgram);
  gl.deleteShader(lineVs);
  gl.deleteShader(lineFs);
  if (!gl.getProgramParameter(lineProgram, gl.LINK_STATUS)) return null;
  const pos = gl.createBuffer();
  const nor = gl.createBuffer();
  const col = gl.createBuffer();
  const idx = gl.createBuffer();
  const linePos = gl.createBuffer();
  const uMvp = gl.getUniformLocation(program, "uMvp");
  const uNormal = gl.getUniformLocation(program, "uNormal");
  const lineMvp = gl.getUniformLocation(lineProgram, "uMvp");
  if (!pos || !nor || !col || !idx || !linePos || !uMvp || !uNormal || !lineMvp) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, pos);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, nor);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, col);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
  return { gl, program, pos, nor, col, idx, uMvp, uNormal, lineProgram, linePos, lineMvp };
}

function uploadMesh(gls: GlState, mesh: SceneMesh) {
  const { gl } = gls;
  gl.bindBuffer(gl.ARRAY_BUFFER, gls.pos);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, gls.nor);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, gls.col);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gls.idx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
}

function fitCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let width = Math.max(2, Math.round((rect.width || 640) * dpr));
  let height = Math.max(2, Math.round((rect.height || 360) * dpr));
  const long = Math.max(width, height);
  if (long > 960) {
    const scale = 960 / long;
    width = Math.max(2, Math.round(width * scale));
    height = Math.max(2, Math.round(height * scale));
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

export const SceneOrbit = forwardRef<SceneOrbitHandle, Props>(function SceneOrbit(
  { positions, indices, polygons, onPolygonCount },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<GlState | null>(null);
  const meshRef = useRef<SceneMesh | null>(null);
  const indexCount = useRef(0);
  const yaw = useRef(SCENE_DEFAULT_YAW);
  const pitch = useRef(SCENE_DEFAULT_PITCH);
  const floorRef = useRef<Float32Array>(floorPositions(-0.8));
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const onCountRef = useRef(onPolygonCount);
  onCountRef.current = onPolygonCount;

  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const canvas = canvasRef.current;
    const gls = glRef.current;
    const mesh = meshRef.current;
    if (!canvas || !gls || !mesh || indexCount.current <= 0) return;
    fitCanvas(canvas);
    const { gl } = gls;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.165, 0.165, 0.176, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    const mvp = sceneMvp(yaw.current, pitch.current, canvas.width / canvas.height);
    gl.useProgram(gls.program);
    gl.uniformMatrix4fv(gls.uMvp, false, mvp);
    gl.uniformMatrix3fv(gls.uNormal, false, mat3FromMat4(sceneViewMatrix(yaw.current, pitch.current)));
    gl.bindBuffer(gl.ARRAY_BUFFER, gls.pos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, gls.nor);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, gls.col);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gls.idx);
    gl.drawElements(gl.TRIANGLES, indexCount.current, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(gls.lineProgram);
    gl.uniformMatrix4fv(gls.lineMvp, false, mvp);
    gl.bindBuffer(gl.ARRAY_BUFFER, gls.linePos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    gl.disableVertexAttribArray(2);
    gl.drawArrays(gl.LINES, 0, floorRef.current.length / 3);
  };

  useImperativeHandle(ref, () => ({
    capture() {
      const canvas = canvasRef.current;
      const gl = glRef.current?.gl;
      if (!canvas || !gl || !meshRef.current) return Promise.reject(new Error("The 3D scene is not ready yet."));
      drawRef.current();
      const w = canvas.width;
      const h = canvas.height;
      if (w < 2 || h < 2) return Promise.reject(new Error("The 3D scene is not ready yet."));
      const frame = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      const copy = document.createElement("canvas");
      copy.width = w;
      copy.height = h;
      const ctx = copy.getContext("2d");
      if (!ctx) return Promise.reject(new Error("Could not read the 3D scene."));
      const image = ctx.createImageData(w, h);
      const row = w * 4;
      for (let y = 0; y < h; y += 1) {
        image.data.set(frame.subarray((h - 1 - y) * row, (h - y) * row), y * row);
      }
      ctx.putImageData(image, 0, 0);
      return new Promise((resolve, reject) => {
        copy.toBlob((blob) => {
          if (!blob) reject(new Error("Could not read the 3D scene."));
          else resolve(blob);
        }, "image/png");
      });
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let gls: GlState | null = null;
    try {
      gls = createGl(canvas);
    } catch {
      gls = null;
    }
    if (!gls) return;
    glRef.current = gls;
    if (meshRef.current) uploadMesh(gls, meshRef.current);
    gls.gl.bindBuffer(gls.gl.ARRAY_BUFFER, gls.linePos);
    gls.gl.bufferData(gls.gl.ARRAY_BUFFER, floorRef.current, gls.gl.DYNAMIC_DRAW);
    const observer = new ResizeObserver(() => drawRef.current());
    observer.observe(canvas);
    drawRef.current();
    return () => {
      observer.disconnect();
      glRef.current = null;
    };
  }, []);

  useEffect(() => {
    const mesh = buildBoxMesh(positions, indices, polygons);
    meshRef.current = mesh;
    indexCount.current = mesh.indices.length;
    floorRef.current = floorPositions(mesh.floorY);
    const lines = glRef.current;
    if (lines) {
      lines.gl.bindBuffer(lines.gl.ARRAY_BUFFER, lines.linePos);
      lines.gl.bufferData(lines.gl.ARRAY_BUFFER, floorRef.current, lines.gl.DYNAMIC_DRAW);
    }
    const gls = glRef.current;
    if (gls) uploadMesh(gls, mesh);
    onCountRef.current?.(mesh.polygonCount);
    drawRef.current();
  }, [positions, indices, polygons]);

  return (
    <canvas
      ref={canvasRef}
      className="scene-orbit"
      aria-label="3D subject. Drag to orbit."
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, yaw: yaw.current, pitch: pitch.current };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const next = orbitFromDrag(start.yaw, start.pitch, event.clientX - start.x, event.clientY - start.y);
        yaw.current = next.yaw;
        pitch.current = next.pitch;
        drawRef.current();
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    />
  );
});
