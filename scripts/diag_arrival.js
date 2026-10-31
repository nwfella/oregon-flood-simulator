// arrival-time audit: where does the wave start, and how fast does it reach the coast?
"use strict";
const fs = require("fs"), zlib = require("zlib"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const S = "/* CORE-START */", E = "/* CORE-END */";
const Core = new Function(html.slice(html.indexOf(S) + S.length, html.indexOf(E)) + "\nreturn Core;")();
const dem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "dem.json"), "utf8"));
const q = zlib.inflateSync(Buffer.from(dem.elev, "base64"));
const elev = new Float32Array(q.length);
for (let i = 0; i < q.length; i++) elev[i] = dem.tbl[q[i]];
const m = Core.makeModel(dem, elev);
const r = Core.scenario(m, { mag: 9.0, centerLat: 44.5, tide: 0.9, subsidence: true });
const nx = dem.nx, ny = dem.ny;
const iOf = (lo) => Math.floor((lo - dem.lon0) / dem.dlon);
const jOf = (la) => Math.floor((dem.lat0 + dem.dlat * ny - la) / dem.dlat);
const KMLON = 111.32 * Math.cos(44 * Math.PI / 180);

function transect(label, lat, coastLon) {
  console.log("\n=== " + label + " (lat " + lat + ", coast ~ " + coastLon + ")");
  const j = jOf(lat);
  let prev = null;
  for (let i = iOf(coastLon - 1.6); i <= iOf(coastLon + 0.03); i += 2) {
    const id = j * nx + i;
    const lon = dem.lon0 + i * dem.dlon;
    const a = r.arrive[id];
    const dist = Math.abs(lon - coastLon) * KMLON;
    if (a < 1e8) {
      let v = "";
      if (prev && prev.a < 1e8) {
        const dd = (prev.dist - dist) * 1000, dt = a - prev.a;
        if (dd > 0 && dt > 0) v = (dd / dt).toFixed(0) + " m/s";
      }
      console.log("  lon " + lon.toFixed(3) + "  depth " + elev[id].toFixed(0).padStart(6) +
        "  " + dist.toFixed(0).padStart(4) + " km out  arrive " + (a / 60).toFixed(1).padStart(6) +
        " min " + (r.srcT[id] >= 0 ? "SEED" : "    ") + " " + v);
      prev = { a, dist };
    }
  }
}
transect("FLORENCE", 44.00, -124.10);
transect("SEASIDE", 46.00, -123.93);

// nearest seed cell to each town
console.log("\n=== nearest source cell per town");
for (const t of Core.TOWNS) {
  const ci = iOf(t.lo), cj = jOf(t.la);
  let best = 1e9, bi = 0, bj = 0;
  for (let dj = -120; dj <= 120; dj++) for (let di = -160; di <= 40; di++) {
    const ii = ci + di, jj = cj + dj;
    if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
    const id = jj * nx + ii;
    if (r.srcT[id] >= 0 || (r.arrive[id] < 1e8 && r.amp[id] > 9)) {
      const dx = di * dem.dlon * KMLON, dy = dj * dem.dlat * 111.32;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) { best = d; bi = ii; bj = jj; }
    }
  }
  if (best < 1e8) {
    const id = bj * nx + bi;
    console.log("  " + t.n.padEnd(15) + " nearest source " + best.toFixed(0).padStart(4) + " km away" +
      "  (depth " + elev[id].toFixed(0) + " m, arrive there " + (r.arrive[id] / 60).toFixed(1) + " min)");
  }
}
