/* =============================================================================
 * theme.js - the two looks this screen comes in.
 *
 *   sand  : the Fallout 2 world map - warm desert palette, amber chrome.
 *   green : a Vault-Tec terminal - single-phosphor green, everything the
 *           screen can say said in brightness alone.
 *
 * The 3D world is recoloured at two choke points rather than by maintaining
 * two copies of every palette: TERRAIN.css() builds every ground quad's fill
 * and R3.shade() builds every mesh face's fill, so a ramp applied there
 * catches the terrain, props, towns, bridges and the car in one place. The
 * flat pieces drawn by hand - sky, roads, water, the route line - go through
 * THEME.rgb()/rgba() instead.
 *
 * A ramp maps luminance to a colour, so relative brightness survives: a lit
 * hillside stays brighter than its shadow, tarmac stays darker than sand.
 *
 * No dependencies. Plain global, like the rest of the view.
 * ========================================================================== */
(function (global) {
  "use strict";

  var THEME = { name: "sand" };

  /* --- ramps ---------------------------------------------------------------
   * Each takes 0..255 luminance and returns a colour. `sand` warms the
   * existing palette rather than replacing it, so the map still reads as a
   * map; `green` throws the hue away entirely.
   */
  var RAMPS = {
    sand: null,          // null means "pass the original colour through"
    green: function (t, out) {
      // A terminal is mostly dark with a few hot lines on it. One straight
      // ramp gives a flat lime field: the map's sand sits around 0.7
      // luminance and swamps the screen. So the curve has two halves - the
      // terrain band is crushed almost to black, and only the top of the
      // range (paint, water highlights, the route, the counters) is allowed
      // to reach full phosphor. They are blended, not spliced, so there is no
      // step where a lit hillside crosses over.
      var dark = Math.pow(t, 3.5) * 0.40;
      var w = (t - 0.80) / 0.17;
      w = w < 0 ? 0 : w > 1 ? 1 : w * w * (3 - 2 * w);
      var d = dark * (1 - w) + t * w;
      var hot = d * d;
      out[0] = 4 + 206 * hot;
      out[1] = 9 + 236 * d;
      out[2] = 6 + 140 * hot;
      return out;
    }
  };

  // Warmth applied in sand mode: push red up and blue down a little so the
  // whole map leans to desert ochre without losing the greens in the north.
  var SAND_WARM = [1.06, 1.005, 0.87];

  var ramp = null, warm = SAND_WARM;
  var tmp = [0, 0, 0];

  /**
   * Recolour one 0..255 triple in place-ish. Returns a 3-array; callers must
   * consume it before the next call (it is a scratch buffer).
   */
  THEME.map = function (r, g, b) {
    if (!ramp) {
      tmp[0] = r * warm[0]; tmp[1] = g * warm[1]; tmp[2] = b * warm[2];
      if (tmp[0] > 255) tmp[0] = 255;
      if (tmp[1] > 255) tmp[1] = 255;
      if (tmp[2] > 255) tmp[2] = 255;
      return tmp;
    }
    var lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    if (lum > 1) lum = 1; else if (lum < 0) lum = 0;
    return ramp(lum, tmp);
  };

  THEME.rgb = function (r, g, b) {
    var c = THEME.map(r, g, b);
    return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")";
  };

  /** Bypass the ramp: for colours the theme has already chosen itself. */
  THEME.raw = function (c, a) {
    return a === undefined
      ? "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")"
      : "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + a + ")";
  };

  /** Mix two scene colours, for day/night and fade bands. */
  THEME.mix = function (a, b, t, alpha) {
    var c = [a[0] + (b[0] - a[0]) * t,
             a[1] + (b[1] - a[1]) * t,
             a[2] + (b[2] - a[2]) * t];
    return THEME.raw(c, alpha);
  };

  THEME.rgba = function (r, g, b, a) {
    var c = THEME.map(r, g, b);
    return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + a + ")";
  };

  /**
   * Self-lit surfaces - headlights, brake lights, the reactor glow - are not
   * shaded, so they miss the ramp. Warm ones stay warm: Fallout's own in-car
   * terminals put warnings in orange against the green, and a brake light
   * that turns green is not a brake light. Everything else is pulled up to
   * full phosphor rather than being crushed like the ground.
   */
  THEME.glow = function (hexStr) {
    if (!ramp) return hexStr;
    var n = parseInt(hexStr.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (r > g + 24 && r > b + 24) return hexStr;
    var lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    lum = 0.55 + lum * 0.45;
    var c = ramp(lum, tmp);
    return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")";
  };

  /** True while the world should be drawn as a single-phosphor display. */
  THEME.isTerminal = function () { return THEME.name === "green"; };

  /* --- palettes the renderer asks for by name ------------------------------ */
  var SCENE = {
    sand: {
      skyTop: [14, 20, 34], skyBot: [58, 62, 72],
      water:  [40, 96, 128], waterLit: [120, 190, 220],
      road:   [30, 27, 25],  roadLit: [74, 66, 58], paint: [242, 220, 158],
      route:  [255, 252, 240]
    },
    green: {
      skyTop: [2, 10, 6],   skyBot: [8, 34, 16],
      water:  [12, 78, 40],  waterLit: [150, 255, 170],
      // Darker than the crushed ground it lies on, so the carriageway reads
      // as a channel and the markings on it read as light.
      road:   [3, 12, 6],    roadLit: [10, 40, 18], paint: [140, 255, 155],
      route:  [210, 255, 210]
    }
  };
  THEME.scene = SCENE.sand;

  /* --- UI chrome ----------------------------------------------------------- */
  THEME.set = function (name) {
    if (!RAMPS.hasOwnProperty(name)) name = "sand";
    THEME.name = name;
    ramp = RAMPS[name];
    THEME.scene = SCENE[name];
    if (global.document && document.documentElement) {
      document.documentElement.setAttribute("data-theme", name);
    }
    // Every cached colour string was built under the old ramp.
    if (global.TERRAIN && TERRAIN.flushColors) TERRAIN.flushColors();
    if (global.R3 && R3.flushColors) R3.flushColors();
    try { localStorage.setItem("fo2.theme", name); } catch (e) {}
    return name;
  };

  THEME.toggle = function () {
    return THEME.set(THEME.name === "sand" ? "green" : "sand");
  };

  THEME.restore = function () {
    var saved = null;
    try { saved = localStorage.getItem("fo2.theme"); } catch (e) {}
    return THEME.set(saved || "sand");
  };

  global.THEME = THEME;
})(window);
