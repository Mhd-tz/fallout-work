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
    // id -> false where the game has told us no interior exists yet. Absent
    // means "assume yes": the view must not hide a door the mod does have.
    enterable: {},
    entering: null,
    // Set once the game has taken the hand-off: the player is indoors and
    // the car is parked outside until they come back out.
    inside: null,
    car: null,
    // "3d" is the tilted terrain view, "2d" the straight-down chart. A view
    // is a camera choice, not a mode: driving, travel and picking all work
    // the same in either.
    view: "3d"
  };
  var TIME_SCALES = [0, 1, 3, 8];
  // Rolling within ARRIVE_R of a site parks you at it; LEAVE_R ends that.
  var ARRIVE_R = 24, LEAVE_R = 32;

  /* --- input state --------------------------------------------------------- */
  var keys = {};
  var drag = null;
  var wasBlocked = false;
  // Ultralight rasterises to the GPU, so the ceiling is set well above what a
  // software rasteriser can hold; the controller below finds the real limit.
  // Seam strokes are off at every tier: stroking each quad in its own fill
  // colour bled half a pixel into its neighbour and drew a visible lattice
  // across the whole map, which read as "pixelated" far more than the facets.
  var QUALITY_TIERS = [
    { quads: 9600, seams: false, detail: true  },
    { quads: 4800, seams: false, detail: true  },
    { quads: 2200, seams: false, detail: false },
    { quads: 1100, seams: false, detail: false }
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
          HUD.buildKey();
          $id("themeswitch").className = THEME.restore();
          restoreView();
          refreshEnterPrompt();
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

  var devBlend = null;
  function applyDevFlags() {
    var h = String(global.location.hash || "").slice(1);
    if (!h) return;
    var q = {};
    h.split("&").forEach(function (part) {
      var kv = part.split("=");
      q[kv[0]] = kv.length > 1 ? kv[1] : true;
    });

    if (q.fps) quality.showFps = true;
    if (q.theme) setTheme(q.theme);
    if (q.blend !== undefined) {
      devBlend = Math.max(0, Math.min(1, parseFloat(q.blend) || 0));
      cam.flat = devBlend;
    }
    // #view=2d lands straight on the chart, with the blend already settled.
    if (q.view) {
      setView(q.view === "2d" ? "2d" : "3d", true);
      cam.flat = state.view === "2d" ? 1 : 0;
      if (state.view === "2d") cam.pitch = Math.PI / 2;
    }
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
      // #at=x,z drops the car anywhere on the map - handy for inspecting a
      // bridge or a hillside without driving there first. Applied before the
      // chase camera is placed, or the camera frames where the car used to be.
      if (typeof q.at === "string") {
        var ap = q.at.split(",");
        if (ap.length >= 2) {
          car.x = parseFloat(ap[0]); car.z = parseFloat(ap[1]);
          revealAround(car.x, car.z, 240, true);
        }
      }
      if (q.heading !== undefined) car.heading = parseFloat(q.heading) || 0;

      setMode("drive");
      var fwd = car.forward();
      var chart = state.view === "2d";
      cam.yaw = chart ? 0 : car.heading;
      cam.tx = car.x + (chart ? 0 : fwd[0] * 26);
      cam.tz = car.z + (chart ? 0 : fwd[1] * 26);
      cam.dist = q.dist ? parseFloat(q.dist) : (chart ? 150 + CHART_DRIVE_EXTRA : 150);
      cam.pitch = q.pitch !== undefined ? parseFloat(q.pitch) : (chart ? Math.PI / 2 : 0.62);
      snapTween();
      if (q.speed) car.speed = parseFloat(q.speed) || 30;
      if (q.boost) state.forceBoost = true;   // dev: hold the overcharge open
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

    B.on("state.sync", function (m) {
      // A full sync is the game re-opening the map: whatever the player was
      // inside, they are back at the car now.
      if (state.inside) leaveLocation(true);
      applyState(m);
    });
    B.on("state.patch", function (m) { applyState(m); });

    B.on("clock.set", function (m) { TR.Clock.set(m); HUD.clock(); });

    // The game took the hand-off: the cell is loading, so this screen is done.
    B.on("location.entered", function (m) {
      var loc = W.loc(m.locId) || hereLoc();
      clearEntering();
      goInside(loc);
      HUD.toast("ENTERING " + (loc ? loc.name : "LOCATION"), "good");
      controller.exit();
    });

    // The player walked back out to the car (the game says so, or the mock).
    B.on("location.exited", function () { leaveLocation(true); });

    // Refused - over-encumbered, in combat, nothing built there. Give the
    // player the button back and tell them why.
    B.on("location.denied", function (m) {
      clearEntering();
      if (m.locId && m.permanent) state.enterable[m.locId] = false;
      refreshEnterPrompt();
      refreshDossier();
      HUD.toast("CANNOT ENTER \u00b7 " +
                String(m.reason || "refused").toUpperCase(), "warn");
    });

    B.on("loc.enterable", function (m) {
      if (!m.id) return;
      state.enterable[m.id] = m.enterable !== false;
      refreshEnterPrompt();
      refreshDossier();
    });

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
    if (m.theme) setTheme(m.theme);
    if (m.view) setView(m.view, true);
    if (m.enterable) applyEnterable(m.enterable);
    if (m.vehicle) {
      if (m.vehicle.fuel !== undefined) car.fuel = m.vehicle.fuel;
      if (m.vehicle.condition !== undefined) car.condition = m.vehicle.condition;
    }
    if (m.player && m.player.x !== undefined) {
      car.x = m.player.x; car.z = m.player.z;
      if (m.player.heading !== undefined) car.heading = m.player.heading;
    }
    if (m.here) {
      state.here = m.here;
      state.discovered[m.here] = true;
      var hereLocation = W.loc(m.here);
      if (hereLocation) {
        // No explicit player position: the car is parked at the site.
        if (!m.player) { car.x = hereLocation.x; car.z = hereLocation.z; }
        car.speed = 0;
        T.revealCircle(hereLocation.x, hereLocation.z, 118);
        recenter();
      }
      refreshEnterPrompt();
    }
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
    unfold("foldRight", "right");
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
    // CLEAR PLOT while the car is under way is the cancel button.
    if (state.travel) abortTravel("player");
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
   * ENTERING A LOCATION
   *
   * The hand-off out of this screen. The view has got the player to the gate;
   * loading the cell and moving them is the game's job, so all this does is
   * ask and then wait to be told what happened.
   * ====================================================================== */
  var ENTER_TIMEOUT = 6000;

  function hereLoc() {
    if (state.inside) return W.loc(state.inside) || null;
    if (!state.here || state.travel) return null;
    if (state.mode === "travel") return null;
    if (HUD.encounterOpen()) return null;
    var l = W.loc(state.here);
    return (l && state.discovered[l.id]) ? l : null;
  }

  /** Keep the arrival prompt in step with where the car actually is. */
  function refreshEnterPrompt() {
    var loc = hereLoc();
    if (!loc) { HUD.enterPrompt(null); return; }
    if (state.inside === loc.id) {
      HUD.enterPrompt(loc, "inside", "Inside \u00b7 the car is parked at the gate");
    } else if (state.entering && state.entering.id === loc.id) {
      HUD.enterPrompt(loc, "busy", "Handing over to the game\u2026");
    } else if (state.enterable[loc.id] === false) {
      HUD.enterPrompt(loc, "blocked", "No interior built for this site yet");
    } else {
      HUD.enterPrompt(loc, "ready");
    }
  }

  function enterLocation() {
    if (state.inside) { leaveLocation(false); return; }
    var loc = hereLoc();
    if (!loc) { HUD.toast("NOT AT A LOCATION", "warn"); return; }
    if (state.entering) return;
    if (state.enterable[loc.id] === false) {
      HUD.toast("NO INTERIOR BUILT FOR " + loc.name, "warn");
      return;
    }
    var idx = W.indexOf(loc.id);
    state.entering = { id: loc.id, at: Date.now() };
    refreshEnterPrompt();
    if (state.selected) refreshDossier();
    B.enterLocation(loc, idx);
    HUD.toast("ENTERING " + loc.name + "\u2026");

    // If the game never answers, give the player their button back rather
    // than leaving the screen stuck on "standby".
    state.entering.timer = setTimeout(function () {
      if (!state.entering || state.entering.id !== loc.id) return;
      state.entering = null;
      refreshEnterPrompt();
      if (state.selected) refreshDossier();
      HUD.toast("NO RESPONSE FROM " + loc.name + " \u00b7 TRY AGAIN", "warn");
    }, ENTER_TIMEOUT);
  }

  function clearEntering() {
    if (state.entering && state.entering.timer) clearTimeout(state.entering.timer);
    state.entering = null;
  }

  /**
   * The game has the player: park the car and lock the wheel. Driving, auto
   * travel and pinning are refused until leaveLocation(), so the map cannot
   * quietly carry the car off to the next town while its driver is indoors.
   */
  function goInside(loc) {
    if (!loc) return;
    state.inside = loc.id;
    state.here = loc.id;
    state.waypoint = null;
    car.speed = 0;
    if (state.mode === "drive") setMode("survey");
    refreshEnterPrompt();
    refreshDossier();
    refreshList();
    HUD.hint('<kbd>ENTER</kbd> leave ' + loc.name + ' &nbsp; <kbd>ESC</kbd> leave');
  }

  /** Back out to the car. `quiet` when the game announced it, not the player. */
  function leaveLocation(quiet) {
    if (!state.inside) return;
    var loc = W.loc(state.inside);
    state.inside = null;
    if (!quiet) {
      B.send("location.leave", { locId: loc ? loc.id : null, marker: loc ? loc.marker : null });
      HUD.toast("BACK AT THE HIGHWAYMAN");
    }
    refreshEnterPrompt();
    refreshDossier();
    HUD.hint('<kbd>LMB</kbd> pan &nbsp; <kbd>RMB</kbd> rotate &nbsp; <kbd>WHEEL</kbd> zoom &nbsp; <kbd>TAB</kbd> drive &nbsp; <kbd>ENTER</kbd> travel');
  }

  function refreshDossier() {
    if (!state.selected || !state.est) return;
    HUD.dossier(W.loc(state.selected), state.est, state);
  }

  /* =========================================================================
   * TRAVEL
   * ====================================================================== */
  function beginTravel() {
    if (!state.route || !state.selected) return;
    if (state.inside) { HUD.toast("LEAVE " + W.loc(state.inside).name + " FIRST [ENTER]", "warn"); return; }
    // Departing again while already under way rebuilt the course from the
    // last known stop and reset the odometer along it, which snapped the car
    // back to where it set off. One course at a time.
    if (state.travel) {
      HUD.toast(state.travel.dest === state.selected
        ? "ALREADY EN ROUTE"
        : "ALREADY EN ROUTE · ABORT FIRST [ESC]", "warn");
      return;
    }
    var loc = W.loc(state.selected);
    if (state.here === loc.id) {
      HUD.toast("ALREADY AT " + loc.name, "warn");
      return;
    }
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
    if (state.selected) HUD.dossier(loc, state.est, state);
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
    if (state.selected && state.est) {
      HUD.dossier(W.loc(state.selected), state.est, state);
    }
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

    // The Highwayman plugin has one hand-off, PlayerTravelToLocation(key),
    // and arriving is when Fallout 2 put you in the town, so call it here
    // and lock the map the same way ENTER does.
    if (B.hasTravelBinding() && B.travelTo(loc)) {
      goInside(loc);
      controller.exit();
    }
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
    if (state.inside) { HUD.toast("LEAVE " + W.loc(state.inside).name + " FIRST [ENTER]", "warn"); return; }
    if (!state.selected) return;
    var loc = W.loc(state.selected);
    state.waypoint = { x: loc.x, z: loc.z, id: loc.id, name: loc.name };
    B.waypoint({ x: loc.x, z: loc.z, destId: loc.id, destName: loc.name });
    setMode("drive");
    HUD.toast("WAYPOINT PINNED · " + loc.name + " · DRIVE MANUALLY");
  }

  var driveFeed = 0, clockFeed = 0;
  function stepDrive(dt) {
    if (HUD.encounterOpen() || state.inside) return;
    var throttle = 0, steer = 0;
    if (state.forceBoost) throttle += 1;
    if (keys["w"] || keys["arrowup"]) throttle += 1;
    if (keys["s"] || keys["arrowdown"]) throttle -= 1;
    if (keys["a"] || keys["arrowleft"]) steer += 1;
    if (keys["d"] || keys["arrowright"]) steer -= 1;
    var moved = car.step(dt, {
      throttle: throttle, steer: steer,
      boost: !!keys["shift"] || !!state.forceBoost,
      handbrake: !!keys[" "]
    });

    // Edge-triggered: holding W against a shoreline used to post the warning
    // every frame and bury the toast stack.
    if (car.blocked && !wasBlocked) HUD.toast("IMPASSABLE TERRAIN", "warn");
    wasBlocked = car.blocked;

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
    // The road usually passes a site rather than through it, so the arrival
    // radius is generous and the departure radius wider still, so the prompt
    // does not flicker at the edge.
    W.LOCATIONS.forEach(function (l) {
      if (Math.hypot(l.x - car.x, l.z - car.z) < ARRIVE_R) {
        if (state.here !== l.id) {
          state.here = l.id;
          refreshEnterPrompt();
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

    // ...and rolling back out again drops the arrival prompt.
    if (state.here) {
      var hl = W.loc(state.here);
      if (hl && Math.hypot(hl.x - car.x, hl.z - car.z) > LEAVE_R) {
        state.here = null;
        refreshList();
        refreshEnterPrompt();
      }
    }

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

  function $id(id) { return document.getElementById(id); }

  /** { id: bool } or [ids] - which locations the mod has interiors for. */
  function applyEnterable(map) {
    if (Array.isArray(map)) {
      W.LOCATIONS.forEach(function (l) { state.enterable[l.id] = false; });
      map.forEach(function (id) { state.enterable[id] = true; });
    } else {
      for (var k in map) if (map.hasOwnProperty(k)) {
        state.enterable[k] = map[k] !== false;
      }
    }
    refreshEnterPrompt();
    refreshDossier();
  }

  /**
   * Sand or terminal green. Both the chrome (CSS variables) and the world
   * (THEME.map, via TERRAIN.css and R3.shade) key off this, so one call
   * repaints everything on the next frame.
   */
  function setTheme(name) {
    var applied = THEME.set(name);
    $id("themeswitch").className = applied;
    B.send("ui.theme", { theme: applied });
    HUD.toast(applied === "green" ? "VAULT-TEC TERMINAL" : "CARTOGRAPHIC \u00b7 SAND");
    return applied;
  }

  /**
   * Perspective terrain or a flat top-down chart. Only the camera changes:
   * updateCamera eases cam.flat and the pitch toward the new target, so the
   * map tilts up into a chart (and back) instead of cutting.
   */
  var VIEWS = { "3d": 1, "2d": 1 };
  // Chase distance 150 plus this is the chart's driving zoom: about a third
  // of the map on screen, which is roughly the window the original scrolled.
  var CHART_DRIVE_EXTRA = 230;
  function setView(name, quiet) {
    if (!VIEWS[name]) name = "3d";
    var changed = state.view !== name;
    state.view = name;
    $id("viewswitch").className = name === "2d" ? "flat" : "persp";
    try { localStorage.setItem("fo2.view", name); } catch (e) { /* no storage */ }
    if (!changed) return name;
    B.send("ui.view", { view: name });
    if (!quiet) HUD.toast(name === "2d" ? "CHART VIEW \u00b7 2D" : "TERRAIN VIEW \u00b7 3D");
    return name;
  }
  function restoreView() {
    var v = "3d";
    try { v = localStorage.getItem("fo2.view") || "3d"; } catch (e) { /* no storage */ }
    if (!VIEWS[v]) v = "3d";
    state.view = v;
    cam.flat = v === "2d" ? 1 : 0;
    if (v === "2d") cam.pitch = Math.PI / 2;
    $id("viewswitch").className = v === "2d" ? "flat" : "persp";
  }

  /** Collapse a side panel down to its header bar, and back. */
  function fold(btnId, panelId) {
    var btn = $id(btnId), panel = $id(panelId);
    if (!btn || !panel) return;
    btn.onclick = function () {
      var shut = panel.className.indexOf("folded") < 0;
      panel.className = shut ? "panel folded" : "panel";
      btn.title = shut ? "Expand" : "Collapse";
      HUD.refreshPanelRects();
    };
  }

  /** Open a folded side panel, e.g. when its contents just changed. */
  function unfold(btnId, panelId) {
    var btn = $id(btnId), panel = $id(panelId);
    if (!panel || panel.className.indexOf("folded") < 0) return;
    panel.className = "panel";
    if (btn) btn.title = "Collapse";
    HUD.refreshPanelRects();
  }

  function setMode(mode) {
    if (state.mode === mode) return;
    if (mode === "drive" && state.inside) {
      HUD.toast("LEAVE " + W.loc(state.inside).name + " FIRST [ENTER]", "warn");
      return;
    }
    var prev = state.mode;
    state.mode = mode;
    HUD.mode(mode);

    if (mode === "drive") {
      B.driveBegin(car);
      B.setTravelMode(2);
      HUD.hint('<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive &nbsp; <kbd>SHIFT</kbd> boost &nbsp; <kbd>SPACE</kbd> brake &nbsp; <kbd>TAB</kbd> back to map &nbsp; <kbd>F</kbd> headlights');
    } else if (prev === "drive") {
      B.driveEnd(car);
      B.setTravelMode(state.travel ? 1 : 0);
      HUD.hint('<kbd>LMB</kbd> pan &nbsp; <kbd>RMB</kbd> rotate &nbsp; <kbd>WHEEL</kbd> zoom &nbsp; <kbd>TAB</kbd> drive &nbsp; <kbd>ENTER</kbd> travel');
    }
    tween.on = false;
    refreshEnterPrompt();
  }

  function recenter(instant) {
    var t = state.here ? W.loc(state.here) : car;
    tween.tx = t.x; tween.tz = t.z + 90;
    tween.dist = 560;
    tween.on = true;
    if (instant) { cam.tx = tween.tx; cam.tz = tween.tz; cam.dist = tween.dist; cam.yaw = 0; tween.on = false; }
  }

  function updateCamera(dt) {
    // Projection blend. The pitch target below is pulled toward vertical by
    // the same amount, so the tilt and the flattening arrive together.
    var flatWant = state.view === "2d" ? 1 : 0;
    if (devBlend !== null) flatWant = devBlend;   // #blend=0.5 holds a mid-tilt frame
    cam.flat += (flatWant - cam.flat) * Math.min(1, dt * 4.5);
    if (Math.abs(cam.flat - flatWant) < 0.004) cam.flat = flatWant;
    var flatK = cam.flat * cam.flat * (3 - 2 * cam.flat);
    var TOP = Math.PI / 2;
    // The pitch normally drifts to its target gently; during a view switch
    // it has ~0.7 rad to cover and must keep pace with the projection blend.
    var pitchRate = Math.abs(cam.flat - flatWant) > 0.002 ? 5.0 : 2.5;

    if (state.mode === "drive") {
      var f = car.forward();
      // The chase camera leads the car; the chart sits on it. Fallout 2's
      // map is north-up with the party as a small marker in the middle of
      // the sheet, and that is what the chart is, so the yaw goes to zero
      // there instead of following the heading.
      var lead = 26 * (1 - flatK);
      var tx = car.x + f[0] * lead, tz = car.z + f[1] * lead;
      var k = Math.min(1, dt * 4.2);
      cam.tx += (tx - cam.tx) * k;
      cam.tz += (tz - cam.tz) * k;
      var yawWant = flatK > 0.5 ? 0 : car.heading;
      var dy = yawWant - cam.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      cam.yaw += dy * Math.min(1, dt * 3.2);
      var pDrive = 0.62 + (TOP - 0.62) * flatK;
      cam.pitch += (pDrive - cam.pitch) * Math.min(1, dt * Math.max(3, pitchRate));
      cam.dist += ((150 + CHART_DRIVE_EXTRA * flatK) - cam.dist) * Math.min(1, dt * 3);
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
      if (state.view !== "2d") {
        if (keys["q"]) cam.yaw += dt * 1.1;
        if (keys["e"]) cam.yaw -= dt * 1.1;
      } else {
        // North-up: a chart does not turn.
        var dy2 = -cam.yaw;
        while (dy2 > Math.PI) dy2 -= Math.PI * 2;
        while (dy2 < -Math.PI) dy2 += Math.PI * 2;
        cam.yaw += dy2 * Math.min(1, dt * 3.2);
      }
      var pSurvey = 0.86 + (TOP - 0.86) * flatK;
      cam.pitch += (pSurvey - cam.pitch) * Math.min(1, dt * pitchRate);
    }

    var m = 260;
    cam.tx = Math.max(-m, Math.min(W.SIZE + m, cam.tx));
    cam.tz = Math.max(-m, Math.min(W.SIZE + m, cam.tz));
    cam.dist = Math.max(90, Math.min(1500, cam.dist));
    // The pitch ceiling opens up to vertical as the chart comes in.
    cam.pitch = Math.max(0.35, Math.min(1.35 + (TOP - 1.35) * flatK, cam.pitch));
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

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /**
   * A continuous solar model. Elevation is a sine over the whole 24h, so the
   * sun rises, crosses and sets without any switch between a "day" branch and
   * a "night" branch - the hard cut at 06:00/20:00 was what made the cycle
   * snap. Everything downstream reads `light.dayness` (0 night, 1 full day)
   * and interpolates.
   */
  function updateLight() {
    var h = TR.Clock.hour();

    var elev = Math.sin((h - 6) / 12 * Math.PI);          // +1 noon, -1 midnight
    var az = -Math.PI * 0.5 + ((h - 6) / 12) * Math.PI;   // east at dawn, west at dusk

    // Twilight band either side of the horizon rather than an instant flip.
    var dayness = clamp01((elev + 0.14) / 0.34);
    light.dayness = dayness;

    var lel, laz;
    if (elev > -0.03) { lel = Math.max(0.07, elev); laz = az; }
    else { lel = Math.max(0.30, -elev * 0.65); laz = az + Math.PI; }  // moon

    var pitch = Math.atan(lel);
    var ce = Math.cos(pitch);
    var dx = Math.sin(laz) * ce, dy = Math.sin(pitch) + 0.22, dz = -Math.cos(laz) * ce * 0.75;
    var L = Math.hypot(dx, dy, dz) || 1;
    light.dir[0] = dx / L; light.dir[1] = dy / L; light.dir[2] = dz / L;

    // Warm low sun near the horizon, cold moonlight at the bottom of the arc.
    var golden = clamp01(1 - Math.abs(elev) / 0.34) * dayness;

    light.amb = 0.20 + dayness * (0.16 + Math.max(0, elev) * 0.08);
    light.intensity = 0.30 + dayness * 0.95;

    var nt = [0.58, 0.72, 1.10];                          // moonlight
    light.tint[0] = nt[0] + (1 - nt[0]) * dayness + golden * 0.26;
    light.tint[1] = nt[1] + (1 - nt[1]) * dayness - golden * 0.05;
    light.tint[2] = nt[2] + (1 - nt[2]) * dayness - golden * 0.34;

    var nh = [16, 24, 40], dh = [120, 122, 104];
    haze[0] = nh[0] + (dh[0] - nh[0]) * dayness + golden * 66;
    haze[1] = nh[1] + (dh[1] - nh[1]) * dayness - golden * 16;
    haze[2] = nh[2] + (dh[2] - nh[2]) * dayness - golden * 34;

    if (state.weather === "storm") {
      light.intensity *= 0.55;
      light.amb += 0.05;
      light.tint[0] *= 0.86; light.tint[1] *= 0.92;
    }
  }

  /**
   * Backdrop the terrain silhouettes against. The horizon usually sits above
   * the top of the screen at survey pitch, so this is a full-canvas wash
   * rather than a band.
   */
  /* --- dynamic stars & skybox --------------------------------------------- */
  var stars = [];
  function getStars() {
    if (stars.length) return stars;
    for (var i = 0; i < 160; i++) {
      stars.push({
        x: ((i * 73.13) % 1),
        y: ((i * 37.49) % 1),
        size: 0.8 + ((i * 17) % 5) * 0.35,
        twinkle: 2.2 + ((i * 23) % 7),
        phase: (i * 1.618) % 6.28,
        hue: (i % 7 === 0) ? "#a6d2ff" : (i % 11 === 0) ? "#ffe6ba" : "#ffffff"
      });
    }
    return stars;
  }

  /**
   * Backdrop the terrain silhouettes against. Dynamic time-of-day atmospheric
   * wash that matches the day/night progression.
   */
  var skyCache = { w: 0, h: 0, night: null, weather: null, hour: null, grad: null };
  // Sky keyframes through the day. paintSky blends the two nearest, so dawn
  // and dusk arrive gradually instead of snapping between presets.
  var SKY_KEYS = [
    { h: 0.0,  c: [[3, 6, 12],   [7, 16, 26],  [16, 26, 38]] },
    { h: 4.5,  c: [[5, 10, 20],  [13, 22, 38], [29, 36, 54]] },
    { h: 6.2,  c: [[17, 20, 40], [44, 26, 46], [74, 42, 40]] },
    { h: 7.8,  c: [[22, 32, 47], [42, 51, 64], [90, 74, 52]] },
    { h: 12.0, c: [[22, 40, 60], [37, 56, 74], [74, 81, 72]] },
    { h: 16.5, c: [[24, 38, 54], [42, 53, 66], [81, 79, 66]] },
    { h: 18.6, c: [[20, 21, 38], [58, 26, 34], [94, 48, 32]] },
    { h: 20.2, c: [[11, 16, 32], [26, 22, 38], [44, 30, 38]] },
    { h: 24.0, c: [[3, 6, 12],   [7, 16, 26],  [16, 26, 38]] }
  ];

  /**
   * Every colour this module paints by hand goes through here, so switching
   * themes recolours the sky, the water, the roads and the route line along
   * with the terrain and the meshes. Alpha passes straight through - only the
   * hue is the theme's business.
   */
  function TC(r, g, b, a) {
    return a === undefined ? THEME.rgb(r, g, b) : THEME.rgba(r, g, b, a);
  }

  function rgbStr(c) { return THEME.rgb(c[0] | 0, c[1] | 0, c[2] | 0); }

  function skyAt(hour) {
    var a = SKY_KEYS[0], b = SKY_KEYS[SKY_KEYS.length - 1];
    for (var i = 1; i < SKY_KEYS.length; i++) {
      if (hour <= SKY_KEYS[i].h) { a = SKY_KEYS[i - 1]; b = SKY_KEYS[i]; break; }
    }
    var t = (hour - a.h) / ((b.h - a.h) || 1);
    var out = [];
    for (var k = 0; k < 3; k++) {
      out.push([
        a.c[k][0] + (b.c[k][0] - a.c[k][0]) * t,
        a.c[k][1] + (b.c[k][1] - a.c[k][1]) * t,
        a.c[k][2] + (b.c[k][2] - a.c[k][2]) * t
      ]);
    }
    return out;
  }

  function paintSky() {
    var w = cam.viewport.w, h = cam.viewport.h;
    var hour = TR.Clock.hour();
    var hBucket = Math.round(hour * 6) / 6;   // refresh every ten minutes
    if (skyCache.w !== w || skyCache.h !== h ||
        skyCache.weather !== state.weather || skyCache.hour !== hBucket) {
      var c = skyAt(hour);
      if (state.weather === "storm") {
        for (var k = 0; k < 3; k++) {
          c[k][0] = c[k][0] * 0.55 + 16; c[k][1] = c[k][1] * 0.6 + 20; c[k][2] = c[k][2] * 0.65 + 26;
        }
      }
      var g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, rgbStr(c[0]));
      g.addColorStop(0.5, rgbStr(c[1]));
      g.addColorStop(1, rgbStr(c[2]));
      skyCache = { w: w, h: h, weather: state.weather, hour: hBucket, grad: g };
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
    ctx.globalAlpha = 0.065;
    ctx.fillStyle = grainPat;
    ctx.fillRect(0, 0, cam.viewport.w, cam.viewport.h);
    ctx.restore();
  }

  function drawSky(horizon) {
    var w = cam.viewport.w, h = cam.viewport.h;
    var hour = TR.Clock.hour();
    var night = TR.Clock.isNight();

    // 1. Sky Dome Zenith-to-Horizon Gradient
    var g = ctx.createLinearGradient(0, 0, 0, Math.max(2, horizon));
    if (night) {
      g.addColorStop(0, "#03060c");
      g.addColorStop(0.5, "#0a1322");
      g.addColorStop(1, "#152234");
    } else if (state.weather === "storm") {
      g.addColorStop(0, "#0c1116");
      g.addColorStop(0.5, "#18212a");
      g.addColorStop(1, "#36424e");
    } else if (hour >= 4.5 && hour < 7.5) {
      // Sunrise / Dawn
      g.addColorStop(0, "#0c142b");
      g.addColorStop(0.4, "#2e1a38");
      g.addColorStop(0.75, "#b54432");
      g.addColorStop(1, "#fca24e");
    } else if (hour >= 17.0 && hour <= 20.0) {
      // Sunset / Golden Hour
      g.addColorStop(0, "#0d162e");
      g.addColorStop(0.4, "#481c32");
      g.addColorStop(0.75, "#cc4d28");
      g.addColorStop(1, "#fca842");
    } else {
      // Crisp Wasteland Daytime
      g.addColorStop(0, "#193558");
      g.addColorStop(0.45, "#3b6082");
      g.addColorStop(0.85, "#809bb0");
      g.addColorStop(1, "#c5c7b4");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, Math.max(0, horizon));

    // 2. Night Cosmic Features: Starfield & Wasteland Aurora
    if (night && state.weather !== "storm") {
      // Shimmering Ionized Radioactive Aurora / Airglow
      var flowT = worldTime * 0.4;
      var aurGrad = ctx.createLinearGradient(0, 0, w, 0);
      aurGrad.addColorStop(0, TC(40,180,120,0));
      aurGrad.addColorStop(0.3, TC(50,220,150,0.08));
      aurGrad.addColorStop(0.6, TC(40,160,210,0.09));
      aurGrad.addColorStop(1, TC(50,220,150,0));
      ctx.fillStyle = aurGrad;
      ctx.beginPath();
      ctx.moveTo(0, horizon * 0.45);
      for (var ax = 0; ax <= w; ax += 80) {
        var ay = horizon * 0.45 + Math.sin(ax * 0.008 + flowT) * 26 + Math.cos(ax * 0.015 - flowT * 0.5) * 14;
        ctx.lineTo(ax, ay);
      }
      ctx.lineTo(w, 0); ctx.lineTo(0, 0); ctx.closePath();
      ctx.fill();

      // Twinkling Starfield
      var st = getStars();
      for (var sIdx = 0; sIdx < st.length; sIdx++) {
        var star = st[sIdx];
        var sx = star.x * w;
        var sy = star.y * Math.max(1, horizon - 8);
        var tw = 0.5 + 0.5 * Math.sin(worldTime * star.twinkle + star.phase);
        ctx.fillStyle = star.hue;
        ctx.globalAlpha = 0.35 + 0.65 * tw;
        ctx.fillRect(sx, sy, star.size, star.size);
      }
      ctx.globalAlpha = 1;
    }

    // 3. 3D Celestial Body (Sun or Moon)
    var sunDist = 5000;
    var sunWx = cam.tx - light.dir[0] * sunDist;
    var sunWy = cam.ty + Math.max(200, light.dir[1] * sunDist);
    var sunWz = cam.tz - light.dir[2] * sunDist;
    var sunSp = cam.project(sunWx, sunWy, sunWz, {});

    if (sunSp && sunSp.w > 0 && sunSp.x > -150 && sunSp.x < w + 150 && sunSp.y < horizon + 80) {
      if (night) {
        // Glowing Moon
        var mR = 14;
        var mHalo = ctx.createRadialGradient(sunSp.x, sunSp.y, mR * 0.5, sunSp.x, sunSp.y, mR * 4.5);
        mHalo.addColorStop(0, TC(195,220,255,0.45));
        mHalo.addColorStop(0.5, TC(160,195,240,0.15));
        mHalo.addColorStop(1, TC(160,195,240,0));
        ctx.fillStyle = mHalo;
        ctx.beginPath(); ctx.arc(sunSp.x, sunSp.y, mR * 4.5, 0, 6.2832); ctx.fill();

        // Moon disc
        ctx.fillStyle = "#e6f0ff";
        ctx.beginPath(); ctx.arc(sunSp.x, sunSp.y, mR, 0, 6.2832); ctx.fill();

        // Maria / crater texture
        ctx.fillStyle = TC(110,135,165,0.32);
        ctx.beginPath();
        ctx.arc(sunSp.x - 3, sunSp.y - 2, 4.5, 0, 6.2832);
        ctx.arc(sunSp.x + 4, sunSp.y + 3, 3.5, 0, 6.2832);
        ctx.arc(sunSp.x - 2, sunSp.y + 5, 2.5, 0, 6.2832);
        ctx.fill();
      } else if (state.weather !== "storm") {
        // Radiant Sun
        var sR = (hour < 7.5 || hour > 17) ? 19 : 15;
        var sHalo = ctx.createRadialGradient(sunSp.x, sunSp.y, sR * 0.4, sunSp.x, sunSp.y, sR * 6.5);
        var haloCol = (hour < 7.5 || hour > 17) ? "rgba(255, 165, 80," : "rgba(255, 240, 185,";
        sHalo.addColorStop(0, haloCol + "0.65)");
        sHalo.addColorStop(0.3, haloCol + "0.28)");
        sHalo.addColorStop(1, haloCol + "0)");
        ctx.fillStyle = sHalo;
        ctx.beginPath(); ctx.arc(sunSp.x, sunSp.y, sR * 6.5, 0, 6.2832); ctx.fill();

        // Sun disc
        ctx.fillStyle = (hour < 7.5 || hour > 17) ? "#fff0d0" : "#ffffff";
        ctx.beginPath(); ctx.arc(sunSp.x, sunSp.y, sR, 0, 6.2832); ctx.fill();

        // Subtle solar flare rays
        ctx.strokeStyle = haloCol + "0.22)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (var ray = 0; ray < 8; ray++) {
          var rAng = ray * (Math.PI / 4) + worldTime * 0.05;
          ctx.moveTo(sunSp.x + Math.cos(rAng) * (sR + 4), sunSp.y + Math.sin(rAng) * (sR + 4));
          ctx.lineTo(sunSp.x + Math.cos(rAng) * (sR * 3.5), sunSp.y + Math.sin(rAng) * (sR * 3.5));
        }
        ctx.stroke();
      }
    }

    // 4. Distant Mountain Silhouettes along the Horizon
    var mtnCol = night ? TC(12,18,28,0.92)
               : (state.weather === "storm") ? TC(35,45,55,0.9)
               : (hour < 7.5 || hour > 17) ? TC(75,40,48,0.85)
               : TC(105,112,105,0.75);
    ctx.fillStyle = mtnCol;
    ctx.beginPath();
    ctx.moveTo(0, horizon + 2);
    for (var mx = 0; mx <= w; mx += 35) {
      var mh = Math.sin(mx * 0.009 + 1.2) * 14 + Math.sin(mx * 0.024 + 4.1) * 7 + Math.sin(mx * 0.055) * 3;
      ctx.lineTo(mx, horizon - Math.max(0, mh));
    }
    ctx.lineTo(w, horizon + 4); ctx.lineTo(0, horizon + 4); ctx.closePath();
    ctx.fill();

    // 5. Atmospheric Horizon Haze
    var hz = ctx.createLinearGradient(0, horizon - 3, 0, horizon + h * 0.18);
    var hzCol = night ? "rgba(21, 34, 52,"
              : (state.weather === "storm") ? "rgba(54, 66, 78,"
              : (hour < 7.5 || hour > 17) ? "rgba(220, 130, 80,"
              : "rgba(197, 199, 180,";
    hz.addColorStop(0, hzCol + "0.95)");
    hz.addColorStop(0.3, hzCol + "0.60)");
    hz.addColorStop(1, TC(0,0,0,0));
    ctx.fillStyle = hz;
    ctx.fillRect(0, horizon - 3, w, h * 0.18 + 3);
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

    // Multi-layered organic flowing river system
    var flow = (global.performance ? performance.now() : Date.now()) * 0.001;
    W.RIVERS.forEach(function (riv) {
      var pts = riv.pts || riv;
      var runs = [], cur = null;
      for (var i = 0; i < pts.length; i++) {
        var wx = pts[i][0], wz = pts[i][1];
        if (!T.isDiscovered(wx, wz)) { cur = null; continue; }
        var wl = T.waterLevelAt(wx, wz);
        var wy = wl === null ? T.reliefAt(wx, wz) : T.hToRelief(wl);
        var sp = cam.project(wx, wy + 0.6, wz, {});
        if (!sp || sp.x < -400 || sp.x > vwid + 400 || sp.y < -400 || sp.y > vhei + 400) {
          cur = null; continue;
        }
        if (!cur) { cur = []; runs.push(cur); }
        cur.push(sp);
      }
      var wide = Math.max(5.5, 4800 / cam.dist);
      runs.forEach(function (run) {
        if (run.length < 2) return;

        // Layer 1: Silt / wet sand riverbanks
        ctx.setLineDash([]);
        ctx.strokeStyle = TR.Clock.isNight() ? TC(16,28,38,0.70) : TC(80,72,50,0.55);
        ctx.lineWidth = wide * 1.9;
        strokePts(run);

        // Layer 2: Deep channel bed
        ctx.strokeStyle = TR.Clock.isNight() ? TC(10,32,52,0.90) : TC(20,60,74,0.88);
        ctx.lineWidth = wide * 1.3;
        strokePts(run);

        // Layer 3: Vibrant water surface
        ctx.strokeStyle = TR.Clock.isNight() ? TC(24,75,110,0.85) : TC(38,120,145,0.82);
        ctx.lineWidth = wide * 0.85;
        strokePts(run);

        // Layer 4: Marching downstream ripples
        ctx.strokeStyle = TR.Clock.isNight() ? TC(130,195,235,0.45) : TC(195,235,252,0.58);
        ctx.lineWidth = Math.max(1.1, wide * 0.32);
        ctx.setLineDash([wide * 2.2, wide * 3.6]);
        ctx.lineDashOffset = -flow * wide * 4.2;
        strokePts(run);

        // Layer 5: Sparkling foam & flow glints
        ctx.strokeStyle = TC(255,255,255,0.68);
        ctx.lineWidth = Math.max(0.8, wide * 0.16);
        ctx.setLineDash([wide * 0.7, wide * 6.5]);
        ctx.lineDashOffset = -flow * wide * 2.5 + wide * 1.8;
        strokePts(run);
        ctx.setLineDash([]);
      });
    });

    // Lakes with multi-tier shorelines & shimmers
    W.LAKES.forEach(function (lk) {
      if (!T.isDiscovered(lk.x, lk.z)) return;
      var wl = T.waterLevelAt(lk.x, lk.z);
      if (wl === null) return;
      var ly = T.hToRelief(wl) + 0.5;

      // Lake shore sand ring
      ctx.strokeStyle = TR.Clock.isNight() ? TC(20,32,42,0.6) : TC(165,145,105,0.45);
      ctx.lineWidth = Math.max(2, 1600 / cam.dist);
      R3.groundCircle(ctx, cam, lk.x, lk.z, lk.r * 1.02, 32, ly);
      ctx.stroke();

      for (var b = 0; b < 4; b++) {
        var rr = lk.r * (0.28 + b * 0.22) + Math.sin(flow * 0.8 + b * 1.2) * 2.5;
        var alpha = (0.22 - b * 0.04);
        ctx.strokeStyle = TR.Clock.isNight()
          ? TC(110,180,230,alpha.toFixed(3))
          : TC(180,230,250,alpha.toFixed(3));
        ctx.lineWidth = Math.max(1, 1100 / cam.dist);
        R3.groundCircle(ctx, cam, lk.x, lk.z, rr, 30, ly);
        ctx.stroke();
      }
    });

    // Embankments first: the road ribbon then paints itself up and over them,
    // because surfaceAt() already knows the deck skirt is there.
    global.PROPS.drawRamps(ctx, cam, light);
    if (!state.showRoads) return;
    drawRoads();
  }

  /* =========================================================================
   * ROADS
   *
   * Drawn as a ribbon of ground quads in WORLD space, not as a screen-space
   * stroke. A stroke has a constant pixel width, so the road stayed the same
   * thin line however close the camera got, and its dash pattern was measured
   * in screen pixels - which is why the markings slid along the road as you
   * drove. Every dimension below is in world units and projected, so the
   * surface is exactly the width the driving model reads off the road mask
   * and the markings stay nailed to the ground.
   * ====================================================================== */
  var roadBuf = [];

  /** Offset a polyline sideways by `h` world units, with mitred joins. */
  function ribbon(pts, h, out) {
    out.length = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var a = pts[i > 0 ? i - 1 : 0], b = pts[i < pts.length - 1 ? i + 1 : i];
      var dx = b[0] - a[0], dz = b[1] - a[1];
      var l = Math.sqrt(dx * dx + dz * dz) || 1;
      out.push([p[0] - (dz / l) * h, p[1] + (dx / l) * h]);
    }
    return out;
  }

  /** World point -> screen, sitting a hair above the surface. */
  function onGround(x, z, lift) {
    return cam.project(x, T.surfaceAt(x, z) + lift, z, {});
  }

  function fillStrip(L, R, style) {
    ctx.fillStyle = style;
    for (var i = 1; i < L.length; i++) {
      var a = L[i - 1], b = L[i], c = R[i], d = R[i - 1];
      if (!a || !b || !c || !d) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** Project one offset polyline, dropping anything unsurveyed or off screen. */
  function projectOffset(pts, h, lift, keep) {
    var off = ribbon(pts, h, roadBuf);
    var out = [];
    for (var i = 0; i < off.length; i++) {
      var wx = off[i][0], wz = off[i][1];
      if (!keep[i]) { out.push(null); continue; }
      out.push(onGround(wx, wz, lift));
    }
    return out;
  }

  function drawRoads() {
    var vwid = cam.viewport.w, vhei = cam.viewport.h;
    var day = light.dayness === undefined ? 1 : light.dayness;
    // Asphalt in daylight, near-black at night, with the shoulder a shade
    // lighter so the edge of the carriageway reads.
    // The theme owns these outright rather than having them ramped. On a
    // terminal the ramp crushes tarmac to black along with the ground it sits
    // on, and a road you cannot see is not a road - there, the carriageway
    // goes darker than the terrain and the markings blaze instead.
    var SC = THEME.scene, term = THEME.isTerminal();
    var deck = THEME.mix(SC.road, SC.roadLit, day * 0.55);
    var shoulder = THEME.mix(SC.road, SC.roadLit, 0.45 + day * 0.55);
    var paint = THEME.raw(SC.paint, (term ? 0.62 + day * 0.34
                                          : 0.34 + day * 0.52).toFixed(2));

    W.ROADS.forEach(function (r) {
      var pts = T.roadPoints(r);
      var hw = T.roadHalfWidth(r);

      // Which vertices are drawable at all: surveyed, on screen, in front.
      var keep = [], anyKeep = false, px = 0;
      for (var i = 0; i < pts.length; i++) {
        var ok = T.isDiscovered(pts[i][0], pts[i][1]);
        if (ok) {
          var sp = onGround(pts[i][0], pts[i][1], 0.35);
          ok = !!sp && sp.x > -600 && sp.x < vwid + 600 &&
                       sp.y > -600 && sp.y < vhei + 600;
          if (ok) px = Math.max(px, sp.scale * hw * 2);
        }
        keep[i] = ok;
        anyKeep = anyKeep || ok;
      }
      if (!anyKeep) return;

      // Two readings of the same road. Close up it is tarmac; pulled back to
      // survey the continent it is a line on a chart, because a 4px ribbon of
      // grey asphalt tells you nothing about where the roads go. They cross
      // fade over a narrow band of on-screen width so zooming is not a jump.
      var k = Math.max(0, Math.min(1, (px - 13) / 11));

      if (k < 1) {
        var thin = [];
        for (var t = 0; t < pts.length; t++) {
          thin.push(keep[t] ? onGround(pts[t][0], pts[t][1], 0.6) : null);
        }
        ctx.globalAlpha = 1 - k;
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.strokeStyle = THEME.raw(SC.road, 0.85);
        ctx.lineWidth = Math.max(3, px * 0.85 + 1.8);
        strokeGaps(thin);
        ctx.strokeStyle = THEME.raw(SC.paint,
          r.w >= 0.9 ? 0.95 : r.w >= 0.6 ? 0.82 : 0.62);
        ctx.lineWidth = Math.max(1.4, px * 0.42);
        strokeGaps(thin);
        ctx.globalAlpha = 1;
      }
      if (k <= 0) return;

      ctx.globalAlpha = k;
      // Shoulder, then carriageway.
      fillStrip(projectOffset(pts, -hw * 1.34, 0.28, keep),
                projectOffset(pts,  hw * 1.34, 0.28, keep), shoulder);
      fillStrip(projectOffset(pts, -hw, 0.42, keep),
                projectOffset(pts,  hw, 0.42, keep), deck);

      // Edge lines, then the centre line. Both are real geometry, so they
      // stay put on the tarmac instead of crawling with the camera.
      var edge = Math.max(0.34, hw * 0.075);
      if (px > 26) {
        fillStrip(projectOffset(pts, -hw * 0.86 - edge, 0.5, keep),
                  projectOffset(pts, -hw * 0.86 + edge, 0.5, keep), paint);
        fillStrip(projectOffset(pts,  hw * 0.86 - edge, 0.5, keep),
                  projectOffset(pts,  hw * 0.86 + edge, 0.5, keep), paint);
      }
      if (px > 34 && r.w >= 0.6) centreLine(pts, keep, edge, paint, r.w >= 0.9);
      ctx.globalAlpha = 1;
    });
  }

  /** Stroke a projected polyline that may contain null gaps. */
  function strokeGaps(pts) {
    ctx.beginPath();
    var pen = false;
    for (var i = 0; i < pts.length; i++) {
      if (!pts[i]) { pen = false; continue; }
      if (!pen) { ctx.moveTo(pts[i].x, pts[i].y); pen = true; }
      else ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
  }

  /**
   * Dashes measured in world units along the centre of the road, emitted as
   * their own little quads. A solid double line marks a highway.
   */
  function centreLine(pts, keep, edge, paint, solid) {
    if (solid) {
      fillStrip(projectOffset(pts, -edge * 2.6, 0.55, keep),
                projectOffset(pts, -edge * 0.6, 0.55, keep), paint);
      fillStrip(projectOffset(pts,  edge * 0.6, 0.55, keep),
                projectOffset(pts,  edge * 2.6, 0.55, keep), paint);
      return;
    }
    var DASH = 7, GAP = 9;
    ctx.fillStyle = paint;
    var s = 0;
    for (var i = 1; i < pts.length; i++) {
      if (!keep[i] || !keep[i - 1]) {
        s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        continue;
      }
      var ax = pts[i - 1][0], az = pts[i - 1][1];
      var dx = pts[i][0] - ax, dz = pts[i][1] - az;
      var len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      var ux = dx / len, uz = dz / len, nx = -uz, nz = ux;
      // Walk this segment in world units, painting wherever the cycle is on.
      var t = 0;
      while (t < len) {
        var phase = (s + t) % (DASH + GAP);
        if (phase < DASH) {
          var run = Math.min(len - t, DASH - phase);
          var x0 = ax + ux * t, z0 = az + uz * t;
          var x1 = ax + ux * (t + run), z1 = az + uz * (t + run);
          var q = [
            onGround(x0 + nx * edge, z0 + nz * edge, 0.55),
            onGround(x1 + nx * edge, z1 + nz * edge, 0.55),
            onGround(x1 - nx * edge, z1 - nz * edge, 0.55),
            onGround(x0 - nx * edge, z0 - nz * edge, 0.55)
          ];
          if (q[0] && q[1] && q[2] && q[3]) {
            ctx.beginPath();
            ctx.moveTo(q[0].x, q[0].y);
            for (var v = 1; v < 4; v++) ctx.lineTo(q[v].x, q[v].y);
            ctx.closePath();
            ctx.fill();
          }
          t += run;
        } else {
          t += Math.min(len - t, DASH + GAP - phase);
        }
      }
      s += len;
    }
  }

  function drawRoute() {
    var route = state.route;
    if (!route) return;
    var pts = projectOnGround(route.points, 1.2);
    if (pts.length < 2) return;

    // casing
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.strokeStyle = TC(0,0,0,0.78);
    ctx.lineWidth = 10.5;
    strokePts(pts);
    ctx.strokeStyle = TC(255,244,214,0.22);
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
    ctx.strokeStyle = TC(255,252,240,0.98);
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
        ctx.strokeStyle = TC(255,182,66,0.98);
        ctx.lineWidth = 5.2;
        strokePts(dp);
      }
    }

    // destination ring
    var dest = W.loc(route.dest);
    if (dest) {
      var pulse = 10 + Math.sin(Date.now() * 0.004) * 3;
      ctx.strokeStyle = TC(127,224,154,0.85);
      ctx.lineWidth = 2;
      var dy = T.reliefAt(dest.x, dest.z) + 1;
      R3.groundCircle(ctx, cam, dest.x, dest.z, pulse, 26, dy);
      ctx.stroke();
      ctx.strokeStyle = TC(127,224,154,0.28);
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
    ctx.strokeStyle = TC(127,224,154,0.9);
    ctx.lineWidth = 2;
    R3.groundCircle(ctx, cam, wp.x, wp.z, r, 24, wy + 1);
    ctx.stroke();
    var top = cam.project(wp.x, wy + 40 + Math.sin(t) * 3, wp.z, {});
    var base = cam.project(wp.x, wy, wp.z, {});
    if (top && base) {
      ctx.strokeStyle = TC(127,224,154,0.45);
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
      ctx.fillStyle = TC(127,224,154,0.95);
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

    ctx.strokeStyle = TC(32,34,22,(0.5 * alpha).toFixed(3));
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
    // On the chart the car is a marker, and a marker casts no shadow, throws
    // no headlight cone and has no reactor on its trunk. The overcharge
    // streaks stay: they are the one thing the boost gauge points at.
    var chart = cam.flat >= 0.5;

    // shadow
    if (!chart) {
      ctx.fillStyle = TC(0,0,0,0.34);
      R3.groundCircle(ctx, cam, car.x, car.z, 6.2, 18, relief);
      ctx.fill();
    }

    // headlights on the ground, at the car's elevation
    if (!chart && (car.lightsOn || TR.Clock.isNight() || state.weather === "storm")) {
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
        g.addColorStop(0, TC(255,232,160,0.30));
        g.addColorStop(1, TC(255,232,160,0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(quad[0].x, quad[0].y);
        for (var i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
        ctx.closePath();
        ctx.fill();
      }
    }

    if (!chart) {
      R3.drawMesh(ctx, car.mesh, cam,
        { x: car.x, y: relief, z: car.z, rot: car.heading,
          pitch: car.pitch, roll: car.roll, scale: car.scale },
        { light: light });
    } else {
      drawChartPlayer(relief);
    }

    // Atomic Micro-Fusion Cell (MFC) reactor pulse glow on the trunk
    var cf = car.forward();
    var rearWx = car.x - cf[0] * 5.0, rearWz = car.z - cf[1] * 5.0;
    var rearSp = chart ? null : cam.project(rearWx, relief + 3.2, rearWz, {});
    if (rearSp && rearSp.w > 0) {
      var pulse = 0.72 + 0.28 * Math.sin(worldTime * 8.5);
      var rxGlow = ctx.createRadialGradient(rearSp.x, rearSp.y, 1, rearSp.x, rearSp.y, Math.max(6, 16 * rearSp.scale * 0.035));
      rxGlow.addColorStop(0, TC(80,225,255,(0.75 * pulse).toFixed(2)));
      rxGlow.addColorStop(0.45, TC(40,130,240,(0.35 * pulse).toFixed(2)));
      rxGlow.addColorStop(1, TC(20,80,220,0));
      ctx.fillStyle = rxGlow;
      ctx.beginPath();
      ctx.arc(rearSp.x, rearSp.y, Math.max(6, 16 * rearSp.scale * 0.035), 0, 6.2832);
      ctx.fill();
    }

    // Overcharge streaks: drawn under the dust so the plume rolls over them.
    if (car.trail.length) {
      for (var tr = 0; tr < car.trail.length; tr++) {
        var q = car.trail[tr];
        var qs = cam.project(q.x, T.surfaceAt(q.x, q.z) + q.y, q.z, {});
        if (!qs) continue;
        var qr = Math.max(2, q.r * qs.scale * 0.095);
        var qg = ctx.createRadialGradient(qs.x, qs.y, 0, qs.x, qs.y, qr);
        qg.addColorStop(0, TC(190,246,255,(q.life * 0.75).toFixed(3)));
        qg.addColorStop(0.4, TC(78,196,255,(q.life * 0.45).toFixed(3)));
        qg.addColorStop(1, TC(30,96,230,0));
        ctx.fillStyle = qg;
        ctx.beginPath();
        ctx.arc(qs.x, qs.y, qr, 0, 6.2832);
        ctx.fill();
      }
      // Twin jets off the tailpipes, so the overcharge reads instantly even
      // at a standstill when there are no particles in the air yet.
      if (car.boosting) {
        var bf = car.forward();
        var brx = -bf[1], brz = bf[0];
        ctx.lineCap = "round";
        for (var js = -1; js <= 1; js += 2) {
          var ox = brx * js * 2.2, oz = brz * js * 2.2;
          var b0 = cam.project(car.x - bf[0] * 5.4 + ox, relief + 2.2,
                               car.z - bf[1] * 5.4 + oz, {});
          var b1 = cam.project(car.x - bf[0] * 17 + ox, relief + 2.2,
                               car.z - bf[1] * 17 + oz, {});
          if (!b0 || !b1) continue;
          var lg = ctx.createLinearGradient(b0.x, b0.y, b1.x, b1.y);
          lg.addColorStop(0, TC(228,252,255,0.9));
          lg.addColorStop(0.35, TC(110,210,255,0.55));
          lg.addColorStop(1, TC(60,150,255,0));
          ctx.strokeStyle = lg;
          ctx.lineWidth = Math.max(3, 10 * b0.scale * 0.06);
          ctx.beginPath();
          ctx.moveTo(b0.x, b0.y);
          ctx.lineTo(b1.x, b1.y);
          ctx.stroke();
        }
        ctx.lineWidth = 1;
        ctx.lineCap = "butt";
      }
    }

    // dust plume
    for (var d = 0; d < car.dust.length; d++) {
      var p = car.dust[d];
      var s = cam.project(p.x, T.reliefAt(p.x, p.z) + p.y, p.z, {});
      if (!s) continue;
      ctx.fillStyle = TC(170,152,116,(p.life * 0.30).toFixed(3));
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(1, p.r * s.scale * 0.06), 0, 6.2832);
      ctx.fill();
    }
  }

  /**
   * The party marker on the chart: Fallout 2 drew the player as a small
   * hollow triangle on the world map, and at chart zoom the car model is a
   * few pixels of red anyway. Screen-sized, so it reads at every zoom, and
   * pointed along the heading so you can still tell which way you are going
   * on a north-up sheet.
   */
  function drawChartPlayer(relief) {
    var s = cam.project(car.x, relief + 1, car.z, {});
    if (!s) return;
    // Point the marker the way the car's own forward vector projects, so it
    // cannot disagree with the model about which way is left.
    var fwd = car.forward();
    var ahead = cam.project(car.x + fwd[0] * 10, relief + 1, car.z + fwd[1] * 10, {});
    var ux = 0, uy = -1;
    if (ahead) {
      var dx = ahead.x - s.x, dy = ahead.y - s.y, dl = Math.hypot(dx, dy);
      if (dl > 1e-3) { ux = dx / dl; uy = dy / dl; }
    }
    var r = 11;
    var tip = [s.x + ux * r, s.y + uy * r];
    var bl = [s.x - ux * r * 0.8 - uy * r * 0.7, s.y - uy * r * 0.8 + ux * r * 0.7];
    var br = [s.x - ux * r * 0.8 + uy * r * 0.7, s.y - uy * r * 0.8 - ux * r * 0.7];
    var notch = [s.x - ux * r * 0.35, s.y - uy * r * 0.35];
    var glow = [255, 84, 64];
    ctx.save();
    ctx.lineJoin = "round";
    ctx.shadowColor = THEME.raw(glow, 0.9);
    ctx.shadowBlur = 10;
    ctx.fillStyle = TC(0, 0, 0, 0.55);
    ctx.strokeStyle = THEME.raw(glow, 0.95);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(bl[0], bl[1]);
    ctx.lineTo(notch[0], notch[1]);
    ctx.lineTo(br[0], br[1]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // A faint ring marks the spot when the car is stationary on a busy sheet.
    if (car.speed < 0.5) {
      ctx.strokeStyle = THEME.raw(glow, 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 6, 0, 6.2832);
      ctx.stroke();
    }
  }

  /**
   * The Vault-Tec survey grid. The original world map is divided into
   * squares - the fog of war lifts one square at a time - and that grid is
   * most of what makes it read as "the Fallout 2 map". Ours is drawn in
   * world units on the ground, so it stays put as the chart pans and zooms,
   * and it fades in with the tilt.
   */
  var GRID_CELL = 50;
  function drawChartGrid() {
    var k = cam.flat;
    if (k < 0.55) return;
    var fade = Math.min(1, (k - 0.55) / 0.35);
    var vw = cam.viewport.w, vh = cam.viewport.h;
    // Visible window on the ground, from the screen corners.
    var c = [cam.unproject(0, 0), cam.unproject(vw, 0), cam.unproject(0, vh), cam.unproject(vw, vh)];
    var x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (var i = 0; i < 4; i++) {
      if (!c[i]) return;
      x0 = Math.min(x0, c[i].x); x1 = Math.max(x1, c[i].x);
      z0 = Math.min(z0, c[i].z); z1 = Math.max(z1, c[i].z);
    }
    x0 = Math.max(0, x0); z0 = Math.max(0, z0);
    x1 = Math.min(W.SIZE, x1); z1 = Math.min(W.SIZE, z1);
    if (x1 <= x0 || z1 <= z0) return;

    var sc = THEME.scene.grid;
    var term = THEME.isTerminal();
    ctx.save();
    ctx.lineWidth = 1;
    // Minor lines every cell, a heavier line every four so the sheet has a
    // scale you can count without a legend.
    for (var pass = 0; pass < 2; pass++) {
      var every = pass === 0 ? GRID_CELL : GRID_CELL * 4;
      var alpha = (pass === 0 ? (term ? 0.28 : 0.30) : (term ? 0.55 : 0.55)) * fade;
      ctx.strokeStyle = THEME.raw(sc, alpha);
      ctx.beginPath();
      for (var gx = Math.ceil(x0 / every) * every; gx <= x1; gx += every) {
        if (pass === 0 && gx % (GRID_CELL * 4) === 0) continue;
        var a = cam.project(gx, 0, z0, {}), b = cam.project(gx, 0, z1, {});
        if (!a || !b) continue;
        ctx.moveTo(Math.round(a.x) + 0.5, a.y);
        ctx.lineTo(Math.round(b.x) + 0.5, b.y);
      }
      for (var gz = Math.ceil(z0 / every) * every; gz <= z1; gz += every) {
        if (pass === 0 && gz % (GRID_CELL * 4) === 0) continue;
        var a2 = cam.project(x0, 0, gz, {}), b2 = cam.project(x1, 0, gz, {});
        if (!a2 || !b2) continue;
        ctx.moveTo(a2.x, Math.round(a2.y) + 0.5);
        ctx.lineTo(b2.x, Math.round(b2.y) + 0.5);
      }
      ctx.stroke();
    }
    // The sheet's edge.
    var e = [cam.project(0, 0, 0, {}), cam.project(W.SIZE, 0, 0, {}),
             cam.project(W.SIZE, 0, W.SIZE, {}), cam.project(0, 0, W.SIZE, {})];
    if (e[0] && e[1] && e[2] && e[3]) {
      ctx.strokeStyle = THEME.raw(sc, 0.8 * fade);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(e[0].x, e[0].y);
      for (var j = 1; j < 4; j++) ctx.lineTo(e[j].x, e[j].y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
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
      ctx.fillStyle = TC(127,224,154,pulse.toFixed(2));
      ctx.beginPath();
      ctx.moveTo(20, 0); ctx.lineTo(-8, -12); ctx.lineTo(-2, 0); ctx.lineTo(-8, 12);
      ctx.closePath(); ctx.fill();
      ctx.rotate(-ang);
    } else {
      ctx.strokeStyle = TC(127,224,154,pulse.toFixed(2));
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 13, 0, 6.2832); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -20); ctx.lineTo(0, -14); ctx.moveTo(0, 14); ctx.lineTo(0, 20);
      ctx.moveTo(-20, 0); ctx.lineTo(-14, 0); ctx.moveTo(14, 0); ctx.lineTo(20, 0);
      ctx.stroke();
    }

    var label = (target.name || "WAYPOINT") + "  " + Math.round(miles) + " MI";
    ctx.font = '10px "FO2 Terminal", Consolas, monospace';
    var tw = ctx.measureText(label).width;
    var lx = -tw / 2, ly = 26;
    ctx.fillStyle = TC(8,12,10,0.85);
    ctx.fillRect(lx - 6, ly - 12, tw + 12, 18);
    ctx.strokeStyle = TC(127,224,154,0.5);
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
      ctx.strokeStyle = TC(186,214,226,0.30);
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
      ctx.fillStyle = TC(214,196,150,0.16);
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
      ctx.fillStyle = TC(20,34,58,0.22);
      ctx.fillRect(0, 0, w, h);
    } else if (state.weather === "storm") {
      ctx.fillStyle = TC(40,58,72,0.16);
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
      haze: haze,
      flat: cam.flat
    });

    var horizon = cam.horizonY();
    if (horizon > 0) drawSky(horizon);
    drawNetwork();
    drawGroundDetail();
    global.PROPS.draw(ctx, cam, {
      light: light,
      time: worldTime,
      dt: dt,
      maxProps: QUALITY_TIERS[quality.tier].detail ? 150 : 60,
      chart: cam.flat >= 0.5
    });
    drawGrain();
    drawChartGrid();
    drawRoute();
    drawWaypoint();
    drawCar(dt);
    drawWaypointCue();
    global.PROPS.drawClouds(ctx, cam, { time: worldTime });
    drawWeather(dt);
    drawGrade();

    HUD.chart(cam.flat >= 0.5);
    HUD.updateMarkers(cam, state);
    HUD.vehicle(car, state.mode);
    if (state.mode === "drive") HUD.compass(car.heading, state.waypoint, car);
    else HUD.compass(-cam.yaw, null, null);

    // Adaptive band size: keep the ground pass inside a frame budget.
    quality.acc += performance.now() - t0;
    if (++quality.frames >= 15) {
      var avg = quality.acc / quality.frames;
      quality.ms = avg;
      quality.fps = Math.round(1000 / Math.max(avg, 1 / 240));
      // Terrain density is the only knob that matters; step down hard when
      // frames run long, and creep back up only when there is real headroom.
      if (quality.lock) { quality.frames = 0; quality.acc = 0; }
      else if (avg > 18 && quality.tier < QUALITY_TIERS.length - 1) {
        // Badly over budget drops two tiers at once; creeping down one step at
        // a time left the first seconds unusable on a slow renderer.
        quality.tier += (avg > 45 ? 2 : 1);
        if (quality.tier > QUALITY_TIERS.length - 1) quality.tier = QUALITY_TIERS.length - 1;
        T.setTarget(QUALITY_TIERS[quality.tier].quads);
      } else if (avg < 8 && quality.tier > 0) {
        quality.tier--;
        T.setTarget(QUALITY_TIERS[quality.tier].quads);
      }
      quality.frames = 0; quality.acc = 0;
    }

    if (quality.showFps) {
      ctx.font = '10px "FO2 Terminal", Consolas, monospace';
      ctx.fillStyle = TC(0,0,0,0.6);
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
        // The chart is north-up and flat: nothing to rotate or tilt.
        if (state.view !== "2d") {
          cam.yaw -= dx * 0.006;
          cam.pitch = Math.max(0.35, Math.min(1.35, cam.pitch + dy * 0.004));
        }
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

    // Mode switch, panel folds and the map key.
    $id("msSurvey").onclick = function () { setMode("survey"); };
    $id("msDrive").onclick = function () {
      if (state.travel) { HUD.toast("EN ROUTE \u00b7 ABORT FIRST [ESC]", "warn"); return; }
      setMode("drive");
    };
    HUD.onEnter(enterLocation);
    $id("thSand").onclick = function () { setTheme("sand"); };
    $id("thGreen").onclick = function () { setTheme("green"); };
    $id("vw3d").onclick = function () { setView("3d"); };
    $id("vw2d").onclick = function () { setView("2d"); };
    fold("foldLeft", "left");
    fold("foldRight", "right");
    $id("keyToggle").onclick = function () {
      var k = $id("mapkey");
      k.className = k.className === "shut" ? "" : "shut";
    };

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
          // ENTER / RETURN: leave the site you are inside, start the plotted
          // course if there is one, otherwise enter the site you are parked
          // at. The route panel's primary action shows which of these it is.
          e.preventDefault();
          if (state.inside) leaveLocation(false);
          else if (state.selected && state.route) beginTravel();
          else enterLocation();
          break;
        case "p":
          if (state.selected) pinAndDrive();
          break;
        case "escape":
          if (state.inside) leaveLocation(false);
          else if (state.travel) abortTravel("player");
          else if (state.selected) clearSelection();
          else controller.exit();
          break;
        case "f":
          car.lightsOn = !car.lightsOn;
          HUD.toast("HEADLIGHTS " + (car.lightsOn ? "ON" : "OFF"));
          break;
        case "r": recenter(); break;
        case "c": setTheme(THEME.name === "sand" ? "green" : "sand"); break;
        case "v": setView(state.view === "2d" ? "3d" : "2d"); break;
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
    enterLocation: enterLocation,
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
      HUD.toast(n === 0 ? "TIME HELD" : "TIME RATE \u00d7" + TIME_SCALES[n]);
    },
    state: state,
    setView: setView,
    /** Toggle the on-canvas frame-cost readout (also: index.html#fps). */
    setFps: function (on) { quality.showFps = !!on; }
  };

  global.FO2Travel = controller;
  // Dev probes read the camera through here; nothing in the app writes it.
  Object.defineProperty(controller, "camera", { get: function () { return cam; } });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
