/* =============================================================================
 * vehicle.js - the Chryslus Highwayman: mesh + driving model.
 *
 * The mesh is deliberately oversized relative to the map (~14 world units for
 * a car on a 1000-unit continent). That is the Hearts of Iron trick: counters
 * are way out of scale so they read as chunky 3D pieces standing on a map.
 *
 * Heading convention: 0 = north. Forward vector is (-sin h, -cos h) in (x, z),
 * which matches R3.drawMesh's Y rotation with the model nosed toward -Z.
 * ========================================================================== */
(function (global) {
  "use strict";

  var T = global.TERRAIN;

  /* --- mesh builder ------------------------------------------------------- */
  function Builder() { this.verts = []; this.faces = []; }
  Builder.prototype.v = function (x, y, z) { this.verts.push([x, y, z]); return this.verts.length - 1; };
  Builder.prototype.quad = function (a, b, c, d, col, opt) {
    var f = { v: [a, b, c, d], c: col };
    if (opt) for (var k in opt) f[k] = opt[k];
    this.faces.push(f);
  };
  Builder.prototype.tri = function (a, b, c, col, opt) {
    var f = { v: [a, b, c], c: col };
    if (opt) for (var k in opt) f[k] = opt[k];
    this.faces.push(f);
  };
  /** Axis-aligned box; `skip` hides faces: t b n s e w */
  Builder.prototype.box = function (x0, x1, y0, y1, z0, z1, col, skip) {
    skip = skip || "";
    var p = [
      this.v(x0, y0, z0), this.v(x1, y0, z0), this.v(x1, y1, z0), this.v(x0, y1, z0),
      this.v(x0, y0, z1), this.v(x1, y0, z1), this.v(x1, y1, z1), this.v(x0, y1, z1)
    ];
    if (skip.indexOf("n") < 0) this.quad(p[0], p[1], p[2], p[3], col);
    if (skip.indexOf("s") < 0) this.quad(p[5], p[4], p[7], p[6], col);
    if (skip.indexOf("w") < 0) this.quad(p[4], p[0], p[3], p[7], col);
    if (skip.indexOf("e") < 0) this.quad(p[1], p[5], p[6], p[2], col);
    if (skip.indexOf("t") < 0) this.quad(p[3], p[2], p[6], p[7], col);
    if (skip.indexOf("b") < 0) this.quad(p[4], p[5], p[1], p[0], col);
    return p;
  };
  /** Wheel: a low-poly cylinder lying on the X axis. */
  Builder.prototype.wheel = function (cx, cy, cz, r, w, col, rim) {
    var segs = 9, self = this, left = [], right = [];
    for (var i = 0; i < segs; i++) {
      var a = (i / segs) * Math.PI * 2;
      var y = cy + Math.sin(a) * r, z = cz + Math.cos(a) * r;
      left.push(self.v(cx - w / 2, y, z));
      right.push(self.v(cx + w / 2, y, z));
    }
    for (var j = 0; j < segs; j++) {
      var k = (j + 1) % segs;
      this.quad(left[j], left[k], right[k], right[j], col);
    }
    var cl = this.v(cx - w / 2, cy, cz), cr = this.v(cx + w / 2, cy, cz);
    for (var m = 0; m < segs; m++) {
      var n = (m + 1) % segs;
      this.tri(cl, left[n], left[m], rim);
      this.tri(cr, right[m], right[n], rim);
    }
  };

  var PAINT = "#7d2f28";      // faded Highwayman maroon
  var PAINT_DK = "#5d221d";
  var CHROME = "#b9bcc2";
  var GLASS = "#243642";
  var TIRE = "#1c1c1f";
  var RIM = "#8b8d92";
  var RUST = "#6b4a2c";

  function buildMesh() {
    var b = new Builder();
    var hw = 0.86;   // half width

    // Chassis / rocker
    b.box(-hw, hw, 0.26, 0.52, -2.05, 2.05, PAINT_DK, "t");
    // Main body
    b.box(-hw, hw, 0.52, 0.86, -1.75, 1.95, PAINT, "t b");

    // Hood - sloped nose
    var n0 = b.v(-hw, 0.86, -1.75), n1 = b.v(hw, 0.86, -1.75);
    var n2 = b.v(hw * 0.94, 0.78, -2.05), n3 = b.v(-hw * 0.94, 0.78, -2.05);
    b.quad(n3, n2, n1, n0, PAINT);
    b.quad(n0, n1, n2, n3, PAINT_DK);

    // Cabin: windshield, roof, rear glass
    var c0 = b.v(-hw * 0.84, 0.86, -0.62), c1 = b.v(hw * 0.84, 0.86, -0.62);
    var r0 = b.v(-hw * 0.74, 1.34, 0.12), r1 = b.v(hw * 0.74, 1.34, 0.12);
    var r2 = b.v(hw * 0.74, 1.34, 0.92), r3 = b.v(-hw * 0.74, 1.34, 0.92);
    var q0 = b.v(-hw * 0.84, 0.86, 1.72), q1 = b.v(hw * 0.84, 0.86, 1.72);
    b.quad(c0, c1, r1, r0, GLASS, { stroke: "rgba(190,205,215,0.35)" }); // windshield
    b.quad(r0, r1, r2, r3, PAINT);                                       // roof
    b.quad(r3, r2, q1, q0, GLASS, { stroke: "rgba(190,205,215,0.25)" }); // fastback glass
    b.quad(c0, r0, r3, q0, PAINT_DK);                                    // left sail
    b.quad(q1, r2, r1, c1, PAINT_DK);                                    // right sail

    // Trunk deck
    b.box(-hw * 0.92, hw * 0.92, 0.84, 0.90, 1.30, 1.98, PAINT, "b");

    // Chrome: grille, bumpers, side spear
    b.box(-hw * 0.8, hw * 0.8, 0.54, 0.74, -2.12, -2.02, CHROME);
    b.box(-hw, hw, 0.34, 0.48, -2.16, -2.06, CHROME);
    b.box(-hw, hw, 0.34, 0.48, 2.06, 2.16, CHROME);
    b.box(-hw - 0.02, -hw + 0.02, 0.62, 0.70, -1.4, 1.5, CHROME);
    b.box(hw - 0.02, hw + 0.02, 0.62, 0.70, -1.4, 1.5, CHROME);

    // Lights
    b.box(-hw * 0.78, -hw * 0.44, 0.60, 0.76, -2.14, -2.08, "#ffe9b0", "");
    b.box(hw * 0.44, hw * 0.78, 0.60, 0.76, -2.14, -2.08, "#ffe9b0", "");
    b.box(-hw * 0.8, -hw * 0.4, 0.58, 0.72, 2.02, 2.08, "#ff5a3c", "");
    b.box(hw * 0.4, hw * 0.8, 0.58, 0.72, 2.02, 2.08, "#ff5a3c", "");

    // Roof rack + lashed cargo - it is a wasteland car, it carries junk
    b.box(-hw * 0.66, hw * 0.66, 1.34, 1.40, 0.18, 0.86, "#3a3a3c");
    b.box(-hw * 0.5, hw * 0.15, 1.40, 1.70, 0.26, 0.72, RUST);
    b.box(hw * 0.2, hw * 0.6, 1.40, 1.58, 0.30, 0.66, "#4c5a3a");
    // Spare tyre on the trunk
    b.wheel(0, 1.08, 1.84, 0.30, 0.16, TIRE, RIM);

    // Wheels
    b.wheel(-hw - 0.05, 0.40, -1.24, 0.42, 0.26, TIRE, RIM);
    b.wheel(hw + 0.05, 0.40, -1.24, 0.42, 0.26, TIRE, RIM);
    b.wheel(-hw - 0.05, 0.40, 1.30, 0.42, 0.26, TIRE, RIM);
    b.wheel(hw + 0.05, 0.40, 1.30, 0.42, 0.26, TIRE, RIM);

    return { verts: b.verts, faces: b.faces };
  }

  /* --- driving model ------------------------------------------------------ */
  var TOP_ROAD = 52;      // world units / second at full throttle on highway
  var TOP_OFF = 24;
  var TOP_REVERSE = 15;
  var ACCEL = 30;
  var BRAKE = 62;
  var DRAG = 0.55;
  var GRAVITY = 26;       // how hard grades pull on the car
  var HALF_LEN = 6.2;     // wheelbase / 2 in world units
  var HALF_WID = 3.0;

  function Vehicle(x, z, heading) {
    this.x = x; this.z = z;
    this.heading = heading || 0;
    this.speed = 0;
    this.steer = 0;
    this.gear = 1;         // 1 forward, -1 reverse
    this.grade = 0;        // + uphill, - downhill, along the heading
    this.pitch = 0;
    this.roll = 0;
    this.groundY = 0;
    this.wheelAngle = 0;
    this.fuel = 100;          // percent of the MFC cell charge
    this.condition = 100;     // percent
    this.odometer = 0;
    this.blocked = false;
    this.mesh = buildMesh();
    this.scale = 3.4;
    this.dust = [];
    this.lightsOn = false;
  }

  /**
   * Sample the ground under all four wheels. Gives the body height, the tilt
   * to sit flat on a slope, and the grade the engine has to fight - and stops
   * the car sinking into a hillside the way a single centre sample did.
   */
  Vehicle.prototype.groundPose = function () {
    var f = this.forward();
    var sx = -f[1], sz = f[0];                     // starboard vector
    var hF = T.surfaceAt(this.x + f[0] * HALF_LEN, this.z + f[1] * HALF_LEN);
    var hB = T.surfaceAt(this.x - f[0] * HALF_LEN, this.z - f[1] * HALF_LEN);
    var hR = T.surfaceAt(this.x + sx * HALF_WID, this.z + sz * HALF_WID);
    var hL = T.surfaceAt(this.x - sx * HALF_WID, this.z - sz * HALF_WID);

    // Ride on the highest axle so no corner ever buries itself.
    this.groundY = Math.max((hF + hB) * 0.5, (hL + hR) * 0.5);
    this.grade = (hF - hB) / (HALF_LEN * 2);
    var tPitch = Math.atan2(hF - hB, HALF_LEN * 2);
    var tRoll = Math.atan2(hR - hL, HALF_WID * 2);
    // Suspension lag, or the body snaps on every polygon edge.
    this.pitch += (tPitch - this.pitch) * 0.25;
    this.roll += (tRoll - this.roll) * 0.25;
    return this.groundY;
  };

  Vehicle.prototype.forward = function () {
    return [-Math.sin(this.heading), -Math.cos(this.heading)];
  };

  /**
   * @param inp { throttle: -1..1, steer: -1..1, handbrake: bool }
   * @return distance travelled this step, in world units
   */
  Vehicle.prototype.step = function (dt, inp) {
    this.groundPose();

    var terr = T.speedAt(this.x, this.z);
    var road = T.onRoad(this.x, this.z);
    var top = TOP_OFF + (TOP_ROAD - TOP_OFF) * road;
    top *= 0.55 + 0.45 * (this.condition / 100);
    if (this.fuel <= 0) top = 0;

    var th = inp.throttle || 0;

    // Gear selection: S brakes while rolling forward, and engages reverse
    // once the car has actually stopped.
    if (th < 0 && this.speed <= 0.35) this.gear = -1;
    else if (th > 0 && this.speed >= -0.35) this.gear = 1;

    var grip = 0.55 + 0.45 * road;

    if (this.gear === 1) {
      if (th > 0) {
        // Climbing costs power; the steeper it gets the less is left.
        var climb = Math.max(0, this.grade);
        var pull = 1 - Math.min(0.82, climb * 1.5);
        this.speed += ACCEL * th * dt * (0.45 + 0.55 * terr) * pull;
      } else if (th < 0) {
        this.speed -= BRAKE * Math.abs(th) * dt;
      }
      if (this.speed > top) this.speed += (top - this.speed) * Math.min(1, dt * 3);
    } else {
      if (th < 0) {
        this.speed -= ACCEL * 0.62 * Math.abs(th) * dt * (0.45 + 0.55 * terr);
      } else if (th > 0) {
        this.speed += BRAKE * th * dt;
      }
      var rtop = -TOP_REVERSE * (0.6 + 0.4 * road);
      if (this.speed < rtop) this.speed += (rtop - this.speed) * Math.min(1, dt * 3);
    }

    // Gravity along the grade: the hill pulls whichever way it faces.
    this.speed -= this.grade * GRAVITY * dt;

    if (inp.handbrake) this.speed *= Math.pow(0.06, dt);
    this.speed -= this.speed * DRAG * dt * (1.4 - road * 0.6);
    if (Math.abs(this.speed) < 0.05 && !th) this.speed = 0;

    // Steering: sharper at low speed, washes out at speed, reversed in reverse.
    var target = (inp.steer || 0);
    this.steer += (target - this.steer) * Math.min(1, dt * 7);
    this.wheelAngle = this.steer * 0.5;
    var rate = 1.9 * grip * Math.min(1, Math.abs(this.speed) / 14) *
               (1 - Math.min(0.55, Math.abs(this.speed) / (top + 1) * 0.55));
    this.heading += this.steer * rate * dt * (this.speed >= 0 ? 1 : -1);

    var f = this.forward();
    var nx = this.x + f[0] * this.speed * dt;
    var nz = this.z + f[1] * this.speed * dt;

    // Water, map edges and cliffs too steep to climb are hard walls.
    this.blocked = false;
    var d = Math.hypot(nx - this.x, nz - this.z);
    if (T.speedAt(nx, nz) <= 0) {
      this.blocked = true;
      this.speed *= -0.25;
      return 0;
    }
    // Only judge steepness over a real step. Measuring it against a
    // sub-millimetre crawl divided by ~zero and blocked the car at rest,
    // which is what stopped reverse from ever engaging.
    if (d > 0.05) {
      var climb = (T.surfaceAt(nx, nz) - T.surfaceAt(this.x, this.z)) / d;
      if (climb > 1.15) {
        this.blocked = true;
        this.speed *= -0.25;
        return 0;
      }
    }

    this.x = nx; this.z = nz;
    this.odometer += d;
    this.fuel = Math.max(0, this.fuel - d * (0.010 + (1 - road) * 0.010));
    if (Math.abs(this.speed) > 4 && road < 0.4) {
      this.condition = Math.max(0, this.condition - d * 0.004 * (1 - road));
    }
    this.emitDust(d, road);
    return d;
  };

  /** Spawn dust at the rear wheels. `y` is relative to the ground under it. */
  Vehicle.prototype.emitDust = function (dist, road) {
    var rate = dist * (1 - road * 0.55) * 0.9;
    if (Math.random() >= rate) return;
    var f = this.forward();
    var rx = -f[1], rz = f[0];
    var side = (Math.random() - 0.5) * 5;
    this.dust.push({
      x: this.x - f[0] * 6.5 + rx * side,
      z: this.z - f[1] * 6.5 + rz * side,
      y: 0.8 + Math.random() * 1.4,
      r: 2.2 + Math.random() * 3,
      life: 1
    });
    if (this.dust.length > 60) this.dust.splice(0, this.dust.length - 60);
  };

  /** Age the plume. Called every frame, moving or not. */
  Vehicle.prototype.stepDust = function (dt) {
    var k = Math.min(3, dt * 60);
    for (var i = this.dust.length - 1; i >= 0; i--) {
      var p = this.dust[i];
      p.life -= 0.022 * k;
      p.r += 0.3 * k;
      p.y += 0.11 * k;
      if (p.life <= 0) this.dust.splice(i, 1);
    }
  };

  /** Snap onto a route: used by auto-travel to steer the car along the path. */
  Vehicle.prototype.driveToward = function (tx, tz, dt, throttleCap) {
    var dx = tx - this.x, dz = tz - this.z;
    var want = Math.atan2(-dx, -dz);            // inverse of forward()
    var diff = want - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    var steer = Math.max(-1, Math.min(1, diff * 2.2));
    var th = Math.min(throttleCap === undefined ? 1 : throttleCap,
                      1 - Math.min(0.7, Math.abs(diff)));
    return this.step(dt, { throttle: th, steer: steer });
  };

  global.Vehicle = Vehicle;
  global.Vehicle.buildMesh = buildMesh;
})(window);
