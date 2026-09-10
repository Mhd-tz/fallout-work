/* =============================================================================
 * props.js - the things standing on the map.
 *
 * A heightfield alone reads as an empty sheet no matter how well it is shaded.
 * What makes a strategy map feel like a place is the clutter on top of it:
 * scrub and dead trees, rock outcrops, buildings clustered at the towns,
 * bridges where the roads cross the rivers, birds, and weather overhead.
 *
 * Scatter is procedural and deterministic - nothing is stored per prop, so the
 * world can be arbitrarily dense without any memory cost. Only the cells near
 * the camera are ever evaluated.
 * ========================================================================== */
(function (global) {
  "use strict";

  var W = global.WORLD, T = global.TERRAIN, R = global.R3;

  /* --- tiny mesh builder --------------------------------------------------- */
  function B() { this.verts = []; this.faces = []; }
  B.prototype.v = function (x, y, z) { this.verts.push([x, y, z]); return this.verts.length - 1; };
  B.prototype.f = function (idx, c) { this.faces.push({ v: idx, c: c }); };
  B.prototype.box = function (x0, x1, y0, y1, z0, z1, c, skip) {
    skip = skip || "";
    var p = [
      this.v(x0, y0, z0), this.v(x1, y0, z0), this.v(x1, y1, z0), this.v(x0, y1, z0),
      this.v(x0, y0, z1), this.v(x1, y0, z1), this.v(x1, y1, z1), this.v(x0, y1, z1)
    ];
    if (skip.indexOf("n") < 0) this.f([p[0], p[1], p[2], p[3]], c);
    if (skip.indexOf("s") < 0) this.f([p[5], p[4], p[7], p[6]], c);
    if (skip.indexOf("w") < 0) this.f([p[4], p[0], p[3], p[7]], c);
    if (skip.indexOf("e") < 0) this.f([p[1], p[5], p[6], p[2]], c);
    if (skip.indexOf("t") < 0) this.f([p[3], p[2], p[6], p[7]], c);
    if (skip.indexOf("b") < 0) this.f([p[4], p[5], p[1], p[0]], c);
    return p;
  };
  /** Tapered 4-sided column - trunks, cactus arms, tower legs. */
  B.prototype.column = function (cx, cz, y0, y1, r0, r1, c) {
    var a = [], b = [], i, ang;
    for (i = 0; i < 4; i++) {
      ang = i * Math.PI / 2 + Math.PI / 4;
      a.push(this.v(cx + Math.cos(ang) * r0, y0, cz + Math.sin(ang) * r0));
      b.push(this.v(cx + Math.cos(ang) * r1, y1, cz + Math.sin(ang) * r1));
    }
    for (i = 0; i < 4; i++) {
      var k = (i + 1) % 4;
      this.f([a[i], a[k], b[k], b[i]], c);
    }
    this.f([b[0], b[1], b[2], b[3]], c);
    return b;
  };
  /** Flat ribbon between two points at a fixed x - truss members. */
  B.prototype.brace = function (x, ay, az, by, bz, w, c) {
    var a0 = this.v(x - w, ay, az), a1 = this.v(x + w, ay, az);
    var b1 = this.v(x + w, by, bz), b0 = this.v(x - w, by, bz);
    this.f([a0, a1, b1, b0], c);
  };

  /** Four-sided pyramid - conifer tiers and roofs. */
  B.prototype.cone = function (cx, cz, y0, y1, r, c) {
    var a = [], i;
    for (i = 0; i < 4; i++) {
      var ang = i * Math.PI / 2 + Math.PI / 4;
      a.push(this.v(cx + Math.cos(ang) * r, y0, cz + Math.sin(ang) * r));
    }
    var tip = this.v(cx, y1, cz);
    for (i = 0; i < 4; i++) this.f([a[i], a[(i + 1) % 4], tip], c);
  };

  var BARK = "#6b5540", DEAD = "#8a7355", NEEDLE = "#5a7343", SCRUB = "#7d8a4e";
  var ROCK = "#9a9080", ROCK_D = "#7d7566", CACTUS = "#6f9455";
  var WALL = "#b3a17c", WALL2 = "#9c8c6c", ROOF = "#7a6852", METAL = "#9ba0a5";
  var TIMBER = "#8a6f4c";

  /* --- prop meshes --------------------------------------------------------- */
  var MESH = {};

  MESH.deadtree = (function () {
    var b = new B();
    b.column(0, 0, 0, 5.6, 0.42, 0.20, DEAD);
    b.f([b.v(-0.15, 3.4, 0), b.v(-2.3, 5.0, 0.3), b.v(-2.0, 4.6, -0.3), b.v(0.15, 3.1, 0)], DEAD);
    b.f([b.v(0.15, 4.0, 0), b.v(2.1, 5.4, -0.3), b.v(1.8, 5.0, 0.3), b.v(-0.15, 3.7, 0)], DEAD);
    b.f([b.v(0, 4.8, 0.2), b.v(0.5, 6.6, 1.4), b.v(0.1, 6.4, 1.0), b.v(-0.2, 4.6, 0)], DEAD);
    return b;
  })();

  MESH.pine = (function () {
    var b = new B();
    b.column(0, 0, 0, 2.0, 0.34, 0.26, BARK);
    b.cone(0, 0, 1.6, 5.0, 1.9, NEEDLE);
    b.cone(0, 0, 3.6, 7.2, 1.35, NEEDLE);
    return b;
  })();

  MESH.scrub = (function () {
    var b = new B();
    b.cone(0, 0, 0, 1.5, 1.25, SCRUB);
    b.cone(0.9, 0.5, 0, 1.05, 0.85, SCRUB);
    return b;
  })();

  MESH.cactus = (function () {
    var b = new B();
    b.column(0, 0, 0, 4.4, 0.55, 0.42, CACTUS);
    // Each arm is an elbow: a horizontal spur out of the trunk, then a riser.
    // Free-floating columns beside the trunk read as detached limbs.
    b.box(-1.05, 0.05, 1.62, 2.12, -0.26, 0.26, CACTUS);   // left spur
    b.column(-0.78, 0, 1.7, 3.35, 0.3, 0.26, CACTUS);      // left riser
    b.box(-0.05, 1.15, 2.30, 2.78, -0.24, 0.24, CACTUS);   // right spur
    b.column(0.88, 0, 2.38, 3.85, 0.28, 0.24, CACTUS);     // right riser
    return b;
  })();

  MESH.rock = (function () {
    var b = new B();
    var p = [
      b.v(-1.5, -0.3, -1.0), b.v(0.5, -0.3, -1.6), b.v(1.6, -0.3, 0.3),
      b.v(0.6, -0.3, 1.5), b.v(-1.2, -0.3, 1.2)
    ];
    var top = b.v(-0.1, 1.7, 0.1);
    for (var i = 0; i < 5; i++) {
      b.f([p[i], p[(i + 1) % 5], top], i % 2 ? ROCK_D : ROCK);
    }
    return b;
  })();

  MESH.boulder = (function () {
    var b = new B();
    b.column(0, 0, 0, 2.6, 2.2, 1.4, ROCK);
    b.cone(0, 0, 2.4, 3.6, 1.5, ROCK_D);
    return b;
  })();

  MESH.hut = (function () {
    var b = new B();
    b.box(-1.8, 1.8, 0, 2.4, -1.5, 1.5, WALL, "b");
    b.cone(0, 0, 2.2, 3.6, 2.5, ROOF);
    return b;
  })();

  MESH.shack = (function () {
    var b = new B();
    b.box(-2.2, 2.2, 0, 3.0, -1.8, 1.8, WALL2, "b");
    b.f([b.v(-2.4, 2.9, -2.0), b.v(2.4, 2.9, -2.0), b.v(2.4, 3.9, 2.0), b.v(-2.4, 3.9, 2.0)], ROOF);
    return b;
  })();

  MESH.tower = (function () {
    var b = new B();
    [[-1.3, -1.3], [1.3, -1.3], [1.3, 1.3], [-1.3, 1.3]].forEach(function (p) {
      b.column(p[0], p[1], 0, 5.2, 0.22, 0.16, METAL);
    });
    b.column(0, 0, 5.0, 7.4, 2.0, 1.5, METAL);
    b.cone(0, 0, 7.2, 8.4, 1.6, ROOF);
    return b;
  })();

  var STEEL = "#8d949b", STEEL_D = "#6f767d", RUST = "#8a6244";

  /**
   * A riveted through-truss span rather than a plank on two posts: deck,
   * kerbs, two side trusses with X bracing, portal frames at each end and
   * piers reaching down into the channel.
   */
  MESH.bridge = (function () {
    var b = new B();
    var HL = 17, HW = 5.2, TOP = 6.4;

    b.box(-HW, HW, -0.5, 0.45, -HL, HL, TIMBER, "b");        // deck
    b.box(-HW - 0.5, -HW + 0.4, 0.45, 1.5, -HL, HL, RUST);   // kerbs
    b.box(HW - 0.4, HW + 0.5, 0.45, 1.5, -HL, HL, RUST);

    [-1, 1].forEach(function (side) {
      var x = side * HW;
      // Top chord and vertical posts.
      b.box(x - 0.35, x + 0.35, TOP - 0.6, TOP, -HL, HL, STEEL);
      for (var i = -2; i <= 2; i++) {
        var z = i * (HL / 2);
        b.box(x - 0.28, x + 0.28, 1.3, TOP, z - 0.3, z + 0.3, STEEL_D);
      }
      // X bracing between the posts.
      for (var k = -2; k < 2; k++) {
        var z0 = k * (HL / 2), z1 = (k + 1) * (HL / 2);
        b.brace(x, 1.4, z0, TOP - 0.7, z1, 0.16, STEEL);
        b.brace(x, TOP - 0.7, z0, 1.4, z1, 0.16, STEEL_D);
      }
    });

    // Portal frames tying the two trusses together at each end.
    [-HL, HL].forEach(function (z) {
      b.box(-HW - 0.4, HW + 0.4, TOP - 0.7, TOP + 0.2, z - 0.35, z + 0.35, STEEL);
      b.box(-HW - 0.4, HW + 0.4, TOP - 2.0, TOP - 1.5, z - 0.25, z + 0.25, STEEL_D);
    });

    // Piers into the water.
    [-HL * 0.62, HL * 0.62].forEach(function (z) {
      b.box(-HW + 0.6, HW - 0.6, -7.5, -0.4, z - 1.3, z + 1.3, "#6d6152");
    });

    // Abutments: concrete blocks under each end. Narrower than the deck and
    // stopping short of it, so the earth ramps outside them read as the thing
    // carrying the road up, not as a slab bolted to a slab.
    [-1, 1].forEach(function (s2) {
      b.box(-HW + 0.7, HW - 0.7, -11, -0.4,
            s2 * (HL - 2.2), s2 * (HL + 0.4), "#5f5548");
    });
    return b;
  })();

  /* --- deterministic hash -------------------------------------------------- */
  function hash2(i, j, salt) {
    var h = (i | 0) * 374761393 + (j | 0) * 668265263 + (salt | 0) * 2147483647;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /* --- fixed placements: towns and bridges --------------------------------- */
  var towns = [];   // { x, z, mesh, rot, scale }
  var bridges = []; // { x, z, rot }

  function segHit(a1, a2, b1, b2) {
    var d1x = a2[0] - a1[0], d1z = a2[1] - a1[1];
    var d2x = b2[0] - b1[0], d2z = b2[1] - b1[1];
    var den = d1x * d2z - d1z * d2x;
    if (Math.abs(den) < 1e-9) return null;
    var t = ((b1[0] - a1[0]) * d2z - (b1[1] - a1[1]) * d2x) / den;
    var u = ((b1[0] - a1[0]) * d1z - (b1[1] - a1[1]) * d1x) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: a1[0] + d1x * t, z: a1[1] + d1z * t, rot: Math.atan2(-d1x, -d1z) };
  }

  function buildBridges() {
    bridges = [];
    var raw = [];
    W.ROADS.forEach(function (r) {
      var rp = T.roadPoints(r);
      W.RIVERS.forEach(function (riv) {
        var pts = riv.pts || riv;
        for (var i = 1; i < rp.length; i++) {
          for (var j = 1; j < pts.length; j++) {
            var hit = segHit(rp[i - 1], rp[i], pts[j - 1], pts[j]);
            if (hit) raw.push(hit);
          }
        }
      });
    });

    // One road can clip the same meander several times, and two roads can cross
    // within a few units of each other. Without this the spans stack up and
    // fight for the same patch of river.
    raw.forEach(function (hit) {
      for (var k = 0; k < bridges.length; k++) {
        if (Math.hypot(hit.x - bridges[k].x, hit.z - bridges[k].z) < 34) return;
      }
      var span = abutments(hit);
      if (span) bridges.push(span);
    });

    T.setDecks(bridges.map(function (b) {
      return { x: b.x, z: b.z, y: b.y, ux: b.ux, uz: b.uz,
               half: b.half, wide: b.wide, slope: b.slope,
               ramp: b.ramp };
    }));
  }

  /**
   * Find where a span can actually land. Walking out along the road from the
   * crossing to the first dry ground on each side gives the two abutment
   * heights; the deck is then pitched to meet both. Setting a single height
   * from the higher bank - which is what this used to do - left the low end
   * hanging in the air wherever the two banks were not level.
   */
  function abutments(hit) {
    // Local +z of the mesh points along (sin rot, cos rot); see r3.drawMesh.
    var ux = Math.sin(hit.rot), uz = Math.cos(hit.rot);

    function reach(sign) {
      var last = null;
      for (var d = 10; d <= 52; d += 2) {
        var x = hit.x + ux * sign * d, z = hit.z + uz * sign * d;
        if (x < 4 || z < 4 || x > W.SIZE - 4 || z > W.SIZE - 4) break;
        if (T.waterLevelAt(x, z) !== null) { last = null; continue; }
        if (T.heightAt(x, z) <= T.SEA) { last = null; continue; }
        // Dry, and dry for another 6 units, so the deck does not land on a
        // sliver of bank that immediately drops back into the channel.
        var x2 = hit.x + ux * sign * (d + 6), z2 = hit.z + uz * sign * (d + 6);
        if (T.waterLevelAt(x2, z2) !== null) continue;
        last = { d: d, y: T.reliefAt(x, z) };
        break;
      }
      return last;
    }

    var A = reach(1), B = reach(-1);
    if (!A || !B) return null;

    var span = Math.max(A.d, B.d);
    var scale = Math.max(0.9, Math.min(2.3, span / 17));

    // Pitch the deck so each end meets its own bank. A steeper grade than this
    // is a ramp, not a bridge, so it gets clamped and the deck rides above the
    // low bank instead of nosing into the high one.
    var slope = (A.y - B.y) / (A.d + B.d);
    if (slope > 0.30) slope = 0.30;
    if (slope < -0.30) slope = -0.30;

    // Sit the deck clearly above the banks: a bridge you step onto from flat
    // ground does not read as a bridge. The approach ramps below carry the
    // road up to it.
    var y = (A.y + B.y) * 0.5 + 2.0 * scale;
    var wl = T.waterLevelAt(hit.x, hit.z);
    var minY = (wl === null ? T.hToRelief(T.SEA) : T.hToRelief(wl)) + 2.6;
    if (y < minY) y = minY;

    var half = 17 * scale;
    var br = {
      x: hit.x, z: hit.z, y: y, rot: hit.rot, scale: scale,
      ux: ux, uz: uz, slope: slope,
      half: half, wide: 7.4 * scale, ramp: 12
    };
    br.ramps = buildRamps(br);
    // The drivable skirt has to be exactly as long as the earthwork you can
    // see, or the car climbs air or clips through the embankment.
    br.ramp = Math.max(br.ramps[0].len, br.ramps[1].len);
    return br;
  }

  /**
   * The earth embankments that carry the road up to the deck. Built per
   * bridge, since the rise is whatever that particular pair of banks needs.
   * Each is placed at its own foot with local +z pointing at the bridge, so
   * it lies on the ground instead of following the deck's pitch.
   */
  function buildRamps(br) {
    var out = [];
    [1, -1].forEach(function (sgn) {
      var deckY = br.y + br.slope * br.half * sgn;
      // Long enough for a comfortable grade, within reason.
      var len = 12, footY = 0;
      for (var k = 0; k < 4; k++) {
        var fx = br.x + br.ux * sgn * (br.half + len);
        var fz = br.z + br.uz * sgn * (br.half + len);
        footY = T.reliefAt(fx, fz);
        var want = Math.max(10, Math.min(30, (deckY - footY) * 6));
        if (Math.abs(want - len) < 1.5) break;
        len = want;
      }
      var x = br.x + br.ux * sgn * (br.half + len);
      var z = br.z + br.uz * sgn * (br.half + len);
      var dx = -br.ux * sgn, dz = -br.uz * sgn;   // local +z points at the bridge
      out.push({
        x: x, z: z, y: footY, len: len,
        rot: Math.atan2(dx, dz),
        mesh: rampMesh(x, z, dx, dz, len,
                       Math.max(0.2, deckY - footY), br.wide * 0.86, footY)
      });
    });
    return out;
  }

  var EARTH = "#8a7a5a", EARTH_D = "#6e6147", GRAVEL = "#4c463c";

  /**
   * A flared embankment that hugs the ground. There is no depth buffer here,
   * so anything modelled below the terrain gets painted straight over it - a
   * version that buried its base nine units read as a black slab parked next
   * to the bridge. Each cross-section's base is sampled off the real terrain
   * instead, and buried only far enough to hide the mismatch.
   */
  function rampMesh(fx, fz, dirX, dirZ, len, rise, w, footY) {
    var b = new B();
    var BURY = 1.4, N = 6;
    var prev = null, sec = null;
    for (var i = 0; i <= N; i++) {
      var t = i / N, z = len * t;
      var g = T.reliefAt(fx + dirX * z, fz + dirZ * z) - footY;
      var top = rise * t;
      if (top < g) top = g;                       // never sit under the ground
      var base = g - BURY;
      var flare = Math.max(0.9, (top - base) * 0.55);
      sec = {
        tl: b.v(-w, top, z),          tr: b.v(w, top, z),
        bl: b.v(-w - flare, base, z), br: b.v(w + flare, base, z)
      };
      if (prev) {
        b.f([prev.tl, prev.tr, sec.tr, sec.tl], GRAVEL);   // the carriageway
        b.f([prev.bl, prev.tl, sec.tl, sec.bl], EARTH);    // left batter
        b.f([prev.tr, prev.br, sec.br, sec.tr], EARTH_D);  // right batter
      }
      prev = sec;
    }
    b.f([sec.tl, sec.tr, sec.br, sec.bl], EARTH_D);        // face at the deck
    b.height = rise + 2;
    return b;
  }

  function buildTowns() {
    towns = [];
    W.LOCATIONS.forEach(function (loc, li) {
      var n = loc.kind === "town" ? 9 : loc.kind === "base" ? 6 : loc.kind === "ruin" ? 5 : 3;
      for (var i = 0; i < n; i++) {
        var a = hash2(li, i, 7) * Math.PI * 2;
        var rad = 7 + hash2(li, i, 11) * 17;
        var x = loc.x + Math.cos(a) * rad, z = loc.z + Math.sin(a) * rad;
        if (T.speedAt(x, z) <= 0) continue;
        var pick = hash2(li, i, 13);
        var mesh = pick < 0.5 ? MESH.hut : MESH.shack;
        if (i === 0 && (loc.kind === "town" || loc.kind === "base")) mesh = MESH.tower;
        towns.push({
          x: x, z: z, mesh: mesh,
          rot: hash2(li, i, 17) * Math.PI * 2,
          scale: 0.85 + hash2(li, i, 19) * 0.5,
          loc: loc.id
        });
      }
    });
  }

  /* --- scatter ------------------------------------------------------------- */
  var SPACING = 15;

  /** What grows here, from elevation and slope. Null means bare ground. */
  function pickType(x, z, r) {
    var h = T.heightAt(x, z);
    if (h <= T.SEA) return null;
    if (T.waterLevelAt(x, z) !== null) return null;
    var e = (h - T.SEA) / (1 - T.SEA);
    var n = T.normalAt(x, z);
    var slope = 1 - n[1];

    if (slope > 0.30) return r < 0.5 ? "rock" : "boulder";
    if (e > 0.62) return r < 0.7 ? "rock" : "pine";
    if (e > 0.34) {
      if (r < 0.34) return "pine";
      if (r < 0.55) return "deadtree";
      if (r < 0.80) return "scrub";
      return "rock";
    }
    if (r < 0.30) return "cactus";
    if (r < 0.62) return "scrub";
    if (r < 0.82) return "deadtree";
    return "rock";
  }

  /* --- birds and clouds ---------------------------------------------------- */
  var flocks = [];

  function seedBirds() {
    flocks = [];
    for (var f = 0; f < 6; f++) {
      var n = 2 + Math.floor(hash2(f, 1, 31) * 3);      // 2-4 birds together
      var members = [];
      for (var i = 0; i < n; i++) {
        members.push({
          ox: (hash2(f, i, 32) - 0.5) * 16,
          oz: (hash2(f, i, 33) - 0.5) * 16,
          oy: (hash2(f, i, 34) - 0.5) * 9,
          ph: hash2(f, i, 35) * 6.2832,
          fl: 5 + hash2(f, i, 36) * 4
        });
      }
      flocks.push({
        x: hash2(f, 2, 37) * W.SIZE,
        z: hash2(f, 3, 37) * W.SIZE,
        y: 70 + hash2(f, 4, 37) * 90,
        a: hash2(f, 5, 37) * 6.2832,
        sp: 6 + hash2(f, 6, 37) * 9,
        wob: 0.25 + hash2(f, 7, 37) * 0.5,
        ph: hash2(f, 8, 37) * 6.2832,
        members: members
      });
    }
  }

  /** Smooth wander: each flock eases its heading rather than flying a line. */
  function stepBirds(dt, t) {
    for (var i = 0; i < flocks.length; i++) {
      var f = flocks[i];
      f.a += Math.sin(t * 0.27 + f.ph) * f.wob * dt;
      f.x += Math.cos(f.a) * f.sp * dt;
      f.z += Math.sin(f.a) * f.sp * dt;
      // Wrap rather than vanish at the map edge.
      if (f.x < -40) f.x += W.SIZE + 80; else if (f.x > W.SIZE + 40) f.x -= W.SIZE + 80;
      if (f.z < -40) f.z += W.SIZE + 80; else if (f.z > W.SIZE + 40) f.z -= W.SIZE + 80;
    }
  }

  var clouds = [];
  function seedClouds() {
    clouds = [];
    for (var i = 0; i < 14; i++) {
      clouds.push({
        x: hash2(i, 21, 2) * W.SIZE,
        z: hash2(i, 22, 2) * W.SIZE,
        y: 190 + hash2(i, 23, 2) * 120,
        r: 55 + hash2(i, 24, 2) * 95,
        o: 0.06 + hash2(i, 25, 2) * 0.10
      });
    }
  }

  /* =========================================================================
   * DRAW
   * ====================================================================== */
  var queue = [];
  var stats = { props: 0 };

  /**
   * @param o { light, time, maxProps, radius, showClouds }
   */
  function draw(ctx, cam, o) {
    o = o || {};
    var light = o.light || R.DEFAULT_LIGHT;
    var vw = cam.viewport.w, vh = cam.viewport.h;
    var maxProps = o.maxProps === undefined ? 150 : o.maxProps;
    queue.length = 0;

    // Scatter density falls away with zoom: at map scale the clutter would be
    // both invisible and ruinous, so it simply stops.
    var radius = o.radius || Math.max(90, Math.min(420, 26000 / Math.max(60, cam.dist)));
    if (maxProps > 0 && cam.dist < 620) {
      var S = SPACING;
      var ci = Math.round(cam.tx / S), cj = Math.round(cam.tz / S);
      var n = Math.ceil(radius / S);
      for (var j = -n; j <= n; j++) {
        for (var i = -n; i <= n; i++) {
          var gx = (ci + i) * S, gz = (cj + j) * S;
          var r1 = hash2(ci + i, cj + j, 1);
          if (r1 > 0.42) continue;                       // thin the field out
          var px = gx + (hash2(ci + i, cj + j, 2) - 0.5) * S;
          var pz = gz + (hash2(ci + i, cj + j, 3) - 0.5) * S;
          if (Math.hypot(px - cam.tx, pz - cam.tz) > radius) continue;
          if (!T.isDiscovered(px, pz)) continue;
          if (T.onRoad(px, pz) > 0.35) continue;         // keep the road clear
          var type = pickType(px, pz, hash2(ci + i, cj + j, 4));
          if (!type) continue;
          push(cam, px, pz, MESH[type],
               hash2(ci + i, cj + j, 5) * Math.PI * 2,
               0.75 + hash2(ci + i, cj + j, 6) * 0.7, vw, vh);
        }
      }
    }

    // Towns are landmarks - they stay visible much further out than scrub.
    if (cam.dist < 900) {
      for (var t = 0; t < towns.length; t++) {
        var tw = towns[t];
        if (!T.isDiscovered(tw.x, tw.z)) continue;
        push(cam, tw.x, tw.z, tw.mesh, tw.rot, tw.scale, vw, vh);
      }
    }

    for (var b = 0; b < bridges.length; b++) {
      var br = bridges[b];
      if (!T.isDiscovered(br.x, br.z)) continue;
      pushAt(cam, br.x, br.y, br.z, MESH.bridge, br.rot, br.scale, vw, vh,
             -Math.atan(br.slope));
    }

    // Keep the NEAREST props when over budget - sorting far-first and then
    // truncating dropped exactly the ones the player was driving up to, which
    // made objects vanish as you approached them.
    queue.sort(function (p, q) { return p.d - q.d; });   // near first
    if (queue.length > maxProps) queue.length = maxProps;
    queue.sort(function (p, q) { return q.d - p.d; });   // paint far to near

    for (var k = 0; k < queue.length; k++) {
      var it = queue[k];
      R.drawMesh(ctx, it.mesh, cam,
        { x: it.x, y: it.y, z: it.z, rot: it.rot, scale: it.scale,
          pitch: it.pitch },
        { light: light });
    }
    stats.props = queue.length;

    drawBirds(ctx, cam, o);
  }

  function push(cam, x, z, mesh, rot, scale, vw, vh) {
    // Sink the base a touch: on a slope a flat-bottomed prop otherwise floats
    // on its downhill corner.
    var y = T.surfaceAt(x, z) - 0.35 * scale;
    return pushAt(cam, x, y, z, mesh, rot, scale, vw, vh);
  }

  function pushAt(cam, x, y, z, mesh, rot, scale, vw, vh, pitch) {
    var s = cam.project(x, y, z, {});
    if (!s) return;
    // Cull against the prop's on-screen extent, not just its base point. Close
    // props have their base well below the viewport while the body is still in
    // frame, and culling on the base alone popped them out from under the car.
    var span = (mesh.height || 8) * scale * s.scale;
    var pad = Math.max(140, span);
    if (s.x < -pad || s.x > vw + pad || s.y < -pad - span || s.y > vh + pad) return;
    queue.push({ x: x, y: y, z: z, mesh: mesh, rot: rot, scale: scale,
                 pitch: pitch || 0, d: s.w });
  }

  /** Clouds sit above everything and are drawn before the terrain's props. */
  function drawClouds(ctx, cam, o) {
    if (!clouds.length) seedClouds();
    var t = (o && o.time) || 0;
    ctx.save();
    for (var i = 0; i < clouds.length; i++) {
      var c = clouds[i];
      var cx = (c.x + t * 1.4) % W.SIZE;
      var s = cam.project(cx, c.y, c.z, {});
      if (!s) continue;
      var rr = c.r * s.scale * 0.02;
      if (rr < 6) continue;
      ctx.fillStyle = "rgba(196,198,182," + c.o.toFixed(3) + ")";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, rr * 2.1, rr * 0.62, 0, 0, 6.2832);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(s.x - rr * 0.7, s.y - rr * 0.18, rr * 1.1, rr * 0.5, 0, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawBirds(ctx, cam, o) {
    if (!flocks.length) seedBirds();
    var t = (o && o.time) || 0;
    stepBirds((o && o.dt) || 0.016, t);

    ctx.strokeStyle = "rgba(26,28,24,0.8)";
    ctx.lineCap = "round";

    for (var i = 0; i < flocks.length; i++) {
      var f = flocks[i];
      var ca = Math.cos(f.a), sa = Math.sin(f.a);
      for (var m = 0; m < f.members.length; m++) {
        var b = f.members[m];
        // Offsets ride in the flock's own frame, so the group banks together.
        var bx = f.x + ca * b.oz - sa * b.ox;
        var bz = f.z + sa * b.oz + ca * b.ox;
        var by = f.y + b.oy + Math.sin(t * 0.6 + b.ph) * 3;
        var s = cam.project(bx, T.reliefAt(bx, bz) + by, bz, {});
        if (!s) continue;
        var w = 9 * s.scale * 0.02;
        if (w < 1.2 || w > 30) continue;
        var flap = Math.sin(t * b.fl + b.ph) * 0.45;
        ctx.lineWidth = Math.max(1, w * 0.22);
        ctx.beginPath();
        ctx.moveTo(s.x - w, s.y + flap * w);
        ctx.lineTo(s.x, s.y - w * 0.3);
        ctx.lineTo(s.x + w, s.y + flap * w);
        ctx.stroke();
      }
    }
  }

  global.PROPS = {
    MESH: MESH,
    stats: stats,
    build: function () {
      buildBridges();
      buildTowns();
      seedBirds();
      seedClouds();
    },
    draw: draw,
    /** Embankments go down with the ground so the road can be painted on top. */
    drawRamps: function (ctx, cam, light) {
      for (var i = 0; i < bridges.length; i++) {
        var rs = bridges[i].ramps;
        if (!rs || !T.isDiscovered(bridges[i].x, bridges[i].z)) continue;
        for (var k = 0; k < rs.length; k++) {
          var rp = rs[k];
          var sp = cam.project(rp.x, rp.y, rp.z, {});
          if (!sp || sp.x < -400 || sp.x > cam.viewport.w + 400 ||
                     sp.y < -400 || sp.y > cam.viewport.h + 400) continue;
          R.drawMesh(ctx, rp.mesh, cam,
            { x: rp.x, y: rp.y, z: rp.z, rot: rp.rot, scale: 1 },
            { light: light });
        }
      }
    },
    drawClouds: drawClouds,
    bridges: function () { return bridges; },
    towns: function () { return towns; }
  };
})(window);
