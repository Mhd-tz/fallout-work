# Chryslus NAVCOM — Fallout 2 world-travel screen for Fallout 4

A Hearts-of-Iron style travel map for the FO2-in-FO4 conversion. The player
opens the car's nav computer, sees the wasteland in 3D perspective with the
Highwayman standing on it, and either plots a fast-travel route or drives the
thing manually. Random encounters interrupt the trip and hand control back to
the game.

Built as a **PrismaUI_F4 view** — plain HTML/CSS/JS off disk, no build step.

---

## 1. Why there is no three.js in here

PrismaUI_F4 renders through **Ultralight**, a WebKit fork with its own
GPU 2D renderer. Per Ultralight's own feature list:

> GPU-accelerated 3D graphics via WebGL 1.0/2.0 is not available. You should
> use SVG or the 2D canvas for visual effects instead.

3D CSS transforms (`rotateX`, `translate3d`) are also unavailable — Ultralight
supports 2D/affine transforms only. So three.js, babylon, css3d and every
WebGL-based map library are non-starters **inside the game**, even though they
would work if you opened the same file in Chrome.

The 3D here is therefore a small purpose-built renderer built on Canvas2D:

* **`js/r3.js`** — mat4 math, a perspective camera that orbits a point on the
  ground, world→screen projection, and painter's-algorithm mesh drawing with a
  single directional light. That is what draws the Highwayman.
* **`js/terrain.js`** — the map is a real heightfield mesh, not a painted
  plane. Every cell has a height, a normal and its own lighting, so mountains
  rise, valleys shade, and the route, the car and the location counters all sit
  on the same surface. Two mip pyramids (colour *and* height) keep the mesh
  smoothing at exactly the rate it coarsens, which is what stops LOD from
  turning the map into a quilt. Power-of-two LOD steps let both pyramids be
  indexed by a shift.
* Roads, rivers and the plotted route are projected polylines draped over the
  relief rather than baked into a texture, so they stay crisp at any zoom and
  can be cut off cell-by-cell by the fog of war.
* **Geography.** Location positions are traced off the Fallout 2 world map as
  fractions of the 729x775 reference, and the Pacific shoreline is a control
  -point curve following the same map - it runs almost straight down the west
  edge in the north, then swings south-east below Navarro, which is what keeps
  Navarro and San Francisco on the coast instead of in the water.
* **Hydrology.** Each river in `worldmap.js` names a source and a mouth. At
  boot `terrain.js` forces its surface monotonically downhill from source to
  mouth, ties it to the lake it drains into, carves a channel whose bed sits
  below that surface, and floods it. Open water is impassable, so a river is a
  real obstacle — crossing it needs a bridge, and bridges are placed wherever a
  road polyline actually intersects a river polyline, decked at the uncut bank
  height and registered with the terrain as drivable road.
* **`js/props.js`** — the clutter that makes it a place rather than a sheet:
  scrub, cacti, dead trees, conifers and rock outcrops chosen by elevation and
  slope; building clusters and a water tower at every settlement; bridges
  placed wherever a road polyline actually intersects a river polyline; birds;
  and drifting cloud billboards. Birds fly in flocks of two to four that ease
  their heading rather than tracking a straight line. Scatter is procedural and
  deterministic from a position hash, so nothing is stored per prop and only
  cells near the camera are ever evaluated.
* **Lighting is dynamic.** The sun tracks east to west across the 06:00–20:00
  window, going warm and low at the edges of the day and handing over to a cold
  moon at night. Terrain, props and the car all take the same light, so the
  whole map changes through the day.
* Location counters are **DOM elements** positioned from projected screen
  coordinates, which keeps their text crisp and gives real hover/click targets
  — the same trick HOI4 uses for its unit counters.

All canvas drawing happens under one device-pixel-ratio transform set once per
frame. Nothing calls `setTransform` mid-frame, which is what previously made
the map render at 1/DPR scale on HiDPI displays while the DOM counters stayed
correct.

Everything else on the page is flex/grid and 2D transforms, all of which
Ultralight supports.

---

## 2. Files

