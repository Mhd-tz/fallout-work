/* =============================================================================
 * r3.js - micro 3D renderer for Canvas2D
 * -----------------------------------------------------------------------------
 * PrismaUI_F4 runs on Ultralight (WebKit fork). Ultralight has NO WebGL and no
 * 3D CSS transforms, so three.js / css3d are not options in-game. This module
 * provides just enough 3D to build a Hearts-of-Iron style map:
 *
 *   - mat4 / vec3 math (column-major, gl-matrix layout)
 *   - a perspective camera orbiting a ground target
 *   - project() / unproject(): world <-> screen, plus a ground-plane
 *     homography for picking and for the terrain's visible-bounds estimate
 *   - drawMesh(): painter's-algorithm polygon rendering with directional light
 *
 * The terrain itself is a heightfield mesh drawn by terrain.js; this module
 * supplies the camera and the props that stand on it.
 *
 * No dependencies. No modules (PrismaUI loads views off disk; file:// + ES
 * modules trips CORS in WebKit, so everything is a plain global).
 * ========================================================================== */
(function (global) {
  "use strict";

  var R3 = {};

  /* --- mat4 ---------------------------------------------------------------
   * Column-major: element (row r, col c) lives at m[c * 4 + r].
   */
  R3.mat4 = {
    create: function () {
      return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    },

    perspective: function (out, fovyRad, aspect, near, far) {
      var f = 1 / Math.tan(fovyRad / 2);
      var nf = 1 / (near - far);
      out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
      out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
      out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
      out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
      return out;
    },

    lookAt: function (out, eye, center, up) {
      var zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
      var zl = Math.hypot(zx, zy, zz) || 1;
      zx /= zl; zy /= zl; zz /= zl;

      var xx = up[1] * zz - up[2] * zy,
          xy = up[2] * zx - up[0] * zz,
          xz = up[0] * zy - up[1] * zx;
      var xl = Math.hypot(xx, xy, xz) || 1;
      xx /= xl; xy /= xl; xz /= xl;

      var yx = zy * xz - zz * xy,
          yy = zz * xx - zx * xz,
          yz = zx * xy - zy * xx;

      out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
      out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
      out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
      out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
      out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
      out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
      out[15] = 1;
      return out;
    },

    multiply: function (out, a, b) {
      for (var c = 0; c < 4; c++) {
        var b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
        out[c * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
        out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
        out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
      }
      return out;
    }
  };

  /* --- 3x3 inverse (used for the screen -> ground homography) ------------- */
  function inv3(m) {
    var a = m[0], b = m[1], c = m[2],
        d = m[3], e = m[4], f = m[5],
        g = m[6], h = m[7], i = m[8];
    var A =  (e * i - f * h), B = -(d * i - f * g), C =  (d * h - e * g);
    var det = a * A + b * B + c * C;
    if (!det) return null;
    var id = 1 / det;
    return [
      A * id, (c * h - b * i) * id, (b * f - c * e) * id,
      B * id, (a * i - c * g) * id, (c * d - a * f) * id,
      C * id, (b * g - a * h) * id, (a * e - b * d) * id
    ];
  }

  /* =========================================================================
   * Camera - orbits a point on the ground plane.
   *   yaw   0 = looking north (-Z), north is up on screen
   *   pitch angle below the horizon, radians
   *   dist  eye distance from the target
   * ====================================================================== */
  function Camera() {
    this.tx = 500;
    this.tz = 500;
    // Height of the point the camera orbits. With real terrain relief this
    // must track the ground, or at close range the eye ends up inside a hill.
    this.ty = 0;
    this.yaw = 0;
    this.pitch = 0.86;
    this.dist = 420;
    this.fov = 0.72;
    this.near = 4;
    this.far = 12000;

    this.eye = [0, 0, 0];
    this.vp = R3.mat4.create();
    this._v = R3.mat4.create();
    this._p = R3.mat4.create();
    this.viewport = { w: 1, h: 1 };
    this.H = null;     // ground(X,Z,1) -> screen(u,v,w)
    this.Hinv = null;  // screen -> ground
  }

  Camera.prototype.update = function (w, h) {
    this.viewport.w = w;
    this.viewport.h = h;

    var cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.eye[0] = this.tx + Math.sin(this.yaw) * cp * this.dist;
    this.eye[1] = this.ty + sp * this.dist;
    this.eye[2] = this.tz + Math.cos(this.yaw) * cp * this.dist;

    R3.mat4.lookAt(this._v, this.eye, [this.tx, this.ty, this.tz], [0, 1, 0]);
    R3.mat4.perspective(this._p, this.fov, w / h, this.near, this.far);
    R3.mat4.multiply(this.vp, this._p, this._v);

    // Collapse the reference plane y = ty out of the 4x4 into a 3x3
    // homography, then fold in the NDC -> pixel step so H maps (X, Z, 1)
    // straight to screen. Picking and the terrain's visible-bounds estimate
    // both ride on this plane, so it tracks the camera target's height.
    var m = this.vp, hw = w / 2, hh = h / 2, py = this.ty;
    var kx = m[4] * py + m[12];
    var ky = m[5] * py + m[13];
    var kw = m[7] * py + m[15];
    this.H = [
      hw * (m[0] + m[3]), hw * (m[8] + m[11]), hw * (kx + kw),
      hh * (m[3] - m[1]), hh * (m[11] - m[9]), hh * (kw - ky),
      m[3],               m[11],               kw
    ];
    this.Hinv = inv3(this.H);
    return this;
  };

  /** World point -> screen. Returns null when behind the near plane. */
  Camera.prototype.project = function (x, y, z, out) {
    var m = this.vp;
    var cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0.0001) return null;
    var cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    var cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    var iw = 1 / cw;
    out = out || {};
    out.x = (cx * iw * 0.5 + 0.5) * this.viewport.w;
    out.y = (0.5 - cy * iw * 0.5) * this.viewport.h;
    out.w = cw;
    // Handy for sizing billboards: pixels per world unit at that depth.
    out.scale = (this.viewport.h * 0.5 / Math.tan(this.fov / 2)) * iw;
    return out;
  };

  /** Screen pixel -> point on the ground plane. Null if the ray misses. */
  Camera.prototype.unproject = function (sx, sy) {
    var K = this.Hinv;
    if (!K) return null;
    var w = K[6] * sx + K[7] * sy + K[8];
    if (Math.abs(w) < 1e-9) return null;
    var X = (K[0] * sx + K[1] * sy + K[2]) / w;
    var Z = (K[3] * sx + K[4] * sy + K[5]) / w;
    if (w < 0) return null; // above the horizon
    return { x: X, z: Z };
  };

  /** Screen y of the horizon line (may be negative / off-screen). */
  Camera.prototype.horizonY = function () {
    var K = this.Hinv;
    if (!K) return 0;
    // w(sx, sy) = 0 -> the vanishing line. No roll, so it is horizontal.
    if (Math.abs(K[7]) < 1e-9) return -1e6;
    var sx = this.viewport.w / 2;
    return -(K[6] * sx + K[8]) / K[7];
  };

  R3.Camera = Camera;

  /* =========================================================================
   * Mesh rendering - painter's algorithm with a single directional light.
   * A mesh is { verts: [[x,y,z], ...], faces: [{ v:[i,j,k,...], c:'#rgb',
   * glow:bool, stroke:'#rgb' }] } in model space.
   * ====================================================================== */
  var DEFAULT_LIGHT = {
    dir: [-0.42, 0.80, -0.43],
    amb: 0.42,
    intensity: 1.0,
    tint: [1, 1, 1]
  };
  R3.DEFAULT_LIGHT = DEFAULT_LIGHT;

  function shade(hex, k, tint) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = r * k; g = g * k; b = b * k;
    if (tint) { r *= tint[0]; g *= tint[1]; b *= tint[2]; }
    r = r > 255 ? 255 : r | 0;
    g = g > 255 ? 255 : g | 0;
    b = b > 255 ? 255 : b | 0;
    return "rgb(" + r + "," + g + "," + b + ")";
  }
  R3.shade = shade;

  /**
   * @param xf {x,y,z, rot, pitch, roll, scale} placement in world space.
   *           rot = yaw about Y, pitch about the model's X, roll about Z -
   *           enough to sit a vehicle flat on a slope.
   * @param o  { light, alpha }
   */
  R3.drawMesh = function (ctx, mesh, cam, xf, o) {
    o = o || {};
    var L = o.light || DEFAULT_LIGHT;
    var sc = xf.scale === undefined ? 1 : xf.scale;

    // R = Ry(yaw) * Rx(pitch) * Rz(roll), expanded once per draw.
    var cy = Math.cos(xf.rot || 0), sy = Math.sin(xf.rot || 0);
    var cp = Math.cos(xf.pitch || 0), sp = Math.sin(xf.pitch || 0);
    var cr = Math.cos(xf.roll || 0), sr = Math.sin(xf.roll || 0);

    var m00 = cy * cr + sy * sp * sr, m01 = -cy * sr + sy * sp * cr, m02 = sy * cp;
    var m10 = cp * sr,                m11 = cp * cr,                 m12 = -sp;
    var m20 = -sy * cr + cy * sp * sr, m21 = sy * sr + cy * sp * cr, m22 = cy * cp;

    var verts = mesh.verts, n = verts.length;
    var wp = mesh._wp || (mesh._wp = []);
    var sps = mesh._sp || (mesh._sp = []);

    for (var i = 0; i < n; i++) {
      var v = verts[i];
      var x = v[0] * sc, y = v[1] * sc, z = v[2] * sc;
      var wx = m00 * x + m01 * y + m02 * z + xf.x;
      var wy = m10 * x + m11 * y + m12 * z + xf.y;
      var wz = m20 * x + m21 * y + m22 * z + xf.z;
      var t = wp[i] || (wp[i] = [0, 0, 0]);
      t[0] = wx; t[1] = wy; t[2] = wz;
      sps[i] = cam.project(wx, wy, wz, sps[i] || {});
    }

    var faces = mesh.faces, list = mesh._list || (mesh._list = []);
    list.length = 0;
    for (var fi = 0; fi < faces.length; fi++) {
      var face = faces[fi], idx = face.v, ok = true, depth = 0;
      for (var k = 0; k < idx.length; k++) {
        var sPt = sps[idx[k]];
        if (!sPt) { ok = false; break; }
        depth += sPt.w;
      }
      if (!ok) continue;
      face._d = depth / idx.length;
      list.push(face);
    }
    list.sort(function (p, q) { return q._d - p._d; });

    var amb = L.amb, inten = L.intensity, dir = L.dir, tint = L.tint;
    ctx.lineJoin = "round";
    if (o.alpha !== undefined) ctx.globalAlpha = o.alpha;

    for (var li = 0; li < list.length; li++) {
      var f2 = list[li], ix = f2.v;
      var A = wp[ix[0]], B = wp[ix[1]], C = wp[ix[2]];
      var ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
      var vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz2 = ux * vy - uy * vx;
      var nl = Math.hypot(nx, ny, nz2) || 1;
      var lam = (nx * dir[0] + ny * dir[1] + nz2 * dir[2]) / nl;

      var k2 = f2.glow ? 1.0 : amb + Math.max(0, lam) * (1 - amb) * 1.5 * inten;

      ctx.beginPath();
      for (var p = 0; p < ix.length; p++) {
        var s2 = sps[ix[p]];
        if (p === 0) ctx.moveTo(s2.x, s2.y); else ctx.lineTo(s2.x, s2.y);
      }
      ctx.closePath();
      ctx.fillStyle = f2.glow ? f2.c : shade(f2.c, k2, tint);
      ctx.fill();
      if (f2.stroke) {
        ctx.strokeStyle = f2.stroke;
        ctx.lineWidth = f2.lw || 1;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  };

  /** Project a world-space polyline; returns screen points (nulls dropped). */
  R3.projectPath = function (cam, pts, y) {
    var out = [], o = {};
    y = y || 0;
    for (var i = 0; i < pts.length; i++) {
      var s = cam.project(pts[i][0], y, pts[i][1], {});
      if (s) out.push(s);
    }
    return out;
  };

  /** Ground-plane circle -> screen polygon (an ellipse under perspective). */
  R3.groundCircle = function (ctx, cam, x, z, r, segs, y) {
    segs = segs || 28;
    y = y || 0;
    ctx.beginPath();
    var started = false;
    for (var i = 0; i <= segs; i++) {
      var a = (i / segs) * Math.PI * 2;
      var s = cam.project(x + Math.cos(a) * r, y, z + Math.sin(a) * r, {});
      if (!s) { started = false; continue; }
      if (!started) { ctx.moveTo(s.x, s.y); started = true; }
      else ctx.lineTo(s.x, s.y);
    }
  };

  global.R3 = R3;
})(window);
