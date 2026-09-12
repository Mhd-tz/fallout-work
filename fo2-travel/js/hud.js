/* =============================================================================
 * hud.js - every DOM read/write in the UI lives here.
 *
 * The canvas draws the world; the HUD draws everything made of text. Location
 * counters and encounter pins are DOM nodes positioned from projected world
 * coordinates each frame - that keeps text crisp at any zoom and gives us real
 * hover/click targets, which is exactly how HOI4 handles its counters.
 * ========================================================================== */
(function (global) {
  "use strict";

  var W = global.WORLD, TR = global.TRAVEL, T = global.TERRAIN;
  var HUD = {};
  var app = null;
  var $ = function (id) { return document.getElementById(id); };

  var KIND_ICON = { town: "■", vault: "●", base: "▲", ruin: "◆", cave: "○", poi: "△" };
  var ENC_ICON = {
    raiders: "RD", deathclaw: "DC", mutants: "SM", geckos: "GK", slavers: "SL",
    patrol: "NC", caravan: "CV", wanderer: "WD", wreck: "WR", radstorm: "RA", enclave: "EN"
  };
  HUD.KIND_ICON = KIND_ICON;
  HUD.ENC_ICON = ENC_ICON;



  /* --- boot ---------------------------------------------------------------- */
  HUD.boot = function (pct, text) {
    var bar = $("bootbar"), log = $("bootlog");
    if (bar) bar.style.width = Math.round(pct * 100) + "%";
    if (log && text) log.textContent = text;
  };
  HUD.bootDone = function () { $("boot").classList.add("done"); };

  /* --- markers ------------------------------------------------------------- */
  var panelRects = null;

  /** Rects of the HUD panels; markers overlapping these are hidden. */
  function refreshPanelRects() {
    panelRects = [];
    ["topbar", "left", "right", "bottom", "travelbar"].forEach(function (id) {
      var el = $(id);
      if (!el || !el.offsetParent && id !== "topbar") return;
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) panelRects.push(r);
    });
  }
  HUD.refreshPanelRects = refreshPanelRects;

  function overPanel(x, y) {
    if (!panelRects) refreshPanelRects();
    // The counter body sits above and astride its anchor point.
    var x0 = x - 76, x1 = x + 76, y0 = y - 56, y1 = y + 4;
    for (var i = 0; i < panelRects.length; i++) {
      var r = panelRects[i];
      if (x1 > r.left && x0 < r.right && y1 > r.top && y0 < r.bottom) return true;
    }
    return false;
  }

  var locMarkers = {};   // locId -> element
  var encMarkers = {};   // encId -> element
  var proj = {};

  function makeMarker(cls, icon, name, sub) {
    var el = document.createElement("div");
    el.className = "mk " + cls;
    el.innerHTML =
      '<div class="stem"></div>' +
      '<div class="body"><div class="ico">' + icon + '</div>' +
      '<div class="txt"><div class="nm">' + name + '</div>' +
      (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div></div>";
    return el;
  }

  HUD.buildMarkers = function () {
    var layer = $("markers");
    layer.innerHTML = "";
    locMarkers = {};
    W.LOCATIONS.forEach(function (l) {
      var el = makeMarker("loc k-" + (l.kind || "poi"), KIND_ICON[l.kind] || "■", l.name, "");
      el.dataset.id = l.id;
      el._nm = el.querySelector(".nm");
      el._known = null;
      el.querySelector(".body").addEventListener("click", function (e) {
        e.stopPropagation();
        if (app) app.selectLocation(l.id, true);
      });
      layer.appendChild(el);
      locMarkers[l.id] = el;
    });
  };

  /** Chart styling for the marker layer: circles and captions, no stems. */
  var chartOn = false;
  HUD.chart = function (on) {
    on = !!on;
    if (on === chartOn) return;
    chartOn = on;
    var layer = $("markers");
    if (layer) layer.className = on ? "chart" : "";
  };

  /** Per-frame: project every marker and park it on screen. */
  HUD.updateMarkers = function (cam, state) {
    var vw = cam.viewport.w, vh = cam.viewport.h;
    var far = cam.dist > 1150;
    var margin = 90;

    for (var id in locMarkers) {
      var el = locMarkers[id], l = W.loc(id);
      var known = state.discovered[id] || T.isDiscovered(l.x, l.z);
      var s = cam.project(l.x, T.reliefAt(l.x, l.z), l.z, proj);
      if (!s || s.x < -margin || s.x > vw + margin || s.y < -margin || s.y > vh + margin ||
          overPanel(s.x, s.y)) {
        if (el.style.display !== "none") el.style.display = "none";
        continue;
      }
      if (el.style.display === "none") el.style.display = "";
      el.style.transform = "translate(" + (s.x | 0) + "px," + (s.y | 0) + "px)";
      el.style.zIndex = String(2000 + Math.round(-s.w));

      // The list already hides an unsurveyed site's name; the marker should
      // not give it away either (the original wrote "Unknown" on the map).
      var kn = !!known;
      if (el._known !== kn) { el._known = kn; el._nm.textContent = kn ? l.name : "UNKNOWN"; }

      var cls = "mk loc k-" + (l.kind || "poi");
      if (far) cls += " far";
      if (!known) cls += " undisc";
      if (state.selected === id) cls += " sel";
      if (state.here === id) cls += " here";
      if (state.travelDest === id) cls += " dest";
      if (el.className !== cls) el.className = cls;
    }

    // Encounter pins
    var layer = $("markers");
    var live = state.encounters || [];
    var seen = {};
    for (var i = 0; i < live.length; i++) {
      var enc = live[i];
      seen[enc.id] = 1;
      var m = encMarkers[enc.id];
      if (!m) {
        m = makeMarker("enc" + (enc.hostile ? "" : " calm"),
                       ENC_ICON[enc.type] || "!!", enc.name, enc.hazard ? "HAZARD" : (enc.hostile ? "HOSTILE" : "NEUTRAL"));
        m.querySelector(".body").classList.add("pulse");
        layer.appendChild(m);
        encMarkers[enc.id] = m;
      }
      var es = cam.project(enc.x, T.reliefAt(enc.x, enc.z) + 4, enc.z, {});
      if (!es || overPanel(es.x, es.y)) { m.style.display = "none"; continue; }
      m.style.display = "";
      m.style.transform = "translate(" + (es.x | 0) + "px," + (es.y | 0) + "px)";
      m.style.zIndex = String(3000 + Math.round(-es.w));
    }
    for (var eid in encMarkers) {
      if (!seen[eid]) { encMarkers[eid].remove(); delete encMarkers[eid]; }
    }
  };

  /* --- location list ------------------------------------------------------- */
  var listFilter = "";

  HUD.buildList = function (state) {
    var box = $("loclist");
    var here = state.here ? W.loc(state.here) : null;
    var origin = here || { x: state.car.x, z: state.car.z };
    var f = listFilter.toLowerCase();

    var groups = {};
    var known = 0;
    W.LOCATIONS.forEach(function (l) {
      var disc = state.discovered[l.id];
      if (disc) known++;
      if (f && l.name.toLowerCase().indexOf(f) < 0) return;
      (groups[l.region] || (groups[l.region] = [])).push(l);
    });

    var html = "";
    W.REGIONS.forEach(function (r) {
      var items = groups[r.id];
      if (!items) return;
      items.sort(function (a, b) {
        return Math.hypot(a.x - origin.x, a.z - origin.z) - Math.hypot(b.x - origin.x, b.z - origin.z);
      });
      html += '<div class="rgroup">' + r.name + "</div>";
      items.forEach(function (l) {
        var d = Math.hypot(l.x - origin.x, l.z - origin.z) * W.SCALE.milesPerUnit;
        var disc = state.discovered[l.id];
        var cls = "litem" + (state.selected === l.id ? " sel" : "") +
                  (disc ? "" : " undisc") + (state.here === l.id ? " here" : "");
        html += '<div class="' + cls + '" data-id="' + l.id + '">' +
                  '<div class="ic">' + (KIND_ICON[l.kind] || "■") + "</div>" +
                  '<div class="nm">' + (disc ? l.name : "UNDISCOVERED") + "</div>" +
                  '<div class="di">' + (state.here === l.id ? "HERE" : Math.round(d) + " mi") + "</div>" +
                  riskBars(l.danger) +
                "</div>";
      });
    });
    box.innerHTML = html || '<div id="empty">NO MATCHES</div>';
    $("loccount").textContent = known + "/" + W.LOCATIONS.length;

    Array.prototype.forEach.call(box.querySelectorAll(".litem"), function (el) {
      el.addEventListener("click", function () {
        if (app) app.selectLocation(el.dataset.id, true);
      });
    });
  };

  function riskBars(n) {
    var s = '<div class="risk">';
    for (var i = 1; i <= 5; i++) s += "<i" + (i <= n ? ' class="r' + Math.min(5, n) + '"' : "") + "></i>";
    return s + "</div>";
  }
  HUD.riskBars = riskBars;

  /* --- dossier ------------------------------------------------------------- */
  HUD.clearDossier = function () {
    $("dossier").innerHTML =
      '<div id="empty">NO DESTINATION SELECTED<br />' +
      '<span style="color:var(--text-dim)">Click a marker on the map, or pick one from the list.</span>' +
      "<br /><br /><span style=\"color:var(--text-mute)\">LMB drag&nbsp;&middot;&nbsp;pan &nbsp; RMB drag&nbsp;&middot;&nbsp;rotate<br />Wheel&nbsp;&middot;&nbsp;zoom &nbsp; TAB&nbsp;&middot;&nbsp;drive mode</span></div>";
    $("rangelabel").textContent = "";
  };

  /**
   * @param loc  destination
   * @param est  TRAVEL.estimate() result
   * @param st   { car, here, mode, discovered }
   */
  HUD.dossier = function (loc, est, st) {
    var box = $("dossier");
    var reg = W.region(loc.region);
    var disc = st.discovered[loc.id];
    var fuelOk = st.car.fuel >= est.fuel;
    var arrive = TR.Clock.minute + est.minutes;
    var arriveDay = Math.floor(arrive / 1440);
    var ah = Math.floor((arrive % 1440) / 60), am = Math.floor(arrive % 60);

    // A course already running must not be re-plotted from under itself.
    var enRoute = !!st.travel;
    // Standing on the place you have selected: the useful action is no longer
    // "travel here", it is "go inside".
    var atHere = st.here === loc.id && !enRoute;
    var canEnter = atHere && st.enterable[loc.id] !== false;
    var chips = "";
    (loc.services || []).forEach(function (s) { chips += '<div class="chip">' + s + "</div>"; });
    if (loc.rads) chips += '<div class="chip warn">RADIATION</div>';
    if (loc.danger >= 4) chips += '<div class="chip warn">HOSTILE ZONE</div>';
    if (!disc) chips += '<div class="chip warn">UNDISCOVERED</div>';

    box.innerHTML =
      '<div class="dhero">' +
        '<div class="dname">' + (disc ? loc.name : "UNKNOWN SITE") + "</div>" +
        '<div class="dreg">' + (reg ? reg.name : "") + " &middot; SECTOR " + sector(loc) + "</div>" +
        '<div class="ddesc">' + (disc ? loc.desc : "No survey data on file. Route plotted from map traces only.") + "</div>" +
      "</div>" +
      '<div class="chips">' + chips + "</div>" +
      '<div class="stats">' +
        '<div class="stat"><div class="k">DISTANCE</div><div class="v">' + Math.round(est.miles) + '<span class="u">MI</span></div></div>' +
        '<div class="stat"><div class="k">TRAVEL TIME</div><div class="v">' + TR.duration(est.minutes) + "</div></div>" +
        '<div class="stat"><div class="k">CELL DRAW</div><div class="v ' + (fuelOk ? "" : "warn") + '">' + est.fuel.toFixed(1) + '<span class="u">%</span></div></div>' +
        '<div class="stat"><div class="k">ARRIVAL</div><div class="v">' + pad(ah) + ":" + pad(am) + (arriveDay ? '<span class="u">+' + arriveDay + "D</span>" : "") + "</div></div>" +
      "</div>" +
      '<div class="rowline"><span>ROUTE LEGS</span><b>' + est.legs + " SEGMENT" + (est.legs === 1 ? "" : "S") + "</b></div>" +
      '<div class="rowline"><span>THREAT RATING</span>' + riskBars(est.risk) + "</div>" +
      '<div class="forecast">' +
        '<div class="fh"><span>ENCOUNTER FORECAST</span><span>' + Math.round(est.encounterChance * 100) + "% LIKELY</span></div>" +
        '<div class="fbars" id="fbars"></div>' +
      "</div>" +
      '<div class="actions">' +
        (atHere
          ? '<button class="act primary" id="actEnter"' + (canEnter ? "" : " disabled") +
              '><span class="k">[ENTER]</span> ' +
              (canEnter ? "Enter " + loc.name : "No Interior Built") + "</button>"
          : '<button class="act primary" id="actGo"' + ((fuelOk && !enRoute) ? "" : " disabled") +
              '><span class="k">[ENTER]</span> ' +
              (enRoute ? "En Route&hellip;" : "Auto-Travel") + "</button>") +
        '<button class="act" id="actPin"><span class="k">[P]</span> Pin &amp; Drive Manually</button>' +
        '<button class="act ghost" id="actClear"><span class="k">[ESC]</span> ' +
          (enRoute ? "Abort Travel" : "Clear Plot") + "</button>" +
      "</div>";

    // Per-segment risk profile, sampled along the route.
    var fb = $("fbars"), route = st.route;
    if (fb && route) {
      var n = 22, html = "";
      for (var i = 0; i < n; i++) {
        var p = TR.sample(route, (i + 0.5) / n * route.distance);
        var h = Math.min(1, TR.hazardAt(p.x, p.z, { night: TR.Clock.isNight() }) * 620);
        var col = TR.riskColorAt(p.x, p.z, { night: TR.Clock.isNight() });
        html += '<i style="height:' + Math.max(10, h * 100) + "%;background:" + col + '"></i>';
      }
      fb.innerHTML = html;
    }

    $("rangelabel").textContent = Math.round(est.miles) + " MI";
    if (!fuelOk) HUD.toast("INSUFFICIENT CELL CHARGE FOR THIS ROUTE", "warn");

    var go = $("actGo"), pin = $("actPin"), cl = $("actClear");
    if (go && !enRoute) go.onclick = function () { app.beginTravel(); };
    var ent = $("actEnter");
    if (ent && canEnter) ent.onclick = function () { app.enterLocation(); };
    if (pin) pin.onclick = function () { app.pinAndDrive(); };
    if (cl) cl.onclick = function () { app.clearSelection(); };
  };

  function sector(l) {
    var c = String.fromCharCode(65 + Math.min(23, Math.floor(l.x / (W.SIZE / 24))));
    return c + (Math.floor(l.z / (W.SIZE / 24)) + 1);
  }
  function pad(n) { n = String(n | 0); return n.length < 2 ? "0" + n : n; }

  /* --- gauges / clock / mode ------------------------------------------------ */
  function cells(el, pct, n) {
    if (el.childElementCount !== n) {
      var h = "";
      for (var i = 0; i < n; i++) h += "<i></i>";
      el.innerHTML = h;
    }
    var lit = Math.round((pct / 100) * n);
    for (var j = 0; j < n; j++) {
      var c = "";
      if (j < lit) c = pct <= 15 ? "on crit" : pct <= 35 ? "on warn" : "on";
      var k = el.children[j];
      if (k.className !== c) k.className = c;
    }
  }

  HUD.vehicle = function (v, mode) {
    cells($("fuelcells"), v.fuel, 16);
    cells($("condcells"), v.condition, 16);
    $("fuelpct").textContent = Math.round(v.fuel) + "%";
    $("condpct").textContent = Math.round(v.condition) + "%";
    // World units/sec -> a readable "mph" for the dashboard.
    $("mph").textContent = Math.round(Math.abs(v.speed) * W.SCALE.milesPerUnit * 1.35);
    $("odo").textContent = "ODO " + Math.round(v.odometer * W.SCALE.milesPerUnit) + " MI";
    var bg = $("boostgauge");
    $("boostfill").style.transform = "scaleX(" + (Math.max(0, v.boost) / 100).toFixed(3) + ")";
    $("boostpct").textContent = Math.round(v.boost) + "%";
    var bc = v.boosting ? "gauge live" : v.boost < 15 ? "gauge dry" : "gauge";
    if (bg.className !== bc) bg.className = bc;
    $("vsub").textContent = v.fuel <= 0 ? "CELL DEPLETED · ENGINE DEAD"
                          : v.condition < 40 ? "CHASSIS DAMAGED · REDUCED SPEED"
                          : "CHRYSLUS CORVEGA · MFC DRIVE";
  };

  /**
   * The prompt that appears when the car is parked at a known location.
   * `state` is one of: "ready", "busy" (waiting on the game), "blocked"
   * (the game says this place has no interior yet), "inside" (the player is
   * in there and the button brings them back out).
   */
  var KIND_LABEL = {
    town: "Settlement", vault: "Vault", base: "Military site",
    ruin: "Ruin", cave: "Cave", poi: "Site of interest"
  };

  HUD.enterPrompt = function (loc, state, note) {
    var bar = $("enterbar");
    if (!loc) {
      if (bar.className !== "panel") bar.className = "panel";
      HUD._enterLoc = null;
      return;
    }
    if (HUD._enterLoc !== loc.id) {
      $("ebIco").innerHTML = KIND_ICON[loc.kind] || "\u25a0";
      $("ebName").textContent = loc.name;
      HUD._enterLoc = loc.id;
    }
    var sub = KIND_LABEL[loc.kind] || "Location";
    if (loc.services && loc.services.length) sub += " \u00b7 " + loc.services.join(" ");
    sub = note || sub;
    if (HUD._enterSub !== sub) { $("ebSub").textContent = sub; HUD._enterSub = sub; }
    $("ebGoLabel").textContent =
      state === "busy" ? "Standby\u2026" : state === "blocked" ? "Unavailable"
      : state === "inside" ? "Leave" : "Enter";
    var cls = "panel on" + (state === "ready" ? "" : " " + state);
    if (bar.className !== cls) bar.className = cls;
  };

  HUD.onEnter = function (fn) { $("ebGo").onclick = fn; };

  HUD.clock = function () {
    $("ctime").textContent = TR.Clock.time();
    $("cdate").textContent = TR.Clock.date();
    var night = TR.Clock.isNight();
    $("daynight").textContent = (night ? "NIGHT" : "DAY") + " · " +
      (night ? "ENCOUNTER RISK +35%" : "CLEAR VISIBILITY");
  };

  HUD.mode = function (mode) {
    $("modeswitch").className = mode;
    var sb = $("speedbox");
    var hide = mode === "drive";
    if (sb && (sb.className === "hidden") !== hide) sb.className = hide ? "hidden" : "";
  };

  /**
   * What the marker shapes mean. The icons carry real information - a vault is
   * not a ruin - and nothing on screen said so.
   */
  HUD.buildKey = function () {
    var LABEL = {
      town: "Settlement", vault: "Vault", base: "Military",
      ruin: "Ruin", cave: "Cave", poi: "Site"
    };
    var html = "";
    for (var k in KIND_ICON) {
      html += '<span><i>' + KIND_ICON[k] + "</i>" + LABEL[k] + "</span>";
    }
    html += '<span class="dim"><i class="sw dash"></i>Undiscovered</span>';
    html += '<span class="dim"><i class="sw hot"></i>Contact</span>';
    $("keygrid").innerHTML = html;
  };

  /* PrismaUI focus state. There is no badge for it any more; the hook stays
   * so the bridge has somewhere to report, and so a future cue can use it. */
  HUD.focus = function (on) { HUD.focused = !!on; };

  HUD.speedButtons = function (idx) {
    for (var i = 0; i <= 3; i++) {
      var b = $("spd" + i);
      if (b) b.className = "spd" + (i === idx ? " on" : "");
    }
  };

  /* --- travel bar ----------------------------------------------------------- */
  HUD.travelBar = function (on, destName, pct, etaMin, pips) {
    var el = $("travelbar");
    el.className = "panel" + (on ? " on" : "");
    if (!on) return;
    $("tbdest").textContent = destName;
    $("tbeta").textContent = "ETA " + TR.duration(etaMin);
    $("track").style.width = Math.round(pct * 100) + "%";
    if (pips) {
      var wrap = $("trackwrap");
      Array.prototype.forEach.call(wrap.querySelectorAll(".pip"), function (p) { p.remove(); });
      pips.forEach(function (p) {
        var i = document.createElement("div");
        i.className = "pip";
        i.style.left = (p * 100) + "%";
        wrap.appendChild(i);
      });
    }
  };

  /* --- compass -------------------------------------------------------------- */
  var CARDS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  var cardEls = null;

  function bearingOf(heading) { return ((360 - heading * 180 / Math.PI) % 360 + 360) % 360; }
  HUD.bearingOf = bearingOf;

  HUD.compass = function (heading, waypoint, car) {
    var tape = $("tape");
    if (!cardEls) {
      cardEls = [];
      tape.innerHTML = "";
      for (var i = 0; i < 8; i++) {
        var d = document.createElement("div");
        d.className = "card";
        d.textContent = CARDS[i];
        tape.appendChild(d);
        cardEls.push(d);
      }
    }
    var wpx = $("compass").clientWidth, cx = wpx / 2, ppd = 1.5;
    var b = bearingOf(heading);
    for (var k = 0; k < 8; k++) {
      var delta = wrap180(k * 45 - b);
      cardEls[k].style.left = (cx + delta * ppd) + "px";
      cardEls[k].style.opacity = Math.abs(delta) > 110 ? "0" : "1";
    }
    var wm = $("wpmark");
    if (waypoint && car) {
      var wb = ((Math.atan2(-(waypoint.x - car.x), -(waypoint.z - car.z)) * 180 / Math.PI));
      wb = ((360 - wb) % 360 + 360) % 360;
      var wd = wrap180(wb - b);
      wm.style.display = Math.abs(wd) > 110 ? "none" : "";
      wm.style.left = (cx + wd * ppd) + "px";
    } else {
      wm.style.display = "none";
    }
  };
  function wrap180(a) { while (a > 180) a -= 360; while (a < -180) a += 360; return a; }

  HUD.hint = function (html) { $("hint").innerHTML = html; };

  /* --- toasts --------------------------------------------------------------- */
  HUD.toast = function (msg, kind) {
    var box = $("toasts");
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0";
      setTimeout(function () { el.remove(); }, 400);
    }, 2600);
    while (box.childElementCount > 5) box.firstChild.remove();
  };

  /* --- encounter modal ------------------------------------------------------- */
  var typer = null;

  HUD.encounter = function (enc, choices, cb) {
    var wrap = $("modalwrap"), m = $("modal");
    m.className = "encwin" + (enc.hostile ? " hostile" : " neutral") + (enc.hazard ? " hazard" : "");

    var reg = W.region(enc.region);
    var kind = enc.hazard ? "ENVIRONMENTAL HAZARD"
             : enc.hostile ? "HOSTILE CONTACT" : "CONTACT";

    $("enckind").textContent = kind;
    $("enctitle").textContent = enc.name;
    $("encwhere").textContent = (reg ? reg.name : "WASTELAND") + " · SECTOR " +
      sectorAt(enc.x, enc.z) + " · " + TR.Clock.time();
    $("encthreat").innerHTML = riskBars(enc.hazard ? 2 : enc.hostile ? 4 : 1);

    // Typewriter: the readout should feel like it is coming in, not appearing.
    var body = $("encbody");
    if (typer) { clearInterval(typer); typer = null; }
    body.textContent = "";
    body.classList.add("typing");
    var full = enc.text, ci = 0;
    typer = setInterval(function () {
      ci += 2;
      body.textContent = full.slice(0, ci);
      if (ci >= full.length) {
        clearInterval(typer); typer = null;
        body.classList.remove("typing");
      }
    }, 14);

    var box = $("mchoices");
    box.innerHTML = "";
    choices.forEach(function (c, i) {
      var b = document.createElement("button");
      b.className = "echoice";
      b.innerHTML = '<span class="num">' + (i + 1) + '</span>' +
                    '<span class="arrow">&raquo;</span>' +
                    '<span class="lbl">' + c.label + "</span>" +
                    (c.odds ? '<span class="tag">[ ' + c.odds + " ]</span>" : "");
      b.onclick = function () { HUD.closeEncounter(); cb(c); };
      box.appendChild(b);
    });

    wrap.classList.add("on");
    HUD._encChoices = choices;
    HUD._encCb = cb;
  };

  function sectorAt(x, z) {
    var c = String.fromCharCode(65 + Math.max(0, Math.min(23, Math.floor(x / (W.SIZE / 24)))));
    return c + (Math.floor(z / (W.SIZE / 24)) + 1);
  }

  HUD.closeEncounter = function () {
    if (typer) { clearInterval(typer); typer = null; }
    $("modalwrap").classList.remove("on");
    HUD._encChoices = null;
    HUD._encCb = null;
  };
  HUD.encounterOpen = function () { return $("modalwrap").classList.contains("on"); };

  /* --- wiring --------------------------------------------------------------- */
  HUD.init = function (controller) {
    app = controller;
    $("search").addEventListener("input", function (e) {
      listFilter = e.target.value || "";
      app.refreshList();
    });
    $("btnClose").onclick = function () { app.exit(); };
    $("btnCenter").onclick = function () { app.recenter(); };
    $("btnRoads").onclick = function () { app.toggleRoads(); };
    for (var i = 0; i <= 3; i++) {
      (function (n) { $("spd" + n).onclick = function () { app.setTimeScale(n); }; })(i);
    }
    return HUD;
  };

  global.HUD = HUD;
})(window);