```
fo2-travel/
  index.html                     the view PrismaUI loads
  css/travel.css                 all styling
  js/r3.js                       camera, projection, mesh drawing
  js/worldmap.js                 FO2 locations, roads, regions, encounter tables
  js/terrain.js                  3D heightfield terrain, fog of war, road mask
  js/props.js                    3D world objects: vegetation, rocks, towns,
                                 bridges, birds, clouds
  js/vehicle.js                  Highwayman mesh + driving physics
  js/travel.js                   road graph, A* routing, risk model, world clock
  js/bridge.js                   >>> the game boundary: JS <-> F4SE/Papyrus <<<
  js/hud.js                      every DOM read/write
  js/main.js                     state, input, simulation, render loop
  fonts/fo2-terminal.ttf         the interface typeface (see §11)
  papyrus/FO2Travel_MapBridge.psc game-side template script
```

`js/bridge.js` and `papyrus/FO2Travel_MapBridge.psc` are the two files your
plugin work touches. The rest is self-contained.

---

## 3. Installing as a PrismaUI view

1. Drop the `fo2-travel` folder wherever your mod keeps its view files, e.g.
   `Data/PrismaUI/views/fo2-travel/`. Take `fonts/` with it — the interface
   typeface is loaded from disk relative to the view (§11), and without it
   everything falls back to Consolas.
2. Create the view from your plugin on `kPostLoadGame` / `kNewGame`:

```cpp
view = api->CreateView("fo2-travel/index.html", [](PrismaView v) {
    // DOM ready: register the JS -> C++ callbacks here, never before.
    api->BindUIEvent(v, "sendDataToF4SE", OnUIMessage);
    api->BindUIEvent(v, "requestClose",  [](const char*) { api->Hide(view); });
});
api->Hide(view);            // opened by a hotkey / activating the car
```

3. Open it when the player uses the car, and give it input focus so WASD
   reaches the page rather than the game:

```cpp
api->Show(view);
api->Focus(view);           // F3 in the stock example plugin
```

The view reads `window.updateFocusLabel(...)`, so the top-right badge shows
INPUT FOCUS / NO INPUT FOCUS automatically. Manual driving is disabled while
unfocused, and the view drops back to survey mode.

---

## 4. Protocol — JS → game

Everything goes through `window.sendDataToF4SE(json)` as a single JSON object
with `type`, `v` (protocol version) and `t` (timestamp ms).

| `type` | when | payload |
|---|---|---|
| `ui.ready` | view finished booting | `ui`, `version` |
| `ui.close` | player pressed EXIT/ESC | — |
| `travel.plot` | destination selected (not committed) | `destId`, `destName`, `marker`, `x`, `z`, `hours`, `miles`, `fuel`, `risk` |
| `travel.begin` | player hit AUTO-TRAVEL | as above + `minutes`, `waypoints[]` (≤24 sparse points) |
| `travel.progress` | throttled during the drive | `x`, `z`, `pct`, `minutes` |
| `travel.abort` | cancelled / out of fuel / fled | `reason` |
| `travel.complete` | car reached the destination | `destId`, `marker`, `x`, `z`, `minutes`, `fuelUsed`, `condition` |
| `drive.begin` / `drive.end` | manual mode toggled | `x`, `z`, `heading`, `odometer` |
| `drive.state` | 4 Hz while driving | `x`, `z`, `heading`, `speed`, `fuel`, `condition` |
| `encounter.trigger` | an encounter fired | `id`, `encType`, `name`, `hostile`, `hazard`, `x`, `z`, `region` |
| `encounter.resolve` | player picked an option | `id`, `encType`, `choice` (`fight`/`sneak`/`flee`/`wait`/`push`/`approach`/`ignore`) |
| `waypoint.set` | pin dropped for manual driving | `x`, `z`, `destId?`, `destName?` |
| `map.discover` | new location found while driving | `id`, `x`, `z` |
| `log` | diagnostics | `message` |

**`travel.complete` is the one that matters.** The UI never moves the player —
it plays the drive, then tells the game where the player ended up. Do the
`MoveTo` and the clock advance in Papyrus so saves, cell loading and script
state all stay consistent.

Plugin side:

