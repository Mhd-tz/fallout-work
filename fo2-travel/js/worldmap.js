/* =============================================================================
 * worldmap.js - Fallout 2 world data.
 *
 * Coordinates are traced off the FO2 world map (729 x 775 px reference) and
 * normalised into a 1000 x 1000 world grid: +X = east, +Z = south.
 * One world unit ~= 1.4 in-game miles; tune SCALE.milesPerUnit to taste.
 *
 * Everything here is data. Retune positions, add locations, or swap the whole
 * table for one generated out of the Creation Kit without touching any other
 * file - the UI reads this at boot and adapts.
 * ========================================================================== */
(function (global) {
  "use strict";

  var SRC_W = 729, SRC_H = 775;
  function px(x, y) { return [ (x / SRC_W) * 1000, (y / SRC_H) * 1000 ]; }

  var SCALE = {
    milesPerUnit: 1.4,
    // Game-minutes of travel time per world unit at the Highwayman's cruise
    // speed. FO2 moved the clock ~ this fast on the world map.
    minutesPerUnit: 1.9,
    // Manual driving is watched in real time, so the clock must not run at the
    // fast-travel rate - that burned a whole game day every 20 seconds.
    driveTimeFactor: 0.08
  };

  /* --- Regions: used for terrain tinting, danger rating and the sidebar ---- */
  var REGIONS = [
    { id: "arroyo",   name: "ARROYO BASIN",       color: "#6d7a4a", danger: 1 },
    { id: "klamath",  name: "KLAMATH HIGHLANDS",  color: "#66713f", danger: 2 },
    { id: "modoc",    name: "MODOC FLATS",        color: "#7d7542", danger: 2 },
    { id: "vc",       name: "VAULT CITY REACH",   color: "#5f6b46", danger: 2 },
    { id: "redding",  name: "REDDING MINES",      color: "#7a6a45", danger: 3 },
    { id: "reno",     name: "NEW RENO SPRAWL",    color: "#6f6242", danger: 4 },
    { id: "hills",    name: "BROKEN HILLS",       color: "#7c6a4c", danger: 3 },
    { id: "coast",    name: "PACIFIC COAST",      color: "#5b6b52", danger: 3 },
    { id: "ncr",      name: "NEW CALIFORNIA REP", color: "#77764a", danger: 2 },
    { id: "wastes",   name: "OPEN WASTELAND",     color: "#7b7049", danger: 4 }
  ];

  /* --- Locations ----------------------------------------------------------
   * kind:     town | vault | base | ruin | cave | poi
   * marker:   editor id of the Fallout 4 map marker / XMarker this entry maps
   *           to. The Papyrus side resolves it - see papyrus/ and README.
   * services: shown as chips on the destination card
   * danger:   0..5, feeds the encounter roll for legs that end here
   */
  var LOCATIONS = [
    { id: "arroyo",   name: "ARROYO",         kind: "town",  region: "arroyo",  p: px(78, 62),   danger: 0, start: true,
      marker: "FO2_MRK_Arroyo",   services: ["HEALER", "TRADE"],            desc: "Your tribe's village. Elder is waiting on the G.E.C.K." },
    { id: "toxic",    name: "TOXIC CAVES",    kind: "cave",  region: "klamath", p: px(112, 40),  danger: 3,
      marker: "FO2_MRK_ToxicCaves", services: ["LOOT"],                     desc: "Sludge-flooded cave system. Something big nests in there." },
    { id: "klamath",  name: "KLAMATH",        kind: "town",  region: "klamath", p: px(186, 56),  danger: 1,
      marker: "FO2_MRK_Klamath",  services: ["TRADE", "REPAIR", "BAR"],     desc: "Trapper town. Gecko pelts, bad beer, worse rats." },
    { id: "den",      name: "THE DEN",        kind: "town",  region: "klamath", p: px(206, 112), danger: 2,
      marker: "FO2_MRK_TheDen",   services: ["TRADE", "REPAIR", "CHEM", "GARAGE"], desc: "Slavers and junkies. Smitty's garage sells the Highwayman." },
    { id: "modoc",    name: "MODOC",          kind: "town",  region: "modoc",   p: px(416, 106), danger: 2,
      marker: "FO2_MRK_Modoc",    services: ["TRADE", "BAR", "REPAIR"],     desc: "Farm town at the edge of the flats. Brahmin and bad blood." },
    { id: "ghost",    name: "GHOST FARM",     kind: "poi",   region: "modoc",   p: px(470, 78),  danger: 2,
      marker: "FO2_MRK_GhostFarm", services: [],                            desc: "Slag settlement below the fields. Not haunted. Mostly." },
    { id: "gecko",    name: "GECKO",          kind: "town",  region: "vc",      p: px(641, 64),  danger: 3, rads: true,
      marker: "FO2_MRK_Gecko",    services: ["TRADE", "REPAIR"],            desc: "Ghoul town around a leaking atomic plant. Rad gear advised." },
    { id: "vcity",    name: "VAULT CITY",     kind: "town",  region: "vc",      p: px(601, 106), danger: 1,
      marker: "FO2_MRK_VaultCity", services: ["TRADE", "DOCTOR", "REPAIR"], desc: "Vault 8 grown fat and cruel. Citizenship required." },
    { id: "redding",  name: "REDDING",        kind: "town",  region: "redding", p: px(291, 196), danger: 2,
      marker: "FO2_MRK_Redding",  services: ["TRADE", "BAR", "DOCTOR"],     desc: "Gold mining town caught between Reno and Vault City." },
    { id: "sad",      name: "S.A.D.",         kind: "base",  region: "reno",    p: px(447, 264), danger: 4,
      marker: "FO2_MRK_SAD",      services: [],                             desc: "Sierra Army Depot. Automated defences still online." },
    { id: "stables",  name: "STABLES",        kind: "poi",   region: "reno",    p: px(431, 296), danger: 3,
      marker: "FO2_MRK_Stables",  services: [],                             desc: "New Reno's outrider camp. Watch the brahmin." },
    { id: "reno",     name: "NEW RENO",       kind: "town",  region: "reno",    p: px(456, 320), danger: 3,
      marker: "FO2_MRK_NewReno",  services: ["TRADE", "CHEM", "BAR", "DOCTOR", "GARAGE"], desc: "Four families, no law. Best mechanic on the coast." },
    { id: "golgotha", name: "GOLGOTHA",       kind: "ruin",  region: "reno",    p: px(442, 351), danger: 3,
      marker: "FO2_MRK_Golgotha", services: [],                             desc: "Reno's boot hill. People get buried here breathing." },
    { id: "raiders",  name: "RAIDERS",        kind: "base",  region: "hills",   p: px(626, 231), danger: 5,
      marker: "FO2_MRK_Raiders",  services: [],                             desc: "Fortified raider camp. Bishop pays well for its location." },
    { id: "hills",    name: "BROKEN HILLS",   kind: "town",  region: "hills",   p: px(641, 291), danger: 2, rads: true,
      marker: "FO2_MRK_BrokenHills", services: ["TRADE", "REPAIR", "DOCTOR"], desc: "Uranium town. Humans, ghouls and mutants, uneasily." },
    { id: "navarro",  name: "NAVARRO",        kind: "base",  region: "coast",   p: px(72, 416),  danger: 5,
      marker: "FO2_MRK_Navarro",  services: ["REPAIR"],                     desc: "Enclave refuelling base. Vertibirds. Power armour. Leave." },
    { id: "sfran",    name: "SAN FRANCISCO",  kind: "town",  region: "coast",   p: px(188, 570), danger: 2,
      marker: "FO2_MRK_SanFran",  services: ["TRADE", "DOCTOR", "REPAIR", "GARAGE"], desc: "Shi and the Hubologists. Tanker in the bay." },
    { id: "mbase",    name: "MILITARY BASE",  kind: "ruin",  region: "wastes",  p: px(332, 611), danger: 4, rads: true,
      marker: "FO2_MRK_MilBase",  services: [],                             desc: "Mariposa. Glowing, half-collapsed, full of teeth." },
    { id: "v13",      name: "VAULT 13",       kind: "vault", region: "ncr",     p: px(491, 620), danger: 3,
      marker: "FO2_MRK_Vault13",  services: [],                             desc: "The old home vault. Deathclaws answered the door." },
    { id: "ncr",      name: "N.C.R.",         kind: "town",  region: "ncr",     p: px(601, 622), danger: 1,
      marker: "FO2_MRK_NCR",      services: ["TRADE", "DOCTOR", "REPAIR", "BAR", "GARAGE"], desc: "New California Republic. Actual laws. Actual police." },
    { id: "v15",      name: "VAULT 15",       kind: "vault", region: "ncr",     p: px(681, 621), danger: 3,
      marker: "FO2_MRK_Vault15",  services: ["TRADE"],                      desc: "Collapsed vault, squatter town on top. Khans nearby." }
  ];

  /* --- Roads --------------------------------------------------------------
   * The red route lines from the world map. `w` is road quality: it scales
   * travel speed and lowers encounter chance.
   *   1.0 highway  |  0.7 road  |  0.45 track
   * `via` inserts intermediate bend points so routes curve like real roads.
   */
  var ROADS = [
    { a: "arroyo",  b: "klamath", w: 0.45, via: [px(130, 74)] },
    { a: "klamath", b: "toxic",   w: 0.45 },
    { a: "klamath", b: "den",     w: 0.7,  via: [px(206, 82)] },
    { a: "den",     b: "modoc",   w: 1.0,  via: [px(290, 128), px(360, 118)] },
    { a: "den",     b: "redding", w: 0.7,  via: [px(238, 156)] },
    { a: "modoc",   b: "ghost",   w: 0.45 },
    { a: "modoc",   b: "vcity",   w: 1.0,  via: [px(506, 96)] },
    { a: "modoc",   b: "redding", w: 0.7,  via: [px(370, 158)] },
    { a: "vcity",   b: "gecko",   w: 0.7 },
    { a: "vcity",   b: "hills",   w: 0.7,  via: [px(636, 186)] },
    { a: "hills",   b: "raiders", w: 0.45 },
    { a: "hills",   b: "reno",    w: 0.7,  via: [px(556, 306)] },
    { a: "redding", b: "reno",    w: 1.0,  via: [px(356, 244), px(410, 288)] },
    { a: "reno",    b: "sad",     w: 0.45, via: [px(452, 292)] },
    { a: "reno",    b: "stables", w: 0.45 },
    { a: "reno",    b: "golgotha", w: 0.45 },
    { a: "reno",    b: "ncr",     w: 1.0,  via: [px(500, 430), px(556, 540)] },
    { a: "ncr",     b: "v15",     w: 0.7 },
    { a: "ncr",     b: "v13",     w: 0.7 },
    { a: "v13",     b: "mbase",   w: 0.45, via: [px(410, 626)] },
    { a: "mbase",   b: "sfran",   w: 0.7,  via: [px(262, 604)] },
    { a: "sfran",   b: "navarro", w: 0.45, via: [px(96, 512)] },
    { a: "navarro", b: "redding", w: 0.45, via: [px(150, 330), px(232, 246)] }
  ];

  /* --- Rivers and lakes ---------------------------------------------------
   * Written in world coordinates directly. Every river starts high in one of
   * the two ranges and ends somewhere real - the Pacific, or a lake - so the
   * water has a source and a destination instead of stopping in open desert.
   * terrain.js carves a channel along each centreline and floods it.
   */
  var RIVERS = [
    { name: "KLAMATH RIVER", from: "NORTH HIGHLANDS", to: "PACIFIC OCEAN",
      pts: [[288, 32], [261, 103], [226, 194], [178, 303], [130, 413], [96, 470], [72, 530]] },
    { name: "SIERRA RUN",    from: "SIERRA SPINE",    to: "GECKO RESERVOIR",
      pts: [[823, 71], [789, 155], [741, 245], [700, 320], [668, 372], [648, 392]] },
    { name: "SALT FORK",     from: "SOUTH SIERRA",    to: "SALT FLAT LAKE",
      pts: [[878, 512], [806, 566], [716, 612], [640, 652], [586, 682], [562, 692]] }
  ];

  var LAKES = [
    { name: "GECKO RESERVOIR", x: 645, z: 392, r: 40 },
    { name: "SALT FLAT LAKE",  x: 558, z: 697, r: 56 }
  ];

  /* --- Encounter tables ---------------------------------------------------
   * `type` maps 1:1 to a quest / encounter form on the Papyrus side; the UI
   * only needs the presentation data. Weights are relative within a region.
   */
  var ENCOUNTERS = [
    { type: "raiders",   name: "RAIDER AMBUSH",       icon: "skull",   hostile: true,  w: { reno: 4, hills: 3, wastes: 4, redding: 2, klamath: 1, ncr: 1, coast: 2, modoc: 2, vc: 1, arroyo: 0 },
      text: "Bikes on the ridge line. They have already seen the car." },
    { type: "deathclaw", name: "DEATHCLAW",           icon: "claw",    hostile: true,  w: { wastes: 3, ncr: 2, hills: 1, redding: 1, coast: 1, reno: 0, klamath: 0, modoc: 0, vc: 0, arroyo: 0 },
      text: "Something crosses the road ahead. It is not a brahmin." },
    { type: "mutants",   name: "SUPER MUTANT PATROL", icon: "mutant",  hostile: true,  w: { wastes: 3, hills: 2, redding: 1, reno: 1, ncr: 1, coast: 1, klamath: 0, modoc: 0, vc: 0, arroyo: 0 },
      text: "Heavy footsteps in the dust. They are asking who sent you." },
    { type: "geckos",    name: "GOLDEN GECKOS",       icon: "gecko",   hostile: true,  w: { klamath: 4, modoc: 2, vc: 2, arroyo: 3, redding: 2, coast: 1, wastes: 1, reno: 0, hills: 1, ncr: 0 },
      text: "A pack breaks from the scrub, low and fast." },
    { type: "slavers",   name: "SLAVER CARAVAN",      icon: "chain",   hostile: true,  w: { klamath: 3, modoc: 2, reno: 2, wastes: 2, redding: 1, vc: 1, hills: 1, coast: 0, ncr: 0, arroyo: 0 },
      text: "Metal Slavers Guild collars. They are counting your passengers." },
    { type: "patrol",    name: "NCR PATROL",          icon: "flag",    hostile: false, w: { ncr: 5, wastes: 1, coast: 1, reno: 1, hills: 0, redding: 1, klamath: 0, modoc: 0, vc: 0, arroyo: 0 },
      text: "Rangers flag you down. Papers, cargo manifest, the usual." },
    { type: "caravan",   name: "TRADE CARAVAN",       icon: "brahmin", hostile: false, w: { ncr: 3, vc: 3, modoc: 3, redding: 3, hills: 2, coast: 2, reno: 2, klamath: 2, wastes: 1, arroyo: 1 },
      text: "Crimson Caravan brahmin train. They will trade on the roadside." },
    { type: "wanderer",  name: "LONE WANDERER",       icon: "walker",  hostile: false, w: { wastes: 2, coast: 2, klamath: 2, redding: 2, modoc: 2, ncr: 2, reno: 1, hills: 1, vc: 1, arroyo: 1 },
      text: "A figure on the shoulder of the road, thumb out." },
    { type: "wreck",     name: "ROADSIDE WRECK",      icon: "wreck",   hostile: false, w: { wastes: 3, redding: 2, reno: 2, coast: 2, ncr: 2, klamath: 2, modoc: 2, hills: 2, vc: 1, arroyo: 1 },
      text: "Burnt-out chassis, half buried. Trunk still shut." },
    { type: "radstorm",  name: "RAD STORM",           icon: "rad",     hostile: false, hazard: true, w: { wastes: 3, hills: 2, vc: 2, coast: 1, redding: 1, reno: 1, ncr: 1, klamath: 1, modoc: 1, arroyo: 1 },
      text: "The horizon goes green. Counter is climbing fast." },
    { type: "enclave",   name: "ENCLAVE VERTIBIRD",   icon: "vtol",    hostile: true,  w: { coast: 3, wastes: 1, ncr: 0, reno: 0, hills: 0, redding: 0, klamath: 0, modoc: 0, vc: 0, arroyo: 0 },
      text: "Rotor wash from above. Black armour in the doorway." }
  ];

  /* Radiation / hazard blooms baked into the terrain and the risk model. */
  var HAZARDS = [
    { x: px(641, 64)[0],  z: px(641, 64)[1],  r: 70,  kind: "rad" },   // Gecko
    { x: px(332, 611)[0], z: px(332, 611)[1], r: 95,  kind: "rad" },   // Mariposa
    { x: px(641, 291)[0], z: px(641, 291)[1], r: 55,  kind: "rad" },   // Broken Hills
    { x: px(112, 40)[0],  z: px(112, 40)[1],  r: 40,  kind: "tox" }    // Toxic Caves
  ];

  var byId = {};
  LOCATIONS.forEach(function (l) {
    l.x = l.p[0];
    l.z = l.p[1];
    byId[l.id] = l;
  });
  var regionById = {};
  REGIONS.forEach(function (r) { regionById[r.id] = r; });

  global.WORLD = {
    SIZE: 1000,
    SCALE: SCALE,
    REGIONS: REGIONS,
    LOCATIONS: LOCATIONS,
    ROADS: ROADS,
    RIVERS: RIVERS,
    LAKES: LAKES,
    ENCOUNTERS: ENCOUNTERS,
    HAZARDS: HAZARDS,
    loc: function (id) { return byId[id]; },
    region: function (id) { return regionById[id]; },
    px: px
  };
})(window);
