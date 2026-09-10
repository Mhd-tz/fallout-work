/* =============================================================================
 * travel.js - road graph, routing, risk model and the world clock.
 *
 * Pure logic, no DOM and no rendering: everything here is safely unit-testable
 * and can be driven either by the UI or by the game through bridge.js.
 * ========================================================================== */
(function (global) {
  "use strict";

  var W = global.WORLD, T = global.TERRAIN;
  var Travel = {};

  /* --- graph -------------------------------------------------------------- */
  var nodes = {};   // id -> { id, x, z, edges: [edgeIndex] }
  var edges = [];   // { a, b, pts, len, w, cum }

  function polyLen(pts) {
    var L = 0, cum = [0];
    for (var i = 1; i < pts.length; i++) {
      L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      cum.push(L);
    }
    return { len: L, cum: cum };
  }

  Travel.buildGraph = function () {
    nodes = {}; edges = [];
    W.LOCATIONS.forEach(function (l) {
      nodes[l.id] = { id: l.id, x: l.x, z: l.z, edges: [] };
    });
    W.ROADS.forEach(function (r) {
      var pts = T.roadPoints(r);
      var m = polyLen(pts);
      var e = { a: r.a, b: r.b, pts: pts, len: m.len, cum: m.cum, w: r.w };
      var idx = edges.push(e) - 1;
      nodes[r.a].edges.push(idx);
      nodes[r.b].edges.push(idx);
    });
    return Travel;
  };

  Travel.edges = function () { return edges; };

  /* --- nearest point on the road network ---------------------------------- */
  Travel.nearestOnRoads = function (x, z) {
    var best = null;
    for (var ei = 0; ei < edges.length; ei++) {
      var e = edges[ei], pts = e.pts;
      for (var i = 1; i < pts.length; i++) {
        var ax = pts[i - 1][0], az = pts[i - 1][1];
        var bx = pts[i][0], bz = pts[i][1];
        var dx = bx - ax, dz = bz - az;
        var L2 = dx * dx + dz * dz;
        var t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)) : 0;
        var px = ax + dx * t, pz = az + dz * t;
        var d = Math.hypot(px - x, pz - z);
        if (!best || d < best.dist) {
          best = { dist: d, x: px, z: pz, edge: ei, seg: i, t: t,
                   along: e.cum[i - 1] + Math.hypot(px - ax, pz - az) };
        }
      }
    }
    return best;
  };

  /* --- A* ----------------------------------------------------------------- */
  function heuristic(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

  /**
   * Route between two node ids. `extra` optionally injects a temporary node
   * (the car's current off-node position) spliced into the nearest edge.
   */
  function astar(startId, goalId, graph) {
    var open = [startId];
    var g = {}, f = {}, from = {};
    g[startId] = 0;
    f[startId] = heuristic(graph[startId], graph[goalId]);

    while (open.length) {
      var bi = 0;
      for (var i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      var cur = open.splice(bi, 1)[0];
      if (cur === goalId) {
        var path = [cur];
        while (from[cur]) { cur = from[cur].node; path.unshift(cur); }
        return path;
      }
      var node = graph[cur];
      for (var k = 0; k < node.links.length; k++) {
        var link = node.links[k];
        // Poor roads cost more than their raw length.
        var cost = link.len * (1 + (1 - link.w) * 0.55);
        var tent = g[cur] + cost;
        if (g[link.to] === undefined || tent < g[link.to]) {
          g[link.to] = tent;
          f[link.to] = tent + heuristic(graph[link.to], graph[goalId]);
          from[link.to] = { node: cur, link: link };
          if (open.indexOf(link.to) < 0) open.push(link.to);
        }
      }
    }
    return null;
  }

  /** Adjacency view of the graph, optionally with a spliced-in start node. */
  function buildAdjacency(splice) {
    var graph = {};
    Object.keys(nodes).forEach(function (id) {
      graph[id] = { id: id, x: nodes[id].x, z: nodes[id].z, links: [] };
    });
    edges.forEach(function (e, ei) {
      graph[e.a].links.push({ to: e.b, len: e.len, w: e.w, edge: ei, rev: false });
      graph[e.b].links.push({ to: e.a, len: e.len, w: e.w, edge: ei, rev: true });
    });

    if (splice) {
      var e = edges[splice.edge];
      var id = "@start";
      graph[id] = { id: id, x: splice.x, z: splice.z, links: [] };
      var toA = splice.along, toB = e.len - splice.along;
      graph[id].links.push({ to: e.a, len: toA, w: e.w, edge: splice.edge, rev: true, partial: splice });
      graph[id].links.push({ to: e.b, len: toB, w: e.w, edge: splice.edge, rev: false, partial: splice });
      graph[e.a].links.push({ to: id, len: toA, w: e.w, edge: splice.edge, rev: false, partial: splice });
      graph[e.b].links.push({ to: id, len: toB, w: e.w, edge: splice.edge, rev: true, partial: splice });
    }
    return graph;
  }

  /** Points of edge `ei` walked from node `fromId` to the other end. */
  function edgePoints(ei, fromId, fromAlong, toAlong) {
    var e = edges[ei];
    var pts = e.pts.slice();
    var forward = (e.a === fromId);
    if (fromAlong !== undefined || toAlong !== undefined) {
      var lo = Math.min(fromAlong === undefined ? 0 : fromAlong, toAlong === undefined ? e.len : toAlong);
      var hi = Math.max(fromAlong === undefined ? 0 : fromAlong, toAlong === undefined ? e.len : toAlong);
      var out = [pointAt(e, lo)];
      for (var i = 0; i < pts.length; i++) {
        if (e.cum[i] > lo && e.cum[i] < hi) out.push(pts[i]);
      }
      out.push(pointAt(e, hi));
      pts = out;
      // Walking direction depends on which end we started from.
      if ((fromAlong !== undefined ? fromAlong : 0) > (toAlong !== undefined ? toAlong : e.len)) pts.reverse();
      return pts;
    }
    return forward ? pts : pts.slice().reverse();
  }

  function pointAt(e, along) {
    along = Math.max(0, Math.min(e.len, along));
    for (var i = 1; i < e.cum.length; i++) {
      if (e.cum[i] >= along) {
        var t = (along - e.cum[i - 1]) / ((e.cum[i] - e.cum[i - 1]) || 1);
        return [e.pts[i - 1][0] + (e.pts[i][0] - e.pts[i - 1][0]) * t,
                e.pts[i - 1][1] + (e.pts[i][1] - e.pts[i - 1][1]) * t];
      }
    }
    return e.pts[e.pts.length - 1].slice();
  }

  /**
   * Plan a route.
   * @param from  { x, z } | locationId
   * @param toId  destination location id
   * @return { points, legs, distance, nodes } or null
   */
  Travel.route = function (from, toId) {
    var splice = null, startId;
    if (typeof from === "string") {
      startId = from;
    } else {
      splice = Travel.nearestOnRoads(from.x, from.z);
      startId = "@start";
      splice.origin = from;
    }
    var graph = buildAdjacency(splice);
    if (!graph[startId] || !graph[toId]) return null;

    var path = astar(startId, toId, graph);
    if (!path || path.length < 2) return null;

    var points = [], legs = [];
    if (splice && splice.dist > 1.5) points.push([from.x, from.z]);

    for (var i = 0; i < path.length - 1; i++) {
      var a = path[i], b = path[i + 1];
      var link = null, links = graph[a].links;
      for (var k = 0; k < links.length; k++) {
        if (links[k].to === b && (!link || links[k].len < link.len)) link = links[k];
      }
      if (!link) continue;

      var pts;
      if (link.partial) {
        var e = edges[link.edge];
        if (a === "@start") pts = edgePoints(link.edge, b, splice.along, (b === e.a ? 0 : e.len));
        else pts = edgePoints(link.edge, a, (a === e.a ? 0 : e.len), splice.along);
      } else {
        pts = edgePoints(link.edge, a);
      }
      for (var p = 0; p < pts.length; p++) {
        var last = points[points.length - 1];
        if (!last || Math.hypot(last[0] - pts[p][0], last[1] - pts[p][1]) > 0.4) points.push(pts[p]);
      }
      legs.push({ from: a, to: b, len: link.len, w: link.w, edge: link.edge });
    }

    var m = polyLen(points);
    return { points: points, legs: legs, distance: m.len, cum: m.cum,
             nodes: path, dest: toId };
  };

  /** Position + heading a given distance along a planned route. */
  Travel.sample = function (route, dist) {
    var pts = route.points, cum = route.cum;
    dist = Math.max(0, Math.min(route.distance, dist));
    for (var i = 1; i < cum.length; i++) {
      if (cum[i] >= dist) {
        var t = (dist - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
        var x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t;
        var z = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
        return { x: x, z: z, heading: Math.atan2(-(pts[i][0] - pts[i - 1][0]), -(pts[i][1] - pts[i - 1][1])), seg: i - 1 };
      }
    }
    var n = pts.length - 1;
    return { x: pts[n][0], z: pts[n][1], heading: 0, seg: n };
  };

  /* --- risk model --------------------------------------------------------- */
  function regionAt(x, z) {
    var best = null, bd = 1e9;
    for (var i = 0; i < W.LOCATIONS.length; i++) {
      var l = W.LOCATIONS[i];
      var d = (l.x - x) * (l.x - x) + (l.z - z) * (l.z - z);
      if (d < bd) { bd = d; best = l; }
    }
    return best ? best.region : "wastes";
  }
  Travel.regionAt = regionAt;

  /** Encounter chance per world unit travelled at (x, z). */
  Travel.hazardAt = function (x, z, opts) {
    opts = opts || {};
    var reg = W.region(regionAt(x, z));
    var danger = reg ? reg.danger : 3;
    var road = T.onRoad(x, z);
    var base = 0.0016 * (0.5 + danger * 0.42);
    base *= (1 - road * 0.45);
    if (opts.night) base *= 1.35;
    if (opts.outdoorsman) base *= Math.max(0.35, 1 - opts.outdoorsman / 200);
    return base;
  };

  /**
   * Summarise a route for the destination card.
   * @param v  vehicle-ish { fuel, condition }
   */
  Travel.estimate = function (route, v, opts) {
    opts = opts || {};
    var minutes = 0, fuel = 0, risk = 0, samples = 0;
    var perUnit = W.SCALE.minutesPerUnit;
    var stepD = 6;

    for (var d = 0; d < route.distance; d += stepD) {
      var p = Travel.sample(route, d);
      var road = T.onRoad(p.x, p.z);
      var terr = Math.max(0.25, T.speedAt(p.x, p.z));
      minutes += (stepD * perUnit) / terr;
      fuel += stepD * (0.010 + (1 - road) * 0.010);
      risk += Travel.hazardAt(p.x, p.z, opts) * stepD;
      samples++;
    }
    if (v && v.condition < 100) minutes *= 1 + (100 - v.condition) / 220;

    var expected = risk;                        // expected encounters
    var chance = 1 - Math.exp(-expected);       // at least one
    return {
      distance: route.distance,
      miles: route.distance * W.SCALE.milesPerUnit,
      minutes: minutes,
      hours: minutes / 60,
      fuel: fuel,
      fuelOk: !v || v.fuel >= fuel,
      encounterExpected: expected,
      encounterChance: chance,
      risk: Math.min(5, Math.round(chance * 6.2)),
      legs: route.legs.length
    };
  };

  /** Danger colour for a point, used to shade the plotted route. */
  Travel.riskColorAt = function (x, z, opts) {
    var h = Travel.hazardAt(x, z, opts) * 1000;
    if (h < 0.9) return "#6fe3a0";
    if (h < 1.4) return "#f2ea6a";
    if (h < 2.0) return "#ff7a4d";
    return "#ff3b30";
  };

  /* --- encounter selection ------------------------------------------------ */
  Travel.pickEncounter = function (x, z, opts) {
    opts = opts || {};
    var reg = regionAt(x, z);
    var pool = [], total = 0;
    W.ENCOUNTERS.forEach(function (e) {
      var w = (e.w && e.w[reg] !== undefined) ? e.w[reg] : 1;
      if (opts.night && e.hostile) w *= 1.4;
      if (w > 0) { pool.push({ e: e, w: w }); total += w; }
    });
    if (!total) return null;
    var r = Math.random() * total;
    for (var i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) {
        var enc = pool[i].e;
        return {
          id: "enc_" + Date.now().toString(36) + "_" + (Math.random() * 1e6 | 0),
          type: enc.type, name: enc.name, icon: enc.icon, hostile: !!enc.hostile,
          hazard: !!enc.hazard, text: enc.text, region: reg, x: x, z: z
        };
      }
    }
    return null;
  };

  /* --- world clock -------------------------------------------------------- */
  var MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  var DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  var Clock = {
    year: 2241, month: 6, day: 25, minute: 8 * 60 + 13,

    advance: function (mins) {
      this.minute += mins;
      while (this.minute >= 1440) {
        this.minute -= 1440;
        this.day++;
        var dim = DAYS[this.month] + ((this.month === 1 && this.year % 4 === 0) ? 1 : 0);
        if (this.day > dim) { this.day = 1; this.month++; }
        if (this.month > 11) { this.month = 0; this.year++; }
      }
      return this;
    },
    set: function (o) {
      if (o.year !== undefined) this.year = o.year | 0;
      if (o.month !== undefined) this.month = Math.max(0, Math.min(11, (o.month | 0)));
      if (o.day !== undefined) this.day = o.day | 0;
      if (o.hour !== undefined) this.minute = Math.round(o.hour * 60);
      if (o.minute !== undefined) this.minute = o.minute;
      return this;
    },
    hour: function () { return this.minute / 60; },
    // Matches the solar model in main.js: the sun is below the horizon
    // outside 06:00-18:00, with a little grace so lights come on at dusk.
    isNight: function () { var h = this.hour(); return h < 6.2 || h >= 18.3; },
    /**
     * "25 JUL 2241 - 16:10". The old form ran the date straight into a bare
     * four-digit 24h time, which read as part of the year.
     */
    stamp: function () {
      return this.date() + "  \u00b7  " + this.time();
    },
    time: function () {
      var h = Math.floor(this.minute / 60), m = Math.floor(this.minute % 60);
      return pad(h, 2) + ":" + pad(m, 2);
    },
    date: function () { return pad(this.day, 2) + " " + MONTHS[this.month] + " " + this.year; }
  };
  function pad(n, w) { n = String(n | 0); while (n.length < w) n = "0" + n; return n; }

  Travel.Clock = Clock;
  Travel.MONTHS = MONTHS;

  /** Human-readable duration: "6h 40m". */
  Travel.duration = function (mins) {
    var d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = Math.round(mins % 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  };

  global.TRAVEL = Travel;
})(window);
