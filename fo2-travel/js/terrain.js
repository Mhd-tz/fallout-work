/* =============================================================================
 * terrain.js - the wasteland as a real 3D heightfield.
 *
 * The map is a shaded mesh, not a painted plane: every cell has a height, a
 * normal and its own lighting, so mountains rise, valleys shade, and anything
 * standing on the map (the car, the counters, the route) shares one coordinate
 * space with the ground under it.
 *
 * Rendering is plain Canvas2D path fills under whatever transform the caller
 * has set, so device-pixel-ratio scaling is handled by the caller's transform
 * and never fights the projection.
 *
 * Roads, rivers and the route are NOT baked in - they are drawn as projected
 * polylines that drape over the relief (see main.js), which keeps them crisp
 * at every zoom.
 * ========================================================================== */
(function (global) {
  "use strict";

  var W = global.WORLD;
  var SIZE = W.SIZE;

  var HF = 385;        // heightfield sampling resolution
  var GN = 384;        // render grid: GN x GN cells, (GN+1)^2 vertices
  var ROADRES = 320;   // road mask resolution (driving model)
  var GRID = 24;       // fog-of-war cells per axis (the FO2 survey grid)

  var SEA = 0.30;
  var RELIEF = 72;     // world units from sea level to the highest peak
  var TARGET_QUADS = 3000;

  /* --- seeded value noise ------------------------------------------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeNoise(seed) {
    var rnd = mulberry32(seed);
    var N = 256, perm = new Uint8Array(512), grad = new Float32Array(N), i;
    for (i = 0; i < N; i++) grad[i] = rnd();
    for (i = 0; i < 512; i++) perm[i] = (Math.floor(rnd() * 256)) & 255;
    function val(ix, iy) { return grad[(perm[(ix & 255)] + perm[(iy & 255)]) & 255]; }
    function smooth(t) { return t * t * (3 - 2 * t); }
    return function (x, y) {
      var ix = Math.floor(x), iy = Math.floor(y);
      var fx = smooth(x - ix), fy = smooth(y - iy);
      var a = val(ix, iy), b = val(ix + 1, iy);
      var c = val(ix, iy + 1), d = val(ix + 1, iy + 1);
      var top = a + (b - a) * fx;
      return top + ((c + (d - c) * fx) - top) * fy;
    };
  }

  var noise = makeNoise(20770412);
  function fbm(x, y, oct, lac, gain) {
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < oct; i++) {
      sum += noise(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain; freq *= lac;
    }
    return sum / norm;
  }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* --- coastline: the Pacific down the south-west, bay at San Francisco --- */
  function coastX(z) {
    return (z - 395) * 0.78 + (fbm(z * 0.011, 7.3, 3, 2, 0.5) - 0.5) * 90;
  }
  function landMask(x, z) {
    var d = x - coastX(z);
    var bay = 1 - Math.min(1, Math.hypot(x - 150, z - 585) / 105);
    return d - bay * 105;
  }

  /* --- hydrology -----------------------------------------------------------
   * Rivers carve a channel into the base terrain and then flood it. The water
   * surface follows the bank height at the nearest centreline point, so a
   * river actually runs downhill from its source to its mouth.
   */
  var CHANNEL = 24;      // how far out the banks are pulled down
  var RIVER_W = 9.5;     // half-width of open water
  var CARVE = 0.078;     // depth of the cut, in normalised height
  var SURFACE = 0.044;   // water sits this far below the original bank

  var riverLines = [];   // { pts, lvl[] } - lvl is the water surface per vertex

  /**
   * Build each river's surface profile. A river must lose height from source
   * to mouth, so the sampled bank levels are forced monotonically downhill and
   * the mouth is tied to its lake. Without this the water climbed hills.
   */
  function buildRivers() {
    // Provisional lake levels first; a river reaching one pins it lower.
    W.LAKES.forEach(function (l) {
      l._level = baseHeight(l.x, l.z) - 0.030;
    });

    riverLines = W.RIVERS.map(function (r) {
      var pts = r.pts;
      var lvl = new Array(pts.length);
      for (var i = 0; i < pts.length; i++) lvl[i] = baseHeight(pts[i][0], pts[i][1]);
      for (i = 1; i < lvl.length; i++) {
        lvl[i] = Math.min(lvl[i], lvl[i - 1] - 0.005);
      }
      // Mouth: settle into the lake it drains to, if any.
      var last = pts.length - 1;
      var lk = lakeAt(pts[last][0], pts[last][1]);
      if (lk) {
        lvl[last] = Math.min(lvl[last], lk._level);
        lk._level = Math.min(lk._level, lvl[last]);
      }
      return { pts: pts, lvl: lvl, name: r.name };
    });
  }

  /** Lake containing a point, with a 0..1 falloff toward its shore. */
  function lakeInfo(x, z) {
    for (var i = 0; i < W.LAKES.length; i++) {
      var l = W.LAKES[i];
      var d = Math.hypot(x - l.x, z - l.z);
      if (d < l.r) return { lake: l, d: d, k: 1 - d / l.r };
    }
    return null;
  }

  function lakeAt(x, z) {
    for (var i = 0; i < W.LAKES.length; i++) {
      var l = W.LAKES[i];
      if (Math.hypot(x - l.x, z - l.z) < l.r) return l;
    }
    return null;
  }

  /** Nearest point on any river, with the interpolated water surface there. */
  function riverInfo(x, z) {
    var bd = 1e9, bx = 0, bz = 0, blvl = 0;
    for (var r = 0; r < riverLines.length; r++) {
      var line = riverLines[r], pts = line.pts;
      for (var i = 1; i < pts.length; i++) {
        var ax = pts[i - 1][0], az = pts[i - 1][1];
        var dx = pts[i][0] - ax, dz = pts[i][1] - az;
        var L2 = dx * dx + dz * dz;
        var t = L2 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        var px = ax + dx * t, pz = az + dz * t;
        var d = Math.hypot(px - x, pz - z);
        if (d < bd) {
          bd = d; bx = px; bz = pz;
          blvl = line.lvl[i - 1] + (line.lvl[i] - line.lvl[i - 1]) * t;
        }
      }
    }
    return { d: bd, x: bx, z: bz, level: blvl };
  }

  /* --- height ------------------------------------------------------------- */
  var height = new Float32Array(HF * HF);

  function baseHeight(x, z) {
    var nx = x / SIZE, nz = z / SIZE;

    // Basins first. The FO2 map is mostly flat desert, so the default state of
    // the map is flat - relief is added deliberately, not sampled everywhere.
    var basin = (fbm(nx * 2.3, nz * 2.3, 4, 2.0, 0.42) - 0.5) * 0.26;
    var local = (fbm(nx * 6.5 + 3, nz * 6.5 + 8, 3, 2.1, 0.38) - 0.5) * 0.045;

    // Two named ranges, masked so mountains only exist where they belong.
    var sierra  = Math.max(0, 1 - Math.abs(nx - 0.80) * 5.2);
    var coastal = Math.max(0, 1 - Math.abs(nx - 0.15) * 8.5);
    var ridge = 1 - Math.abs(fbm(nx * 3.1 + 11, nz * 3.1 + 4, 4, 2.1, 0.5) * 2 - 1);
    var range = sierra * sierra * 0.92 + coastal * coastal * 0.40;
    var mtn = range * (0.35 + ridge * ridge * 0.85);

    // A broad flat trough down the middle - the central valley.
    var valley = Math.max(0, 1 - Math.abs(nx - 0.48) * 3.2);
    var h = basin + local + mtn * 0.62 - valley * 0.05;

    var land = landMask(x, z);
    if (land < 0) return SEA + Math.max(-0.30, land * 0.0035);
    // Fade the outer border down to sea level: the map should read as a
    // surveyed plateau, not a slab that stops in mid-air.
    var edge = Math.min(x, SIZE - x, z, SIZE - z);
    // Smoothstep, and narrow: a wide linear taper built a hard diagonal ridge
    // across the map corners.
    var te = clamp01(edge / 40);
    var taper = te * te * (3 - 2 * te);
    var shore = Math.min(1, land / 60);
    return SEA + 0.035 + Math.max(0, h) * shore * taper;
  }

  /** Terrain height including the river channels and lake basins. */
  function rawHeight(x, z) {
    var h = baseHeight(x, z);
    if (h <= SEA) return h;

    // Blend the ground down to a bed that is genuinely below the water
    // surface, so the channel holds its river instead of the water sitting on
    // top of a ridge.
    var ri = riverInfo(x, z);
    if (ri.d < CHANNEL) {
      var k = 1 - ri.d / CHANNEL;
      k = k * k;
      h = h * (1 - k) + (ri.level - 0.026) * k;
    }
    var li = lakeInfo(x, z);
    if (li) {
      var lk = li.k * li.k;
      h = h * (1 - lk) + (li.lake._level - 0.030) * lk;
    }
    return h;
  }

  /**
   * Water surface height at a point, or null for dry ground. Rivers take the
   * bank level at their nearest centreline point, which is what makes the
   * surface follow the slope downstream instead of sitting flat.
   */
  function waterLevelAt(x, z) {
    var li = lakeInfo(x, z);
    if (li && li.d < li.lake.r * 0.86) return li.lake._level;
    var ri = riverInfo(x, z);
    if (ri.d < RIVER_W) {
      if (ri.level <= SEA) return null;          // already in the ocean
      return ri.level;
    }
    return null;
  }

  function buildHeight() {
    buildRivers();
    var s = SIZE / (HF - 1);
    for (var j = 0; j < HF; j++) {
      for (var i = 0; i < HF; i++) height[j * HF + i] = rawHeight(i * s, j * s);
    }
  }

  function heightAt(x, z) {
    var s = (HF - 1) / SIZE;
    var fx = Math.min(HF - 1.001, Math.max(0, x * s));
    var fz = Math.min(HF - 1.001, Math.max(0, z * s));
    var i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
    var h00 = height[j * HF + i], h10 = height[j * HF + i + 1];
    var h01 = height[(j + 1) * HF + i], h11 = height[(j + 1) * HF + i + 1];
    var top = h00 + (h10 - h00) * tx;
    return top + ((h01 + (h11 - h01) * tx) - top) * tz;
  }

  /** Ground elevation in world units. Everything that stands on the map uses
   *  this, so props and terrain can never disagree. */
  function hToRelief(h) {
    if (h <= SEA) return 0;
    return ((h - SEA) / (1 - SEA)) * RELIEF;
  }

  function reliefAt(x, z) {
    return hToRelief(heightAt(x, z));
  }

  /**
   * Ground the car and props actually rest on: the terrain, except on a bridge
   * deck, which spans the channel at bank height.
   */
  var decks = [];
  function setDecks(list) { decks = list || []; }

  function surfaceAt(x, z) {
    for (var i = 0; i < decks.length; i++) {
      var d = decks[i];
      if (Math.abs(x - d.x) < d.r && Math.abs(z - d.z) < d.r &&
          Math.hypot(x - d.x, z - d.z) < d.r) return d.y;
    }
    return reliefAt(x, z);
  }

  function onDeck(x, z) {
    for (var i = 0; i < decks.length; i++) {
      var d = decks[i];
      if (Math.hypot(x - d.x, z - d.z) < d.r) return decks[i];
    }
    return null;
  }

  /* --- regions ------------------------------------------------------------ */
  function nearestRegion(x, z) {
    var best = null, bestD = 1e9, second = 1e9;
    for (var i = 0; i < W.LOCATIONS.length; i++) {
      var l = W.LOCATIONS[i];
      var d = (l.x - x) * (l.x - x) + (l.z - z) * (l.z - z);
      if (d < bestD) { second = bestD; bestD = d; best = l; }
      else if (d < second) second = d;
    }
    return { region: best ? best.region : "wastes",
             edge: Math.sqrt(second) - Math.sqrt(bestD) };
  }

  /* --- palette ------------------------------------------------------------ */
  function hex(h) {
    var n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  var PAL = {
    deep:    hex("#0e1a24"), sea:   hex("#1a3143"), shallow: hex("#2a5162"),
    beach:   hex("#9c8b5d"), scrub: hex("#6b7742"), dust:    hex("#8f7b46"),
    rock:    hex("#6d5a3c"), high:  hex("#544835"), peak:    hex("#7b7261")
  };
  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  /* --- render grid -------------------------------------------------------- */
  var VN = GN + 1;
  var vhArr = new Float32Array(VN * VN);         // vertex heights (world units)
  var cellR = new Uint8Array(GN * GN);
  var cellG = new Uint8Array(GN * GN);
  var cellB = new Uint8Array(GN * GN);
  var cellWater = new Uint8Array(GN * GN);
  var CS = SIZE / GN;                            // cell size in world units

  function buildGrid() {
    var i, j;
    for (j = 0; j < VN; j++) {
      for (i = 0; i < VN; i++) {
        var vx = i * CS, vz = j * CS;
        var wl = waterLevelAt(vx, vz);
        vhArr[j * VN + i] = wl === null ? reliefAt(vx, vz) : hToRelief(wl);
      }
    }

    for (j = 0; j < GN; j++) {
      for (i = 0; i < GN; i++) {
        var x = (i + 0.5) * CS, z = (j + 0.5) * CS;
        var h = heightAt(x, z), col, water = 0;

        var wlc = waterLevelAt(x, z);
        if (h <= SEA || wlc !== null) {
          water = 1;
          if (wlc !== null) h = wlc;
          var t = Math.min(1, (SEA - h) / 0.16);
          col = mix(PAL.shallow, PAL.deep, t);
          col = mix(col, PAL.sea, fbm(x * 0.03, z * 0.03, 2, 2, 0.5) * 0.5);
        } else {
          var e = (h - SEA) / (1 - SEA);
          var veg = fbm(x * 0.009 + 70, z * 0.009 + 41, 4, 2.1, 0.55);
          var dry = fbm(x * 0.006 + 30, z * 0.006 + 12, 3, 2, 0.5);

          if (e < 0.035) col = mix(PAL.beach, PAL.scrub, e / 0.035);
          else if (e < 0.32) col = mix(PAL.dust, PAL.scrub, 0.35);
          else if (e < 0.60) col = mix(PAL.dust, PAL.rock, (e - 0.32) / 0.28);
          else if (e < 0.83) col = mix(PAL.rock, PAL.high, (e - 0.60) / 0.23);
          else col = mix(PAL.high, PAL.peak, (e - 0.83) / 0.17);

          col = mix(col, PAL.scrub, clamp01((veg - 0.44) * 2.3) * 0.34);
          col = mix(col, PAL.dust, clamp01((dry - 0.5) * 1.4) * 0.22);

          var nr = nearestRegion(x, z);
          var rg = W.region(nr.region);
          if (rg) col = mix(col, hex(rg.color), 0.14);
          if (nr.edge < 5) col = mix(col, [26, 24, 20], (1 - nr.edge / 5) * 0.5);

        }

        // Radiation blooms tint the ground rather than glowing over it.
        for (var k = 0; k < W.HAZARDS.length; k++) {
          var hz = W.HAZARDS[k];
          var d2 = Math.hypot(hz.x - x, hz.z - z);
          if (d2 < hz.r) {
            var f = (1 - d2 / hz.r) * 0.5;
            col = mix(col, hz.kind === "tox" ? [120, 170, 60] : [96, 190, 110], f);
          }
        }

        var idx = j * GN + i;
        cellR[idx] = Math.max(0, Math.min(255, col[0]));
        cellG[idx] = Math.max(0, Math.min(255, col[1]));
        cellB[idx] = Math.max(0, Math.min(255, col[2]));
        cellWater[idx] = water;
      }
    }
  }

  /* --- colour mips ---------------------------------------------------------
   * At low LOD each drawn quad covers many cells. Point-sampling the centre
   * cell made the map a patchwork quilt, so every level is a 2x2 average of
   * the one below and the renderer samples the level matching its step.
   */
  var mipR = [], mipG = [], mipB = [], mipW = [], mipN = [];
  // Geometry needs the same treatment as colour: rendering a coarse quad from
  // level-0 corner heights made every quad's normal jump, which read as a
  // quilt. Each level is a tent-filtered halving, so the mesh gets smoother
  // exactly as fast as it gets coarser.
  var mipH = [], mipVN = [];

  function buildHeightMips() {
    mipH = [vhArr]; mipVN = [VN];
    var lvl = 0;
    while (mipVN[lvl] > 5 && lvl < 6) {
      var pn = mipVN[lvl], prev = mipH[lvl];
      var n = ((pn - 1) >> 1) + 1;
      var arr = new Float32Array(n * n);
      for (var j = 0; j < n; j++) {
        for (var i = 0; i < n; i++) {
          var si = i * 2, sj = j * 2, sum = 0, wsum = 0;
          for (var dj = -1; dj <= 1; dj++) {
            var yj = sj + dj;
            if (yj < 0 || yj >= pn) continue;
            for (var di = -1; di <= 1; di++) {
              var xi = si + di;
              if (xi < 0 || xi >= pn) continue;
              var wgt = (di === 0 ? 2 : 1) * (dj === 0 ? 2 : 1);
              sum += prev[yj * pn + xi] * wgt;
              wsum += wgt;
            }
          }
          arr[j * n + i] = sum / wsum;
        }
      }
      lvl++;
      mipH[lvl] = arr; mipVN[lvl] = n;
    }
  }

  function buildMips() {
    mipR = [cellR]; mipG = [cellG]; mipB = [cellB]; mipW = [cellWater]; mipN = [GN];
    var n = GN, lvl = 0;
    while (n > 4 && lvl < 6) {
      var hn = n >> 1;
      var pr = mipR[lvl], pg = mipG[lvl], pb = mipB[lvl], pw = mipW[lvl];
      var nr = new Uint8Array(hn * hn), ng = new Uint8Array(hn * hn);
      var nb = new Uint8Array(hn * hn), nw = new Uint8Array(hn * hn);
      for (var j = 0; j < hn; j++) {
        for (var i = 0; i < hn; i++) {
          var a = (j * 2) * n + i * 2, b = a + 1, c = a + n, d = c + 1;
          var o = j * hn + i;
          nr[o] = (pr[a] + pr[b] + pr[c] + pr[d]) >> 2;
          ng[o] = (pg[a] + pg[b] + pg[c] + pg[d]) >> 2;
          nb[o] = (pb[a] + pb[b] + pb[c] + pb[d]) >> 2;
          nw[o] = (pw[a] + pw[b] + pw[c] + pw[d]) >= 2 ? 1 : 0;
        }
      }
      lvl++;
      mipR[lvl] = nr; mipG[lvl] = ng; mipB[lvl] = nb; mipW[lvl] = nw; mipN[lvl] = hn;
      n = hn;
    }
  }

  /* --- road mask (driving model only) ------------------------------------- */
  var roadMask = null;

  function roadPoints(r) {
    if (r._pts) return r._pts;
    var a = W.loc(r.a), b = W.loc(r.b);
    var ctrl = [[a.x, a.z]].concat(r.via || []).concat([[b.x, b.z]]);
    if (ctrl.length === 2) { r._pts = ctrl; return ctrl; }
    var pts = [];
    var ext = [ctrl[0]].concat(ctrl, [ctrl[ctrl.length - 1]]);
    for (var i = 1; i < ext.length - 2; i++) {
      var p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
      for (var t = 0; t < 1; t += 0.1) {
        var t2 = t * t, t3 = t2 * t;
        pts.push([
          0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
        ]);
      }
    }
    pts.push([b.x, b.z]);
    r._pts = pts;
    return pts;
  }

  function buildRoadMask() {
    var c = document.createElement("canvas");
    c.width = ROADRES; c.height = ROADRES;
    var g = c.getContext("2d");
    g.fillStyle = "#000"; g.fillRect(0, 0, ROADRES, ROADRES);
    var k = ROADRES / SIZE;
    g.strokeStyle = "#fff"; g.lineCap = "round"; g.lineJoin = "round";
    W.ROADS.forEach(function (r) {
      var pts = roadPoints(r);
      g.lineWidth = 2 + r.w * 3;
      g.beginPath();
      pts.forEach(function (p, i) {
        if (i === 0) g.moveTo(p[0] * k, p[1] * k); else g.lineTo(p[0] * k, p[1] * k);
      });
      g.stroke();
    });
    var d = g.getImageData(0, 0, ROADRES, ROADRES).data;
    roadMask = new Uint8Array(ROADRES * ROADRES);
    for (var i = 0; i < roadMask.length; i++) roadMask[i] = d[i * 4];
  }

  function onRoad(x, z) {
    var k = ROADRES / SIZE;
    var i = Math.round(x * k), j = Math.round(z * k);
    if (i < 0 || j < 0 || i >= ROADRES || j >= ROADRES) return 0;
    return roadMask[j * ROADRES + i] / 255;
  }

  /* --- fog of war (applied at render time, so reveals are instant) -------- */
  var discovered = new Uint8Array(GRID * GRID);

  function revealCircle(x, z, r) {
    var cell = SIZE / GRID, changed = false;
    var i0 = Math.max(0, Math.floor((x - r) / cell)), i1 = Math.min(GRID - 1, Math.floor((x + r) / cell));
    var j0 = Math.max(0, Math.floor((z - r) / cell)), j1 = Math.min(GRID - 1, Math.floor((z + r) / cell));
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        var cx = (i + 0.5) * cell, cz = (j + 0.5) * cell;
        if (Math.hypot(cx - x, cz - z) <= r + cell * 0.5 && !discovered[j * GRID + i]) {
          discovered[j * GRID + i] = 1;
          changed = true;
        }
      }
    }
    return changed;
  }

  function isDiscovered(x, z) {
    var cell = SIZE / GRID;
    var i = Math.floor(x / cell), j = Math.floor(z / cell);
    if (i < 0 || j < 0 || i >= GRID || j >= GRID) return false;
    return !!discovered[j * GRID + i];
  }

  function speedAt(x, z) {
    if (x < 0 || z < 0 || x > SIZE || z > SIZE) return 0;
    if (onDeck(x, z)) return 1;                    // the bridge is a road
    var h = heightAt(x, z);
    if (h <= SEA) return 0;
    if (waterLevelAt(x, z) !== null) return 0;     // ford it at a bridge only
    var road = onRoad(x, z);
    var e = (h - SEA) / (1 - SEA);
    var rough = 1 - Math.min(0.62, e * 0.85);
    return Math.max(0.22, rough) * (1 - road) + road * 1.0;
  }

  /* =========================================================================
   * 3D RENDER
   * ====================================================================== */
  var MAXV = 176;
  var pvx = new Float32Array(MAXV * MAXV);
  var pvy = new Float32Array(MAXV * MAXV);
  var pvok = new Uint8Array(MAXV * MAXV);
  var pvw = new Float32Array(MAXV * MAXV);
  var order = [];
  var qi = new Int32Array(MAXV * MAXV);
  var qj = new Int32Array(MAXV * MAXV);
  var qd = new Float32Array(MAXV * MAXV);

  // Colour strings are the one per-quad allocation, so they get cached by a
  // 15-bit quantised key instead of being rebuilt every frame.
  var colorCache = new Array(32768);
  function css(r, g, b) {
    var key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    var s = colorCache[key];
    if (s === undefined) {
      s = "rgb(" + (r & 248) + "," + (g & 248) + "," + (b & 248) + ")";
      colorCache[key] = s;
    }
    return s;
  }

  var SUN = [-0.42, 0.80, -0.43];

  /** World-space bounds of what the camera can currently see on the ground. */
  function visibleBounds(cam, maxDist) {
    var w = cam.viewport.w, h = cam.viewport.h;
    var pts = [];
    var corners = [[0, h], [w, h], [0, 0], [w, 0], [w * 0.5, 0]];
    for (var i = 0; i < corners.length; i++) {
      var g = cam.unproject(corners[i][0], corners[i][1]);
      if (g) {
        var d = Math.hypot(g.x - cam.eye[0], g.z - cam.eye[2]);
        if (d > maxDist) {
          // Clamp rays that shoot far past the draw distance.
          var k = maxDist / d;
          g = { x: cam.eye[0] + (g.x - cam.eye[0]) * k,
                z: cam.eye[2] + (g.z - cam.eye[2]) * k };
        }
        pts.push(g);
      }
    }
    // Above-horizon corners produce no hit; fall back to a disc around the eye.
    if (pts.length < 3) {
      return { x0: cam.tx - maxDist, x1: cam.tx + maxDist,
               z0: cam.tz - maxDist, z1: cam.tz + maxDist };
    }
    var x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (var k2 = 0; k2 < pts.length; k2++) {
      x0 = Math.min(x0, pts[k2].x); x1 = Math.max(x1, pts[k2].x);
      z0 = Math.min(z0, pts[k2].z); z1 = Math.max(z1, pts[k2].z);
    }
    var pad = CS * 2;
    return { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad };
  }

  var stats = { quads: 0, step: 1, ms: 0 };

  /**
   * Draw the terrain.
   * @param o { fogColor, hazeColor, night, seams }
   */
  function draw3D(ctx, cam, o) {
    o = o || {};
    var t0 = (global.performance && performance.now()) || 0;

    var maxDist = Math.max(700, cam.dist * 5.5);
    var b = visibleBounds(cam, maxDist);

    var i0 = Math.max(0, Math.floor(b.x0 / CS));
    var i1 = Math.min(GN - 1, Math.ceil(b.x1 / CS));
    var j0 = Math.max(0, Math.floor(b.z0 / CS));
    var j1 = Math.min(GN - 1, Math.ceil(b.z1 / CS));
    if (i1 < i0 || j1 < j0) { stats.quads = 0; return; }

    var total = (i1 - i0 + 1) * (j1 - j0 + 1);
    // Power of two: it lets the colour and height mips be indexed by a shift,
    // so the geometry the renderer draws is exactly the level it samples.
    var raw = Math.sqrt(total / TARGET_QUADS);
    var lvl0 = Math.max(0, Math.ceil(Math.log(Math.max(1, raw)) / Math.LN2));
    var step = 1 << lvl0;
    // Keep the vertex grid inside the preallocated buffers.
    while (((i1 - i0) / step + 2) > MAXV || ((j1 - j0) / step + 2) > MAXV) {
      lvl0++; step = 1 << lvl0;
    }
    var hLvl = Math.min(mipVN.length - 1, lvl0);
    var hN = mipVN[hLvl], hArr = mipH[hLvl];
    // Snap the window to the level grid so vertices land on real samples.
    i0 = (i0 >> lvl0) << lvl0;
    j0 = (j0 >> lvl0) << lvl0;
    stats.step = step;

    var nx = Math.floor((i1 - i0) / step) + 2;
    var nz = Math.floor((j1 - j0) / step) + 2;

    // 1. project the vertex grid
    var eyeX = cam.eye[0], eyeY = cam.eye[1], eyeZ = cam.eye[2];
    var vw = cam.viewport.w, vh2 = cam.viewport.h;
    var out = { x: 0, y: 0, w: 0, scale: 0 };
    for (var b2 = 0; b2 < nz; b2++) {
      var gj = Math.min(GN, j0 + b2 * step);
      var wz = gj * CS;
      for (var a2 = 0; a2 < nx; a2++) {
        var gi = Math.min(GN, i0 + a2 * step);
        var idx = b2 * MAXV + a2;
        var wx = gi * CS;
        var hi = Math.min(hN - 1, gi >> hLvl), hj = Math.min(hN - 1, gj >> hLvl);
        var wy = hArr[hj * hN + hi];
        var s = cam.project(wx, wy, wz, out);
        if (!s) { pvok[idx] = 0; continue; }
        pvok[idx] = 1;
        pvx[idx] = s.x; pvy[idx] = s.y; pvw[idx] = s.w;
      }
    }

    // 2. collect visible quads with a depth key
    var n = 0;
    var margin = 60;
    for (var b3 = 0; b3 < nz - 1; b3++) {
      for (var a3 = 0; a3 < nx - 1; a3++) {
        var i00 = b3 * MAXV + a3, i10 = i00 + 1;
        var i01 = i00 + MAXV, i11 = i01 + 1;
        if (!pvok[i00] || !pvok[i10] || !pvok[i01] || !pvok[i11]) continue;

        var minx = Math.min(pvx[i00], pvx[i10], pvx[i01], pvx[i11]);
        if (minx > vw + margin) continue;
        var maxx = Math.max(pvx[i00], pvx[i10], pvx[i01], pvx[i11]);
        if (maxx < -margin) continue;
        var miny = Math.min(pvy[i00], pvy[i10], pvy[i01], pvy[i11]);
        if (miny > vh2 + margin) continue;
        var maxy = Math.max(pvy[i00], pvy[i10], pvy[i01], pvy[i11]);
        if (maxy < -margin) continue;

        qi[n] = a3; qj[n] = b3;
        qd[n] = pvw[i00] + pvw[i10] + pvw[i01] + pvw[i11];
        n++;
      }
    }

    // 3. painter's order: far to near
    if (order.length < n) { order = new Array(n); }
    for (var m = 0; m < n; m++) order[m] = m;
    var slice = order.length === n ? order : order.slice(0, n);
    slice.sort(function (p, q) { return qd[q] - qd[p]; });

    // 4. fill
    var lvl = Math.min(mipN.length - 1, lvl0);
    var mn = mipN[lvl], mR = mipR[lvl], mG = mipG[lvl], mB = mipB[lvl], mW = mipW[lvl];
    var mScale = mn / SIZE;

    var L = o.light || { dir: SUN, amb: o.night ? 0.26 : 0.38, intensity: 1, tint: [1, 1, 1] };
    var sunX = L.dir[0], sunY = L.dir[1], sunZ = L.dir[2];
    var amb = L.amb, inten = L.intensity;
    var tintR = L.tint[0], tintG = L.tint[1], tintB = L.tint[2];
    var fogC = o.haze || (o.night ? [18, 26, 38] : [120, 122, 104]);
    var fogR = fogC[0], fogG = fogC[1], fogB = fogC[2];
    var fogNear = maxDist * 0.45, fogFar = maxDist * 1.05;
    var invS = 1 / (step * CS);
    var seams = o.seams !== false;

    ctx.lineJoin = "round";
    ctx.lineWidth = 1;

    for (var q = 0; q < n; q++) {
      var qq = slice[q];
      var a = qi[qq], bb = qj[qq];
      var v00 = bb * MAXV + a, v10 = v00 + 1, v01 = v00 + MAXV, v11 = v01 + 1;

      var cx = (i0 + a * step + step * 0.5) * CS;
      var cz = (j0 + bb * step + step * 0.5) * CS;
      var mi = Math.max(0, Math.min(mn - 1, (cx * mScale) | 0));
      var mj = Math.max(0, Math.min(mn - 1, (cz * mScale) | 0));
      var ci = mj * mn + mi;
      var r, g2, bl;

      if (!isDiscovered(cx, cz)) {
        // Unsurveyed: flat black cells, hard edged, exactly like the FO2 map.
        r = 7; g2 = 9; bl = 12;
      } else {
        // Smooth shading: average the four corner normals, each from central
        // differences on the level grid. Using the quad's own corners alone
        // made every facet jump, which is what read as "pixelated".
        var ha = Math.min(hN - 1, (i0 + a * step) >> hLvl);
        var hb = Math.min(hN - 1, (j0 + bb * step) >> hLvl);
        var ha1 = Math.min(hN - 1, ha + 1), hb1 = Math.min(hN - 1, hb + 1);
        var nX = 0, nZ = 0;
        for (var cn = 0; cn < 4; cn++) {
          var vi = (cn & 1) ? ha1 : ha, vj = (cn & 2) ? hb1 : hb;
          var im = vi > 0 ? vi - 1 : 0, ip = vi < hN - 1 ? vi + 1 : hN - 1;
          var jm = vj > 0 ? vj - 1 : 0, jp = vj < hN - 1 ? vj + 1 : hN - 1;
          nX += (hArr[vj * hN + im] - hArr[vj * hN + ip]) / ((ip - im) || 1);
          nZ += (hArr[jm * hN + vi] - hArr[jp * hN + vi]) / ((jp - jm) || 1);
        }
        nX *= 0.25 * invS * step; nZ *= 0.25 * invS * step;
        var nl = Math.sqrt(nX * nX + 1 + nZ * nZ);
        var lam = (nX * sunX + sunY + nZ * sunZ) / nl;
        var k3 = amb + Math.max(0, lam) * (1 - amb) * 1.62 * inten;
        // Slopes facing away from the light get pushed down harder than a pure
        // lambert would, which is what makes the relief read at map scale.
        if (lam < 0) k3 *= 1 + lam * 0.55;

        // Water catches a flat sheen instead of terrain shading.
        if (mW[ci]) k3 = o.night ? 0.5 : 0.95;

        r = mR[ci] * k3 * tintR; g2 = mG[ci] * k3 * tintG; bl = mB[ci] * k3 * tintB;

        var depth = qd[qq] * 0.25;
        if (depth > fogNear) {
          var f2 = Math.min(1, (depth - fogNear) / (fogFar - fogNear)) * 0.85;
          r += (fogR - r) * f2; g2 += (fogG - g2) * f2; bl += (fogB - bl) * f2;
        }
        if (r > 255) r = 255; if (g2 > 255) g2 = 255; if (bl > 255) bl = 255;
        if (r < 0) r = 0; if (g2 < 0) g2 = 0; if (bl < 0) bl = 0;
      }

      var style = css(r | 0, g2 | 0, bl | 0);
      ctx.fillStyle = style;
      ctx.beginPath();
      ctx.moveTo(pvx[v00], pvy[v00]);
      ctx.lineTo(pvx[v10], pvy[v10]);
      ctx.lineTo(pvx[v11], pvy[v11]);
      ctx.lineTo(pvx[v01], pvy[v01]);
      ctx.closePath();
      ctx.fill();
      // Antialiased quad edges leave hairline seams; a same-colour stroke of
      // one pixel closes them without a second geometry pass.
      if (seams) { ctx.strokeStyle = style; ctx.stroke(); }
    }

    stats.quads = n;
    stats.ms = ((global.performance && performance.now()) || 0) - t0;
  }

  /** Ground normal at a point, for props that must sit flat on a slope. */
  function normalAt(x, z) {
    var d = 6;
    var nX = (reliefAt(x - d, z) - reliefAt(x + d, z)) / (2 * d);
    var nZ = (reliefAt(x, z - d) - reliefAt(x, z + d)) / (2 * d);
    var l = Math.sqrt(nX * nX + 1 + nZ * nZ);
    return [nX / l, 1 / l, nZ / l];
  }

  global.TERRAIN = {
    SEA: SEA,
    normalAt: normalAt,
    GRID: GRID,
    RELIEF: RELIEF,
    CS: CS,
    stats: stats,
    build: function () {
      buildHeight();
      buildRoadMask();
      buildGrid();
      buildMips();
      buildHeightMips();
    },
    draw3D: draw3D,
    /** Quality knob: target number of terrain quads per frame. */
    setTarget: function (n) { TARGET_QUADS = Math.max(400, n | 0); },
    getTarget: function () { return TARGET_QUADS; },
    heightAt: heightAt,
    reliefAt: reliefAt,
    surfaceAt: surfaceAt,
    onDeck: onDeck,
    setDecks: setDecks,
    baseHeight: baseHeight,
    hToRelief: hToRelief,
    waterLevelAt: waterLevelAt,
    riverInfo: riverInfo,
    speedAt: speedAt,
    onRoad: onRoad,
    isWater: function (x, z) { return heightAt(x, z) <= SEA; },
    roadPoints: roadPoints,
    revealCircle: revealCircle,
    revealAll: function () { for (var i = 0; i < discovered.length; i++) discovered[i] = 1; },
    isDiscovered: isDiscovered,
    discovered: discovered
  };
})(window);
