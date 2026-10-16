'use strict';
/*
  Spacetime Slicer
  A video becomes a block of points: x = column, y = row, z = time (one layer per sampled frame).
  A sheet cuts through the block. ω, φ and κ tilt it about the x, y and z axes, depth pushes it
  through the block along its normal, and sphereness bends it into part of a sphere.
  Left: the block in 3D with the sheet. Right: the points the sheet touches, laid out flat.
*/
(() => {
  const MAX_SECONDS = 60;
  const QUALITY = {  // longest frame side in points, most frames sampled, most points drawn for the 3D block
    fast: { long: 112, frames: 240, cloud: 900000 },
    balanced: { long: 160, frames: 300, cloud: 1800000 },
    detailed: { long: 224, frames: 450, cloud: 3200000 },
  };
  const AXIS_NAMES = ['x · column', 'y · row', 'z · time'];
  const AXIS_TOKENS = ['--x', '--y', '--z'];
  // The classic slices: the sheet square to time, to rows, or to columns.
  const PRESETS = {
    xy: { omega: 0, phi: 0, kappa: 0 },
    xz: { omega: -90, phi: 0, kappa: 0 },
    zy: { omega: 0, phi: 90, kappa: 0 },
  };
  const SHEET_NAMES = {
    xy: 'XY · a frame',
    xz: 'XZ · one row over time',
    zy: 'ZY · one column over time',
    tilted: 'Tilted sheet',
    curved: 'Curved sheet',
  };
  const EXPLAIN = {
    xy: 'A single frame of the video. Push the sheet through time and the video plays.',
    xz: 'One row of pixels stacked through time. Anything moving across the row smears into streaks and curves.',
    zy: 'One column of pixels unrolled across time, like a photo-finish camera. Whatever passes the column gets painted in.',
    tilted: 'A tilted sheet cuts through space and time at once, so each part of it shows a different moment.',
    curved: 'The sheet is bent into part of a sphere. This is its surface unrolled flat, with its centre in the middle.',
  };
  const GHOST_ALPHA = 0.1;
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
    vol: null,     // { W, H, T, dims, half, grid, ghostGrid, cloudSpacing, ghostSpacing, duration, loaded, name }
    depth: 0,      // 0 to 1: how far the sheet has been pushed through the block
    omega: 0,      // degrees of rotation about x
    phi: 0,        // about y
    kappa: 0,      // about z (time)
    sphere: 0,     // 0 keeps the sheet flat, 1 closes it into a sphere
    mode: 'ghost',
    pointScale: 1,
    playing: false,
    speed: 1,
    source: null,  // what to sample again when the detail setting changes
  };
  let sheet = null;  // the sheet's geometry, derived from the state by computeSheet()

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

  // ---------- block and sheet geometry ----------
  // World coordinate of index i along axis k: x runs left to right, row 0 is the top, frame 0 is the front face.
  function worldCoord(vol, k, i) {
    const h = vol.half[k], n = i / Math.max(vol.dims[k] - 1, 1);
    return k === 0 ? -h + 2 * h * n : h - 2 * h * n;
  }
  function indexAt(vol, k, w) {
    const h = vol.half[k];
    return ((k === 0 ? w + h : h - w) / (2 * h)) * (vol.dims[k] - 1);
  }
  function spacing(vol, k) {
    return (2 * vol.half[k]) / Math.max(vol.dims[k] - 1, 1);
  }
  function makeVolume(W, H, T, duration, name, cloudBudget) {
    const long = Math.max(W, H);
    const half = [W / long, H / long, 1];  // time is as deep as the frame is wide (or tall)
    const f = Math.min(1, Math.cbrt(cloudBudget / (W * H * T)));
    const grid = [W, H, T].map((d) => Math.max(2, Math.round(d * f)));
    const ghostGrid = grid.map((g) => Math.max(2, Math.round(g / 2)));  // a faint haze needs far fewer points
    const pitch = (g) => Math.max((2 * half[0]) / (g[0] - 1), (2 * half[1]) / (g[1] - 1));
    return {
      W, H, T, dims: [W, H, T], half, grid, ghostGrid,
      cloudSpacing: pitch(grid), ghostSpacing: pitch(ghostGrid), duration, loaded: 0, name,
    };
  }

  const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dominant = (w) => [0, 1, 2].reduce((m, k) => (Math.abs(w[k]) > Math.abs(w[m]) ? k : m), 0);

  // Rotate v about x by ω, then about y by φ, then about z by κ (all in degrees).
  function rotate(v, omega, phi, kappa) {
    const r = Math.PI / 180;
    const co = Math.cos(omega * r), so = Math.sin(omega * r);
    const cf = Math.cos(phi * r), sf = Math.sin(phi * r);
    const ck = Math.cos(kappa * r), sk = Math.sin(kappa * r);
    let [x, y, z] = v;
    [y, z] = [y * co - z * so, y * so + z * co];
    [x, z] = [x * cf + z * sf, -x * sf + z * cf];
    [x, y] = [x * ck - y * sk, x * sk + y * ck];
    return [x, y, z];
  }
  function presetOf(s) {
    return Object.keys(PRESETS).find((key) => {
      const p = PRESETS[key];
      return p.omega === s.omega && p.phi === s.phi && p.kappa === s.kappa;
    }) || null;
  }
  // Everything the shaders and guides need about the sheet, derived from the state.
  function computeSheet(vol) {
    const { omega, phi, kappa, sphere } = state;
    const U = rotate([1, 0, 0], omega, phi, kappa);   // the sheet's rightward direction
    const V = rotate([0, -1, 0], omega, phi, kappa);  // its downward direction
    const N = rotate([0, 0, 1], omega, phi, kappa);   // its normal; depth 0 starts on this side
    const reach = (w) => vol.half[0] * Math.abs(w[0]) + vol.half[1] * Math.abs(w[1]) + vol.half[2] * Math.abs(w[2]);
    const extent = [reach(U), reach(V)];  // the block's shadow on the sheet: as much sheet as can ever touch it
    const D = reach(N);
    // Sphereness wraps the sheet around a sphere behind it; at 1 its corners meet and the sphere closes.
    const bend = sphere > 0.001 ? (sphere * Math.PI) / Math.hypot(extent[0], extent[1]) : 0;  // radians per unit of arc
    const R = bend ? 1 / bend : 0;
    const sag = bend ? R * (1 - Math.cos(sphere * Math.PI)) : 0;  // how far the rim trails behind the centre
    let offset = D - state.depth * (2 * D + sag);  // the centre's distance from the middle of the block, along N
    const axis = dominant(N);
    const aligned = Math.abs(N[axis]) > 0.9999;
    if (aligned && !bend) {  // square to an axis: sit exactly on a layer of voxels so frames stay crisp
      offset = worldCoord(vol, axis, Math.round(indexAt(vol, axis, N[axis] * offset))) / N[axis];
    }
    const steps = [0, 1, 2].map((k) => spacing(vol, k));
    const stepAlong = (w) => 1 / Math.hypot(w[0] / steps[0], w[1] / steps[1], w[2] / steps[2]);  // one voxel along w
    const grid = [extent[0] / stepAlong(U), extent[1] / stepAlong(V)].map((n) => clamp(Math.round(2 * n) + 1, 2, 640));
    const weight = Math.abs(N[0]) + Math.abs(N[1]) + Math.abs(N[2]);
    const color = [0, 1, 2].map((c) => [0, 1, 2].reduce((sum, k) => sum + Math.abs(N[k]) * AXIS_RGB[k][c], 0) / weight);
    return {
      U, V, N, C: scale3(N, offset), extent, D, bend, R, sag, axis, grid, color,
      cell: Math.max((2 * extent[0]) / (grid[0] - 1), (2 * extent[1]) / (grid[1] - 1)),
      ends: [scale3(N, D), scale3(N, -D - sag)],  // where the centre sits at depth 0 and at depth 1
      depthStep: stepAlong(N) / (2 * D + sag),     // one voxel of depth
      kind: bend ? 'curved' : aligned ? ['zy', 'xz', 'xy'][axis] : 'tilted',
    };
  }
  // Signed distance of p from the sheet, positive on the side its normal points to.
  function sideOf(sh, p) {
    if (!sh.bend) return (p[0] - sh.C[0]) * sh.N[0] + (p[1] - sh.C[1]) * sh.N[1] + (p[2] - sh.C[2]) * sh.N[2];
    const O = sh.C.map((c, k) => c - sh.R * sh.N[k]);
    return Math.hypot(p[0] - O[0], p[1] - O[1], p[2] - O[2]) - sh.R;
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
// world position -> fractional voxel index
vec3 toIndex(vec3 p) {
  return vec3(p.x + uHalf.x, uHalf.y - p.y, uHalf.z - p.z) / (2.0 * uHalf) * vec3(max(uDim - 1, ivec3(1)));
}
bool inBlock(vec3 i) {
  return all(greaterThanEqual(i, vec3(-0.5))) && all(lessThanEqual(i, vec3(uDim) - 0.5)) && i.z <= float(uLoaded) - 0.5;
}
vec3 colorAt(vec3 i) {
  return texture(uVol, (i + 0.5) / vec3(uDim)).rgb;
}
`;
  const SHEET = `
uniform vec3 uC;       // the sheet's centre
uniform vec3 uU;       // its rightward and downward directions
uniform vec3 uV;
uniform vec3 uN;       // its normal
uniform vec2 uExtent;  // half its width and height, in world units
uniform ivec2 uSheetGrid;
uniform float uBend;   // radians of sphere per unit of arc; 0 keeps it flat
// sheet coordinates (arc length from the centre) -> world position
vec3 sheetPoint(vec2 uv) {
  float rho = length(uv);
  if (uBend < 1e-5 || rho < 1e-6) return uC + uv.x * uU + uv.y * uV;
  float theta = rho * uBend, r = 1.0 / uBend;
  vec2 d = uv / rho;
  return uC + r * (cos(theta) - 1.0) * uN + r * sin(theta) * (d.x * uU + d.y * uV);
}
vec2 sheetCoord(ivec2 g) {
  return (vec2(g) / vec2(max(uSheetGrid - 1, ivec2(1))) * 2.0 - 1.0) * uExtent;
}
`;
  const CLOUD_VS = HEAD + VOLUME + `
uniform ivec3 uGrid;
uniform mat4 uMVP;
uniform float uSize;
uniform vec3 uCutC;
uniform vec3 uCutN;
uniform float uCutR;  // radius of a bent sheet's sphere; 0 when flat
uniform float uSide;  // +1 hides the side the sheet's normal points to, -1 the other side, 0 keeps all
uniform float uAlpha;
out vec4 vColor;
void main() {
  int id = gl_VertexID;
  ivec3 g = ivec3(id % uGrid.x, (id / uGrid.x) % uGrid.y, id / (uGrid.x * uGrid.y));
  ivec3 span = max(uGrid - 1, ivec3(1));
  ivec3 v = (g * (uDim - 1) * 2 + span) / (span * 2);  // nearest voxel to this grid point
  vec3 p = toWorld(v);
  float side = uCutR > 0.0 ? length(p - (uCutC - uCutR * uCutN)) - uCutR : dot(p - uCutC, uCutN);
  vec4 clip = uMVP * vec4(p, 1.0);
  bool hidden = v.z >= uLoaded || uSide * side > 1e-4;
  gl_Position = hidden ? vec4(0.0, 0.0, 2.0, 1.0) : clip;
  gl_PointSize = hidden ? 0.0 : clamp(uSize / clip.w, 1.0, 48.0);
  vColor = vec4(texelFetch(uVol, v, 0).rgb, uAlpha);
}`;
  const SHEET3D_VS = HEAD + VOLUME + SHEET + `
uniform mat4 uMVP;
uniform float uSize;
uniform vec3 uEdge;
out vec4 vColor;
void main() {
  ivec2 g = ivec2(gl_VertexID % uSheetGrid.x, gl_VertexID / uSheetGrid.x);
  vec2 uv = sheetCoord(g);
  vec2 step = 2.0 * uExtent / vec2(max(uSheetGrid - 1, ivec2(1)));
  vec3 p = sheetPoint(uv);
  vec3 i = toIndex(p);
  bool inside = inBlock(i);
  // the sheet's outline: points inside the block with a neighbour outside it
  bool edge = inside && !(inBlock(toIndex(sheetPoint(uv + vec2(step.x, 0.0)))) && inBlock(toIndex(sheetPoint(uv - vec2(step.x, 0.0))))
    && inBlock(toIndex(sheetPoint(uv + vec2(0.0, step.y)))) && inBlock(toIndex(sheetPoint(uv - vec2(0.0, step.y)))));
  vec4 clip = uMVP * vec4(p, 1.0);
  gl_Position = inside ? clip : vec4(0.0, 0.0, 2.0, 1.0);
  gl_PointSize = inside ? clamp(uSize * (edge ? 1.5 : 1.0) / clip.w, 1.0, 48.0) : 0.0;
  vColor = vec4(edge ? uEdge : colorAt(i), 1.0);
}`;
  const SHEET2D_VS = HEAD + VOLUME + SHEET + `
uniform vec4 uRect;  // left, bottom, width, height in clip space
uniform vec2 uDot;   // dot diameter in pixels along u and v
out vec4 vColor;
void main() {
  ivec2 g = ivec2(gl_VertexID % uSheetGrid.x, gl_VertexID / uSheetGrid.x);
  vec3 i = toIndex(sheetPoint(sheetCoord(g)));
  vec2 c = (vec2(g) + 0.5) / vec2(uSheetGrid);
  gl_Position = vec4(uRect.xy + vec2(c.x, 1.0 - c.y) * uRect.zw, 0.0, 1.0);
  gl_PointSize = max(uDot.x, uDot.y);
  vColor = inBlock(i) ? vec4(colorAt(i), 1.0) : vec4(0.0);
}`;
  const POINT_FS = HEAD + `
in vec4 vColor;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  outColor = vColor;
}`;
  const DOT_FS = HEAD + `
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

  // Screen-sized dots for guides, paths and handles.
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
      // the block's own points read exact voxels; a tilted or bent sheet blends its neighbours
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE);
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
    useSheet(p, sh) {
      const gl = this.gl;
      gl.uniform3fv(p.u.uC, sh.C);
      gl.uniform3fv(p.u.uU, sh.U);
      gl.uniform3fv(p.u.uV, sh.V);
      gl.uniform3fv(p.u.uN, sh.N);
      gl.uniform2f(p.u.uExtent, sh.extent[0], sh.extent[1]);
      gl.uniform2i(p.u.uSheetGrid, sh.grid[0], sh.grid[1]);
      gl.uniform1f(p.u.uBend, sh.bend);
    }
  }

  // ---------- left: the block in 3D ----------
  class CubeView extends GLView {
    constructor(canvas, labels) {
      super(canvas);
      this.cloud = createProgram(this.gl, CLOUD_VS, POINT_FS);
      this.surface = createProgram(this.gl, SHEET3D_VS, POINT_FS);
      this.labels = labels;
      this.cam = { yaw: 0.62, pitch: 0.42, zoom: 1, vYaw: 0, vPitch: 0 };
      this.handle = null;  // CSS px of the sheet's handle
      this.rail = null;    // CSS px of the two ends of the path it slides along
      this.hover = false;
      this.grabbed = false;
      this.orbiting = false;
      this.listen();
    }
    resetView() {
      Object.assign(this.cam, { yaw: 0.62, pitch: 0.42, zoom: 1, vYaw: 0, vPitch: 0 });
      this.dirty = true;
    }
    orbit(dYaw, dPitch) {
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
      this.orbit(c.vYaw, c.vPitch);
      c.vYaw *= 0.9;
      c.vPitch *= 0.9;
    }
    camera(half) {
      const fov = (34 * Math.PI) / 180;
      const aspect = this.width / this.height;
      const radius = Math.hypot(half[0] + 0.14, half[1] + 0.14, half[2] + 0.14);
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
      if (vol && this.texture && sheet) this.drawVolume(vol, sheet, mvp, eye, focal);
      this.drawGuides(vol ? sheet : null, half, mvp);
    }
    drawVolume(vol, sh, mvp, eye, focal) {
      const gl = this.gl;
      const ghost = state.mode === 'ghost';
      const sampling = vol.loaded < vol.T;
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.bindVertexArray(this.vao);

      // The sheet at full resolution, outlined where it leaves the block.
      const sp = this.surface;
      this.useVolume(sp, vol);
      this.useSheet(sp, sh);
      gl.uniformMatrix4fv(sp.u.uMVP, false, mvp);
      gl.uniform1f(sp.u.uSize, sh.cell * focal * state.pointScale);
      gl.uniform3fv(sp.u.uEdge, sh.color);
      gl.drawArrays(gl.POINTS, 0, sh.grid[0] * sh.grid[1]);

      // The block: a faint haze in ghost mode, or cut away between the camera and the sheet.
      const cp = this.cloud;
      const grid = ghost ? vol.ghostGrid : vol.grid;
      this.useVolume(cp, vol);
      gl.uniformMatrix4fv(cp.u.uMVP, false, mvp);
      gl.uniform3i(cp.u.uGrid, grid[0], grid[1], grid[2]);
      gl.uniform3fv(cp.u.uCutC, sh.C);
      gl.uniform3fv(cp.u.uCutN, sh.N);
      gl.uniform1f(cp.u.uCutR, sh.R);
      gl.uniform1f(cp.u.uSide, ghost || sampling ? 0 : sideOf(sh, eye) >= 0 ? 1 : -1);
      gl.uniform1f(cp.u.uAlpha, ghost ? GHOST_ALPHA : 1);
      gl.uniform1f(cp.u.uSize, (ghost ? vol.ghostSpacing : vol.cloudSpacing) * focal * state.pointScale);
      if (ghost) gl.depthMask(false);
      gl.drawArrays(gl.POINTS, 0, grid[0] * grid[1] * grid[2]);
      gl.depthMask(true);
      gl.bindVertexArray(null);
      gl.disable(gl.DEPTH_TEST);
    }
    drawGuides(sh, half, mvp) {
      const ov = this.overlay, px = this.dpr, [a, b, c] = half;
      const cw = this.cssWidth, ch = this.cssHeight;
      ov.clear();
      const corners = [];
      for (const z of [-c, c]) for (const y of [-b, b]) for (const x of [-a, a]) corners.push([x, y, z]);
      for (const [i, j] of BOX_EDGES) ov.line(corners[i], corners[j], WHITE, 0.2, 1.5 * px, 0.035);

      this.handle = this.rail = null;
      if (sh) {
        const [e0, e1] = sh.ends;  // the path the sheet's centre slides along
        ov.line(e0, e1, sh.color, 0.45, 1.6 * px, 0.04);
        ov.point(e0, sh.color, 0.8, 5 * px);
        ov.point(e1, sh.color, 0.8, 5 * px);
        ov.point(sh.C, sh.color, 1, (this.hover || this.grabbed ? 25 : 21) * px, 1);
        this.handle = project(mvp, sh.C, cw, ch);
        this.rail = [project(mvp, e0, cw, ch), project(mvp, e1, cw, ch)];
      }
      ov.draw(mvp);

      const gap = 0.12;
      const spots = [[0, -b - gap, c + gap], [a + gap, 0, c + gap], [a + gap, -b - gap, 0]];
      this.labels.forEach((el, k) => {
        el.hidden = !sh;
        if (!sh) return;
        const [x, y] = project(mvp, spots[k], cw, ch);
        const hw = el.offsetWidth / 2 + 8, hh = el.offsetHeight / 2 + 8;  // keep the label inside the view
        el.style.transform = `translate(${clamp(x, hw, cw - hw).toFixed(1)}px, ${clamp(y, hh, ch - hh).toFixed(1)}px) translate(-50%, -50%)`;
      });
    }
    nearHandle(p, reach) {
      return Boolean(this.handle) && Math.hypot(this.handle[0] - p[0], this.handle[1] - p[1]) < reach;
    }
    dragHandle(p) {
      if (!this.rail) return;
      const [r0, r1] = this.rail;
      const dx = r1[0] - r0[0], dy = r1[1] - r0[1], len2 = dx * dx + dy * dy;
      if (len2 < 64) return;  // path seen end-on
      setDepth(((p[0] - r0[0]) * dx + (p[1] - r0[1]) * dy) / len2);
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
        const p = local(e);
        if (this.nearHandle(p, e.pointerType === 'mouse' ? 18 : 32)) {  // fingers need a bigger target
          drag = { type: 'handle' };
          this.grabbed = true;
          this.dragHandle(p);
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
          const near = this.nearHandle(p, 18);
          if (near !== this.hover) { this.hover = near; this.dirty = true; }
          c.style.cursor = near ? 'grab' : '';
          return;
        }
        if (drag.type === 'handle') {
          this.dragHandle(p);
        } else if (drag.type === 'orbit') {
          const dx = p[0] - drag.p[0], dy = p[1] - drag.p[1];
          drag.p = p;
          drag.at = e.timeStamp;
          this.cam.vYaw = -dx * 0.0085;
          this.cam.vPitch = dy * 0.0085;
          this.orbit(this.cam.vYaw, this.cam.vPitch);
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
        this.grabbed = false;
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

  // ---------- right: the points the sheet touches, laid out flat ----------
  class SliceView extends GLView {
    constructor(canvas, labelU, labelV) {
      super(canvas);
      this.flat = createProgram(this.gl, SHEET2D_VS, DOT_FS);
      this.labelU = labelU;
      this.labelV = labelV;
      this.box = null;
      this.listen();
    }
    render() {
      this.begin();
      const vol = state.vol, sh = sheet;
      this.box = null;
      if (!vol || !this.texture || !sh) {
        this.labelU.hidden = this.labelV.hidden = true;
        return;
      }
      const W = this.cssWidth, H = this.cssHeight, pad = 38;
      const ew = 2 * sh.extent[0], eh = 2 * sh.extent[1];
      const s = Math.max(0, Math.min((W - 2 * pad) / ew, (H - 2 * pad) / eh));
      const box = (this.box = { w: ew * s, h: eh * s });
      box.x = (W - box.w) / 2;
      box.y = (H - box.h) / 2;

      const gl = this.gl, p = this.flat;
      this.useVolume(p, vol);
      this.useSheet(p, sh);
      gl.uniform4f(p.u.uRect, (box.x / W) * 2 - 1, 1 - ((box.y + box.h) / H) * 2, (box.w / W) * 2, (box.h / H) * 2);
      // Round dots sized by the coarser direction; once cells are too small to read as dots, they overlap into an image.
      const cell = Math.max(box.w / sh.grid[0], box.h / sh.grid[1]) * this.dpr;
      const size = cell * (0.9 + 0.5 * clamp((4 - cell) / 2, 0, 1)) * state.pointScale;
      gl.uniform2f(p.u.uDot, size, size);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.POINTS, 0, sh.grid[0] * sh.grid[1]);
      gl.bindVertexArray(null);

      this.placeLabel(this.labelU, sh.U, false, box.x + box.w / 2, box.y + box.h + 26, '');
      this.placeLabel(this.labelV, sh.V, true, box.x - 26, box.y + box.h / 2, ' rotate(-90deg)');
    }
    // Name the block axis a sheet direction runs along, when it runs close to one.
    placeLabel(el, w, down, x, y, turn) {
      const k = dominant(w);
      el.hidden = Math.abs(w[k]) < 0.9;
      if (el.hidden) return;
      const grows = w[k] * (k === 0 ? 1 : -1) > 0;  // the voxel index grows along w
      el.textContent = grows !== down ? `${AXIS_NAMES[k]} →` : `← ${AXIS_NAMES[k]}`;
      el.style.setProperty('--c', `var(${AXIS_TOKENS[k]})`);
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)${turn}`;
    }
    listen() {
      const c = this.canvas;
      let drag = null, wheel = 0;
      // Drag sideways to push the sheet through the block, like scrubbing a video.
      c.addEventListener('pointerdown', (e) => {
        if (!this.box) return;
        drag = { x: e.clientX, depth: state.depth };
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', (e) => {
        if (drag && this.box) setDepth(drag.depth + (e.clientX - drag.x) / Math.max(1, this.box.w));
      });
      const stop = () => { drag = null; };
      c.addEventListener('pointerup', stop);
      c.addEventListener('pointercancel', stop);
      c.addEventListener('wheel', (e) => {
        if (!sheet) return;
        e.preventDefault();
        wheel += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;  // trackpads send many small deltas
        const steps = Math.trunc(wheel / 24);
        if (steps) {
          wheel -= steps * 24;
          setDepth(state.depth + steps * sheet.depthStep);
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
    resume: $('#resume'),
    file: $('#file'),
    demo: $('#demo'),
    quality: $('#quality'),
    meta: $('#meta'),
    viewport: $('.viewport'),
    presets: [...document.querySelectorAll('[data-preset]')],
    modeGhost: $('#mode-ghost'),
    modeCut: $('#mode-cut'),
    depth: $('#depth'),
    depthOut: $('#depth-out'),
    angles: { omega: [$('#omega'), $('#omega-num')], phi: [$('#phi'), $('#phi-num')], kappa: [$('#kappa'), $('#kappa-num')] },
    sphere: [$('#sphere'), $('#sphere-num')],
    size: $('#size'),
    reset: $('#reset'),
    sheetName: $('#sheet-name'),
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
  function secondsAt(i) {
    const vol = state.vol;
    return ((i + 0.5) / vol.T) * vol.duration;
  }
  // Where the sheet is: in frames, rows or columns when it is square to an axis, otherwise as a share of the way.
  function describeDepth(long) {
    const vol = state.vol, sh = sheet;
    if (!vol || !sh) return '';
    if (sh.kind === 'xy' || sh.kind === 'xz' || sh.kind === 'zy') {
      const i = Math.round(indexAt(vol, sh.axis, sh.C[sh.axis]));
      if (sh.axis === 2) return long ? `frame ${i + 1} / ${vol.T} · ${secondsAt(i).toFixed(2)} s` : `${secondsAt(i).toFixed(2)} s`;
      if (sh.axis === 1) return long ? `row ${i + 1} / ${vol.H}` : `row ${i + 1}`;
      return long ? `column ${i + 1} / ${vol.W}` : `col ${i + 1}`;
    }
    return `${long ? 'depth ' : ''}${Math.round(state.depth * 100)}%`;
  }
  function syncFill(input) {
    const min = Number(input.min), max = Number(input.max);
    input.style.setProperty('--fill', `${((Number(input.value) - min) / Math.max(1e-9, max - min)) * 100}%`);
  }
  // Recompute the sheet from the state and bring every control and label in line with it.
  function update() {
    sheet = state.vol ? computeSheet(state.vol) : null;
    ui.depth.value = String(state.depth);
    syncFill(ui.depth);
    for (const [key, [range, number]] of [...Object.entries(ui.angles), ['sphere', ui.sphere]]) {
      range.value = String(state[key]);
      syncFill(range);
      if (document.activeElement !== number) number.value = String(state[key]);
    }
    const preset = presetOf(state);
    ui.presets.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === preset)));
    const kind = sheet ? sheet.kind : preset || 'tilted';
    ui.sheetName.textContent = SHEET_NAMES[kind];
    ui.explain.textContent = EXPLAIN[kind];
    ui.depthOut.textContent = describeDepth(false);
    ui.readout.textContent = describeDepth(true);
    if (sheet) document.documentElement.style.setProperty('--sheet', `rgb(${sheet.color.map((v) => Math.round(v * 255)).join(' ')})`);
    requestDraw();
  }
  function setDepth(d) {
    state.depth = clamp(d, 0, 1);
    update();
  }
  // Turn or bend the sheet about its centre: the handle stays put and the sheet pivots around it.
  function reshape(changes) {
    const pivot = sheet && sheet.C;
    Object.assign(state, changes);
    if (pivot) {
      const sh = computeSheet(state.vol);
      const offset = pivot[0] * sh.N[0] + pivot[1] * sh.N[1] + pivot[2] * sh.N[2];
      state.depth = clamp((sh.D - offset) / (2 * sh.D + sh.sag), 0, 1);
    }
    update();
  }
  function setMode(mode) {
    state.mode = mode;
    ui.modeGhost.setAttribute('aria-pressed', String(mode === 'ghost'));
    ui.modeCut.setAttribute('aria-pressed', String(mode === 'cut'));
    requestDraw();
  }

  // Play pushes the sheet through the block; at 1× one pass lasts as long as the clip.
  let playClock = 0;
  function setPlaying(on) {
    state.playing = Boolean(on && state.vol);
    ui.play.innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
    ui.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    playClock = performance.now();
  }
  function advancePlay(now) {
    const dt = Math.min(0.1, (now - playClock) / 1000);
    playClock = now;
    if (!state.playing || !state.vol) return;
    const next = state.depth + (dt * state.speed) / state.vol.duration;
    setDepth(next > 1 ? next - 1 : next);
  }

  // ---------- turning video into points ----------
  let loadToken = 0;

  function beginVolume(vol) {
    state.vol = vol;
    views.forEach((v) => v.setVolume(vol));
    state.depth = 0;
    const points = vol.grid[0] * vol.grid[1] * vol.grid[2];
    ui.meta.textContent = `${vol.W} × ${vol.H} px · ${vol.T} frames · ${points.toLocaleString('en-US')} points`;
    update();
  }
  function pushFrame(vol, i, pixels) {
    if (state.vol !== vol) return;
    const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    views.forEach((v) => v.addFrame(vol, i, bytes));
    vol.loaded = i + 1;
    // With the sheet square to time, follow the newest frame so the clip plays while it loads.
    if (!state.playing && sheet && sheet.kind === 'xy') state.depth = (sheet.D - worldCoord(vol, 2, i) * sheet.N[2]) / (2 * sheet.D);
    update();
  }
  function finishVolume(vol, note = '') {
    if (state.vol !== vol) return;
    setProgress(null);
    state.depth = 0;
    setStatus(`${vol.name} · ${vol.T} frames from ${formatSeconds(vol.duration)}${note}`);
    update();
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

  // Sampling a video file.
  const MEDIA_ERRORS = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'format not supported' };
  // Safari, and every browser on iOS, won't load or seek a video that hasn't started playing, so there the
  // clip is played through quickly and frames are caught as they are shown. Elsewhere seeking is faster.
  const WEBKIT = /Apple/.test(navigator.vendor);

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
      const timer = setTimeout(() => finish(reject, Object.assign(new Error(`The video stalled while ${stage}.`), { code: 'stalled' })), ms);
      video.addEventListener(event, ok);
      video.addEventListener('error', bad);
    });
  }
  // Recorded WebM files often report an unknown length until their end has been read.
  async function measureDuration(video) {
    const changed = waitFor(video, 'durationchange', 5000, 'measuring its length').catch(() => {});
    const seeked = waitFor(video, 'seeked', 5000, 'measuring its length').catch(() => {});
    video.currentTime = 1e7;
    await Promise.all([changed, seeked]);
    return Number.isFinite(video.duration) ? video.duration : video.currentTime;
  }
  // The clip shows in a small preview while it is sampled; WebKit only decodes frames of a video it can show.
  function createSampler() {
    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.className = 'sampler';
    ui.viewport.appendChild(video);
    return video;
  }
  function describeFailure(err, file, video, blockedByPolicy) {
    if (blockedByPolicy) {
      return `This page isn't allowed to play local video files where it's open now, so ${file.name} can't be read. Open Spacetime Slicer from its own web address instead.`;
    }
    if (err.code === 'decode') {
      const e = video.error;
      const reason = e ? [MEDIA_ERRORS[e.code], e.message].filter(Boolean).join(': ') : '';
      return `This browser can't decode ${file.name}${reason ? ` (${reason})` : ''}. Try an MP4 (H.264) or MOV file.`;
    }
    return err.message;
  }

  // Seek to the middle of each frame's time slot. Returns false if the browser stops answering seeks.
  async function sampleBySeeking(video, vol, span, duration, take, cancelled) {
    if (video.readyState < 2) await waitFor(video, 'loadeddata', 4000, 'decoding the first frame').catch(() => {});
    for (let i = 0; i < vol.T; i++) {
      const seeked = waitFor(video, 'seeked', 6000, 'seeking');
      video.currentTime = Math.min(((i + 0.5) / vol.T) * span, duration - 0.001);
      try {
        await seeked;
      } catch (err) {
        if (err.code === 'stalled') return false;
        throw err;
      }
      if (cancelled()) return true;
      take(i, i);
    }
    return true;
  }

  // Play the clip muted at up to 4× and catch frames as they are shown. Returns how many time slots got a frame.
  async function sampleByPlaying(video, vol, span, take, cancelled) {
    if (!video.requestVideoFrameCallback) throw new Error("This browser can't step through a video's frames. Try a recent Safari, Chrome or Firefox.");
    const T = vol.T, slot = span / T;
    // as fast as possible while a 60 Hz screen still shows about one frame per time slot
    const rate = clamp(Math.floor(slot * 60 * 0.8 * 4) / 4, 0.5, 4);
    try {
      video.defaultPlaybackRate = rate;
      video.playbackRate = rate;
    } catch {
      video.playbackRate = 1;
    }
    if (video.currentTime > 0) video.currentTime = 0;
    let next = 0;
    await new Promise((resolve, reject) => {
      let done = false, watchdog = 0, nudged = false;
      const play = () => video.play().catch((err) => {
        if (done) return;
        if (err.name !== 'NotAllowedError') return finish(err);
        // Low Power Mode on iPhone, for one, only plays video after a tap.
        setStatus('Tap Start sampling: this browser only plays the video after a tap.');
        ui.resume.hidden = false;
      });
      const resume = () => {
        ui.resume.hidden = true;
        play();
      };
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        video.removeEventListener('ended', onEnded);
        document.removeEventListener('visibilitychange', onVisible);
        ui.resume.removeEventListener('click', resume);
        ui.resume.hidden = true;
        video.pause();
        if (err) reject(err); else resolve();
      };
      const guard = () => {  // give up if frames stop coming while the page is in view
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          if (done) return;
          if (cancelled()) return finish();
          if (document.hidden || !ui.resume.hidden) return guard();
          if (!nudged) {
            nudged = true;
            play();
            return guard();
          }
          finish(new Error('The video stopped playing while it was being sampled. Try again, or try a shorter clip.'));
        }, 8000);
      };
      const onFrame = (now, meta) => {
        if (done) return;
        if (cancelled()) return finish();
        const i = Math.min(T - 1, Math.floor(meta.mediaTime / slot));
        if (i >= next) {
          take(next, i);  // slots skipped by a dropped frame reuse this one
          next = i + 1;
        }
        if (next >= T || meta.mediaTime >= span) return finish();
        nudged = false;
        guard();
        video.requestVideoFrameCallback(onFrame);
      };
      const onEnded = () => finish();
      // Frames can't be caught while the page is out of view, so pause until it is back.
      const onVisible = () => {
        if (document.hidden) video.pause();
        else if (video.paused && ui.resume.hidden) play();
      };
      video.addEventListener('ended', onEnded);
      document.addEventListener('visibilitychange', onVisible);
      ui.resume.addEventListener('click', resume);
      video.requestVideoFrameCallback(onFrame);
      guard();
      play();
    });
    return next;
  }

  async function loadFile(file) {
    if (!file) return;
    const token = ++loadToken;
    const cancelled = () => token !== loadToken;
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
      if (cancelled()) return;
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
      const take = (from, to) => {  // the frame on show fills time slots from..to
        ctx.drawImage(video, 0, 0, W, H);
        const pixels = ctx.getImageData(0, 0, W, H).data;
        for (let i = from; i <= to; i++) pushFrame(vol, i, pixels);
        setProgress((to + 1) / T);
        setStatus(`Sampling ${file.name} · frame ${to + 1} of ${T}`);
      };
      const seeked = !WEBKIT && await sampleBySeeking(video, vol, span, duration, take, cancelled);
      if (cancelled()) return;
      if (!seeked) {
        const filled = await sampleByPlaying(video, vol, span, take, cancelled);
        if (cancelled()) return;
        if (!filled) throw new Error(`No frames could be caught while ${file.name} played. Keep this page open and in view while it samples, then try again.`);
        if (filled < T) take(filled, T - 1);  // the clip ended a little early: hold its last frame
      }
      const note = duration > MAX_SECONDS + 0.05 ? ` (the first minute of ${formatSeconds(duration)})` : '';
      finishVolume(vol, note);
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 0));  // a policy violation can be reported just after the error
      if (cancelled()) return;
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

  ui.presets.forEach((button) => button.addEventListener('click', () => reshape(PRESETS[button.dataset.preset])));
  ui.depth.addEventListener('input', () => setDepth(Number(ui.depth.value)));
  const params = [['omega', ui.angles.omega, -180, 180], ['phi', ui.angles.phi, -180, 180], ['kappa', ui.angles.kappa, -180, 180], ['sphere', ui.sphere, 0, 1]];
  for (const [key, [range, number], lo, hi] of params) {
    range.addEventListener('input', () => reshape({ [key]: Number(range.value) }));
    number.addEventListener('input', () => {  // typed values apply as you type
      const v = parseFloat(number.value);
      if (Number.isFinite(v)) reshape({ [key]: clamp(v, lo, hi) });
    });
    number.addEventListener('change', () => { number.value = String(state[key]); });
  }
  ui.modeGhost.addEventListener('click', () => setMode('ghost'));
  ui.modeCut.addEventListener('click', () => setMode('cut'));
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
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && sheet) {
      e.preventDefault();
      setDepth(state.depth + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1) * sheet.depthStep);
    } else if (e.key === '1' || e.key === '2' || e.key === '3') {
      reshape(PRESETS[['xy', 'xz', 'zy'][Number(e.key) - 1]]);
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
  setMode('ghost');
  setPlaying(false);
  syncFill(ui.size);
  update();
  requestAnimationFrame(loop);
  loadDemo();
})();
