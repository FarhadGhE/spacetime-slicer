'use strict';
/*
  Spacetime Slicer
  A video becomes a block of points: x = column, y = row, z = time (one layer per sampled frame).
  Left: the block in 3D with three planes you can slide. Right: the points on the active plane.
  XY is a single frame (sliding it through z plays the video), XZ is one row of pixels over time,
  ZY is one column of pixels over time (a slit-scan).
*/
(() => {
  const MAX_SECONDS = 60;
  const QUALITY = {  // longest frame side in points, most frames sampled, most points drawn for the 3D block
    fast: { long: 112, frames: 180, cloud: 900000 },
    balanced: { long: 160, frames: 300, cloud: 1800000 },
    detailed: { long: 224, frames: 450, cloud: 3200000 },
  };
  const UV_AXES = [[2, 1], [0, 2], [0, 1]];  // plane k in the slice view: [horizontal axis, vertical axis]
  const AXIS_NAMES = ['x · column', 'y · row', 'z · time'];
  const AXIS_TOKENS = ['--x', '--y', '--z'];
  const EXPLAIN = [
    'One column of pixels unrolled across time, like a photo-finish camera. Whatever passes the column gets painted in.',
    'One row of pixels stacked through time. Anything moving across the row smears into streaks and curves.',
    'A single frame of the video. Slide this plane through z (time) and the video plays.',
  ];
  const RAIL_GAP = 0.14;                     // how far the handle rails sit outside the block
  const BOX_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const ICON_PLAY = '<svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><path d="M2 1.6v12.8a.9.9 0 0 0 1.36.77l10.2-6.4a.9.9 0 0 0 0-1.54L3.36.83A.9.9 0 0 0 2 1.6z" fill="currentColor"/></svg>';
  const ICON_PAUSE = '<svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true"><rect x="1.5" y="1" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="8.5" y="1" width="4" height="14" rx="1.2" fill="currentColor"/></svg>';

  const $ = (sel) => document.querySelector(sel);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const tokens = getComputedStyle(document.documentElement);
  const tokenRGB = (name) => {
    const hex = tokens.getPropertyValue(name).trim().replace('#', '');
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  };
  const AXIS_RGB = AXIS_TOKENS.map(tokenRGB);
  const PANEL_RGB = tokenRGB('--panel');
  const WHITE = [1, 1, 1];

  const state = {
    vol: null,       // { W, H, T, dims, half, grid, cloudSpacing, duration, loaded, name }
    pos: [0, 0, 0],  // slice index along x (column), y (row), z (frame)
    active: 2,       // plane shown in the slice view: 2 = XY, 1 = XZ, 0 = ZY
    mode: 'cut',
    pointScale: 1,
    playing: false,
    speed: 1,
    source: null,    // what to sample again when the detail setting changes
  };

  // ---------- matrices (column-major, like WebGL) ----------
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  function lookAt(e, t, u) {
    let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
    let l = Math.hypot(zx, zy, zz);
    zx /= l; zy /= l; zz /= l;
    let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx;
    l = Math.hypot(xx, xy, xz);
    xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([
      xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1,
    ]);
  }
  function multiply(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }
  // world point -> CSS pixels in a w × h view
  function project(m, p, w, h) {
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const q = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [(x / q * 0.5 + 0.5) * w, (0.5 - y / q * 0.5) * h];
  }

  // ---------- block geometry ----------
  // World coordinate of slice index i along axis k: x runs left to right, row 0 is the top, frame 0 is the front face.
  function worldCoord(vol, k, i) {
    const h = vol.half[k], n = i / Math.max(vol.dims[k] - 1, 1);
    return k === 0 ? -h + 2 * h * n : h - 2 * h * n;
  }
  function spacing(vol, k) {
    return (2 * vol.half[k]) / Math.max(vol.dims[k] - 1, 1);
  }
  function planeCorners(half, k, w) {
    const [a, b, c] = half;
    if (k === 0) return [[w, -b, -c], [w, b, -c], [w, b, c], [w, -b, c]];
    if (k === 1) return [[-a, w, -c], [a, w, -c], [a, w, c], [-a, w, c]];
    return [[-a, -b, w], [a, -b, w], [a, b, w], [-a, b, w]];
  }
  // Each plane's handle rides a rail just outside the block, near the front-bottom-right corner.
  function railPoint(half, k, w) {
    const [a, b, c] = half, m = RAIL_GAP;
    if (k === 0) return [w, -b - m, c + m];
    if (k === 1) return [a + m, w, c + m];
    return [a + m, -b - m, w];
  }
  function planeAnchor(half, k, w) {
    const [a, b, c] = half;
    if (k === 0) return [w, -b, c];
    if (k === 1) return [a, w, c];
    return [a, -b, w];
  }
  function makeVolume(W, H, T, duration, name, cloudBudget) {
    const long = Math.max(W, H);
    const half = [W / long, H / long, 1];  // time is as deep as the frame is wide (or tall)
    const f = Math.min(1, Math.cbrt(cloudBudget / (W * H * T)));
    const grid = [W, H, T].map((d) => Math.max(2, Math.round(d * f)));
    const cloudSpacing = Math.max((2 * half[0]) / (grid[0] - 1), (2 * half[1]) / (grid[1] - 1));
    return { W, H, T, dims: [W, H, T], half, grid, cloudSpacing, duration, loaded: 0, name };
  }

  // ---------- shaders ----------
  const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
`;
  const VOLUME = `
uniform sampler3D uVol;
uniform ivec3 uDim;   // columns, rows, frames
uniform vec3 uHalf;   // half size of the block in world units
uniform int uLoaded;  // frames sampled so far
// x runs left to right, row 0 is the top, frame 0 is the front face
vec3 toWorld(ivec3 v) {
  vec3 n = vec3(v) / vec3(max(uDim - 1, ivec3(1)));
  return vec3(mix(-uHalf.x, uHalf.x, n.x), mix(uHalf.y, -uHalf.y, n.y), mix(uHalf.z, -uHalf.z, n.z));
}
// Voxel for slot 'id' of the slice through plane 'axis' at 'index'; slots run along u first, then v.
ivec3 sliceVoxel(int axis, int index, int id) {
  if (axis == 2) return ivec3(id % uDim.x, id / uDim.x, index);  // XY: u = x, v = y
  if (axis == 1) return ivec3(id % uDim.x, index, id / uDim.x);  // XZ: u = x, v = z
  return ivec3(index, id / uDim.z, id % uDim.z);                 // ZY: u = z, v = y
}
`;
  const CLOUD_VS = HEAD + VOLUME + `
uniform ivec3 uGrid;
uniform mat4 uMVP;
uniform float uSize;
uniform int uAxis;
uniform float uCut;
uniform float uSide;  // +1 hides points past the cut, -1 hides points before it, 0 keeps all
uniform float uAlpha;
out vec4 vColor;
void main() {
  int id = gl_VertexID;
  ivec3 g = ivec3(id % uGrid.x, (id / uGrid.x) % uGrid.y, id / (uGrid.x * uGrid.y));
  ivec3 span = max(uGrid - 1, ivec3(1));
  ivec3 v = (g * (uDim - 1) * 2 + span) / (span * 2);  // nearest voxel to this grid point
  vec3 p = toWorld(v);
  vec4 clip = uMVP * vec4(p, 1.0);
  bool hidden = v.z >= uLoaded || uSide * (p[uAxis] - uCut) > 1e-4;
  gl_Position = hidden ? vec4(0.0, 0.0, 2.0, 1.0) : clip;
  gl_PointSize = hidden ? 0.0 : clamp(uSize / clip.w, 1.0, 48.0);
  vColor = vec4(texelFetch(uVol, v, 0).rgb, uAlpha);
}`;
  const SLICE_VS = HEAD + VOLUME + `
uniform int uSliceAxis;
uniform int uIndex;
uniform mat4 uMVP;
uniform float uSize;
out vec4 vColor;
void main() {
  ivec3 v = sliceVoxel(uSliceAxis, uIndex, gl_VertexID);
  vec4 clip = uMVP * vec4(toWorld(v), 1.0);
  bool hidden = v.z >= uLoaded;
  gl_Position = hidden ? vec4(0.0, 0.0, 2.0, 1.0) : clip;
  gl_PointSize = hidden ? 0.0 : clamp(uSize / clip.w, 1.0, 48.0);
  vColor = vec4(texelFetch(uVol, v, 0).rgb, 1.0);
}`;
  const POINT_FS = HEAD + `
in vec4 vColor;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  outColor = vColor;
}`;
  const FLAT_VS = HEAD + VOLUME + `
uniform int uSliceAxis;
uniform int uIndex;
uniform ivec2 uGridUV;
uniform vec4 uRect;  // left, bottom, width, height in clip space
uniform vec2 uDot;   // dot diameter in pixels along u and v
uniform bool uVUp;   // v grows upward (time in XZ) instead of downward (rows)
out vec4 vColor;
void main() {
  int id = gl_VertexID;
  ivec3 v = sliceVoxel(uSliceAxis, uIndex, id);
  vec2 c = (vec2(ivec2(id % uGridUV.x, id / uGridUV.x)) + 0.5) / vec2(uGridUV);
  if (!uVUp) c.y = 1.0 - c.y;
  gl_Position = vec4(uRect.xy + c * uRect.zw, 0.0, 1.0);
  gl_PointSize = max(uDot.x, uDot.y);
  vColor = v.z < uLoaded ? vec4(texelFetch(uVol, v, 0).rgb, 1.0) : vec4(0.0);
}`;
  const FLAT_FS = HEAD + `
uniform vec2 uDot;
in vec4 vColor;
out vec4 outColor;
void main() {
  vec2 d = (gl_PointCoord - 0.5) * 2.0 * max(uDot.x, uDot.y) / uDot;  // length 1.0 on the dot's edge
  float r = length(d);
  float aa = fwidth(r);
  float a = vColor.a * (1.0 - smoothstep(1.0 - aa, 1.0, r));
  if (a < 0.02) discard;
  outColor = vec4(vColor.rgb, a);
}`;
  const OVERLAY_VS = HEAD + `
in vec3 aPos;
in vec4 aColor;
in vec2 aSizeKind;
uniform mat4 uMVP;
out vec4 vColor;
out float vKind;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
  gl_PointSize = aSizeKind.x;
  vColor = aColor;
  vKind = aSizeKind.y;
}`;
  const OVERLAY_FS = HEAD + `