```cpp
void OnUIMessage(const char* json) {
    // Runs on the GAME THREAD - RE:: access is safe directly here.
    auto msg = nlohmann::json::parse(json, nullptr, false);
    if (msg.is_discarded()) return;
    const auto type = msg.value("type", "");

    if (type == "travel.complete") {
        int   idx   = FindLocationIndex(msg.value("destId", ""));
        float hours = msg.value("minutes", 0.0f) / 60.0f;
        CallPapyrus("FO2Travel_MapBridge", "OnTravelComplete",
                    idx, hours, msg.value("fuelUsed", 0.0f),
                    msg.value("condition", 100.0f));
    } else if (type == "encounter.resolve" && msg.value("choice", "") == "fight") {
        StartEncounter(msg.value("encType", ""), msg.value("x", 0.0f), msg.value("z", 0.0f));
        api->Hide(view);
    } else if (type == "ui.close") {
        api->Hide(view);
    }
}
```

---

## 5. Protocol — game → JS

One entry point. Call it with a JSON string:

```cpp
api->InteropCall(view, "fo2Message", R"({"type":"travel.approve","destId":"ncr"})");
// or, for one-offs:
api->Invoke(view, "fo2Message('{\"type\":\"ui.show\"}')");
```

| `type` | effect in the view |
|---|---|
| `state.sync` / `state.patch` | merge `{ player:{x,z,heading}, vehicle:{fuel,condition}, clock:{year,month,day,hour}, here, discovered:[ids], weather }` |
| `travel.approve` | `{destId}` — route confirmed, the drive plays out |
| `travel.deny` | `{destId, reason}` — aborts with a banner |
| `travel.arrived` | game finished its `MoveTo` |
| `encounter.spawn` | force an encounter: `{encType, name, text, hostile, hazard, x, z}` |
| `encounter.result` | `{id, outcome:"win"/"flee"/"loss", damage, caps}` — resumes or abandons the route |
| `loc.unlock` | `{id}` reveals a location and its fog |
| `clock.set` | `{year, month, day, hour, minute}` |
| `ui.show` / `ui.hide` / `ui.toggle` | visibility |

If the game never sends anything, the view still runs standalone — it simulates
its own clock, fuel and encounters. That is deliberate: you can ship the UI and
wire the game up piece by piece.

---

## 6. Papyrus-only path (no plugin of your own)

`window.prisma` is injected by PrismaUI_F4, so the view can read and write
`TESGlobal`s and Papyrus auto-properties directly. `js/bridge.js` already
mirrors the important state into globals:

| global | id | meaning |
|---|---|---|
| `FO2_DestX` | `801` | world X of the chosen destination |
| `FO2_DestZ` | `802` | world Z |
| `FO2_DestIndex` | `803` | index into `WORLD.LOCATIONS` |
| `FO2_TravelMode` | `804` | 0 idle · 1 fast travel · 2 manual drive |
| `FO2_Fuel` | `805` | MFC charge 0–100 |
| `FO2_Condition` | `806` | chassis condition 0–100 |
| `FO2_Encounter` | `807` | non-zero while an encounter is pending |

Set the plugin name and ids at the top of `js/bridge.js`:

```js
var CONFIG = {
  esp: "FO2Wasteland.esp",
  script: "FO2Travel_MapBridge",
  questFormId: "800",
  globals: { destX: "801", destZ: "802", /* ... */ }
};
```

Form ids are **local hex without the file-index byte** — `0x0F000801` is
written `"801"`. ESL prefixes are resolved for you.

`papyrus/FO2Travel_MapBridge.psc` polls those globals and does the `MoveTo` and
clock advance. Fill `TravelMarkers[]` in the CK **in the same order as
`WORLD.LOCATIONS`** — index 0 is Arroyo.

---

## 7. Tuning the world

Everything about the map is data in `js/worldmap.js`:

* **Locations** — traced off the FO2 world map into a 1000×1000 grid using
  `px(x, y)` against the 729×775 reference image, so you can read new
  coordinates straight off the same map. Each entry carries `kind`, `region`,
  `danger`, `services`, `desc` and `marker` (the CK editor id it maps to).
* **Roads** — `{a, b, w, via[]}`. `w` is road quality (1.0 highway, 0.7 road,
  0.45 track) and drives speed, encounter chance and how the road is drawn.
  `via` points are run through a Catmull-Rom spline so routes curve.
* **Encounters** — per-region weights, plus `hostile` / `hazard` flags. `type`
  is what gets sent to the game as `encType`.
