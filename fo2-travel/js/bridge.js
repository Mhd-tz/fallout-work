/* =============================================================================
 * bridge.js - the UI <-> Fallout 4 boundary.
 *
 * Everything the game needs to know, and everything the UI needs from the
 * game, goes through here. Nothing else in this project touches window.prisma,
 * sendDataToF4SE or requestClose.
 *
 * THREE TRANSPORTS (all provided by PrismaUI_F4):
 *
 *  1. JS -> C++    window.sendDataToF4SE(jsonString)
 *                  Bound plugin-side with BindUIEvent("sendDataToF4SE", cb).
 *                  The callback runs on the game thread, so RE:: access is
 *                  safe directly inside it.
 *
 *  1b. JS -> C++   window.PlayerTravelToLocation(key)   (Highwayman plugin)
 *                  The mod's own plugin binds this one plain-string event
 *                  instead of the JSON channel: `key` names the site (the
 *                  `key` column of worldmap.js, e.g. "Klamath"; see
 *                  CONFIG.travelKey) and the plugin moves the player there.
 *                  It also binds requestClose() and, when it opens the map,
 *                  calls LoadHighwayman("<current location name>") so the
 *                  view knows where the car is. When this binding exists
 *                  and sendDataToF4SE does not, the JSON messages below are
 *                  still built (they drive the mock and the log) but go
 *                  nowhere; the two calls above are the whole contract.
 *
 *  2. C++ -> JS    api->InteropCall(view, "fo2Message", jsonString)
 *                  or api->Invoke(view, "fo2Message('{...}')")
 *                  Single inbound entry point; see INBOUND below.
 *
 *  3. Papyrus      window.prisma.getGlobal / setGlobal / getProperty /
 *                  setProperty - direct TESGlobal and script-property access,
 *                  no plugin code required. Used here for the clock and for
 *                  handing the destination to a Papyrus quest script.
 *
 * When none of those exist (i.e. you opened index.html in Chrome), the bridge
 * transparently switches to MOCK mode and simulates the game side so the UI
 * stays fully playable for development.
 * ========================================================================== */
