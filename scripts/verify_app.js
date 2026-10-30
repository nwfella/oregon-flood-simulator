#!/usr/bin/env node
/*
 * verify_app.js — tier-1 gate. Lifts the DOM-free CORE out of index.html and
 * exercises the physics against a synthetic shelf AND the baked real DEM.
 * No browser, no dependencies.
 *
 *   node scripts/verify_app.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  \x1b[32mPASS\x1b[0m " + label + (detail !== undefined ? "  \x1b[90m" + detail + "\x1b[0m" : "")); }
  else { fail++; console.log("  \x1b[31mFAIL\x1b[0m " + label + (detail !== undefined ? "  \x1b[31m" + detail + "\x1b[0m" : "")); }
}

/* ---------- 1. packaging ---------- */
console.log("\x1b[1mpackaging\x1b[0m");
const S = "/* CORE-START */", E = "/* CORE-END */";
ok(html.indexOf(S) > 0 && html.indexOf(E) > 0, "core markers present");
const coreSrc = html.slice(html.indexOf(S) + S.length, html.indexOf(E));
ok(!/__DEM_JSON__|__DEM__\s*=\s*null/.test(html), "DEM placeholder is baked");
ok(!/<script[^>]+src=/i.test(html), "no external script tags");
const ext = html.match(/(src|href)\s*=\s*"https?:[^"]*"/gi);
ok(!ext, "no offsite src/href", ext ? ext.join(",") : "none");
ok(/<link rel="icon" href="data:image\/svg/.test(html), "inline svg favicon (no 404)");
ok(!/\bfetch\s*\(|\bXMLHttpRequest\b/.test(html), "zero network calls at runtime");

/* ---------- 2. core isolation ---------- */
console.log("\n\x1b[1mcore isolation\x1b[0m");
const stripped = coreSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
["document.getElementById", "document.querySelector", "document.createElement",
  "window.addEventListener", "localStorage", "fetch(", "new Image(", "XMLHttpRequest",
  "requestAnimationFrame", "getElementById"].forEach(function (pat) {
  ok(stripped.indexOf(pat) < 0, "core free of " + pat);
});

const Core = new Function(coreSrc + "\nreturn Core;")();

/* ---------- 3. synthetic shelf ---------- */
console.log("\n\x1b[1msynthetic shelf (60x40)\x1b[0m");
const SNX = 60, SNY = 40;
const sdem = { nx: SNX, ny: SNY, lon0: -126.0, lat0: 44.0, dlon: 0.02, dlat: 0.02 };
const selev = new Float32Array(SNX * SNY);
// water 40 cells wide (the CSZ front at lon -125.38 sits inside it), then a coastal plain
for (let j = 0; j < SNY; j++) for (let i = 0; i < SNX; i++) {
  selev[j * SNX + i] = i < 40 ? -(2600 - i * 64) : Math.pow(i - 40, 1.25) * 1.6;
}
const smodel = Core.makeModel(sdem, selev);
const s9 = Core.scenario(smodel, { mag: 9.0, centerLat: 44.4, tide: 0.9, subsidence: true });
const s7 = Core.scenario(smodel, { mag: 7.0, centerLat: 44.4, tide: 0.9, subsidence: true });
ok(s9.areaKm2 > 0, "synthetic case floods something", s9.areaKm2.toFixed(1) + " km2");
ok(s9.areaKm2 > s7.areaKm2, "M9 > M7 on the synthetic shelf",
  s7.areaKm2.toFixed(1) + " -> " + s9.areaKm2.toFixed(1));
ok(s9.maxR > s7.maxR, "M9 runup > M7 runup", s7.maxR.toFixed(1) + " / " + s9.maxR.toFixed(1));
let scattered = 0, nanCount = 0;
for (let i = 0; i < selev.length; i++) {
  if (!isFinite(s9.arrive[i]) || !isFinite(s9.landT[i]) || !isFinite(s9.landD[i])) nanCount++;
  if (selev[i] > 0 && s9.landD[i] > 0 && !(s9.landT[i] < 1e8)) scattered++;
  if (selev[i] <= 0 && s9.landD[i] > 0) scattered++;
}
ok(nanCount === 0, "no non-finite values on a synthetic grid", nanCount);
ok(scattered === 0, "wet cells are land, wet cells have a time", scattered);
ok(s9.firstLandfall > 0 && s9.firstLandfall < s9.duration, "first landfall inside the run",
  (s9.firstLandfall / 60).toFixed(1) + " / " + (s9.duration / 60).toFixed(0) + " min");

/* determinism */
const s9b = Core.scenario(smodel, { mag: 9.0, centerLat: 44.4, tide: 0.9, subsidence: true });
let diff = 0;
for (let i = 0; i < selev.length; i++) if (Math.abs(s9.landD[i] - s9b.landD[i]) > 1e-6) diff++;
ok(diff === 0, "deterministic across runs", diff + " cells differ");

/* ---------- 4. scaling laws ---------- */
console.log("\n\x1b[1mscaling laws\x1b[0m");
const Ls = [7.0, 7.5, 8.0, 8.5, 9.0].map(Core.ruptureLength);
ok(Ls.every((v, i) => i === 0 || v > Ls[i - 1]), "rupture length increases with Mw", Ls.map(v => v.toFixed(0)).join(" < "));
ok(Core.ruptureLength(9) > 700 && Core.ruptureLength(9) < 1300, "M9 rupture ~1000 km", Core.ruptureLength(9).toFixed(0) + " km");
const slips = [7.0, 8.0, 8.5, 9.0].map(m => Core.slipFor(m, Core.ruptureLength(m)));
ok(slips.every((v, i) => i === 0 || v > slips[i - 1]), "slip increases with Mw", slips.map(v => v.toFixed(1)).join(" < "));
ok(slips[3] > 5 && slips[3] < 30, "M9 slip in the geological range (5-30 m)", slips[3].toFixed(1) + " m");
ok(Core.fmtClock(0) === "00:00" && Core.fmtClock(3599) === "59:59" && Core.fmtClock(1e9) === "--:--",
  "clock formatting incl. no-data", Core.fmtClock(3599));

/* ---------- 5. the baked DEM ---------- */
console.log("\n\x1b[1mbaked DEM\x1b[0m");
const demMatch = html.match(/window\.__DEM__ = (\{[\s\S]*?\});\s*<\/script>/);
ok(!!demMatch, "DEM blob found in the page");
let real = null;
if (demMatch) {
  const dem = JSON.parse(demMatch[1]);
  ok(dem.nx >= 600 && dem.ny >= 800, "grid size", dem.nx + " x " + dem.ny);
  ok(Array.isArray(dem.tbl) && dem.tbl.length === 256, "quantisation table is 256 entries", dem.tbl && dem.tbl.length);
  const q = zlib.inflateSync(Buffer.from(dem.elev, "base64"));
  ok(q.length === dem.nx * dem.ny, "elevation blob length matches the grid", q.length);
  const elev = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) elev[i] = dem.tbl[q[i]];
  // spot-check the quantisation against known places: ocean deep, Cascades high
  const at = (lon, lat) => elev[Math.floor((dem.lat0 + dem.dlat * dem.ny - lat) / dem.dlat) * dem.nx +
    Math.floor((lon - dem.lon0) / dem.dlon)];
  ok(at(-125.6, 44.5) < -2000, "deep water ~3 km off the trench", at(-125.6, 44.5).toFixed(0) + " m");
  ok(at(-122.0, 44.5) > 400, "Cascade crest is high", at(-122.0, 44.5).toFixed(0) + " m");
  ok(at(-124.3, 44.6) <= 0, "the sea off Newport is water", at(-124.3, 44.6).toFixed(0) + " m");
  let land = 0, low = 0;
  for (let i = 0; i < elev.length; i++) if (elev[i] > 0) { land++; if (elev[i] < 5) low++; }
  ok(land > 200000 && land < 400000, "land/water split looks like Oregon", land + " land cells");
  ok(low > 300, "there is coastal lowland below 5 m", low + " cells");

  const model = Core.makeModel(dem, elev);
  const r9 = Core.scenario(model, { mag: 9.0, centerLat: 44.5, tide: 0.9, subsidence: true });
  real = r9;
  ok(r9.areaKm2 > 80 && r9.areaKm2 < 900, "M9 flooded land plausible for the Oregon coast", r9.areaKm2.toFixed(0) + " km2");
  ok(r9.maxR > 8 && r9.maxR <= 30, "M9 peak runup inside the DOGAMI 9-30 m envelope", r9.maxR.toFixed(1) + " m");
  ok(r9.firstLandfall > 300 && r9.firstLandfall < 2400, "first landfall 5-40 min", (r9.firstLandfall / 60).toFixed(1) + " min");
  ok(r9.towns.filter(t => t.depth > 0.05).length >= 6, "several communities inundated",
    r9.towns.filter(t => t.depth > 0.05).length + " / " + r9.towns.length);

  const r8 = Core.scenario(model, { mag: 8.0, centerLat: 44.5, tide: 0.9, subsidence: true });
  const r70 = Core.scenario(model, { mag: 7.0, centerLat: 44.5, tide: -1, subsidence: false });
  ok(r8.areaKm2 < r9.areaKm2 && r8.maxR < r9.maxR, "M8 sits between M7 and M9",
    `${r8.areaKm2.toFixed(0)} km2 / ${r8.maxR.toFixed(1)} m`);
  ok(r70.areaKm2 < r9.areaKm2 * 0.2, "M7 at low tide barely floods", r70.areaKm2.toFixed(1) + " km2");

  const south = Core.scenario(model, { mag: 8.5, centerLat: 42.6, tide: 0.9, subsidence: true });
  const north = Core.scenario(model, { mag: 8.5, centerLat: 45.8, tide: 0.9, subsidence: true });
  // Southern Oregon is far steeper than the Clatsop plain, so the same rupture centre
  // flooding much less there is a real result of this DEM, not a bug.
  ok(north.areaKm2 > south.areaKm2 * 4, "rupture centre steers the damage north vs south",
    south.areaKm2.toFixed(0) + " (S) vs " + north.areaKm2.toFixed(0) + " (N) km2");
  ok(south.maxR > 3, "a southern rupture still runs up onto land", south.maxR.toFixed(1) + " m");

  const count = (r) => { let c = 0; for (let i = 0; i < r.landD.length; i++) if (r.landD[i] > 0.02) c++; return c; };
  ok(count(r9) === r9.floodedCells, "floodedCells matches the field", count(r9));
  ok(Math.abs(r9.areaKm2 - r9.floodedCells * r9.cellAreaKm2) < 1e-6, "area = cells x cell area",
    r9.cellAreaKm2.toFixed(4) + " km2/cell");
  ok(r9.curve.area.length === r9.curve.people.length && r9.curve.area[0] <= r9.curve.area[r9.curve.area.length - 1],
    "cumulative curves are monotone", r9.curve.area.length + " bins");
  const last = r9.curve.area[r9.curve.area.length - 1];
  ok(Math.abs(last - r9.areaKm2) / r9.areaKm2 < 0.02, "final curve value equals total area",
    last.toFixed(0) + " vs " + r9.areaKm2.toFixed(0));
  ok(r9.computedMs < 8000, "scenario computes in a usable time", r9.computedMs.toFixed(0) + " ms");
}

console.log("\n" + (fail ? "\x1b[31mRED\x1b[0m" : "\x1b[32mGREEN\x1b[0m") + " - " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
