// latitude-band diagnostics
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
const mag = parseFloat(process.argv[2] || "9.0");
const t0 = Date.now();
const r = Core.scenario(m, { mag, centerLat: 44.5, tide: 0.9, subsidence: true });
console.log(`M${mag}: ${Date.now() - t0}ms flooded=${r.areaKm2.toFixed(0)}km2 maxR=${r.maxR.toFixed(1)} first=${(r.firstLandfall / 60).toFixed(1)}min`);
for (const la of [42.0, 43.0, 43.5, 44.0, 44.6, 45.0, 45.5, 46.0]) {
  let seedN = 0, arrN = 0, landN = 0, wet = 0, maxR = 0, maxAmp = 0, lowLand = 0;
  const j = Math.floor((dem.lat0 + dem.dlat * dem.ny - la) / dem.dlat);
  for (let i = 0; i < dem.nx; i++) {
    const id = j * dem.nx + i;
    if (elev[id] <= 0) {
      if (r.srcT[id] >= 0) seedN++;
      if (r.arrive[id] < 1e8) arrN++;
      if (r.amp[id] > maxAmp) maxAmp = r.amp[id];
    } else {
      landN++;
      if (elev[id] < 8) lowLand++;
      if (r.landD[id] > 0.02) wet++;
      if (r.landR[id] > maxR) maxR = r.landR[id];
    }
  }
  console.log(`lat ${la}  seeds=${String(seedN).padStart(4)} reached=${String(arrN).padStart(4)} maxAmp=${maxAmp.toFixed(1).padStart(5)} | land=${String(landN).padStart(3)} (<8m:${String(lowLand).padStart(3)}) wet=${String(wet).padStart(4)} maxR=${maxR.toFixed(1)}`);
}