(function (global) {
  "use strict";

  /* --- CONFIG -------------------------------------------------------------
   * Edit these to match the mod's plugin. Form IDs are LOCAL hex ids with the
   * file-index byte stripped ("800", not "0F000800"); PrismaUI_F4 resolves ESL
   * prefixes automatically.
   */
  var CONFIG = {
    // Which field of a worldmap.js location is passed to
    // PlayerTravelToLocation(): "key" (Klamath), "marker" (FO2_MRK_Klamath),
    // "name" (KLAMATH) or "id" (klamath). It must match the name the
    // plugin's markers were registered under (AddHighwaymanMarkerLocation).
    travelKey: "key",
    esp: "FO2Wasteland.esp",
    script: "FO2Travel_MapBridge",       // Papyrus script hosting the properties
    questFormId: "800",                  // quest form the script sits on
    globals: {
      destX:      "801",   // world X of the chosen destination
      destZ:      "802",   // world Z
      destIndex:  "803",   // index into the location table
      travelMode: "804",   // 0 idle, 1 fast travel, 2 manual drive
      fuel:       "805",
      condition:  "806",
      encounter:  "807",   // non-zero while an encounter is pending
      enterIndex: "808",   // index of the location the player is entering
      enterReq:   "809"    // ticks up each time the player asks to enter
    }
  };

  var listeners = {};
  var outQueue = [];
  var Bridge = {
    CONFIG: CONFIG,
    mock: false,
    domReady: false,
    focused: false,
    version: 1
  };

  /* --- transport detection ------------------------------------------------ */
  function hasJsonChannel() { return typeof global.sendDataToF4SE === "function"; }
  function hasTravelBinding() { return typeof global.PlayerTravelToLocation === "function"; }
  function hasNative() { return hasJsonChannel() || hasTravelBinding(); }
  Bridge.hasTravelBinding = hasTravelBinding;

  /** The string the plugin wants for a site. */
  Bridge.travelKey = function (loc) {
    var k = CONFIG.travelKey;
    return String(loc[k] !== undefined ? loc[k] : loc.key);
  };

  /**
   * Hand the player to the plugin: one plain string, nothing else. Returns
   * false when the plugin has not bound the event (browser, or a plugin that
   * speaks the JSON channel instead).
   */
  Bridge.travelTo = function (loc) {
    if (!hasTravelBinding()) return false;
    var key = Bridge.travelKey(loc);
    try { global.PlayerTravelToLocation(key); }
    catch (e) { console.error("[FO2Travel] PlayerTravelToLocation threw", e); return false; }
    console.log("[FO2Travel] PlayerTravelToLocation(" + key + ")");
    return true;
  };

  function rawSend(obj) {
    var json;
    try { json = JSON.stringify(obj); }
    catch (e) { console.error("[FO2Travel] payload not serialisable", e); return; }

    if (hasJsonChannel()) {
      try { global.sendDataToF4SE(json); }
      catch (e2) { console.error("[FO2Travel] sendDataToF4SE threw", e2); }
    } else if (hasTravelBinding()) {
      // Plain-string plugin: no JSON listener, so the message only goes to
      // the console (which the plugin forwards to its log).
      console.log("[FO2Travel] " + obj.type + " " + json);
    } else {
      Bridge.mock = true;
      Mock.receive(obj);
    }
    emit("bridge.out", obj);
  }

  /* --- public API --------------------------------------------------------- */

  /** Send a message to the game. Queued until the DOM-ready handshake. */
  Bridge.send = function (type, payload) {
    var msg = { v: Bridge.version, type: type, t: Date.now() };
    if (payload) for (var k in payload) if (payload.hasOwnProperty(k)) msg[k] = payload[k];
    if (!Bridge.domReady && type !== "ui.ready") { outQueue.push(msg); return msg; }
    rawSend(msg);
    return msg;
  };

  Bridge.on = function (type, fn) {
    (listeners[type] || (listeners[type] = [])).push(fn);
    return Bridge;
  };

  function emit(type, data) {
    var ls = listeners[type];
    if (ls) for (var i = 0; i < ls.length; i++) {
      try { ls[i](data); } catch (e) { console.error("[FO2Travel] handler " + type, e); }
    }
    var any = listeners["*"];
    if (any) for (var j = 0; j < any.length; j++) {
      try { any[j](type, data); } catch (e2) { console.error(e2); }
    }
  }
  Bridge.emit = emit;

  function flush() {
    while (outQueue.length) rawSend(outQueue.shift());
  }

  /* --- INBOUND: C++ / Papyrus -> JS ---------------------------------------
   * The plugin should call exactly one of these:
   *   InteropCall(view, "fo2Message", R"({"type":"state.sync", ...})")
   *   Invoke(view, "fo2Message('{\"type\":\"travel.approve\"}')")
   *
   * Recognised inbound types (all optional - the UI runs standalone too):
   *   state.sync      full state: player, vehicle, clock, discovered, unlocked
   *   state.patch     shallow merge of the same shape
   *   travel.approve  { destId } game agreed; UI starts the drive animation
   *   travel.deny     { destId, reason } shown as a banner
   *   travel.arrived  { destId } game finished the MoveTo; UI settles the car
   *   encounter.spawn { type, x, z, hostile, name, text } force an encounter
   *   encounter.result{ id, outcome:"win"|"flee"|"loss", damage, caps }
   *   loc.unlock      { id } reveal a location
   *   loc.enterable   { id, enterable } mark whether a location has an
   *                   interior built yet; false greys out the ENTER action
   *   location.entered{ locId } the game accepted; the view closes itself and
   *                   locks the car until the player leaves (or the game says so)
   *   location.denied { locId, reason } refused; reason is shown to the player
   *   location.exited { locId } the player is back at the car; unlocks the map
   *   clock.set       { year, month, day, hour, minute }
   *   ui.show / ui.hide / ui.toggle
   *   focus           { focused: bool }
   */
  global.fo2Message = function (payload) {
    var msg = payload;
    if (typeof payload === "string") {
      try { msg = JSON.parse(payload); }
      catch (e) { console.error("[FO2Travel] bad inbound JSON: " + payload); return; }
    }
    if (!msg || !msg.type) { console.warn("[FO2Travel] inbound without type"); return; }
    emit("bridge.in", msg);
    emit(msg.type, msg);
  };

  // Convenience aliases, in case the plugin prefers narrow entry points.
  global.fo2State = function (p) { global.fo2Message(wrap(p, "state.sync")); };
  global.fo2Event = function (p) { global.fo2Message(p); };
  global.fo2Show  = function () { global.fo2Message({ type: "ui.show" }); };
  global.fo2Hide  = function () { global.fo2Message({ type: "ui.hide" }); };

  function wrap(p, type) {
    var o = (typeof p === "string") ? JSON.parse(p) : (p || {});
    if (!o.type) o.type = type;
    return o;
  }

  /**
   * The Highwayman plugin calls this when it shows the map, with the full
   * name of the location the player is standing in (it formats the argument
   * as a quoted string, so the quotes are stripped here). Matched against
   * name, marker and id, case-insensitively; an unknown name leaves the car
   * where it was. Either way the view treats it as the game re-opening the
   * map, which also releases the "inside" lock.
   */
  global.LoadHighwayman = function (arg) {
    var raw = String(arg === undefined || arg === null ? "" : arg).trim();
    if (raw.length >= 2 && raw.charAt(0) === '"' && raw.charAt(raw.length - 1) === '"') {
      raw = raw.slice(1, -1);
    }
    var want = raw.trim().toLowerCase();
    var hit = null;
    if (want && global.WORLD) {
      var L = global.WORLD.LOCATIONS;
      for (var i = 0; i < L.length; i++) {
        var l = L[i];
        if (String(l.key).toLowerCase() === want ||
            String(l.name).toLowerCase() === want ||
            String(l.marker).toLowerCase() === want ||
            String(l.id).toLowerCase() === want) { hit = l; break; }
      }
    }
    console.log("[FO2Travel] LoadHighwayman(" + raw + ") -> " + (hit ? hit.id : "no match"));
    var sync = { type: "state.sync" };
    if (hit) { sync.here = hit.id; sync.player = { x: hit.x, z: hit.z }; }
    global.fo2Message(sync);
  };

  /* PrismaUI calls window.init() once the view's DOM is ready. */
  global.init = function () {
    Bridge.domReady = true;
    emit("prisma.domready", {});
    // The remembered palette and camera ride along so the game can pick the
    // matching music without waiting for the player to touch a switch.
    var pref = {};
    try {
      pref.theme = localStorage.getItem("fo2.theme") || "sand";
      pref.view = localStorage.getItem("fo2.view") || "3d";
    } catch (e) { pref.theme = "sand"; pref.view = "3d"; }
    Bridge.send("ui.ready", { ui: "fo2-travel", version: Bridge.version,
                              theme: pref.theme, view: pref.view });
    flush();
  };

  /* PrismaUI pushes focus changes here; driving needs keyboard focus. */
  global.updateFocusLabel = function (msg) {
    var focused = String(msg || "").indexOf("Focused") !== -1;
    Bridge.focused = focused;
    emit("focus", { focused: focused, raw: msg });
  };

  /* --- OUTBOUND helpers ---------------------------------------------------
   * Thin, named wrappers so gameplay code reads clearly and the protocol stays
   * in one place. Each corresponds to a row in README.md's protocol table.
   */
  /**
   * Close the view. `requestClose` is the event the plugin binds with
   * BindUIEvent (PlayerExitMap in Highwayman_Map.cpp); PrismaUI exposes those
   * as window.<name>(arg), one string argument, so it is called with one.
   * Every step is logged: the plugin forwards console output to the F4SE log,
   * so the log says exactly how far the close got.
   */
  Bridge.uiClose = function () {
    Bridge.send("ui.close", {});
    var fn = global.requestClose;
    if (typeof fn !== "function") {
      console.error("[FO2Travel] close: window.requestClose is " + (typeof fn) +
                    " - the plugin has not bound it (BindUIEvent) or bound it " +
                    "under another name");
      return false;
    }
    try {
      fn("close");
      console.log("[FO2Travel] close: requestClose called");
      return true;
    } catch (e) {
      // Some bindings reject an argument; try the bare call before giving up.
      try {
        fn();
        console.log("[FO2Travel] close: requestClose() called with no argument");
        return true;
      } catch (e2) {
        console.error("[FO2Travel] close: requestClose threw", e2);
        return false;
      }
    }
  };

  /** Type fo2Close() in the PrismaUI inspector to test the close path. */
  global.fo2Close = function () { return Bridge.uiClose(); };

  /** Player picked a destination but has not committed yet. */
  Bridge.plot = function (loc, est) {
    return Bridge.send("travel.plot", {
      destId: loc.id, destName: loc.name, marker: loc.marker,
      x: loc.x, z: loc.z,
      hours: est ? +est.hours.toFixed(2) : 0,
      miles: est ? Math.round(est.miles) : 0,
      fuel: est ? +est.fuel.toFixed(1) : 0,
      risk: est ? est.risk : 0
    });
  };

  /** Player committed to fast travel. Game should validate, then approve. */
  Bridge.requestTravel = function (loc, est, route) {
    Bridge.writeDestGlobals(loc);
    return Bridge.send("travel.begin", {
      destId: loc.id, destName: loc.name, marker: loc.marker,
      x: loc.x, z: loc.z,
      hours: est ? +est.hours.toFixed(2) : 0,
      minutes: est ? Math.round(est.minutes) : 0,
      fuel: est ? +est.fuel.toFixed(1) : 0,
      risk: est ? est.risk : 0,
      waypoints: route ? sparse(route.points, 24) : []
    });
  };

  Bridge.travelProgress = function (o) { return Bridge.send("travel.progress", o); };
  Bridge.travelAbort = function (why) { return Bridge.send("travel.abort", { reason: why || "player" }); };

  /** Arrived. The game does the actual MoveTo and advances the clock. */
  Bridge.arrive = function (loc, o) {
    return Bridge.send("travel.complete", {
      destId: loc.id, destName: loc.name, marker: loc.marker,
      x: loc.x, z: loc.z,
      minutes: o ? Math.round(o.minutes) : 0,
      fuelUsed: o ? +o.fuelUsed.toFixed(1) : 0,
      condition: o ? +o.condition.toFixed(1) : 100
    });
  };

  /** Manual driving: mode changes + a throttled position feed. */
  Bridge.driveBegin = function (v) {
    return Bridge.send("drive.begin", { x: v.x, z: v.z, heading: v.heading });
  };
  Bridge.driveEnd = function (v) {
    return Bridge.send("drive.end", { x: v.x, z: v.z, heading: v.heading, odometer: Math.round(v.odometer) });
  };
  Bridge.driveState = function (v) {
    return Bridge.send("drive.state", {
      x: +v.x.toFixed(2), z: +v.z.toFixed(2),
      heading: +v.heading.toFixed(3),
      speed: +v.speed.toFixed(2),
      fuel: +v.fuel.toFixed(2),
      condition: +v.condition.toFixed(2)
    });
  };

  /** An encounter fired. The game decides what cell to load. */
  Bridge.encounter = function (enc) {
    return Bridge.send("encounter.trigger", {
      id: enc.id, encType: enc.type, name: enc.name,
      hostile: !!enc.hostile, hazard: !!enc.hazard,
      x: +enc.x.toFixed(1), z: +enc.z.toFixed(1), region: enc.region
    });
  };
  Bridge.encounterChoice = function (enc, choice) {
    return Bridge.send("encounter.resolve", { id: enc.id, encType: enc.type, choice: choice });
  };

  /**
   * The player is parked at a location and wants to go inside. This is the
   * hand-off: the view has done its job and the game takes over, loading the
   * cell and moving the player. Carries the map-marker editor id as well as
   * the table index, so the game side can resolve it whichever way suits -
   * by editor id if it keeps a lookup, by index into TravelMarkers if it
   * does not.
   *
   * The game must answer with location.entered or location.denied; until one
   * of those arrives the UI holds the action disabled.
   */
  Bridge.enterLocation = function (loc, idx) {
    Bridge.setGlobal(CONFIG.globals.enterIndex, idx);
    // A counter rather than a flag: entering the same place twice in a row
    // has to read as two separate requests on a polling Papyrus script.
    enterTicket = (enterTicket + 1) % 1000000;
    Bridge.setGlobal(CONFIG.globals.enterReq, enterTicket);
    var msg = Bridge.send("location.enter", {
      locId: loc.id, name: loc.name, marker: loc.marker,
      kind: loc.kind, region: loc.region, index: idx,
      x: +loc.x.toFixed(2), z: +loc.z.toFixed(2),
      services: loc.services || []
    });
    if (hasTravelBinding()) {
      // The plugin moves the player inside PlayerTravelToLocation itself and
      // has no reply channel, so a successful call is the acknowledgement.
      if (Bridge.travelTo(loc)) {
        setTimeout(function () {
          global.fo2Message({ type: "location.entered", locId: loc.id });
        }, 0);
      } else {
        setTimeout(function () {
          global.fo2Message({ type: "location.denied", locId: loc.id, reason: "plugin call failed" });
        }, 0);
      }
      return msg;
    }
    Bridge.pollEnterAck(loc.id);
    return msg;
  };
  var enterTicket = 0;

  /**
   * Acknowledgement for the Papyrus-only path. With a plugin the game answers
   * with location.entered / location.denied and this is not used; without
   * one, Papyrus has no way to call into JS at all, so the quest script
   * answers by writing the request global back instead - 0 for accepted,
   * a negative value for refused. Polled, because that is the only channel
   * there is.
   */
  Bridge.pollEnterAck = function (locId) {
    if (hasNative() || !papyrusReady()) return;
    var tries = 0;
    (function tick() {
      if (++tries > 14) return;
      Bridge.getGlobal(CONFIG.globals.enterReq).then(function (v) {
        if (v === null || v === undefined) return setTimeout(tick, 400);
        var n = Number(v);
        if (n === 0) {
          global.fo2Message({ type: "location.entered", locId: locId });
        } else if (n < 0) {
          global.fo2Message({
            type: "location.denied", locId: locId,
            reason: n === -2 ? "no interior built" : "refused by the game"
          });
        } else {
          setTimeout(tick, 400);
        }
      });
    })();
  };

  Bridge.waypoint = function (p) { return Bridge.send("waypoint.set", p); };
  Bridge.discover = function (o) { return Bridge.send("map.discover", o); };
  Bridge.log = function (m) { return Bridge.send("log", { message: String(m) }); };

  function sparse(points, max) {
    if (points.length <= max) return points.map(round2);
    var out = [], stride = (points.length - 1) / (max - 1);
    for (var i = 0; i < max; i++) out.push(round2(points[Math.round(i * stride)]));
    return out;
  }
  function round2(p) { return [+p[0].toFixed(1), +p[1].toFixed(1)]; }

  /* --- Papyrus direct access ---------------------------------------------- */
  function papyrusReady() { return !!(global.prisma && global.prisma.getGlobal); }
  Bridge.papyrusReady = papyrusReady;

  Bridge.getGlobal = function (formId) {
    if (!papyrusReady()) return Promise.resolve(null);
    return global.prisma.getGlobal(CONFIG.esp, formId).catch(function () { return null; });
  };
  Bridge.setGlobal = function (formId, value) {
    if (!papyrusReady()) return false;
    try { global.prisma.setGlobal(CONFIG.esp, formId, value); return true; }
    catch (e) { console.error("[FO2Travel] setGlobal", e); return false; }
  };
  Bridge.getProperty = function (prop) {
    if (!papyrusReady()) return Promise.resolve(null);
    return global.prisma.getProperty(CONFIG.esp, CONFIG.questFormId, CONFIG.script, prop)
      .catch(function () { return null; });
  };
  Bridge.setProperty = function (prop, value) {
    if (!papyrusReady()) return false;
    try { global.prisma.setProperty(CONFIG.esp, CONFIG.questFormId, CONFIG.script, prop, value); return true; }
    catch (e) { console.error("[FO2Travel] setProperty", e); return false; }
  };

  /** Mirror the destination into TESGlobals so Papyrus can act without C++. */
  Bridge.writeDestGlobals = function (loc) {
    var g = CONFIG.globals, idx = 0;
    if (global.WORLD) {
      for (var i = 0; i < global.WORLD.LOCATIONS.length; i++) {
        if (global.WORLD.LOCATIONS[i].id === loc.id) { idx = i; break; }
      }
    }
    Bridge.setGlobal(g.destX, +loc.x.toFixed(2));
    Bridge.setGlobal(g.destZ, +loc.z.toFixed(2));
    Bridge.setGlobal(g.destIndex, idx);
  };

  Bridge.writeVehicleGlobals = function (v) {
    Bridge.setGlobal(CONFIG.globals.fuel, +v.fuel.toFixed(1));
    Bridge.setGlobal(CONFIG.globals.condition, +v.condition.toFixed(1));
  };

  Bridge.setTravelMode = function (mode) {
    Bridge.setGlobal(CONFIG.globals.travelMode, mode);
  };

  /** Pull the in-game clock from Fallout 4's own globals, if the mod maps them. */
  Bridge.syncClockFromGame = function () {
    if (!papyrusReady()) return Promise.resolve(null);
    var base = "Fallout4.esm";
    function g(id) {
      return global.prisma.getGlobal(base, id).catch(function () { return null; });
    }
    // GameHour 0x38, GameDay 0x37, GameMonth 0x36, GameYear 0x35
    return Promise.all([g("38"), g("37"), g("36"), g("35")]).then(function (r) {
      if (r[0] === null) return null;
      return { hour: r[0], day: r[1], month: r[2], year: r[3] };
    });
  };

  /* =========================================================================
   * MOCK GAME - only active outside Fallout 4.
   * Keeps the UI honest: same message shapes, same async latency, so code that
   * works here works in-game.
   * ====================================================================== */
  var Mock = {
    receive: function (msg) {
      console.log("[FO2Travel MOCK] ->game", msg.type, msg);
      switch (msg.type) {
        case "travel.begin":
          setTimeout(function () {
            global.fo2Message({ type: "travel.approve", destId: msg.destId });
          }, 220);
          break;
        case "location.enter":
          // Nothing is built in mock mode, so acknowledge and let the view
          // show what the hand-off looks like.
          setTimeout(function () {
            global.fo2Message({ type: "location.entered", locId: msg.locId });
          }, 420);
          break;
        case "encounter.resolve":
          setTimeout(function () {
            var win = msg.choice !== "flee" ? Math.random() > 0.25 : true;
            global.fo2Message({
              type: "encounter.result", id: msg.id,
              outcome: msg.choice === "flee" ? "flee" : (win ? "win" : "loss"),
              damage: msg.choice === "fight" ? Math.round(Math.random() * 12) : 0,
              caps: win && msg.choice === "fight" ? Math.round(Math.random() * 300) : 0
            });
          }, 420);
          break;
        case "travel.complete":
          setTimeout(function () {
            global.fo2Message({ type: "travel.arrived", destId: msg.destId });
          }, 200);
          break;
      }
    }
  };

  Bridge.isMock = function () { return !hasNative(); };

  /* If PrismaUI never calls init() (browser dev), self-start after load. */
  global.addEventListener("load", function () {
    setTimeout(function () {
      if (!Bridge.domReady) {
        Bridge.mock = !hasNative();
        global.init();
      }
    }, 60);
  });

  global.GameBridge = Bridge;
})(window);