in vec4 vColor;
in float vKind;
out vec4 outColor;
void main() {
  float r = length(gl_PointCoord * 2.0 - 1.0);
  float aa = max(fwidth(r), 0.02);
  vec3 col = vColor.rgb;
  if (vKind > 0.5) {  // handle: coloured core, light ring, dark rim
    col = mix(col, vec3(1.0), smoothstep(0.56 - aa, 0.56 + aa, r));
    col = mix(col, vec3(0.03, 0.04, 0.07), smoothstep(0.84 - aa, 0.84 + aa, r));
  }
  float a = vColor.a * (1.0 - smoothstep(1.0 - aa, 1.0, r));
  if (a < 0.01) discard;
  outColor = vec4(col, a);
}`;

  function createProgram(gl, vsSource, fsSource) {
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vsSource], [gl.FRAGMENT_SHADER, fsSource]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const locations = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const { name } = gl.getActiveUniform(program, i);
      locations[name] = gl.getUniformLocation(program, name);
    }
    // uniforms the compiler dropped come back as null, which WebGL ignores
    return { program, u: new Proxy(locations, { get: (t, name) => t[name] ?? null }) };
  }

  // Screen-sized dots for guides, rails, handles and crosshairs.
  class Overlay {
    constructor(gl) {
      this.gl = gl;
      this.p = createProgram(gl, OVERLAY_VS, OVERLAY_FS);
      this.vao = gl.createVertexArray();
      this.buffer = gl.createBuffer();
      this.data = [];
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      for (const [name, size, offset] of [['aPos', 3, 0], ['aColor', 4, 12], ['aSizeKind', 2, 28]]) {
        const loc = gl.getAttribLocation(this.p.program, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 36, offset);
      }
      gl.bindVertexArray(null);
    }
    clear() { this.data.length = 0; }
    point(p, rgb, alpha, size, kind = 0) {
      this.data.push(p[0], p[1], p[2], rgb[0], rgb[1], rgb[2], alpha, size, kind);
    }
    line(p0, p1, rgb, alpha, size, step) {
      const n = Math.max(1, Math.round(Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / step));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        this.point([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t], rgb, alpha, size);
      }
    }
    draw(mvp) {
      if (!this.data.length) return;
      const gl = this.gl;
      gl.useProgram(this.p.program);
      gl.uniformMatrix4fv(this.p.u.uMVP, false, mvp);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this.data), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, this.data.length / 9);
      gl.bindVertexArray(null);
    }
  }

  // One WebGL2 canvas holding its own copy of the video volume as a 3D texture.
  class GLView {
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('This browser has no WebGL2, which the point cloud needs. Try a recent Chrome, Edge, Firefox or Safari.');
      this.canvas = canvas;
      this.gl = gl;
      this.vao = gl.createVertexArray();  // the volume shaders read no attributes
      this.overlay = new Overlay(gl);
      this.texture = null;
      this.dirty = true;
      new ResizeObserver(() => { this.dirty = true; }).observe(canvas);
    }
    setVolume(vol) {
      const gl = this.gl;
      if (this.texture) gl.deleteTexture(this.texture);
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, this.texture);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, vol.W, vol.H, vol.T);
      this.dirty = true;
    }
    addFrame(vol, t, rgba) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_3D, this.texture);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, t, vol.W, vol.H, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      this.dirty = true;
    }
    begin() {
      const c = this.canvas, gl = this.gl;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.cssWidth = Math.max(1, c.clientWidth);
      this.cssHeight = Math.max(1, c.clientHeight);
      const w = Math.round(this.cssWidth * dpr), h = Math.round(this.cssHeight * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      this.dpr = dpr;
      this.width = w;
      this.height = h;
      gl.viewport(0, 0, w, h);
      gl.clearColor(PANEL_RGB[0], PANEL_RGB[1], PANEL_RGB[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    useVolume(p, vol) {
      const gl = this.gl;
      gl.useProgram(p.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, this.texture);
      gl.uniform1i(p.u.uVol, 0);
      gl.uniform3i(p.u.uDim, vol.W, vol.H, vol.T);
      gl.uniform3f(p.u.uHalf, vol.half[0], vol.half[1], vol.half[2]);
      gl.uniform1i(p.u.uLoaded, vol.loaded);
    }
  }

  // ---------- left: the block in 3D ----------
  class CubeView extends GLView {
    constructor(canvas, labels) {
      super(canvas);
      this.cloud = createProgram(this.gl, CLOUD_VS, POINT_FS);
      this.slice = createProgram(this.gl, SLICE_VS, POINT_FS);
      this.labels = labels;
      this.cam = { yaw: 0.62, pitch: 0.42, zoom: 1, vYaw: 0, vPitch: 0 };
      this.handles = [];  // CSS px of each plane's handle, by axis
      this.rails = [];    // CSS px of each rail's two ends, by axis
      this.hover = -1;
      this.grabbed = -1;
      this.orbiting = false;
      this.listen();
    }
    resetView() {
      Object.assign(this.cam, { yaw: 0.62, pitch: 0.42, zoom: 1, vYaw: 0, vPitch: 0 });
      this.dirty = true;
    }
    rotate(dYaw, dPitch) {
      this.cam.yaw += dYaw;
      this.cam.pitch = clamp(this.cam.pitch + dPitch, -1.45, 1.45);
      this.dirty = true;
    }
    zoomTo(z) {
      this.cam.zoom = clamp(z, 0.45, 3);
      this.dirty = true;
    }
    tick() {  // orbit inertia after a flick
      const c = this.cam;
      if (this.orbiting || (Math.abs(c.vYaw) < 1e-4 && Math.abs(c.vPitch) < 1e-4)) return;
      this.rotate(c.vYaw, c.vPitch);
      c.vYaw *= 0.9;
      c.vPitch *= 0.9;
    }
    camera(half) {
      const fov = (34 * Math.PI) / 180;
      const aspect = this.width / this.height;
      const radius = Math.hypot(half[0] + RAIL_GAP, half[1] + RAIL_GAP, half[2] + RAIL_GAP);
      const fit = aspect >= 1 ? fov : 2 * Math.atan(Math.tan(fov / 2) * aspect);
      const dist = (radius / Math.sin(fit / 2)) * 0.9 * this.cam.zoom;
      const { yaw, pitch } = this.cam;
      const eye = [dist * Math.cos(pitch) * Math.sin(yaw), dist * Math.sin(pitch), dist * Math.cos(pitch) * Math.cos(yaw)];
      const mvp = multiply(perspective(fov, aspect, dist * 0.02, dist * 4), lookAt(eye, [0, 0, 0], [0, 1, 0]));
      return { mvp, eye, focal: this.height / (2 * Math.tan(fov / 2)) };
    }
    render() {
      this.begin();
      const vol = state.vol;
      const half = vol ? vol.half : [1, 0.5625, 1];
      const { mvp, eye, focal } = this.camera(half);
      if (vol && this.texture) this.drawVolume(vol, mvp, eye, focal);
      this.drawGuides(vol, half, mvp);
    }
    drawVolume(vol, mvp, eye, focal) {
      const gl = this.gl, k = state.active;
      const ghost = state.mode === 'ghost';
      const sampling = vol.loaded < vol.T;
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.bindVertexArray(this.vao);

      // Full-resolution slices: the active plane on the cut face, or all three planes in ghost mode.
      const sp = this.slice;
      this.useVolume(sp, vol);
      gl.uniformMatrix4fv(sp.u.uMVP, false, mvp);
      const planes = ghost ? [0, 1, 2] : sampling ? [] : [k];
      for (const a of planes) {
        const [u, v] = UV_AXES[a];
        gl.uniform1i(sp.u.uSliceAxis, a);
        gl.uniform1i(sp.u.uIndex, state.pos[a]);
        gl.uniform1f(sp.u.uSize, Math.max(spacing(vol, u), spacing(vol, v)) * focal * state.pointScale);
        gl.drawArrays(gl.POINTS, 0, vol.dims[u] * vol.dims[v]);
      }

      // The block itself, cut away between the camera and the active plane.
      const cp = this.cloud;
      const cut = worldCoord(vol, k, state.pos[k]);
      this.useVolume(cp, vol);
      gl.uniformMatrix4fv(cp.u.uMVP, false, mvp);
      gl.uniform3i(cp.u.uGrid, vol.grid[0], vol.grid[1], vol.grid[2]);
      gl.uniform1i(cp.u.uAxis, k);
      gl.uniform1f(cp.u.uCut, cut);
      gl.uniform1f(cp.u.uSide, ghost || sampling ? 0 : eye[k] >= cut ? 1 : -1);
      gl.uniform1f(cp.u.uAlpha, ghost ? 0.05 : 1);
      gl.uniform1f(cp.u.uSize, vol.cloudSpacing * focal * state.pointScale * (ghost ? 0.8 : 1));
      if (ghost) gl.depthMask(false);
      gl.drawArrays(gl.POINTS, 0, vol.grid[0] * vol.grid[1] * vol.grid[2]);
      gl.depthMask(true);
      gl.bindVertexArray(null);
      gl.disable(gl.DEPTH_TEST);
    }
    drawGuides(vol, half, mvp) {
      const ov = this.overlay, px = this.dpr, [a, b, c] = half;
      const cw = this.cssWidth, ch = this.cssHeight;
      ov.clear();
      const corners = [];
      for (const z of [-c, c]) for (const y of [-b, b]) for (const x of [-a, a]) corners.push([x, y, z]);
      for (const [i, j] of BOX_EDGES) ov.line(corners[i], corners[j], WHITE, 0.2, 1.5 * px, 0.035);

      this.handles = [];
      this.rails = [];
      if (vol) {
        const knobs = [];
        for (let k = 0; k < 3; k++) {
          const color = AXIS_RGB[k], active = k === state.active;
          const w = worldCoord(vol, k, state.pos[k]);
          const rect = planeCorners(half, k, w);
          for (let e = 0; e < 4; e++) ov.line(rect[e], rect[(e + 1) % 4], color, active ? 0.95 : 0.45, (active ? 2.6 : 1.7) * px, 0.03);
          const r0 = railPoint(half, k, worldCoord(vol, k, 0));
          const r1 = railPoint(half, k, worldCoord(vol, k, vol.dims[k] - 1));
          ov.line(r0, r1, color, 0.38, 1.6 * px, 0.04);
          ov.point(r0, color, 0.8, 5 * px);
          ov.point(r1, color, 0.8, 5 * px);
          const h = railPoint(half, k, w);
          ov.line(h, planeAnchor(half, k, w), color, 0.75, 1.4 * px, 0.02);
          knobs.push({ k, h, active });
          this.handles[k] = project(mvp, h, cw, ch);
          this.rails[k] = [project(mvp, r0, cw, ch), project(mvp, r1, cw, ch)];
        }
        knobs.sort((p, q) => p.active - q.active);  // active handle on top
        for (const { k, h, active } of knobs) {
          const lit = k === this.hover || k === this.grabbed;
          ov.point(h, AXIS_RGB[k], 1, (lit ? 25 : active ? 21 : 17) * px, 1);
        }
      }
      ov.draw(mvp);

      const spots = [[-a - 0.12, -b - RAIL_GAP, c + RAIL_GAP], [a + RAIL_GAP, b + 0.13, c + RAIL_GAP], [a + RAIL_GAP, -b - RAIL_GAP, -c - 0.16]];
      this.labels.forEach((el, k) => {
        el.hidden = !vol;
        if (!vol) return;
        const [x, y] = project(mvp, spots[k], cw, ch);
        const hw = el.offsetWidth / 2 + 8, hh = el.offsetHeight / 2 + 8;  // keep the label inside the view
        el.style.transform = `translate(${clamp(x, hw, cw - hw).toFixed(1)}px, ${clamp(y, hh, ch - hh).toFixed(1)}px) translate(-50%, -50%)`;
      });
    }
    pickHandle(p, reach = 18) {
      let best = -1, bestDist = reach;
      this.handles.forEach((h, k) => {
        const d = Math.hypot(h[0] - p[0], h[1] - p[1]);
        if (d < bestDist) { bestDist = d; best = k; }
      });
      return best;
    }
    dragHandle(k, p) {
      const vol = state.vol, rail = this.rails[k];
      if (!vol || !rail) return;
      const [r0, r1] = rail;
      const dx = r1[0] - r0[0], dy = r1[1] - r0[1], len2 = dx * dx + dy * dy;
      if (len2 < 64) return;  // rail seen end-on
      const u = clamp(((p[0] - r0[0]) * dx + (p[1] - r0[1]) * dy) / len2, 0, 1);
      setPos(k, u * (vol.dims[k] - 1));
    }
    listen() {
      const c = this.canvas, pointers = new Map();
      let drag = null;
      const local = (e) => {
        const r = c.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
      };
      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, local(e));
        if (pointers.size === 2) {
          const [p, q] = [...pointers.values()];
          drag = { type: 'pinch', span: Math.hypot(p[0] - q[0], p[1] - q[1]), zoom: this.cam.zoom };
          this.orbiting = false;
          return;
        }
        const p = local(e), k = this.pickHandle(p, e.pointerType === 'mouse' ? 18 : 32);  // fingers need a bigger target
        if (k >= 0) {
          drag = { type: 'handle', k };
          this.grabbed = k;
          setActive(k);
          this.dragHandle(k, p);
          c.style.cursor = 'grabbing';
        } else {
          drag = { type: 'orbit', p, at: e.timeStamp };
          this.orbiting = true;
          this.cam.vYaw = this.cam.vPitch = 0;
        }
      });
      c.addEventListener('pointermove', (e) => {
        const p = local(e);
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
        if (!drag) {
          const k = this.pickHandle(p);
          if (k !== this.hover) { this.hover = k; this.dirty = true; }
          c.style.cursor = k >= 0 ? 'grab' : '';
          return;
        }
        if (drag.type === 'handle') {
          this.dragHandle(drag.k, p);
        } else if (drag.type === 'orbit') {
          const dx = p[0] - drag.p[0], dy = p[1] - drag.p[1];
          drag.p = p;
          drag.at = e.timeStamp;
          this.cam.vYaw = -dx * 0.0085;
          this.cam.vPitch = dy * 0.0085;
          this.rotate(this.cam.vYaw, this.cam.vPitch);
        } else if (drag.type === 'pinch' && pointers.size === 2) {
          const [p0, p1] = [...pointers.values()];
          this.zoomTo((drag.zoom * drag.span) / Math.max(1, Math.hypot(p0[0] - p1[0], p0[1] - p1[1])));
        }
      });
      const end = (e) => {
        pointers.delete(e.pointerId);
        if (!drag) return;
        // keep spinning only after a flick, not after the pointer came to rest, and never wildly
        if (drag.type !== 'orbit' || e.timeStamp - drag.at > 80) this.cam.vYaw = this.cam.vPitch = 0;
        this.cam.vYaw = clamp(this.cam.vYaw, -0.04, 0.04);
        this.cam.vPitch = clamp(this.cam.vPitch, -0.025, 0.025);
        drag = null;
        this.orbiting = false;
        this.grabbed = -1;
        c.style.cursor = '';
        this.dirty = true;
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoomTo(this.cam.zoom * Math.exp(dy * 0.0012));
      }, { passive: false });
      c.addEventListener('dblclick', () => this.resetView());
    }
  }

  // ---------- right: the points on the active plane ----------
  class SliceView extends GLView {
    constructor(canvas, labelU, labelV) {
      super(canvas);
      this.flat = createProgram(this.gl, FLAT_VS, FLAT_FS);
      this.labelU = labelU;
      this.labelV = labelV;
      this.box = null;
      this.listen();
    }
    layout(vol) {
      const k = state.active, [ua, va] = UV_AXES[k];
      const ew = 2 * vol.half[ua], eh = 2 * vol.half[va];
      const pad = 38;
      const s = Math.max(0, Math.min((this.cssWidth - 2 * pad) / ew, (this.cssHeight - 2 * pad) / eh));
      const w = ew * s, h = eh * s;
      return { x: (this.cssWidth - w) / 2, y: (this.cssHeight - h) / 2, w, h, ua, va, U: vol.dims[ua], V: vol.dims[va], up: k === 1 };
    }
    xAt(box, i) { return box.x + ((i + 0.5) / box.U) * box.w; }
    yAt(box, j) {
      const f = (j + 0.5) / box.V;
      return box.up ? box.y + box.h - f * box.h : box.y + f * box.h;
    }
    render() {
      this.begin();
      const vol = state.vol;
      if (!vol || !this.texture) return;
      const gl = this.gl, p = this.flat, box = (this.box = this.layout(vol));
      const W = this.cssWidth, H = this.cssHeight;
      this.useVolume(p, vol);
      gl.uniform1i(p.u.uSliceAxis, state.active);
      gl.uniform1i(p.u.uIndex, state.pos[state.active]);
      gl.uniform2i(p.u.uGridUV, box.U, box.V);
      gl.uniform4f(p.u.uRect, (box.x / W) * 2 - 1, 1 - ((box.y + box.h) / H) * 2, (box.w / W) * 2, (box.h / H) * 2);
      const fill = 0.9 * state.pointScale;
      gl.uniform2f(p.u.uDot, (box.w / box.U) * this.dpr * fill, (box.h / box.V) * this.dpr * fill);
      gl.uniform1i(p.u.uVUp, box.up ? 1 : 0);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.POINTS, 0, box.U * box.V);
      gl.bindVertexArray(null);

      // Crosshair: where the other two planes cross this one.
      const ov = this.overlay, px = this.dpr;
      const x = this.xAt(box, state.pos[box.ua]), y = this.yAt(box, state.pos[box.va]);
      const cu = AXIS_RGB[box.ua], cv = AXIS_RGB[box.va];
      ov.clear();
      ov.line([x, box.y, 0], [x, box.y + box.h, 0], cu, 0.35, 1.5 * px, 7);
      ov.line([box.x, y, 0], [box.x + box.w, y, 0], cv, 0.35, 1.5 * px, 7);
      ov.point([x, box.y - 10, 0], cu, 1, 7 * px);
      ov.point([x, box.y + box.h + 10, 0], cu, 1, 7 * px);
      ov.point([box.x - 10, y, 0], cv, 1, 7 * px);
      ov.point([box.x + box.w + 10, y, 0], cv, 1, 7 * px);
      ov.draw(new Float32Array([2 / W, 0, 0, 0, 0, -2 / H, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1]));

      this.labelU.textContent = `${AXIS_NAMES[box.ua]} →`;
      this.labelV.textContent = box.up ? `${AXIS_NAMES[box.va]} →` : `← ${AXIS_NAMES[box.va]}`;
      this.labelU.style.setProperty('--c', `var(${AXIS_TOKENS[box.ua]})`);
      this.labelV.style.setProperty('--c', `var(${AXIS_TOKENS[box.va]})`);
      this.labelU.style.transform = `translate(${box.x + box.w / 2}px, ${box.y + box.h + 26}px) translate(-50%, -50%)`;
      this.labelV.style.transform = `translate(${box.x - 26}px, ${box.y + box.h / 2}px) translate(-50%, -50%) rotate(-90deg)`;
    }
    listen() {
      const c = this.canvas;
      let probing = false, wheel = 0;
      // Click or drag to place the crosshair: it moves the other two planes to that point.
      const probe = (e) => {
        const box = this.box;
        if (!box || !state.vol) return;
        const r = c.getBoundingClientRect();
        const fu = (e.clientX - r.left - box.x) / box.w;
        const fv = (e.clientY - r.top - box.y) / box.h;
        setPos(box.ua, Math.floor(fu * box.U));
        setPos(box.va, Math.floor((box.up ? 1 - fv : fv) * box.V));
      };
      c.addEventListener('pointerdown', (e) => {
        if (!this.box) return;
        probing = true;
        c.setPointerCapture(e.pointerId);
        probe(e);
      });
      c.addEventListener('pointermove', (e) => { if (probing) probe(e); });
      const stop = () => { probing = false; };
      c.addEventListener('pointerup', stop);
      c.addEventListener('pointercancel', stop);
      c.addEventListener('wheel', (e) => {
        if (!state.vol) return;
        e.preventDefault();
        wheel += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;  // trackpads send many small deltas
        const steps = Math.trunc(wheel / 24);
        if (steps) {
          wheel -= steps * 24;
          setPos(state.active, state.pos[state.active] + steps);
        }
      }, { passive: false });
    }
  }

  // ---------- page ----------
  const ui = {
    status: $('#status'),
    progress: $('#progress'),
    bar: $('#bar'),
    open: $('#open'),
    file: $('#file'),
    demo: $('#demo'),
    quality: $('#quality'),
    meta: $('#meta'),
    sliders: [$('#pos-x'), $('#pos-y'), $('#pos-z')],
    values: [$('#val-x'), $('#val-y'), $('#val-z')],
    rows: [...document.querySelectorAll('.slide')],
    modeCut: $('#mode-cut'),
    modeGhost: $('#mode-ghost'),
    size: $('#size'),
    reset: $('#reset'),
    tabs: [...document.querySelectorAll('.tabs [data-axis]')],
    play: $('#play'),
    speeds: [...document.querySelectorAll('[data-speed]')],
    readout: $('#readout'),
    explain: $('#explain'),
    drop: $('#drop'),
  };

  function setStatus(text, isError = false) {
    ui.status.textContent = text;
    ui.status.title = text;
    ui.status.classList.toggle('error', isError);
  }
  function setProgress(fraction) {
    ui.progress.hidden = fraction == null;
    if (fraction != null) ui.bar.style.width = `${(fraction * 100).toFixed(1)}%`;
  }
  function formatSeconds(s) {
    if (s < 60) return `${s.toFixed(1)} s`;
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  let cube, slice;
  try {
    cube = new CubeView($('#cube'), [...document.querySelectorAll('.axis-label')]);
    slice = new SliceView($('#slice'), $('#label-u'), $('#label-v'));
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  const views = [cube, slice];
  const maxTexture = Math.min(...views.map((v) => v.gl.getParameter(v.gl.MAX_3D_TEXTURE_SIZE)));

  function requestDraw() {
    cube.dirty = true;
    slice.dirty = true;
  }
  // While frames are still arriving, the time plane can only reach the ones already sampled.
  function maxIndex(k) {
    const vol = state.vol;
    return k === 2 ? Math.max(0, vol.loaded - 1) : vol.dims[k] - 1;
  }
  function secondsAt(i) {
    const vol = state.vol;
    return ((i + 0.5) / vol.T) * vol.duration;
  }
  function describe(k, i, long) {
    const vol = state.vol;
    if (k === 2) return long ? `frame ${i + 1} / ${vol.T} · ${secondsAt(i).toFixed(2)} s` : `${secondsAt(i).toFixed(2)} s`;
    if (k === 1) return long ? `row ${i + 1} / ${vol.H}` : `row ${i + 1}`;
    return long ? `column ${i + 1} / ${vol.W}` : `col ${i + 1}`;
  }
  function syncFill(input) {
    const min = Number(input.min), max = Number(input.max);
    input.style.setProperty('--fill', `${((Number(input.value) - min) / Math.max(1e-9, max - min)) * 100}%`);
  }
  function syncAxis(k) {
    const vol = state.vol, input = ui.sliders[k];
    input.max = String(vol.dims[k] - 1);
    input.value = String(state.pos[k]);
    syncFill(input);
    ui.values[k].textContent = describe(k, state.pos[k], false);
    if (k === state.active) ui.readout.textContent = describe(k, state.pos[k], true);
  }
  function setPos(k, i) {
    if (!state.vol) return;
    const next = clamp(Math.round(i), 0, maxIndex(k));
    if (next === state.pos[k]) return;
    state.pos[k] = next;
    syncAxis(k);
    requestDraw();
  }
  function setActive(k) {
    state.active = k;
    ui.tabs.forEach((t) => t.setAttribute('aria-selected', String(Number(t.dataset.axis) === k)));
    ui.rows.forEach((r) => r.classList.toggle('active', Number(r.dataset.axis) === k));
    ui.explain.textContent = EXPLAIN[k];
    if (state.vol) ui.readout.textContent = describe(k, state.pos[k], true);
    playAcc = 0;
    requestDraw();
  }
  function setMode(mode) {
    state.mode = mode;
    ui.modeCut.setAttribute('aria-pressed', String(mode === 'cut'));
    ui.modeGhost.setAttribute('aria-pressed', String(mode === 'ghost'));
    requestDraw();
  }

  // Play sweeps the active plane along its axis; at 1× a sweep lasts as long as the clip.
  let playClock = 0, playAcc = 0;
  function setPlaying(on) {
    state.playing = Boolean(on && state.vol);
    ui.play.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
    ui.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    playClock = performance.now();
    playAcc = 0;
  }
  function advancePlay(now) {
    const vol = state.vol;
    const dt = Math.min(0.1, (now - playClock) / 1000);
    playClock = now;
    if (!state.playing || !vol) return;
    const k = state.active, n = maxIndex(k) + 1;
    if (n < 2) return;
    playAcc += (dt * state.speed * (vol.dims[k] - 1)) / vol.duration;
    const steps = Math.floor(playAcc);
    if (steps > 0) {
      playAcc -= steps;
      setPos(k, (state.pos[k] + steps) % n);
    }
  }

  // ---------- turning video into points ----------
  let loadToken = 0;

  function beginVolume(vol) {
    state.vol = vol;
    views.forEach((v) => v.setVolume(vol));
    state.pos = [Math.floor(vol.W / 2), Math.floor(vol.H / 2), 0];
    for (let k = 0; k < 3; k++) syncAxis(k);
    const points = vol.grid[0] * vol.grid[1] * vol.grid[2];
    ui.meta.textContent = `${vol.W} × ${vol.H} px · ${vol.T} frames · ${points.toLocaleString('en-US')} points`;
    requestDraw();
  }
  function pushFrame(vol, i, pixels) {
    if (state.vol !== vol) return;
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    views.forEach((v) => v.addFrame(vol, i, bytes));
    vol.loaded = i + 1;
    if (!state.playing) state.pos[2] = i;  // the time plane follows the newest frame
    syncAxis(2);
    requestDraw();
  }
  function finishVolume(vol, note = '') {
    if (state.vol !== vol) return;
    setProgress(null);
    state.pos[2] = 0;
    syncAxis(2);
    setStatus(`${vol.name} · ${vol.T} frames from ${formatSeconds(vol.duration)}${note}`);
    requestDraw();
  }

  async function loadDemo() {
    const token = ++loadToken;
    setPlaying(false);
    const q = QUALITY[ui.quality.value], length = 8;
    const W = Math.min(q.long, maxTexture), H = Math.round((W * 9) / 16);
    const T = Math.min(q.frames, length * 30, maxTexture);
    const vol = makeVolume(W, H, T, length, 'Demo clip', q.cloud);
    state.source = { kind: 'demo' };
    beginVolume(vol);
    setStatus('Building the demo clip…');
    setProgress(0);
    const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const chunk = reducedMotion ? T : 6;
    for (let i = 0; i < T; i++) {
      drawDemoFrame(ctx, ((i + 0.5) / T) * length, length);
      pushFrame(vol, i, ctx.getImageData(0, 0, W, H).data);
      if ((i + 1) % chunk === 0) {
        setProgress((i + 1) / T);
        await nextFrame();
        if (token !== loadToken) return;
      }
    }
    finishVolume(vol, ' · open or drop your own video (up to 60 s)');
  }

  const MEDIA_ERRORS = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'format not supported' };
  const WEBKIT = /Apple/.test(navigator.vendor);  // Safari and every browser on iOS

  function waitFor(video, event, ms, stage) {
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(timer);
        video.removeEventListener(event, ok);
        video.removeEventListener('error', bad);
        fn(value);
      };
      const ok = () => finish(resolve);
      const bad = () => finish(reject, Object.assign(new Error('decode'), { code: 'decode' }));
      const timer = setTimeout(() => finish(reject, new Error(`The video stalled while ${stage}. Try a shorter clip, or an MP4 (H.264).`)), ms);
      video.addEventListener(event, ok);
      video.addEventListener('error', bad);
    });
  }
  async function seek(video, t) {
    // WebKit can fire 'seeked' before the new frame is drawable, so there we also wait for it to be presented.
    const presented = WEBKIT && video.requestVideoFrameCallback
      ? new Promise((resolve) => video.requestVideoFrameCallback(resolve))
      : null;
    const seeked = waitFor(video, 'seeked', 15000, 'seeking to the next frame');
    video.currentTime = t;
    await seeked;
    if (presented) await Promise.race([presented, new Promise((resolve) => setTimeout(resolve, 300))]);
  }
  // Recorded WebM files often report an unknown length until their end has been read.
  async function measureDuration(video) {
    const changed = waitFor(video, 'durationchange', 5000, 'measuring its length').catch(() => {});
    const seeked = waitFor(video, 'seeked', 5000, 'measuring its length').catch(() => {});
    video.currentTime = 1e7;
    await Promise.all([changed, seeked]);
    return Number.isFinite(video.duration) ? video.duration : video.currentTime;
  }
  // Phone browsers decode frames more reliably from a video that is part of the page, so keep it there, invisible.
  function createSampler() {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
    document.body.appendChild(video);
    return video;
  }
  function describeFailure(err, file, video, blockedByPolicy) {
    if (blockedByPolicy) {
      return `This page isn't allowed to play local video files where it's open now, so ${file.name} can't be read. Open Spacetime Slicer from its own web address instead.`;
    }
    if (err.code === 'decode') {
      const e = video.error;
      const reason = e ? [MEDIA_ERRORS[e.code], e.message].filter(Boolean).join(': ') : '';
      return `This browser can't decode ${file.name}${reason ? ` (${reason})` : ''}. Try an MP4 (H.264) or WebM file.`;
    }
    return err.message;
  }

  async function loadFile(file) {
    if (!file) return;
    const token = ++loadToken;
    setPlaying(false);
    setStatus(`Opening ${file.name}…`);
    setProgress(0);
    const url = URL.createObjectURL(file);
    const video = createSampler();
    let blockedByPolicy = false;
    const onViolation = (e) => {
      if (/^media-src/.test(e.effectiveDirective) || /^blob/.test(e.blockedURI)) blockedByPolicy = true;
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    try {
      video.src = url;
      await waitFor(video, 'loadedmetadata', 20000, 'reading the file');
      let duration = video.duration;
      if (!Number.isFinite(duration)) duration = await measureDuration(video);
      if (token !== loadToken) return;
      if (video.readyState < 2) await waitFor(video, 'loadeddata', 8000, 'decoding the first frame').catch(() => {});
      if (token !== loadToken) return;
      if (!video.videoWidth || !video.videoHeight) throw new Error(`${file.name} has no picture to sample. Pick a video file.`);
      if (!(duration > 0)) throw new Error(`Couldn't tell how long ${file.name} is. Try saving it as an MP4.`);

      const span = Math.min(duration, MAX_SECONDS);
      const q = QUALITY[ui.quality.value];
      const scale = Math.min(1, Math.min(q.long, maxTexture) / Math.max(video.videoWidth, video.videoHeight));
      const W = Math.max(2, Math.round(video.videoWidth * scale));
      const H = Math.max(2, Math.round(video.videoHeight * scale));
      const T = clamp(Math.round(span * 30), 2, Math.min(q.frames, maxTexture));
      const vol = makeVolume(W, H, T, span, file.name, q.cloud);
      state.source = { kind: 'file', file };
      beginVolume(vol);

      const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      for (let i = 0; i < T; i++) {
        await seek(video, Math.min(((i + 0.5) / T) * span, duration - 0.001));
        if (token !== loadToken) return;
        ctx.drawImage(video, 0, 0, W, H);
        pushFrame(vol, i, ctx.getImageData(0, 0, W, H).data);
        setProgress((i + 1) / T);
        setStatus(`Sampling ${file.name} · frame ${i + 1} of ${T}`);
      }
      const note = duration > MAX_SECONDS + 0.05 ? ` (the first minute of ${formatSeconds(duration)})` : '';
      finishVolume(vol, note);
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 0));  // a policy violation can be reported just after the error
      if (token !== loadToken) return;
      setProgress(null);
      setStatus(describeFailure(err, file, video, blockedByPolicy), true);
    } finally {
      document.removeEventListener('securitypolicyviolation', onViolation);
      video.removeAttribute('src');
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    }
  }

  // An eight-second synthetic clip with motion that makes good slices.
  function drawDemoFrame(ctx, t, length) {
    const { width: W, height: H } = ctx.canvas;
    const disc = (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); };
    ctx.setTransform(W / 320, 0, 0, H / 180, 0, 0);
    const phase = t / length;

    const hue = 230 + 45 * Math.sin(phase * Math.PI * 2);  // sky drifting through the hues
    const sky = ctx.createLinearGradient(0, 0, 0, 132);
    sky.addColorStop(0, `hsl(${hue}, 55%, 13%)`);
    sky.addColorStop(1, `hsl(${(hue + 115) % 360}, 75%, 55%)`);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 320, 132);

    const sx = 26 + 268 * phase, sy = 112 - 86 * Math.sin(Math.PI * phase);  // sun on an arc
    const glow = ctx.createRadialGradient(sx, sy, 6, sx, sy, 44);
    glow.addColorStop(0, 'rgba(255, 238, 180, 0.85)');
    glow.addColorStop(1, 'rgba(255, 190, 120, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(sx - 44, sy - 44, 88, 88);
    ctx.fillStyle = '#fff3cc';
    disc(sx, sy, 12);

    ctx.fillStyle = '#1b2740';  // hills
    ctx.beginPath();
    ctx.moveTo(0, 132);
    for (let x = 0; x <= 320; x += 8) ctx.lineTo(x, 112 + 9 * Math.sin(x * 0.035 + 1.3) + 5 * Math.sin(x * 0.11));
    ctx.lineTo(320, 132);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#121319';  // road with dashes rushing left
    ctx.fillRect(0, 132, 320, 48);
    ctx.fillStyle = '#f4c95d';
    for (let x = -((t * 96) % 40); x < 320; x += 40) ctx.fillRect(x, 154, 22, 4);

    ctx.fillStyle = '#c3c9d6';  // pinwheel on a pole
    ctx.fillRect(90.5, 86, 3, 46);
    ctx.save();
    ctx.translate(92, 86);
    ctx.rotate(t * Math.PI * 1.25);
    for (const color of ['#ff5c7a', '#45dc9c', '#5bb6ff', '#ffd166']) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(34, -12);
      ctx.lineTo(31, 7);
      ctx.closePath();
      ctx.fill();
      ctx.rotate(Math.PI / 2);
    }
    ctx.restore();

    const bounce = (t % 1.6) / 1.6, lift = 4 * bounce * (1 - bounce);  // ball bouncing along the road
    const bx = 170 + 120 * phase, by = 121 - 84 * lift;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.beginPath();
    ctx.ellipse(bx, 134, 12 - 5 * lift, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    const shade = ctx.createRadialGradient(bx - 4, by - 4, 1, bx, by, 12);
    shade.addColorStop(0, '#ffe0c9');
    shade.addColorStop(1, '#ff6a3d');
    ctx.fillStyle = shade;
    disc(bx, by, 11);
  }

  // ---------- wiring ----------
  ui.open.addEventListener('click', () => ui.file.click());
  ui.file.addEventListener('change', () => {
    const file = ui.file.files[0];
    ui.file.value = '';
    loadFile(file);
  });
  ui.demo.addEventListener('click', loadDemo);
  ui.quality.addEventListener('change', () => {
    if (state.source && state.source.kind === 'file') loadFile(state.source.file);
    else loadDemo();
  });

  ui.sliders.forEach((input, k) => {
    input.addEventListener('pointerdown', () => setActive(k));
    input.addEventListener('focus', () => { if (state.active !== k) setActive(k); });
    input.addEventListener('input', () => {
      if (state.active !== k) setActive(k);
      setPos(k, Number(input.value));
      syncAxis(k);  // snaps back if the frame isn't sampled yet
    });
  });
  ui.tabs.forEach((tab) => tab.addEventListener('click', () => setActive(Number(tab.dataset.axis))));
  ui.modeCut.addEventListener('click', () => setMode('cut'));
  ui.modeGhost.addEventListener('click', () => setMode('ghost'));
  ui.size.addEventListener('input', () => {
    state.pointScale = Number(ui.size.value);
    syncFill(ui.size);
    requestDraw();
  });
  ui.reset.addEventListener('click', () => cube.resetView());
  ui.play.addEventListener('click', () => setPlaying(!state.playing));
  ui.speeds.forEach((button) => button.addEventListener('click', () => {
    state.speed = Number(button.dataset.speed);
    ui.speeds.forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  }));

  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (e.metaKey || e.ctrlKey || e.altKey || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === ' ' && tag !== 'BUTTON') {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1);
      setPos(state.active, state.pos[state.active] + step);
    } else if (e.key === '1' || e.key === '2' || e.key === '3') {
      setActive([2, 1, 0][Number(e.key) - 1]);
    }
  });

  // Drop a video anywhere on the page.
  let dragDepth = 0;
  const carriesFiles = (e) => Array.from(e.dataTransfer ? e.dataTransfer.types : []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    ui.drop.hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (carriesFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) ui.drop.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    ui.drop.hidden = true;
    const files = Array.from(e.dataTransfer ? e.dataTransfer.files : []);
    const file = files.find((f) => f.type.startsWith('video/')) || files[0];
    if (file) loadFile(file);
  });

  function loop(now) {
    advancePlay(now);
    cube.tick();
    if (cube.dirty) { cube.dirty = false; cube.render(); }
    if (slice.dirty) { slice.dirty = false; slice.render(); }
    requestAnimationFrame(loop);
  }

  // Phones sample and draw faster at the lighter setting; it can still be raised from the Detail menu.
  if (matchMedia('(pointer: coarse)').matches) ui.quality.value = 'fast';
  setActive(2);
  setMode('cut');
  setPlaying(false);
  syncFill(ui.size);
  requestAnimationFrame(loop);
  loadDemo();
})();
