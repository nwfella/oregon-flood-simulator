// diagnostic: run the shipped CORE against the real baked DEM and print field stats
"use strict";
const fs = require("fs"), zlib = require("zlib"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const CS = html.indexOf("/* CORE-START */"), CE = html.indexOf("/* CORE-END */");
if (CS < 0 || CE < 0) throw new Error("core markers missing");
const body = html.slice(CS + "/* CORE-START */".length, CE);
const Core = new Function(body + "\nreturn Core;")();

const dem = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "dem.json"), "utf8"));
const q = zlib.inflateSync(Buffer.from(dem.elev, "base64"));
const elev = new Float32Array(q.length);
for (let i = 0; i < q.length; i++) elev[i] = dem.tbl[q[i]];
const model = Core.makeModel(dem, elev);

const at = (lon, lat) => {
  const i = Math.floor((lon - dem.lon0) / dem.dlon);
  const j = Math.floor((dem.lat0 + dem.dlat * dem.ny - lat) / dem.dlat);
  return j * dem.nx + i;
};

const mag = parseFloat(process.argv[2] || "9.0");
const t0 = Date.now();
const res = Core.scenario(model, { mag, centerLat: 44.5, tide: 0.9, subsidence: true });
console.log(`M${mag} computed in ${Date.now() - t0} ms  slip=${res.slip.toFixed(1)}m A0=${res.sourceAmp.toFixed(2)}m L=${res.ruptureKm.toFixed(0)}km`);
console.log(`flooded ${res.areaKm2.toFixed(0)} km2  maxR=${res.maxR.toFixed(1)}m maxDepth=${res.maxDepth.toFixed(1)}m firstLandfall=${(res.firstLandfall / 60).toFixed(1)}min`);

function show(lon, lat, label) {
  const id = at(lon, lat);
  const e = elev[id];
  console.log(`${label.padEnd(22)} e=${e.toFixed(0).padStart(6)}m  arrive=${(res.arrive[id] / 60).toFixed(1).padStart(6)}min  amp=${res.amp[id].toFixed(2).padStart(6)}m  R=${(res.landR[id] || 0).toFixed(2).padStart(5)}m  landT=${(res.landT[id] / 60).toFixed(1).padStart(6)}min depth=${res.landD[id].toFixed(2)}`);
}
show(-125.5, 44.5, "source/trench");
show(-125.0, 44.5, "60km offshore");
show(-124.6, 44.5, "30km offshore");
show(-124.2, 44.5, "5km offshore");
show(-124.05, 44.6, "Newport shore");
show(-124.02, 44.62, "Newport 500m in");
show(-124.0, 44.63, "Newport 1km in");
show(-124.05, 43.37, "Coos Bay");
show(-123.92, 45.99, "Seaside");
show(-123.94, 45.94, "Seaside beach");

// histogram of arrival times over ocean cells
const buckets = new Array(12).fill(0);
for (let i = 0; i < elev.length; i++) {
  if (elev[i] < 0 && res.arrive[i] < 1e8) buckets[Math.min(11, Math.floor(res.arrive[i] / 600))]++;
}
console.log("ocean arrival histogram (10-min bins):", buckets.join(" "));

// where is the flooding? count by latitude band
const bands = {};
for (let i = 0; i < elev.length; i++) {
  if (res.landD[i] > 0.02) {
    const j = Math.floor(i / dem.nx);
    const lat = (dem.lat0 + dem.dlat * dem.ny - (j + 0.5) * dem.dlat).toFixed(1);
    bands[lat] = (bands[lat] || 0) + 1;
  }
}
console.log("flooded cells by lat:", Object.keys(bands).sort().map((k) => k + ":" + bands[k]).join(" "));
console.log("towns:", res.towns.map((t) => `${t.n} ${t.depth.toFixed(1)}m@${(t.arrive / 60).toFixed(0)}`).join(" | "));
