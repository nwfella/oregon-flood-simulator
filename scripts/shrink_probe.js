// does the map canvas shrink over time? sample the layout repeatedly.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), { spawn } = require("child_process");
const url = process.argv[2] || "file:///" + path.resolve(__dirname, "..", "index.html").replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe"].find((x) => fs.existsSync(x));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shrink-"));
const port = 9600 + (process.pid % 200);
const child = spawn(chrome, ["--headless=new", "--no-first-run", "--hide-scrollbars", "--enable-unsafe-swiftshader",
  "--use-gl=angle", "--use-angle=swiftshader", "--force-device-scale-factor=1",
  "--window-size=1500,1000", "--user-data-dir=" + profile, "--remote-debugging-port=" + port, "about:blank"], { stdio: "ignore" });

(async () => {
  try {
    let v = null;
    for (let i = 0; i < 120 && !v; i++) {
      try { const r = await fetch("http://127.0.0.1:" + port + "/json/version"); if (r.ok) v = await r.json(); } catch (e) {}
      if (!v) await sleep(250);
    }
    const tg = (await (await fetch("http://127.0.0.1:" + port + "/json/list")).json()).find((t) => t.type === "page");
    const ws = new WebSocket(tg.webSocketDebuggerUrl);
    await new Promise((res) => ws.addEventListener("open", res, { once: true }));
    let id = 0; const pend = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    });
    const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.value;
    await send("Runtime.enable"); await send("Page.enable");
    await send("Page.navigate", { url });
    for (let i = 0; i < 80; i++) { if (await ev("!!window.__READY__")) break; await sleep(250); }

    const probe = `(() => { const c=document.getElementById('gl'), b=document.getElementById('mapBox'), f=document.getElementById('mapFit');
      const r=c.getBoundingClientRect();
      return { cw:Math.round(r.width), ch:Math.round(r.height), boxW:b.clientWidth, boxH:b.clientHeight,
               fitW:f.style.width, fitH:f.style.height, buf:[c.width,c.height], inner:[innerWidth,innerHeight] }; })()`;
    for (let i = 0; i < 8; i++) {
      console.log(i + "s", JSON.stringify(await ev(probe)));
      await sleep(1000);
    }
    await ev("window.__SETT__ ? window.__SETT__(45) : 0");
    await sleep(600);
    const layout = await ev(`(() => {
      const r = (id) => { const e = document.getElementById(id); if (!e) return null;
        const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width)]; };
      return JSON.stringify({ railL: r('railL'), stage: r('stage'), railR: r('railR'), main: r('main') || (() => { const m = document.querySelector('main').getBoundingClientRect(); return [Math.round(m.left), Math.round(m.top), Math.round(m.width)]; })() });
    })()`);
    console.log("layout", layout);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(__dirname, "..", "artifacts", "shrink.png"), Buffer.from(shot.data, "base64"));
    console.log("shot -> artifacts/shrink.png");
  } catch (e) {
    console.log("ERR " + e.message);
  } finally {
    try { child.kill(); } catch (e) {}
    setTimeout(() => process.exit(0), 300);
  }
})();
