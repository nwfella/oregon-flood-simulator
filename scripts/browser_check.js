#!/usr/bin/env node
/*
 * browser_check.js — real-browser gate for the Oregon tsunami simulator.
 * Zero dependencies: drives headless Chrome over the DevTools Protocol.
 *
 *   node scripts/browser_check.js
 *   node scripts/browser_check.js --url=https://nwfella.github.io/oregon-flood-simulator/
 *   node scripts/browser_check.js --shots=artifacts
 *
 * Asserts: no exceptions/console errors, model + WebGL boot, canvas actually
 * paints, magnitude/tide monotonicity through the real UI controls, DOM readouts
 * agree with the model, and no horizontal overflow at 1500/1024/390 px.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const argv = process.argv.slice(2);
const flag = (n, d) => { const h = argv.find((a) => a.startsWith("--" + n + "=")); return h ? h.slice(n.length + 3) : d; };
const URL_ = flag("url", null);
const SHOTS = flag("shots", null);
const local = path.resolve(__dirname, "..", "index.html");
const target = URL_ || "file:///" + local.replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const c = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH))
    ? process.env.CHROME_PATH : c.find((x) => fs.existsSync(x));
}

let pass = 0, fail = 0;
const out = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  \x1b[32mPASS\x1b[0m " + label + (detail !== undefined ? "  \x1b[90m" + detail + "\x1b[0m" : "")); }
  else { fail++; console.log("  \x1b[31mFAIL\x1b[0m " + label + (detail !== undefined ? "  \x1b[31m" + detail + "\x1b[0m" : "")); }
  out.push((cond ? "PASS " : "FAIL ") + label + (detail !== undefined ? " :: " + detail : ""));
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) for (const l of this.listeners) l(m);
    });
  }
  on(fn) { this.listeners.push(fn); }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("CDP timeout " + method)); } }, 60000);
    });
  }
  async eval(expression, awaitPromise) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: !!awaitPromise, userGesture: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  }
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + label);
    await sleep(120);
  }
}

(async () => {
  const chrome = findChrome();
  if (!chrome) { console.error("no chrome"); process.exit(2); }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tsunami-cdp-"));
  const port = 9411 + (process.pid % 300);
  const args = ["--headless=new", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    "--disable-extensions", "--force-device-scale-factor=1", "--enable-unsafe-swiftshader",
    "--use-gl=angle", "--use-angle=swiftshader",
    "--window-size=1500,1000", "--user-data-dir=" + profile,
    "--remote-debugging-port=" + port, "about:blank"];
  let child = spawn(chrome, args, { stdio: "ignore" });
  let cdp = null, close = async () => { try { child.kill(); } catch (e) {} };

  try {
    const version = await waitFor(async () => {
      const r = await fetch("http://127.0.0.1:" + port + "/json/version");
      return r.ok ? r.json() : false;
    }, 25000, "devtools port");
    const tg = await waitFor(async () => {
      const l = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
      return l.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || false;
    }, 15000, "page target");
    const ws = new WebSocket(tg.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", () => rej(new Error("ws"))); });
    cdp = new CDP(ws);
    const errors = [];
    cdp.on((m) => {
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        errors.push((d.exception && d.exception.description) || d.text);
      }
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errors.push(m.params.entry.text);
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: target });

    console.log("\x1b[90m" + version.Browser + " -> " + target + "\x1b[0m");
    await waitFor(() => cdp.eval("document.readyState==='complete'"), 30000, "load");
    await waitFor(() => cdp.eval("!!window.__READY__ || !!window.__BOOTERR__"), 40000, "boot");
    const booterr = await cdp.eval("window.__BOOTERR__ || null");
    ok(!booterr, "boots without a fatal error", booterr || "ok");
    if (booterr) throw new Error("boot: " + booterr);
    await sleep(600);

    const p1 = await cdp.eval("JSON.stringify(window.__PROBE__())");
    const P1 = JSON.parse(p1);
    ok(P1.ready === true, "model ready", "cells=" + P1.cells);
    ok(P1.gl && P1.gl.ok, "WebGL2 context created", P1.gl && P1.gl.renderer);
    ok(P1.cells === 723 * 900, "grid is 723x900", P1.cells);
    ok(P1.areaKm2 > 80 && P1.areaKm2 < 4000, "M9 flooded area plausible", P1.areaKm2.toFixed(0) + " km2");
    ok(P1.maxR > 6 && P1.maxR < 40, "M9 peak runup within published envelope (9-30 m)", P1.maxR.toFixed(1) + " m");
    ok(P1.first > 240 && P1.first < 3600, "first landfall 4-60 min", (P1.first / 60).toFixed(1) + " min");
    ok(P1.townsWet >= 8, "at least 8 communities inundated at M9", P1.townsWet);
    ok(P1.slip > 6 && P1.slip < 30, "M9 slip plausible", P1.slip.toFixed(1) + " m");

    // --- canvas actually paints
    await cdp.eval("window.__SETT__(35)");
    const pix35 = JSON.parse(await cdp.eval("JSON.stringify(window.__PIXELS__())"));
    ok(pix35.mean > 4, "canvas renders (mean luminance)", pix35.mean.toFixed(1));
    ok(pix35.waterFrac > 0.15, "ocean reads as water in the frame", (pix35.waterFrac * 100).toFixed(0) + "%");
    await cdp.eval("window.__SETT__(95)");
    const pix95 = JSON.parse(await cdp.eval("JSON.stringify(window.__PIXELS__())"));
    ok(pix95.wetFrac > 0.0002, "inundation visible at T+95 (bright water pixels)", (pix95.wetFrac * 100).toFixed(3) + "%");
    const diffBlocks = pix35.sig.filter((v, i) => Math.abs(v - pix95.sig[i]) > 1.5).length;
    ok(diffBlocks >= 8, "frame genuinely changes with simulation time", diffBlocks + "/64 blocks differ");

    // --- real UI control: magnitude
    async function setRange(id, v) {
      await cdp.eval("(()=>{var e=document.getElementById('" + id + "');e.value='" + v +
        "';e.dispatchEvent(new Event('input',{bubbles:true}));})()");
    }
    await setRange("mag", "7.0");
    await waitFor(() => cdp.eval("window.__SIM__.res && Math.abs(window.__SIM__.res.mag-7.0)<0.01"), 30000, "M7 recompute");
    await sleep(300);
    const p7 = JSON.parse(await cdp.eval("JSON.stringify(window.__PROBE__())"));
    ok(p7.areaKm2 < P1.areaKm2 * 0.5, "M7 floods far less than M9",
      p7.areaKm2.toFixed(1) + " vs " + P1.areaKm2.toFixed(0) + " km2");
    ok(p7.maxR < P1.maxR, "M7 runup below M9", p7.maxR.toFixed(1) + " vs " + P1.maxR.toFixed(1));

    await setRange("tide", "3");
    await waitFor(() => cdp.eval("window.__SIM__.res && Math.abs(window.__SIM__.res.tide-3)<0.01"), 30000, "tide recompute");
    const p7hi = JSON.parse(await cdp.eval("JSON.stringify(window.__PROBE__())"));
    ok(p7hi.areaKm2 > p7.areaKm2, "high tide increases inundation",
      p7.areaKm2.toFixed(1) + " -> " + p7hi.areaKm2.toFixed(1) + " km2");

    // back to the headline scenario
    await setRange("mag", "9.0");
    await setRange("tide", "0.9");
    await waitFor(() => cdp.eval("window.__SIM__.res && Math.abs(window.__SIM__.res.mag-9.0)<0.01 && Math.abs(window.__SIM__.res.tide-0.9)<0.01"), 30000, "M9 recompute");

    // --- DOM readouts agree with the model
    await cdp.eval("window.__SETT__(120)");
    await sleep(200);
    const dom = JSON.parse(await cdp.eval(`JSON.stringify({
      area: document.querySelector('#stArea b').textContent,
      people: document.querySelector('#stPeople b').textContent,
      first: document.querySelector('#stFirst b').textContent,
      clock: document.getElementById('clockT').textContent,
      rows: document.querySelectorAll('#townList .town').length,
      hitRows: document.querySelectorAll('#townList .town.wet').length,
      markers: document.querySelectorAll('#markers .mk').length,
      hitMarkers: document.querySelectorAll('#markers .mk.hit').length,
      townCount: document.getElementById('townCount').textContent
    })`));
    const resNow = JSON.parse(await cdp.eval("JSON.stringify({area: window.__SIM__.res.areaKm2, dur: window.__SIM__.res.duration, wet: window.__SIM__.res.towns.filter(t=>t.depth>0.05).length, slots: window.__SIM__.res.curve.area.length})"));
    ok(dom.rows === 27, "all 27 communities listed", dom.rows);
    ok(dom.markers === 27, "all 27 map markers built", dom.markers);
    ok(parseFloat(dom.area) > 0 && parseFloat(dom.area) <= resNow.area + 1,
      "rendered flooded area matches model", dom.area + " of " + resNow.area.toFixed(0));
    ok(dom.hitRows > 5, "town rows flip to wet as the wave passes", dom.hitRows);
    ok(dom.hitMarkers === dom.hitRows, "map markers and town rows agree",
      dom.hitMarkers + " vs " + dom.hitRows);
    ok(/^T\+\d{1,3}:\d{2}$/.test(dom.clock), "clock format", dom.clock);

    // --- responsive
    for (const [w, h] of [[1500, 1000], [1024, 900], [390, 844]]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
      await sleep(450);
      const m = JSON.parse(await cdp.eval(`JSON.stringify((function(){
        var d=document.documentElement, o=[], iw=window.innerWidth;
        document.querySelectorAll('body *').forEach(function(el){
          var r=el.getBoundingClientRect();
          if(r.width>0 && r.right>iw+1.5) o.push(el.tagName+'.'+(el.className||'').toString().slice(0,24)+'@'+Math.round(r.right));
        });
        var cv=document.getElementById('gl').getBoundingClientRect();
        return {iw:iw, sw:d.scrollWidth, cw:d.clientWidth, off:o.slice(0,8), canvas:[Math.round(cv.width),Math.round(cv.height)]};
      })())`));
      ok(m.sw - m.cw <= 2, "no horizontal page overflow at " + w + "px", "sw=" + m.sw + " cw=" + m.cw);
      ok(m.off.length === 0, "no element overflows the viewport at " + w + "px", m.off.join(" "));
      ok(m.canvas[0] > 180 && m.canvas[1] > 200, "map canvas has real size at " + w + "px", m.canvas.join("x"));
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(400);

    // --- screenshots
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      const shots = [[0, "t000"], [22, "t022"], [45, "t045"], [95, "t095"], [150, "t150"]];
      for (const [mins, name] of shots) {
        await cdp.eval("window.__SETT__(" + mins + ")");
        await sleep(350);
        const r = await cdp.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(r.data, "base64"));
      }
      console.log("\x1b[90mshots -> " + SHOTS + "\x1b[0m");
    }

    const selftest = await cdp.eval("JSON.stringify((function(){var r=window.__SELFTEST__();return {fails:r.fails,total:r.out.length,out:r.out};})())");
    const st = JSON.parse(selftest);
    ok(st.fails === 0, "in-page selftest", st.total + " checks, " + st.fails + " fails");
    if (st.fails) st.out.filter((s) => s.startsWith("FAIL")).forEach((s) => console.log("     " + s));

    ok(errors.length === 0, "zero exceptions / console errors across the session", errors.length ? errors[0].split("\n")[0] : "clean");
    if (errors.length) errors.slice(0, 6).forEach((e) => console.log("     \x1b[31m" + String(e).split("\n")[0] + "\x1b[0m"));
  } catch (e) {
    fail++;
    console.log("\x1b[31mharness error:\x1b[0m " + (e && e.message ? e.message : e));
  } finally {
    await close();
    console.log("\n" + (fail ? "\x1b[31mRED\x1b[0m" : "\x1b[32mGREEN\x1b[0m") + " - " + pass + " passed, " + fail + " failed");
    setTimeout(() => process.exit(fail ? 1 : 0), 250);
  }
})();