* **Scale** — `milesPerUnit` (map distance → the mileage shown) and
  `minutesPerUnit` (fast-travel clock rate). `driveTimeFactor` slows the clock
  during manual driving so a road trip does not eat a game week.

Terrain is generated procedurally from a seed in `js/terrain.js` (coastline,
Sierra spine, central valley, radiation blooms around Gecko/Mariposa/Broken
Hills). Change `makeNoise(20770412)` for a different wasteland.

---

## 8. Previewing without the game

Open `index.html` in a browser. `js/bridge.js` detects that
`window.sendDataToF4SE` is missing and switches to **mock mode**: same message
shapes, same async latency, fake approvals and encounter results, so the whole
screen is playable.

URL hash flags jump straight to a state:

| hash | state |
|---|---|
| `#reveal` | lift the fog |
| `#reveal&dest=reno` | route plotted to New Reno |
| `#reveal&travel=ncr&seek=0.45` | mid auto-travel to the NCR |
| `#reveal&dest=reno&pin&drive` | manual driving with the destination pinned |
| `#drive&night` | manual driving after dark |
| `#reveal&dest=hills&enc=deathclaw` | encounter prompt (any `encType` works) |
| `#storm` | rain/storm weather |
| `#fps` | on-canvas frame-cost readout |
| `#quality=0..3` | lock a terrain quality tier instead of auto-tuning |
| `#drive&boost&speed=34` | driving with the overcharge held open (dev only) |
| `#drive&at=600,513&heading=0.64` | drop the car at a world position, facing a bearing |
| `#drive&pitch=0.25&dist=110` | override the chase camera, e.g. to inspect a bridge |

Controls: **LMB** pan · **RMB** rotate/tilt · **wheel** zoom · **TAB** drive
mode · **WASD** drive · **SHIFT** boost · **SPACE** brake (or pause in survey)
· **ENTER** auto-travel · **P** pin & drive · **F** headlights · **R** recenter
· **0–3** time rate · **ESC** clear/abort/exit.

The time-rate control folds away in manual driving — the clock there follows
the wheels, not a multiplier — and folds back in on the way out.

## 9. Performance

The terrain mesh is the only expensive pass. Measured at 1600×900 on
**software rasterization** (headless Chrome, `--disable-gpu`) — a deliberate
worst case, since Ultralight rasterizes to the GPU:

| pass | cost |
|---|---|
| terrain bake incl. hydrology (once, at boot) | ~200 ms |
| prop placement (once, at boot) | ~1 ms |
| terrain + 150 props (survey) | ~6 ms/frame |
| terrain + 130 props (driving) | ~3 ms/frame |

Because that floor is so pessimistic, quality is **adaptive**: `main.js` keeps
a 15-frame average and walks a tier table (9600 → 4800 → 2200 → 1100 target
quads, dropping the ground-detail scatter on the way down); badly over budget
drops two tiers at once instead of creeping.
It starts at the top tier and settles wherever the real renderer can hold.
Watch it live with `FO2Travel.setFps(true)` or `index.html#fps`, and pin a tier
with `#quality=2` to compare.

Other knobs: `GN` and `RELIEF` in `terrain.js` (mesh resolution and how tall
the mountains are), `TARGET_QUADS` (the default tier), `SPACING` and the
`maxProps` cap in `props.js` (how dense the clutter is), and `DPR` at the top
of `main.js` (capped at 1.5).

### Day and night

The sun's elevation is a sine over the full 24 hours, so it rises, crosses and
sets continuously - there is no "day branch" and "night branch" to snap
between. Everything downstream reads `light.dayness` (0 night, 1 full day) and
interpolates: ambient, intensity, a warm tint when the sun is near the horizon,
cold moonlight below it, the distance haze, and a keyframed sky gradient
blended between the two nearest times of day.

### Terrain shading

Three things keep the heightfield from reading as a grid of squares, none of
which Canvas2D gives you for free:

* **Vertex lighting.** The sun term is evaluated at each of the quad's four
  corners from central differences, not once at its centre. Two quads sharing
  an edge compute the same value at the shared corners, so the shading is
  continuous across the mesh; each quad is then filled with a two-stop ramp
  between its brightest and darkest corner. Flat-filling the average is what
  used to make the map look like a chequerboard.
