/* =============================================================================
 * main.js - the travel screen itself: state, input, simulation, render loop.
 *
 * Modes
 *   survey  free camera over the map, plot a route             (default)
 *   travel  the car drives the plotted route on its own, time compresses
 *   drive   WASD manual driving with a chase camera and a pinned waypoint
 * ========================================================================== */
(function (global) {
  "use strict";

  var W = global.WORLD, T = global.TERRAIN, TR = global.TRAVEL;
  var B = global.GameBridge, HUD = global.HUD;

  var canvas, ctx, cam, car;
  var DPR = Math.min(1.5, global.devicePixelRatio || 1);

  var state = {
    mode: "survey",
    selected: null,
    route: null,
    est: null,
    here: "arroyo",
    travelDest: null,
    discovered: {},
    encounters: [],
    waypoint: null,
    timeScale: 1,
    weather: "clear",
    showRoads: true,
    paused: false,
    hidden: false,
    travel: null,
    pendingEnc: null,
    car: null
  };
  var TIME_SCALES = [0, 1, 3, 8];

  /* --- input state --------------------------------------------------------- */
  var keys = {};
  var drag = null;
  // Ultralight rasterises to the GPU, so the ceiling is set well above what a
  // software rasteriser can hold; the controller below finds the real limit.
  // Seam strokes are off at every tier: stroking each quad in its own fill
  // colour bled half a pixel into its neighbour and drew a visible lattice
  // across the whole map, which read as "pixelated" far more than the facets.
  var QUALITY_TIERS = [
    { quads: 14000, seams: false, detail: true  },
    { quads: 7000,  seams: false, detail: true  },
    { quads: 3500,  seams: false, detail: false },
    { quads: 1500,  seams: false, detail: false }
  ];
  var quality = { tier: 0, frames: 0, acc: 0, fps: 0, ms: 0, showFps: false, lock: false };

  /* =========================================================================
   * BOOT
   * ====================================================================== */
  function boot() {
    canvas = document.getElementById("map");
    ctx = canvas.getContext("2d", { alpha: false });
    cam = new R3.Camera();
    HUD.init(controller);

    var steps = [
      ["SURVEYING TERRAIN", function () { T.build(); }],
      ["PLOTTING ROAD NETWORK", function () { TR.buildGraph(); }],
      ["RAISING LANDMARKS", function () { global.PROPS.build(); }],
      ["SPOOLING NAVCOM", function () {
        T.setTarget(QUALITY_TIERS[quality.tier].quads);
        var start = W.loc(state.here);
        car = new Vehicle(start.x + 6, start.z + 6, Math.PI * 0.25);
        state.car = car;
        ["arroyo", "klamath", "den", "toxic"].forEach(function (id) {
          state.discovered[id] = true;
          var l = W.loc(id);
          T.revealCircle(l.x, l.z, 118);
        });
      }],
      ["LINKING VEHICLE TELEMETRY", function () {
        HUD.buildMarkers();
        wireBridge();
        wireInput();
        resize();
      }]
    ];

    var i = 0;
    (function next() {
      if (i >= steps.length) {
        HUD.boot(1, "READY");
        setTimeout(function () {
          HUD.bootDone();
          recenter(true);
          refreshList();
          HUD.clock();
          HUD.mode("survey");
          HUD.focus(B.focused);
          HUD.toast("NAVCOM ONLINE · " + W.LOCATIONS.length + " SITES ON FILE", "good");
          applyDevFlags();
          requestAnimationFrame(frame);
        }, 180);
        return;
      }
      HUD.boot(i / steps.length, steps[i][1] ? steps[i][0] : "");
      // Yield between steps so the boot bar actually paints.
      setTimeout(function () {
        try { steps[i][1](); }
        catch (e) { console.error("[FO2Travel] boot step failed: " + steps[i][0], e); }
        i++;
        next();
      }, 30);
    })();
  }

  /* -------------------------------------------------------------------------
   * Dev flags. Outside Fallout 4 there is no game to drive the view, so the
   * URL hash can put it straight into any state for a look:
   *   index.html#reveal&dest=reno            plotted route, fog lifted
   *   index.html#reveal&travel=ncr&seek=0.45 mid auto-travel
   *   index.html#drive&night                 manual driving after dark
   *   index.html#reveal&dest=hills&enc       encounter prompt
   * Ignored entirely when the hash is empty, so it costs the shipped view
   * nothing.
   * ---------------------------------------------------------------------- */
  function snapTween() {
    if (!tween.on) return;
    cam.tx = tween.tx; cam.tz = tween.tz; cam.dist = tween.dist;
    tween.on = false;
  }

  function applyDevFlags() {
    var h = String(global.location.hash || "").slice(1);
    if (!h) return;
    var q = {};
    h.split("&").forEach(function (part) {
      var kv = part.split("=");
      q[kv[0]] = kv.length > 1 ? kv[1] : true;
    });

    if (q.fps) quality.showFps = true;
    if (q.quality !== undefined) {
      quality.tier = Math.max(0, Math.min(QUALITY_TIERS.length - 1, parseInt(q.quality, 10) || 0));
      quality.lock = true;
      T.setTarget(QUALITY_TIERS[quality.tier].quads);
    }
    if (q.night) TR.Clock.set({ hour: 22, minute: 22 * 60 + 40 });
    if (q.storm) state.weather = "storm";
    if (q.reveal) {
      W.LOCATIONS.forEach(function (l) { state.discovered[l.id] = true; });
      T.revealAll();
    }
    if (q.dest) { selectLocation(q.dest === true ? "reno" : q.dest, true); snapTween(); }
    if (q.travel) {
      selectLocation(q.travel === true ? "reno" : q.travel, true);
      beginTravel();
      if (q.seek && state.travel) {
        var f = Math.max(0, Math.min(0.98, parseFloat(q.seek) || 0.4));
        var tv = state.travel;
        tv.dist = tv.route.distance * f;
        tv.minutes = tv.est.minutes * f;
        var p = TR.sample(tv.route, tv.dist);
        car.x = p.x; car.z = p.z; car.heading = p.heading;
        car.fuel -= tv.est.fuel * f;
        T.revealCircle(p.x, p.z, 110);
        cam.tx = p.x; cam.tz = p.z + 40;
        HUD.travelBar(true, W.loc(tv.dest).name, f, tv.est.minutes * (1 - f), tv.pips);
      }
    }
    if (q.pin && state.selected) pinAndDrive();
    if (q.drive) {
      setMode("drive");
      var fwd = car.forward();
      cam.yaw = car.heading;
      cam.tx = car.x + fwd[0] * 26;
      cam.tz = car.z + fwd[1] * 26;
      cam.dist = 150; cam.pitch = 0.62;
      if (q.speed) car.speed = parseFloat(q.speed) || 30;
    }
    if (q.enc) {
      var enc = TR.pickEncounter(car.x, car.z, { night: TR.Clock.isNight() });
      if (enc) {
        if (typeof q.enc === "string") {
          for (var i = 0; i < W.ENCOUNTERS.length; i++) {
            if (W.ENCOUNTERS[i].type === q.enc) {
              var d = W.ENCOUNTERS[i];
              enc.type = d.type; enc.name = d.name; enc.text = d.text;
              enc.hostile = !!d.hostile; enc.hazard = !!d.hazard;
              break;
            }
          }
        }
        triggerEncounter(enc, !!state.travel);
      }
    }
    refreshList();
    HUD.clock();
  }

  /* =========================================================================
   * BRIDGE WIRING - everything the game can say to this screen
   * ====================================================================== */
  function wireBridge() {
    B.on("focus", function (d) {
      HUD.focus(d.focused);
      if (!d.focused && state.mode === "drive") setMode("survey");
    });

    B.on("state.sync", function (m) { applyState(m); });
    B.on("state.patch", function (m) { applyState(m); });

    B.on("clock.set", function (m) { TR.Clock.set(m); HUD.clock(); });

    B.on("travel.approve", function (m) {
      if (!state.travel || state.travel.dest !== m.destId) return;
      state.travel.approved = true;
      HUD.toast("ROUTE APPROVED · DEPARTING", "good");
    });

    B.on("travel.deny", function (m) {
      abortTravel(m.reason || "route refused");
      HUD.toast("TRAVEL DENIED · " + String(m.reason || "").toUpperCase(), "warn");
    });

    B.on("travel.arrived", function () { /* game finished its MoveTo */ });

    B.on("encounter.spawn", function (m) {
      var p = (state.mode === "travel" && state.travel)
        ? TR.sample(state.travel.route, state.travel.dist)
        : { x: car.x, z: car.z };
      var enc = {
        id: m.id || ("enc_" + Date.now().toString(36)),
        type: m.encType || m.type || "raiders",
        name: m.name || "ENCOUNTER",
        icon: m.icon || "", hostile: !!m.hostile, hazard: !!m.hazard,
        text: m.text || "Something is on the road ahead.",
        region: TR.regionAt(p.x, p.z),
        x: m.x !== undefined ? m.x : p.x,
        z: m.z !== undefined ? m.z : p.z
      };
      triggerEncounter(enc, false);
    });

    B.on("encounter.result", function (m) { resolveEncounter(m); });

    B.on("loc.unlock", function (m) {
      var l = W.loc(m.id);
      if (!l) return;
      state.discovered[l.id] = true;
      revealAround(l.x, l.z, 120, true);
      refreshList();
      HUD.toast("LOCATION ADDED · " + l.name, "good");
    });

    B.on("ui.show", function () { state.hidden = false; document.getElementById("app").style.display = ""; });
    B.on("ui.hide", function () { state.hidden = true; document.getElementById("app").style.display = "none"; });
    B.on("ui.toggle", function () {
      state.hidden = !state.hidden;
      document.getElementById("app").style.display = state.hidden ? "none" : "";
    });

    // Pull the live game clock if the mod exposes Fallout 4's globals.
    B.syncClockFromGame().then(function (c) {
      if (!c) return;
      TR.Clock.set({ hour: c.hour, day: c.day, month: (c.month | 0), year: 2241 + (c.year | 0) });
      HUD.clock();
    });
  }

  /** Apply a state.sync / state.patch payload from the game. */
  function applyState(m) {
    if (m.clock) { TR.Clock.set(m.clock); HUD.clock(); }
    if (m.vehicle) {
      if (m.vehicle.fuel !== undefined) car.fuel = m.vehicle.fuel;
      if (m.vehicle.condition !== undefined) car.condition = m.vehicle.condition;
    }
    if (m.player && m.player.x !== undefined) {
      car.x = m.player.x; car.z = m.player.z;
      if (m.player.heading !== undefined) car.heading = m.player.heading;
    }
    if (m.here) { state.here = m.here; state.discovered[m.here] = true; }
    if (m.discovered && m.discovered.length) {
      m.discovered.forEach(function (id) {
        state.discovered[id] = true;
        var l = W.loc(id);
        if (l) T.revealCircle(l.x, l.z, 110);
      });
    }
    if (m.weather) state.weather = m.weather;
    refreshList();
    HUD.vehicle(car, state.mode);
  }

  /* =========================================================================
   * SELECTION / ROUTING
   * ====================================================================== */
  function selectLocation(id, focusCam) {
    var loc = W.loc(id);
    if (!loc) return;
    if (id === state.here) {
      HUD.toast("YOU ARE ALREADY AT " + loc.name);
      return;
    }
    state.selected = id;
    var from = (state.mode === "drive" || !state.here) ? { x: car.x, z: car.z } : state.here;
    var route = TR.route(from, id);
    if (!route) {
      HUD.toast("NO ROAD LINK TO " + loc.name, "warn");
      state.route = null; state.est = null;
      HUD.clearDossier();
      return;
    }
    state.route = route;
    state.est = TR.estimate(route, car, { night: TR.Clock.isNight() });
    HUD.dossier(loc, state.est, state);
    refreshList();
    B.plot(loc, state.est);
    if (focusCam && state.mode === "survey") frameRoute(route);
  }

  function clearSelection() {
    state.selected = null;
    state.route = null;
    state.est = null;
    HUD.clearDossier();
    refreshList();
  }

  /** Ease the camera so the whole route is comfortably in frame. */
  function frameRoute(route) {
    var minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    route.points.forEach(function (p) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    });
    tween.tx = (minX + maxX) / 2;
    tween.tz = (minZ + maxZ) / 2 + 40;
    tween.dist = Math.max(260, Math.min(1150, Math.max(maxX - minX, maxZ - minZ) * 1.3 + 140));
    tween.on = true;
  }

  /* =========================================================================
   * TRAVEL
   * ====================================================================== */
  function beginTravel() {
    if (!state.route || !state.selected) return;
    var loc = W.loc(state.selected);
    if (car.fuel < state.est.fuel) {
      HUD.toast("NOT ENOUGH CELL CHARGE · " + Math.round(state.est.fuel) + "% NEEDED", "warn");
      return;
    }
    state.travel = {
      route: state.route, est: state.est, dest: loc.id,
      dist: 0, risk: 0, approved: B.isMock() ? false : false,
      startFuel: car.fuel, minutes: 0, pips: []
    };
    state.travelDest = loc.id;
    setMode("travel");
    B.setTravelMode(1);
    B.requestTravel(loc, state.est, state.route);
    HUD.travelBar(true, loc.name, 0, state.est.minutes, []);
    HUD.refreshPanelRects();
    HUD.toast("PLOTTING COURSE TO " + loc.name);
  }

  function abortTravel(reason) {
    if (!state.travel) return;
    B.travelAbort(reason);
    B.setTravelMode(0);
    state.travel = null;
    state.travelDest = null;
    HUD.travelBar(false);
    HUD.refreshPanelRects();
    setMode("survey");
    HUD.toast("TRAVEL ABORTED · " + String(reason || "").toUpperCase(), "warn");
  }

  function completeTravel() {
    var tv = state.travel, loc = W.loc(tv.dest);
    car.x = loc.x; car.z = loc.z;
    car.speed = 0;
    state.here = loc.id;
    state.discovered[loc.id] = true;
    revealAround(loc.x, loc.z, 130, true);

    B.arrive(loc, {
      minutes: tv.minutes,
      fuelUsed: tv.startFuel - car.fuel,
      condition: car.condition
    });
    B.writeVehicleGlobals(car);
    B.setTravelMode(0);

    state.travel = null;
    state.travelDest = null;
    HUD.travelBar(false);
    HUD.refreshPanelRects();
    setMode("survey");
    clearSelection();
    refreshList();
    HUD.toast("ARRIVED · " + loc.name + " · " + TR.Clock.stamp(), "good");
  }

  function stepTravel(dt) {
    var tv = state.travel;
    if (!tv) return;
    var scale = TIME_SCALES[state.timeScale];
    if (!scale || state.paused || HUD.encounterOpen()) return;

    var p = TR.sample(tv.route, tv.dist);
    var terr = Math.max(0.25, T.speedAt(p.x, p.z));
    var speed = 17 * terr * (0.6 + 0.4 * (car.condition / 100));
    var adv = speed * dt * scale;
    if (adv <= 0) return;

    // Encounter accumulation over the distance just covered.
    var hz = TR.hazardAt(p.x, p.z, { night: TR.Clock.isNight() }) * adv;
    if (Math.random() < hz) {
      var enc = TR.pickEncounter(p.x, p.z, { night: TR.Clock.isNight() });
      if (enc) {
        car.x = p.x; car.z = p.z; car.heading = p.heading;
        triggerEncounter(enc, true);
        return;
      }
    }

    tv.dist += adv;
    var mins = (adv * W.SCALE.minutesPerUnit) / terr;
    tv.minutes += mins;
    TR.Clock.advance(mins);
    car.fuel = Math.max(0, car.fuel - adv * 0.011);
    car.odometer += adv;

    var np = TR.sample(tv.route, tv.dist);
    car.x = np.x; car.z = np.z; car.heading = np.heading;
    car.speed = speed;
    car.emitDust(adv * 0.35, T.onRoad(np.x, np.z));

    revealAround(np.x, np.z, 78, false);

    var pct = tv.dist / tv.route.distance;
    HUD.travelBar(true, W.loc(tv.dest).name, pct, Math.max(0, tv.est.minutes - tv.minutes), tv.pips);
    HUD.clock();

    if (car.fuel <= 0) {
      abortTravel("cells depleted");
      HUD.toast("MICRO FUSION CELL DEPLETED · STRANDED", "warn");
      return;
    }
    if (tv.dist >= tv.route.distance - 0.5) completeTravel();
  }

  /* =========================================================================
   * ENCOUNTERS
   * ====================================================================== */
  function triggerEncounter(enc, fromTravel) {
    state.encounters.push(enc);
    state.pendingEnc = enc;
    if (state.travel) {
      state.travel.pips.push(state.travel.dist / state.travel.route.distance);
    }
    B.encounter(enc);
    B.setGlobal(B.CONFIG.globals.encounter, 1);

    var choices;
    if (enc.hazard) {
      choices = [
        { id: "push", label: "Push through it", odds: "TAKE RADS" },
        { id: "wait", label: "Pull over and wait it out", odds: "+2-4 HRS" }
      ];
    } else if (enc.hostile) {
      choices = [
        { id: "fight", label: "Stop and fight", odds: "LOAD ENCOUNTER" },
        { id: "sneak", label: "Try to slip past", odds: "OUTDOORSMAN" },
        { id: "flee", label: "Turn around", odds: "ABORT ROUTE" }
      ];
    } else {
      choices = [
        { id: "approach", label: "Pull over and talk", odds: "LOAD ENCOUNTER" },
        { id: "ignore", label: "Drive on by", odds: "" }
      ];
    }
    HUD.encounter(enc, choices, function (c) { onEncounterChoice(enc, c); });
  }

  function onEncounterChoice(enc, choice) {
    B.encounterChoice(enc, choice.id);

    switch (choice.id) {
      case "fight":
      case "approach":
        // The game owns this from here: it loads the encounter cell and hides
        // the view. In mock mode the bridge sends back a fake result.
        HUD.toast("STAND BY · HANDING OFF TO ENCOUNTER", "warn");
        break;

      case "sneak": {
        var skill = state.outdoorsman || 55;
        var ok = Math.random() * 100 < skill;
        if (ok) {
          HUD.toast("SLIPPED PAST · " + enc.name, "good");
          dismissEncounter(enc);
        } else {
          HUD.toast("SPOTTED · NO WAY AROUND", "warn");
          B.encounterChoice(enc, "fight");
        }
        break;
      }

      case "flee":
        dismissEncounter(enc);
        abortTravel("hostile contact");
        break;

      case "wait": {
        var hrs = 2 + Math.random() * 2;
        TR.Clock.advance(hrs * 60);
        HUD.clock();
        HUD.toast("WAITED OUT THE STORM · " + TR.duration(hrs * 60));
        dismissEncounter(enc);
        break;
      }

      case "push":
        HUD.toast("PUSHING THROUGH · RADIATION EXPOSURE", "warn");
        car.condition = Math.max(0, car.condition - 4);
        dismissEncounter(enc);
        break;

      case "ignore":
      default:
        dismissEncounter(enc);
        break;
    }
  }

  function dismissEncounter(enc) {
    var i = state.encounters.indexOf(enc);
    if (i >= 0) state.encounters.splice(i, 1);
    if (state.pendingEnc === enc) state.pendingEnc = null;
    B.setGlobal(B.CONFIG.globals.encounter, 0);
  }

  /** The game reports how an encounter went. */
  function resolveEncounter(m) {
    var enc = null;
    for (var i = 0; i < state.encounters.length; i++) {
      if (state.encounters[i].id === m.id) { enc = state.encounters[i]; break; }
    }
    if (m.damage) car.condition = Math.max(0, car.condition - m.damage);
    if (m.caps) HUD.toast("RECOVERED " + m.caps + " CAPS", "good");

    if (m.outcome === "loss") {
      HUD.toast("ENCOUNTER LOST · ROUTE ABANDONED", "warn");
      if (enc) dismissEncounter(enc);
      abortTravel("combat loss");
      return;
    }
    if (enc) dismissEncounter(enc);
    HUD.toast(m.outcome === "flee" ? "DISENGAGED · RESUMING ROUTE" : "ROAD CLEAR · RESUMING ROUTE", "good");
    HUD.vehicle(car, state.mode);
  }

  /* =========================================================================
   * MANUAL DRIVING
   * ====================================================================== */
  function pinAndDrive() {
    if (!state.selected) return;
    var loc = W.loc(state.selected);
    state.waypoint = { x: loc.x, z: loc.z, id: loc.id, name: loc.name };
    B.waypoint({ x: loc.x, z: loc.z, destId: loc.id, destName: loc.name });
    setMode("drive");
    HUD.toast("WAYPOINT PINNED · " + loc.name + " · DRIVE MANUALLY");
  }

  var driveFeed = 0, clockFeed = 0;
  function stepDrive(dt) {
    if (HUD.encounterOpen()) return;
    var throttle = 0, steer = 0;
    if (keys["w"] || keys["arrowup"]) throttle += 1;
    if (keys["s"] || keys["arrowdown"]) throttle -= 1;
    if (keys["a"] || keys["arrowleft"]) steer += 1;
    if (keys["d"] || keys["arrowright"]) steer -= 1;
    if (keys["shift"] && throttle > 0) throttle = 1.35;

    var moved = car.step(dt, {
      throttle: throttle, steer: steer, handbrake: !!keys[" "]
    });

    if (car.blocked) HUD.toast("IMPASSABLE TERRAIN", "warn");

    if (moved > 0) {
      var terr = Math.max(0.25, T.speedAt(car.x, car.z));
      var mins = (moved * W.SCALE.minutesPerUnit * W.SCALE.driveTimeFactor) / terr;
      TR.Clock.advance(mins);
      clockFeed += mins;
      if (clockFeed > 1) { clockFeed = 0; HUD.clock(); }

      var hz = TR.hazardAt(car.x, car.z, { night: TR.Clock.isNight() }) * moved;
      if (Math.random() < hz) {
        var enc = TR.pickEncounter(car.x, car.z, { night: TR.Clock.isNight() });
        if (enc) { triggerEncounter(enc, false); return; }
      }
      revealAround(car.x, car.z, 62, false);
    }

    // Arrival on a pinned waypoint, or just rolling into any known town.
    W.LOCATIONS.forEach(function (l) {
      if (Math.hypot(l.x - car.x, l.z - car.z) < 12) {
        if (state.here !== l.id) {
          state.here = l.id;
          if (!state.discovered[l.id]) {
            state.discovered[l.id] = true;
            B.discover({ id: l.id, x: l.x, z: l.z });
            HUD.toast("NEW LOCATION DISCOVERED · " + l.name, "good");
          }
          revealAround(l.x, l.z, 120, true);
          refreshList();
          if (state.waypoint && state.waypoint.id === l.id) {
            HUD.toast("WAYPOINT REACHED · " + l.name, "good");
            B.arrive(l, { minutes: 0, fuelUsed: 0, condition: car.condition });
            state.waypoint = null;
          }
        }
      }
    });

    driveFeed += dt;
    if (driveFeed > 0.25) { driveFeed = 0; B.driveState(car); }
  }

  /* =========================================================================
   * DISCOVERY
   * ====================================================================== */
  function revealAround(x, z, r, immediate) {
    var changed = T.revealCircle(x, z, r);
    return changed;
  }

  /* =========================================================================
   * MODES / CAMERA
   * ====================================================================== */
  var tween = { on: false, tx: 0, tz: 0, dist: 0 };

  function setMode(mode) {
    if (state.mode === mode) return;
    var prev = state.mode;
    state.mode = mode;
    HUD.mode(mode);

    if (mode === "drive") {
      B.driveBegin(car);
      B.setTravelMode(2);
      HUD.hint('<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive &nbsp; <kbd>SHIFT</kbd> boost &nbsp; <kbd>SPACE</kbd> brake &nbsp; <kbd>TAB</kbd> survey map &nbsp; <kbd>F</kbd> headlights');
    } else if (prev === "drive") {
      B.driveEnd(car);
      B.setTravelMode(state.travel ? 1 : 0);
      HUD.hint('<kbd>LMB</kbd> pan &nbsp; <kbd>RMB</kbd> rotate &nbsp; <kbd>WHEEL</kbd> zoom &nbsp; <kbd>TAB</kbd> drive &nbsp; <kbd>ENTER</kbd> travel');
    }
    tween.on = false;
  }

  function recenter(instant) {
    var t = state.here ? W.loc(state.here) : car;
    tween.tx = t.x; tween.tz = t.z + 90;
    tween.dist = 560;
    tween.on = true;
    if (instant) { cam.tx = tween.tx; cam.tz = tween.tz; cam.dist = tween.dist; cam.yaw = 0; tween.on = false; }
  }

  function updateCamera(dt) {
    if (state.mode === "drive") {
      var f = car.forward();
      var tx = car.x + f[0] * 26, tz = car.z + f[1] * 26;
      var k = Math.min(1, dt * 4.2);
      cam.tx += (tx - cam.tx) * k;
      cam.tz += (tz - cam.tz) * k;
      var dy = car.heading - cam.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      cam.yaw += dy * Math.min(1, dt * 3.2);
      cam.pitch += (0.62 - cam.pitch) * Math.min(1, dt * 3);
      cam.dist += (150 - cam.dist) * Math.min(1, dt * 3);
    } else {
      if (state.mode === "travel") {
        var kk = Math.min(1, dt * 1.6);
        cam.tx += (car.x - cam.tx) * kk;
        cam.tz += (car.z + 40 - cam.tz) * kk;
      } else if (tween.on) {
        var k2 = Math.min(1, dt * 3.4);
        cam.tx += (tween.tx - cam.tx) * k2;
        cam.tz += (tween.tz - cam.tz) * k2;
        cam.dist += (tween.dist - cam.dist) * k2;
        if (Math.abs(cam.tx - tween.tx) < 1 && Math.abs(cam.dist - tween.dist) < 2) tween.on = false;
      }
      // Keyboard pan/rotate in survey mode
      var pan = cam.dist * 0.9 * dt;
      var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      if (keys["w"] || keys["arrowup"])    { cam.tx -= sy * pan; cam.tz -= cy * pan; tween.on = false; }
      if (keys["s"] || keys["arrowdown"])  { cam.tx += sy * pan; cam.tz += cy * pan; tween.on = false; }
      if (keys["a"] || keys["arrowleft"])  { cam.tx -= cy * pan; cam.tz += sy * pan; tween.on = false; }
      if (keys["d"] || keys["arrowright"]) { cam.tx += cy * pan; cam.tz -= sy * pan; tween.on = false; }
      if (keys["q"]) cam.yaw += dt * 1.1;
      if (keys["e"]) cam.yaw -= dt * 1.1;
      cam.pitch += (0.86 - cam.pitch) * Math.min(1, dt * 2.5);
    }

    var m = 260;
    cam.tx = Math.max(-m, Math.min(W.SIZE + m, cam.tx));
    cam.tz = Math.max(-m, Math.min(W.SIZE + m, cam.tz));
    cam.dist = Math.max(90, Math.min(1500, cam.dist));
    cam.pitch = Math.max(0.35, Math.min(1.35, cam.pitch));
    // Orbit the ground, not the y=0 plane, and ease so ridgelines do not
    // snap the view. Zoomed out the relief stops mattering, so fade it away.
    var groundY = T.reliefAt(cam.tx, cam.tz) * Math.max(0, 1 - cam.dist / 1600);
    cam.ty += (groundY - cam.ty) * Math.min(1, dt * 5);
    cam.update(canvas.width / DPR, canvas.height / DPR);

    // Terrain collision: if the eye ends up inside a hill, lift the orbit
    // point until it clears. Cheaper and steadier than moving the camera.
    var eyeGround = T.reliefAt(cam.eye[0], cam.eye[2]) + 22;
    if (cam.eye[1] < eyeGround) {
      cam.ty += (eyeGround - cam.eye[1]);
      cam.update(canvas.width / DPR, canvas.height / DPR);
    }
  }

  /* =========================================================================
   * RENDER
   * ====================================================================== */
  var rain = [], motes = [];

  /**
   * Sun (or moon) for the current game hour. Drives the terrain shading, every
   * prop, and the car, so the whole map changes through the day rather than
   * being lit from a fixed corner.
   */
  var light = { dir: [0, 1, 0], amb: 0.4, intensity: 1, tint: [1, 1, 1] };
  var haze = [120, 122, 104];

  function updateLight() {
    var h = TR.Clock.hour();
    // Day runs 06:00-20:00; the sun tracks east to west across that window.
    var t = (h - 6) / 14;
    var day = t >= 0 && t <= 1;
    var az, el;

    if (day) {
      az = -Math.PI * 0.5 + t * Math.PI;      // sunrise east -> sunset west
      el = Math.sin(t * Math.PI) * 1.15 + 0.06;
    } else {
      // Moon: opposite side of the sky, low and cold.
      var nt = h < 6 ? (h + 4) / 10 : (h - 20 + 4) / 10;
      az = Math.PI * 0.5 - nt * Math.PI;
      el = 0.55;
    }

    var ce = Math.cos(Math.atan(el));
    var dx = Math.sin(az) * ce, dy = Math.sin(Math.atan(el)) + 0.25, dz = -Math.cos(az) * ce * 0.75;
    var L = Math.hypot(dx, dy, dz) || 1;
    light.dir[0] = dx / L; light.dir[1] = dy / L; light.dir[2] = dz / L;

    // Warm and bright at midday, red at the edges of the day, blue at night.
    if (day) {
      var noon = 1 - Math.abs(t - 0.5) * 2;          // 0 at dawn/dusk, 1 at noon
      var golden = Math.pow(1 - noon, 2);
      light.amb = 0.34 + noon * 0.10;
      light.intensity = 0.72 + noon * 0.5;
      light.tint[0] = 1.0 + golden * 0.22;
      light.tint[1] = 1.0 - golden * 0.06;
      light.tint[2] = 1.0 - golden * 0.30;
      haze[0] = 120 + golden * 60; haze[1] = 122 - golden * 18; haze[2] = 104 - golden * 40;
    } else {
      light.amb = 0.22;
      light.intensity = 0.42;
      light.tint[0] = 0.62; light.tint[1] = 0.74; light.tint[2] = 1.05;
      haze[0] = 18; haze[1] = 26; haze[2] = 42;
    }
    if (state.weather === "storm") {
      light.intensity *= 0.55;
      light.amb += 0.05;
      light.tint[0] *= 0.86; light.tint[1] *= 0.92; light.tint[2] *= 1.0;
    }
  }

  /**
   * Backdrop the terrain silhouettes against. The horizon usually sits above
   * the top of the screen at survey pitch, so this is a full-canvas wash
   * rather than a band.
   */
  var skyCache = { w: 0, h: 0, night: null, weather: null, grad: null };
  function paintSky() {
    var w = cam.viewport.w, h = cam.viewport.h;
    var night = TR.Clock.isNight();
    if (skyCache.w !== w || skyCache.h !== h || skyCache.night !== night ||
        skyCache.weather !== state.weather) {
      var g = ctx.createLinearGradient(0, 0, 0, h);
      if (night) {
        g.addColorStop(0, "#04060a"); g.addColorStop(0.55, "#080d14"); g.addColorStop(1, "#101a24");
      } else if (state.weather === "storm") {
        g.addColorStop(0, "#0a0e12"); g.addColorStop(0.55, "#151d24"); g.addColorStop(1, "#26313a");
      } else {
        g.addColorStop(0, "#080b0e"); g.addColorStop(0.5, "#131a1c"); g.addColorStop(1, "#3a3d33");
      }
      skyCache = { w: w, h: h, night: night, weather: state.weather, grad: g };
    }
    ctx.fillStyle = skyCache.grad;
    ctx.fillRect(0, 0, w, h);
  }

  /**
   * A tiled noise wash over the terrain. The mesh is flat-shaded per quad, so
   * without some surface texture large faces read as plastic; this is one
   * pattern fill per frame and restores a sense of ground material.
   */
  var grainPat = null;
  function makeGrain() {
    var g = document.createElement("canvas");
    g.width = g.height = 96;
    var gc = g.getContext("2d");
    var im = gc.createImageData(96, 96);
    var seed = 1337;
    for (var i = 0; i < 96 * 96; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      var v = (seed >> 16) & 255;
      var o = i * 4;
      im.data[o] = im.data[o + 1] = im.data[o + 2] = v < 128 ? 0 : 255;
      im.data[o + 3] = Math.abs(v - 128) >> 1;
    }
    gc.putImageData(im, 0, 0);
    return ctx.createPattern(g, "repeat");
  }

  function drawGrain() {
    if (!grainPat) grainPat = makeGrain();
    ctx.save();
    ctx.globalAlpha = 0.075;
    ctx.fillStyle = grainPat;
    ctx.fillRect(0, 0, cam.viewport.w, cam.viewport.h);
    ctx.restore();
  }

  function drawSky(horizon) {
    var w = cam.viewport.w, h = cam.viewport.h;
    var night = TR.Clock.isNight();
    var top = night ? "#070b12" : "#2a3240";
    var bot = night ? "#182231" : "#8a8a76";
    if (state.weather === "storm") { top = night ? "#05070c" : "#1e242c"; bot = night ? "#101720" : "#4d5560"; }

    var g = ctx.createLinearGradient(0, 0, 0, Math.max(2, horizon));
    g.addColorStop(0, top);
    g.addColorStop(1, bot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, Math.max(0, horizon));

    if (night && state.weather !== "storm") {
      ctx.fillStyle = "rgba(210,225,255,0.55)";
      for (var i = 0; i < 60; i++) {
        var sx = ((i * 137.5) % w), sy = ((i * 53.7) % Math.max(1, horizon * 0.9));
        ctx.fillRect(sx, sy, 1, 1);
      }
    }
    // Haze band that hides the texture's far edge.
    var hz = ctx.createLinearGradient(0, horizon - 2, 0, horizon + h * 0.16);
    hz.addColorStop(0, night ? "rgba(24,34,49,0.95)" : "rgba(138,138,118,0.9)");
    hz.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = hz;
    ctx.fillRect(0, horizon - 2, w, h * 0.16 + 2);
  }

  /**
   * Roads and rivers are drawn as polylines draped over the relief rather than
   * baked into a texture: they stay crisp at every zoom, they climb the hills
   * correctly, and they can be hidden cell-by-cell by the fog of war.
   */
  function drawNetwork() {
    var vwid = cam.viewport.w, vhei = cam.viewport.h;

    function drapedSegments(pts) {
      // Split the polyline wherever it crosses into unsurveyed ground.
      var runs = [], cur = null;
      for (var i = 0; i < pts.length; i++) {
        var wx = pts[i][0], wz = pts[i][1];
        if (!T.isDiscovered(wx, wz)) { cur = null; continue; }
        var sp = cam.project(wx, T.surfaceAt(wx, wz) + 0.8, wz, {});
        if (!sp) { cur = null; continue; }
        if (sp.x < -400 || sp.x > vwid + 400 || sp.y < -400 || sp.y > vhei + 400) { cur = null; continue; }
        if (!cur) { cur = []; runs.push(cur); }
        cur.push(sp);
      }
      return runs;
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Rivers: the water body itself is part of the terrain mesh, so what is
    // drawn here is the flow - a highlight down the centreline plus dashes
    // marching downstream, which is what makes it read as moving.
    var flow = (global.performance ? performance.now() : Date.now()) * 0.001;
    W.RIVERS.forEach(function (riv) {
      var pts = riv.pts || riv;
      var runs = [], cur = null;
      for (var i = 0; i < pts.length; i++) {
        var wx = pts[i][0], wz = pts[i][1];
        if (!T.isDiscovered(wx, wz)) { cur = null; continue; }
        var wl = T.waterLevelAt(wx, wz);
        var wy = wl === null ? T.reliefAt(wx, wz) : T.hToRelief(wl);
        var sp = cam.project(wx, wy + 0.5, wz, {});
        if (!sp || sp.x < -400 || sp.x > vwid + 400 || sp.y < -400 || sp.y > vhei + 400) {
          cur = null; continue;
        }
        if (!cur) { cur = []; runs.push(cur); }
        cur.push(sp);
      }
      var wide = Math.max(2, 2600 / cam.dist);
      runs.forEach(function (run) {
        if (run.length < 2) return;
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(96,158,180,0.42)";
        ctx.lineWidth = wide;
        strokePts(run);
        ctx.strokeStyle = "rgba(158,214,232,0.5)";
        ctx.lineWidth = Math.max(0.9, wide * 0.30);
        strokePts(run);
        // Marching highlights, drifting from source toward the mouth.
        ctx.strokeStyle = "rgba(226,246,255,0.55)";
        ctx.lineWidth = Math.max(0.8, wide * 0.22);
        ctx.setLineDash([wide * 1.6, wide * 4.2]);
        ctx.lineDashOffset = -flow * wide * 5;
        strokePts(run);
        ctx.setLineDash([wide * 0.7, wide * 6.5]);
        ctx.lineDashOffset = -flow * wide * 3.1 + wide * 2;
        ctx.strokeStyle = "rgba(226,246,255,0.32)";
        strokePts(run);
        ctx.setLineDash([]);
      });
    });

    // Lakes get a slow shimmer so they are not dead mirrors.
    W.LAKES.forEach(function (lk) {
      if (!T.isDiscovered(lk.x, lk.z)) return;
      var wl = T.waterLevelAt(lk.x, lk.z);
      if (wl === null) return;
      var ly = T.hToRelief(wl) + 0.5;
      for (var b = 0; b < 3; b++) {
        var rr = lk.r * (0.32 + b * 0.24) + Math.sin(flow * 0.7 + b) * 2.2;
        ctx.strokeStyle = "rgba(196,232,246," + (0.16 - b * 0.04).toFixed(3) + ")";
        ctx.lineWidth = Math.max(1, 900 / cam.dist);
        R3.groundCircle(ctx, cam, lk.x, lk.z, rr, 26, ly);
        ctx.stroke();
      }
    });

    if (!state.showRoads) return;
    var wide = Math.max(1.6, 1500 / cam.dist);
    W.ROADS.forEach(function (r) {
      var runs = drapedSegments(T.roadPoints(r));
      runs.forEach(function (run) {
        if (run.length < 2) return;
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(26,21,16,0.8)";
        ctx.lineWidth = wide * (0.9 + r.w * 1.1);
        strokePts(run);
        ctx.strokeStyle = r.w >= 0.9 ? "rgba(232,152,72,0.95)"
                        : r.w >= 0.6 ? "rgba(200,134,66,0.85)"
                                     : "rgba(158,124,76,0.7)";
        ctx.lineWidth = wide * (0.32 + r.w * 0.55);
        ctx.setLineDash(r.w >= 0.9 ? [wide * 3, wide * 1.7]
                      : r.w >= 0.6 ? [wide * 2.2, wide * 1.9]
                                   : [wide * 0.9, wide * 2.2]);
        strokePts(run);
        ctx.setLineDash([]);
      });
    });
  }

  function drawRoute() {
    var route = state.route;
    if (!route) return;
    var pts = projectOnGround(route.points, 1.2);
    if (pts.length < 2) return;

    // casing
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.78)";
    ctx.lineWidth = 10.5;
    strokePts(pts);
    ctx.strokeStyle = "rgba(255,244,214,0.22)";
    ctx.lineWidth = 6.5;
    strokePts(pts);

    // risk-shaded body, sampled per screen segment
    var night = TR.Clock.isNight();
    for (var i = 1; i < pts.length; i++) {
      var wp = route.points[i];
      ctx.strokeStyle = TR.riskColorAt(wp[0], wp[1], { night: night });
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 4.6;
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // marching ants toward the destination
    ctx.setLineDash([9, 11]);
    ctx.lineDashOffset = -(Date.now() * 0.02) % 20;
    ctx.strokeStyle = "rgba(255,252,240,0.98)";
    ctx.lineWidth = 2.6;
    strokePts(pts);
    ctx.setLineDash([]);

    // completed portion during auto-travel
    if (state.travel) {
      var done = [route.points[0]];
      var acc = 0;
      for (var k = 1; k < route.points.length; k++) {
        acc = route.cum[k];
        if (acc > state.travel.dist) break;
        done.push(route.points[k]);
      }
      if (done.length > 1) {
        var dp = projectOnGround(done, 1.6);
        ctx.strokeStyle = "rgba(255,182,66,0.98)";
        ctx.lineWidth = 5.2;
        strokePts(dp);
      }
    }

    // destination ring
    var dest = W.loc(route.dest);
    if (dest) {
      var pulse = 10 + Math.sin(Date.now() * 0.004) * 3;
      ctx.strokeStyle = "rgba(127,224,154,0.85)";
      ctx.lineWidth = 2;
      var dy = T.reliefAt(dest.x, dest.z) + 1;
      R3.groundCircle(ctx, cam, dest.x, dest.z, pulse, 26, dy);
      ctx.stroke();
      ctx.strokeStyle = "rgba(127,224,154,0.28)";
      R3.groundCircle(ctx, cam, dest.x, dest.z, pulse + 7, 26, dy);
      ctx.stroke();
    }
  }

  /** Project a world polyline so it lies on the terrain surface. */
  function projectOnGround(pts, lift) {
    var out = [];
    lift = lift || 0;
    for (var i = 0; i < pts.length; i++) {
      var s2 = cam.project(pts[i][0], T.reliefAt(pts[i][0], pts[i][1]) + lift, pts[i][1], {});
      if (s2) out.push(s2);
    }
    return out;
  }

  function strokePts(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function drawWaypoint() {
    var wp = state.waypoint;
    if (!wp) return;
    var t = Date.now() * 0.003;
    var r = 9 + Math.sin(t) * 2.5;
    var wy = T.reliefAt(wp.x, wp.z);
    ctx.strokeStyle = "rgba(127,224,154,0.9)";
    ctx.lineWidth = 2;
    R3.groundCircle(ctx, cam, wp.x, wp.z, r, 24, wy + 1);
    ctx.stroke();
    var top = cam.project(wp.x, wy + 40 + Math.sin(t) * 3, wp.z, {});
    var base = cam.project(wp.x, wy, wp.z, {});
    if (top && base) {
      ctx.strokeStyle = "rgba(127,224,154,0.45)";
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
      ctx.fillStyle = "rgba(127,224,154,0.95)";
      ctx.beginPath();
      ctx.moveTo(top.x, top.y + 7);
      ctx.lineTo(top.x - 5, top.y - 3);
      ctx.lineTo(top.x + 5, top.y - 3);
      ctx.closePath(); ctx.fill();
    }
  }

  /**
   * Scrub tufts and stones scattered on the ground near the camera. The map
   * texture is ~1.6px per world unit, so at driving zoom it is heavily
   * magnified and reads as blur; these give back both detail and the parallax
   * that makes speed legible.
   */
  function drawGroundDetail() {
    if (cam.dist > 340 || !QUALITY_TIERS[quality.tier].detail) return;
    var S = 9, R = 135;
    var cx = Math.round(cam.tx / S) * S, cz = Math.round(cam.tz / S) * S;
    var n = Math.ceil(R / S);
    var alpha = Math.min(1, (340 - cam.dist) / 160);
    var W2 = cam.viewport.w, H2 = cam.viewport.h;

    ctx.strokeStyle = "rgba(32,34,22," + (0.5 * alpha).toFixed(3) + ")";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    var drawn = 0;
    for (var j = -n; j <= n; j++) {
      for (var i = -n; i <= n; i++) {
        var gx = cx + i * S, gz = cz + j * S;
        // Deterministic jitter so tufts never swim as the camera moves.
        var h1 = Math.sin(gx * 12.9898 + gz * 78.233) * 43758.5453;
        var h2 = Math.sin(gx * 39.3468 + gz * 11.135) * 24634.6345;
        h1 -= Math.floor(h1); h2 -= Math.floor(h2);
        if (h1 > 0.62) continue;                       // thin them out
        var px = gx + (h1 - 0.5) * S, pz = gz + (h2 - 0.5) * S;
        if (T.speedAt(px, pz) <= 0) continue;          // no scrub on water
        if (T.onRoad(px, pz) > 0.5) continue;          // roads are bare
        var sp = cam.project(px, T.reliefAt(px, pz), pz, {});
        if (!sp || sp.x < -20 || sp.x > W2 + 20 || sp.y < -20 || sp.y > H2 + 20) continue;
        var hgt = (0.9 + h2 * 1.8) * sp.scale * 0.04;
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(sp.x + (h1 - 0.5) * hgt * 0.5, sp.y - hgt);
        if (++drawn > 1400) break;
      }
    }
    ctx.stroke();
  }

  function drawCar(dt) {
    car.stepDust(dt);
    // Re-sample the ground every frame: auto-travel moves the car by writing
    // x/z directly, so without this it would ride at a stale height.
    var relief = car.groundPose();

    // shadow
    ctx.fillStyle = "rgba(0,0,0,0.34)";
    R3.groundCircle(ctx, cam, car.x, car.z, 6.2, 18, relief);
    ctx.fill();

    // headlights on the ground, at the car's elevation
    if (car.lightsOn || TR.Clock.isNight() || state.weather === "storm") {
      var f = car.forward();
      var rx = -f[1], rz = f[0];
      var near = 8, far = 78, spread = 26;
      function lit(dist, side) {
        var wx = car.x + f[0] * dist + rx * side, wz = car.z + f[1] * dist + rz * side;
        return cam.project(wx, T.reliefAt(wx, wz) + 0.8, wz, {});
      }
      var quad = [lit(near, -3.5), lit(near, 3.5), lit(far, spread), lit(far, -spread)];
      if (quad[0] && quad[1] && quad[2] && quad[3]) {
        var g = ctx.createLinearGradient(quad[0].x, quad[0].y, quad[3].x, quad[3].y);
        g.addColorStop(0, "rgba(255,232,160,0.30)");
        g.addColorStop(1, "rgba(255,232,160,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(quad[0].x, quad[0].y);
        for (var i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
        ctx.closePath();
        ctx.fill();
      }
    }

    R3.drawMesh(ctx, car.mesh, cam,
      { x: car.x, y: relief, z: car.z, rot: car.heading,
        pitch: car.pitch, roll: car.roll, scale: car.scale },
      { light: light });

    // dust plume
    for (var d = 0; d < car.dust.length; d++) {
      var p = car.dust[d];
      var s = cam.project(p.x, T.reliefAt(p.x, p.z) + p.y, p.z, {});
      if (!s) continue;
      ctx.fillStyle = "rgba(170,152,116," + (p.life * 0.30).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(1, p.r * s.scale * 0.06), 0, 6.2832);
      ctx.fill();
    }
  }

  /**
   * Where to go when the target is not on screen. Without this, manual driving
   * is guesswork the moment the destination leaves the viewport.
   */
  function drawWaypointCue() {
    var target = state.waypoint;
    if (!target && state.travelDest) {
      var d = W.loc(state.travelDest);
      if (d) target = { x: d.x, z: d.z, name: d.name };
    }
    // Driving with a route plotted but not pinned still needs a heading cue.
    if (!target && state.mode === "drive" && state.selected) {
      var sel = W.loc(state.selected);
      if (sel) target = { x: sel.x, z: sel.z, name: sel.name };
    }
    if (!target || state.mode === "survey") return;

    var vw = cam.viewport.w, vh2 = cam.viewport.h;
    var cxp = vw / 2, cyp = vh2 / 2;
    var sp = cam.project(target.x, T.reliefAt(target.x, target.z) + 20, target.z, {});
    var miles = Math.hypot(target.x - car.x, target.z - car.z) * W.SCALE.milesPerUnit;

    // Keep the cue inside the map viewport - the HUD panels own the edges.
    var box = {
      l: 300, r: vw - 320,
      t: 70,  b: vh2 - (state.travel ? 210 : 140)
    };
    if (box.r < box.l + 80) { box.l = 20; box.r = vw - 20; }

    var onScreen = sp && sp.w > 0 && sp.x > box.l && sp.x < box.r &&
                   sp.y > box.t && sp.y < box.b;
    var ax, ay, ang;

    if (onScreen) {
      ax = sp.x; ay = sp.y;
      ang = null;
    } else {
      // Behind the camera projects to the wrong side - use the world bearing.
      var f = car.forward();
      var dx = target.x - car.x, dz = target.z - car.z;
      var rel = Math.atan2(dx, dz) - Math.atan2(-f[0], -f[1]);
      if (sp && sp.w > 0) {
        ang = Math.atan2(sp.y - cyp, sp.x - cxp);
      } else {
        ang = -Math.PI / 2 + rel;
      }
      // Ray from the viewport centre out to the clamp box.
      var ox = (box.l + box.r) / 2, oy = (box.t + box.b) / 2;
      var hx = (box.r - box.l) / 2, hy = (box.b - box.t) / 2;
      var ca = Math.cos(ang), sa = Math.sin(ang);
      var tx2 = ca !== 0 ? hx / Math.abs(ca) : 1e9;
      var tz2 = sa !== 0 ? hy / Math.abs(sa) : 1e9;
      var t = Math.min(tx2, tz2);
      ax = ox + ca * t;
      ay = oy + sa * t;
    }

    ctx.save();
    ctx.translate(ax, ay);
    var pulse = 0.75 + Math.sin(Date.now() * 0.005) * 0.25;

    if (ang !== null) {
      ctx.rotate(ang);
      ctx.fillStyle = "rgba(127,224,154," + pulse.toFixed(2) + ")";
      ctx.beginPath();
      ctx.moveTo(20, 0); ctx.lineTo(-8, -12); ctx.lineTo(-2, 0); ctx.lineTo(-8, 12);
      ctx.closePath(); ctx.fill();
      ctx.rotate(-ang);
    } else {
      ctx.strokeStyle = "rgba(127,224,154," + pulse.toFixed(2) + ")";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 13, 0, 6.2832); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -20); ctx.lineTo(0, -14); ctx.moveTo(0, 14); ctx.lineTo(0, 20);
      ctx.moveTo(-20, 0); ctx.lineTo(-14, 0); ctx.moveTo(14, 0); ctx.lineTo(20, 0);
      ctx.stroke();
    }

    var label = (target.name || "WAYPOINT") + "  " + Math.round(miles) + " MI";
    ctx.font = "11px Consolas, monospace";
    var tw = ctx.measureText(label).width;
    var lx = -tw / 2, ly = 26;
    ctx.fillStyle = "rgba(8,12,10,0.85)";
    ctx.fillRect(lx - 6, ly - 12, tw + 12, 18);
    ctx.strokeStyle = "rgba(127,224,154,0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(lx - 6, ly - 12, tw + 12, 18);
    ctx.fillStyle = "#9bf0b6";
    ctx.fillText(label, lx, ly + 1);
    ctx.restore();
  }

  function drawWeather(dt) {
    var w = cam.viewport.w, h = cam.viewport.h;
    if (state.weather === "storm") {
      if (rain.length < 220) {
        for (var i = rain.length; i < 220; i++) {
          rain.push({ x: Math.random() * w, y: Math.random() * h,
                      l: 9 + Math.random() * 16, v: 700 + Math.random() * 500 });
        }
      }
      ctx.strokeStyle = "rgba(186,214,226,0.30)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var r = 0; r < rain.length; r++) {
        var d2 = rain[r];
        d2.y += d2.v * dt;
        d2.x -= d2.v * dt * 0.16;
        if (d2.y > h) { d2.y = -20; d2.x = Math.random() * w; }
        if (d2.x < 0) d2.x = w;
        ctx.moveTo(d2.x, d2.y);
        ctx.lineTo(d2.x + d2.l * 0.16, d2.y + d2.l);
      }
      ctx.stroke();
    } else {
      rain.length = 0;
      if (motes.length < 42) {
        for (var m = motes.length; m < 42; m++) {
          motes.push({ x: Math.random() * w, y: Math.random() * h,
                       vx: 8 + Math.random() * 26, vy: (Math.random() - 0.5) * 9,
                       s: Math.random() * 1.5 + 0.4 });
        }
      }
      ctx.fillStyle = "rgba(214,196,150,0.16)";
      for (var k = 0; k < motes.length; k++) {
        var p2 = motes[k];
        p2.x += p2.vx * dt; p2.y += p2.vy * dt;
        if (p2.x > w) { p2.x = -4; p2.y = Math.random() * h; }
        ctx.fillRect(p2.x, p2.y, p2.s, p2.s);
      }
    }
  }

  function drawGrade() {
    var w = cam.viewport.w, h = cam.viewport.h;
    if (TR.Clock.isNight()) {
      ctx.fillStyle = "rgba(20,34,58,0.22)";
      ctx.fillRect(0, 0, w, h);
    } else if (state.weather === "storm") {
      ctx.fillStyle = "rgba(40,58,72,0.16)";
      ctx.fillRect(0, 0, w, h);
    }
  }

  /* =========================================================================
   * FRAME
   * ====================================================================== */
  var last = 0, worldTime = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (state.hidden) return;
    var t0 = performance.now();
    var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
    last = ts;
    worldTime += dt;
    updateLight();

    if (state.mode === "drive") stepDrive(dt);
    else if (state.mode === "travel") stepTravel(dt);
    else if (!state.paused && TIME_SCALES[state.timeScale]) {
      TR.Clock.advance(dt * TIME_SCALES[state.timeScale] * 0.5);
    }

    updateCamera(dt);

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    paintSky();

    T.draw3D(ctx, cam, {
      night: TR.Clock.isNight(),
      seams: QUALITY_TIERS[quality.tier].seams,
      light: light,
      haze: haze
    });

    var horizon = cam.horizonY();
    if (horizon > 0) drawSky(horizon);
    drawNetwork();
    drawGroundDetail();
    global.PROPS.draw(ctx, cam, {
      light: light,
      time: worldTime,
      dt: dt,
      maxProps: QUALITY_TIERS[quality.tier].detail ? 150 : 60
    });
    drawGrain();
    drawRoute();
    drawWaypoint();
    drawCar(dt);
    drawWaypointCue();
    global.PROPS.drawClouds(ctx, cam, { time: worldTime });
    drawWeather(dt);
    drawGrade();

    HUD.updateMarkers(cam, state);
    HUD.vehicle(car, state.mode);
    if (state.mode === "drive") HUD.compass(car.heading, state.waypoint, car);
    else HUD.compass(-cam.yaw, null, null);

    // Adaptive band size: keep the ground pass inside a frame budget.
    quality.acc += performance.now() - t0;
    if (++quality.frames >= 30) {
      var avg = quality.acc / quality.frames;
      quality.ms = avg;
      quality.fps = Math.round(1000 / Math.max(avg, 1 / 240));
      // Terrain density is the only knob that matters; step down hard when
      // frames run long, and creep back up only when there is real headroom.
      if (quality.lock) { quality.frames = 0; quality.acc = 0; }
      else if (avg > 18 && quality.tier < QUALITY_TIERS.length - 1) {
        quality.tier++;
        T.setTarget(QUALITY_TIERS[quality.tier].quads);
      } else if (avg < 8 && quality.tier > 0) {
        quality.tier--;
        T.setTarget(QUALITY_TIERS[quality.tier].quads);
      }
      quality.frames = 0; quality.acc = 0;
    }

    if (quality.showFps) {
      ctx.font = "12px Consolas, monospace";
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(cam.viewport.w - 250, cam.viewport.h - 150, 240, 56);
      ctx.fillStyle = "#7fe09a";
      ctx.fillText("frame  " + quality.ms.toFixed(2) + " ms · " + quality.fps + " fps", cam.viewport.w - 240, cam.viewport.h - 132);
      ctx.fillText("terrain " + T.stats.ms.toFixed(2) + " ms · " + T.stats.quads + " quads", cam.viewport.w - 240, cam.viewport.h - 116);
      ctx.fillText("tier " + quality.tier + " · step " + T.stats.step + " · target " + T.getTarget(), cam.viewport.w - 240, cam.viewport.h - 100);
    }
  }

  /* =========================================================================
   * INPUT
   * ====================================================================== */
  function wireInput() {
    global.addEventListener("resize", resize);

    canvas.addEventListener("mousedown", function (e) {
      var g = cam.unproject(e.clientX, e.clientY);
      drag = { x: e.clientX, y: e.clientY, btn: e.button, g: g, moved: 0 };
    });

    global.addEventListener("mousemove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.btn === 2) {
        cam.yaw -= dx * 0.006;
        cam.pitch = Math.max(0.35, Math.min(1.35, cam.pitch + dy * 0.004));
      } else if (state.mode !== "drive") {
        var k = cam.dist * 0.0022;
        var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
        cam.tx -= (dx * cy - dy * sy) * k;
        cam.tz -= (-dx * sy - dy * cy) * k;
        tween.on = false;
      }
      drag.x = e.clientX; drag.y = e.clientY;
    });

    global.addEventListener("mouseup", function (e) {
      if (drag && drag.moved < 5 && drag.btn === 0) onMapClick(e);
      drag = null;
    });

    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      var before = cam.unproject(e.clientX, e.clientY);
      cam.dist *= (e.deltaY > 0 ? 1.14 : 0.88);
      cam.dist = Math.max(90, Math.min(1500, cam.dist));
      cam.update(cam.viewport.w, cam.viewport.h);
      var after = cam.unproject(e.clientX, e.clientY);
      if (before && after && state.mode !== "drive") {
        cam.tx += before.x - after.x;
        cam.tz += before.z - after.z;
      }
      tween.on = false;
    }, { passive: false });

    global.addEventListener("keydown", function (e) {
      var k = e.key.toLowerCase();
      keys[k] = true;
      if (k === "shift") keys["shift"] = true;

      if (HUD.encounterOpen()) {
        var n = parseInt(k, 10);
        if (n >= 1 && n <= 9 && HUD._encChoices && HUD._encChoices[n - 1]) {
          var c = HUD._encChoices[n - 1], cb = HUD._encCb;
          HUD.closeEncounter();
          cb(c);
        }
        return;
      }

      switch (k) {
        case "tab":
          e.preventDefault();
          setMode(state.mode === "drive" ? "survey" : "drive");
          break;
        case "enter":
          if (state.selected) beginTravel();
          break;
        case "p":
          if (state.selected) pinAndDrive();
          break;
        case "escape":
          if (state.travel) abortTravel("player");
          else if (state.selected) clearSelection();
          else controller.exit();
          break;
        case "f":
          car.lightsOn = !car.lightsOn;
          HUD.toast("HEADLIGHTS " + (car.lightsOn ? "ON" : "OFF"));
          break;
        case "r": recenter(); break;
        case "0": case "1": case "2": case "3":
          controller.setTimeScale(parseInt(k, 10));
          break;
        case " ":
          if (state.mode !== "drive") {
            e.preventDefault();
            controller.setTimeScale(state.timeScale ? 0 : 1);
          }
          break;
      }
    });

    global.addEventListener("keyup", function (e) {
      keys[e.key.toLowerCase()] = false;
      if (e.key === "Shift") keys["shift"] = false;
    });

    global.addEventListener("blur", function () { keys = {}; });
  }

  function onMapClick(e) {
    var g = cam.unproject(e.clientX, e.clientY);
    if (!g) return;
    // Nearest location within a zoom-scaled grab radius.
    var best = null, bd = 1e9;
    W.LOCATIONS.forEach(function (l) {
      var d = Math.hypot(l.x - g.x, l.z - g.z);
      if (d < bd) { bd = d; best = l; }
    });
    var grab = Math.max(14, cam.dist * 0.045);
    if (best && bd < grab) { selectLocation(best.id, false); return; }

    if (state.mode === "drive") {
      state.waypoint = { x: g.x, z: g.z, id: null, name: "MAP MARK" };
      B.waypoint({ x: +g.x.toFixed(1), z: +g.z.toFixed(1) });
      HUD.toast("WAYPOINT SET");
    } else {
      clearSelection();
    }
  }

  function resize() {
    var w = global.innerWidth, h = global.innerHeight;
    canvas.width = Math.round(w * DPR);
    canvas.height = Math.round(h * DPR);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    cam.update(w, h);
    HUD.refreshPanelRects();
    rain.length = 0; motes.length = 0;
  }

  function refreshList() { HUD.buildList(state); }

  /* =========================================================================
   * CONTROLLER - the surface HUD calls back into
   * ====================================================================== */
  var controller = {
    selectLocation: selectLocation,
    clearSelection: clearSelection,
    beginTravel: beginTravel,
    pinAndDrive: pinAndDrive,
    refreshList: refreshList,
    recenter: function () { recenter(); },
    exit: function () {
      if (state.travel) abortTravel("player exit");
      B.uiClose();
      HUD.toast("CLOSING NAVCOM");
    },
    toggleRoads: function () {
      state.showRoads = !state.showRoads;
      HUD.toast("ROAD OVERLAY " + (state.showRoads ? "ON" : "OFF"));
    },
    setTimeScale: function (n) {
      state.timeScale = n;
      state.paused = (n === 0);
      HUD.speedButtons(n);
      HUD.toast(n === 0 ? "TIME PAUSED" : "TIME x" + TIME_SCALES[n]);
    },
    state: state,
    /** Toggle the on-canvas frame-cost readout (also: index.html#fps). */
    setFps: function (on) { quality.showFps = !!on; }
  };

  global.FO2Travel = controller;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