* **Seam overlap.** Canvas2D antialiases every polygon edge, so two quads that
  share an edge each cover it only half and the background bleeds through as a
  hairline — a lattice over the whole map. Each quad is scaled a fraction of a
  pixel about its own centre so neighbours overlap and close it.
* **LOD hysteresis.** The mesh step is a power of two (the colour and height
  mips are indexed by a shift), so a camera sitting on a level boundary used to
  flip the entire map between two quad sizes frame to frame. The current level
  is held until demand is clearly past it in either direction.

### Roads

Roads are a ribbon of ground quads built in **world** space, not a stroked
polyline. A stroke has a constant pixel width, so the road stayed the same thin
line however close the camera got, and its dash pattern was measured in screen
pixels - which is why the markings crawled along the tarmac as you drove. Every
dimension is now in world units and projected: shoulder, carriageway, edge
lines and centre line, all as real geometry, all pinned to the ground. The
width comes from `TERRAIN.roadHalfWidth()`, the same figure the road mask is
rasterised with, so the surface you see is exactly the surface the driving
model gives you grip on.

There are two readings of the same road, cross-faded over a narrow band of
on-screen width (`px` 13 → 24). Close up it is tarmac. Pulled back to survey
the continent it reverts to a line on a chart, because four pixels of grey
asphalt tells you nothing about where the roads run.

### Driving model

`vehicle.js` samples the ground under all four wheels every frame. That gives
the body height (ride on the highest axle, so no corner buries itself), the
pitch and roll to sit flat on a slope, and the grade the engine has to fight —
climbing costs power, descending pulls you along, and anything above a 1.15
grade is a wall. Gravity along the grade is deliberately weaker than the
engine, so every hilltop stays reachable - a location on high ground must never
be cut off. There is a real reverse gear: `S` brakes while rolling forward and
engages reverse once stopped, with its own top speed and inverted steering.

Speeds, in world units per second (`× 1.89` for the dashboard reading):

| | on road | off road |
|---|---|---|
| cruise | 37.5 (71 mph) | 24 (45 mph) |
| overcharge | 45 (85 mph) | 27 (51 mph) |
| reverse | 15 | 9 |

**Overcharge** is `SHIFT`. It is a reservoir, not a throttle multiplier: 100%
drains in about six seconds, refills at 9%/s after a second of cooldown, and it
only engages under power with a live cell and a forward gear. It raises the
ceiling as well as the acceleration — scaling the throttle alone, which is what
this used to do, did nothing once the car was already at top speed. `TOP_BOOST`
is the hard cap, so nothing (a downhill run included) puts the dashboard past
85.

### Bridges

`buildBridges()` puts a span wherever a road crosses a river. Placement walks
outward along the road from the crossing to the first ground that is dry, and
dry for another six units, on each side; those two points give the abutment
heights and the span length. The deck is **pitched** to meet both banks — a
single height taken from the higher bank leaves the low end hanging in the air,
which is what used to make spans look like they were floating. Two more pieces
finish the job: concrete abutment blocks under each end so an uneven bank
cannot open a gap, and an approach skirt in `TERRAIN.deckAt()` that eases the
drivable surface off the deck onto the bank instead of stepping off a lip. Crossings within 34 units of each other collapse into one span, so a
meandering river does not stack four bridges on the same water.

The deck sits clearly above the banks - a bridge you step onto from flat ground
does not read as a bridge - and **earth embankments** carry the road up to it.
Each is built for its own bridge, since the rise is whatever that pair of banks
needs, and placed at its own foot with local +z pointing at the deck so it lies
on the ground rather than following the deck's pitch. Its cross-sections sample
the real terrain: there is no depth buffer here, so an embankment modelled with
a deep flat base gets painted straight over the hillside and reads as a black
slab parked next to the bridge. The drivable skirt in `TERRAIN.deckAt()` is
exactly as long as the earthwork you can see, so the car never climbs air or
clips through the batter. The road ribbon is drawn *after* the embankments and
reads its height from `surfaceAt()`, so it paints itself up and over them with
no extra work.

## 10. What is verified, and what is not

**Verified** — the whole view was run headlessly and screenshotted in every
mode: boot, survey, route plotting, auto-travel with a live progress rail,
manual driving with the chase camera and an off-screen waypoint cue, night,
storm, and the encounter prompt. The driving model is unit-tested headlessly:
accelerate → brake through zero into reverse → back to forward all behave, and
over 600 simulated steps of steering across terrain the car never once dropped
below the ground surface. Hydrology is checked the same way: every river's
surface is verified monotonically downhill from source to mouth, open water
reports as impassable, bridge decks report as road, and a car driven at a
bridge crosses it — roughly 150 frames on the deck, zero in the water, zero
blocked. Every bridge is checked for gaps at both ends and for a continuous
drivable surface across the span and its approaches: sampling every half unit
from one embankment foot to the other finds no step over 1.6 units on any of
the four. Ground clipping is re-checked after every change — four bridge
crossings plus eight cross-country runs of 1500 steps each, re-posing the car
the way the renderer does, report zero frames below the surface. Rendering was checked at both 1× and 2×
device-pixel-ratio, since a HiDPI-only projection bug is what previously made
the counters float off the map. All 420 location pairs route with correct
endpoints, clock rollover is exact, and encounter draws match the weight
tables. `index.html` carries a permanent `window.onerror` trap that writes the
failure into the boot log and to `console.error`, because Ultralight otherwise
fails silently — a JS error just leaves you a blank view. Register a
`ConsoleMessageCallback` in `OnDomReadyCallback` and it lands in your F4SE log.

**Known limits.** Shading is interpolated per quad, not per pixel, because
Canvas2D has no fragment stage. The chequerboard and the lattice are gone (see
§9), but a quad is still a quad: at full-map zoom the colour texture is sampled
from a coarse mip and reads as soft patches, and hard edges like the coastline
still step. Raising `TARGET_QUADS` past the top tier is the knob, and it is a
real cost even on the GPU; the honest fix would be WebGL, which Ultralight does
not offer.

**Not verified** — anything that needs the game:

* `papyrus/FO2Travel_MapBridge.psc` has not been compiled against a load order.
  It is a template: wire the properties in the CK and adapt the encounter
  hand-off to however your mod spawns encounters.
* The C++ snippets in this README are illustrative, not a compiled plugin.
* Ultralight's Canvas2D performance in-game will differ from the numbers above.
  Start at `step: 3` and let the adaptive controller settle.
* Location coordinates are traced by eye off the FO2 map. They are close, and
  `px()` makes them trivial to retune once you have the real marker positions.

---

## 11. Interface notes

**Mode** is a two-position switch, not a label: survey and drive were already
the thing the player changes most often, so the readout may as well be the
control that changes it (`TAB` still works). While a course is running the
switch is replaced by an AUTO-TRAVEL state, because the mode is not the
player's to pick until they abort.

**Both side panels fold** to their header bar via the chevron in the header;
the header keeps its count / range readout so a folded panel still tells you
something. `HUD.refreshPanelRects()` is called on every fold, so the map
counters immediately reclaim the space.

**The map key** lives at the foot of the location list and collapses the same
way. The six marker glyphs carry real information - a vault is not a ruin - and
nothing on screen said so; the last two rows describe the border treatment
(dashed for undiscovered, red for a contact) rather than repeating a glyph.

## 12. The typeface

Fallout 2's interface type is a small blocky bitmap face. No system font looks
like one and there is nothing free to ship, so `fonts/fo2-terminal.ttf` is
authored here: the glyphs are pixel grids, merged into rectangular contours and
emitted as a real TrueType file. 107 glyphs — ASCII plus the box, triangle and
disc marks the markers use.

The grid is seven rows above the baseline and two below, at 128 units per pixel
in a 1280-unit em. That puts the cap height at 0.70 em, the same optical size
as the system faces the layout was built against, so nothing had to be
re-measured. **Ten pixel rows per em means font sizes that are multiples of
10px land on whole pixels and stay sharp** — the stylesheet uses 10 / 15 / 20 /
30 throughout for that reason. Sizes in between still render, just softer.

To regenerate or extend it, the generator is a single script; add a grid to the
`G` table and rebuild. Keep the family name `FO2 Terminal` — `travel.css`
declares it in `@font-face` with a relative `../fonts/` URL, which is what
Ultralight resolves against the view's own path, and falls back to Consolas /
SF Mono / Menlo if the file is ever missing.
