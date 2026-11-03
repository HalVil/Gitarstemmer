import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}/Gitarstemmer/`;
const CHROME = process.env.CHROME || "google-chrome";

const STRINGS = [
  { id: "E2", name: "E", octave: "2", freq: 440 * 2 ** ((40 - 69) / 12) },
  { id: "A2", name: "A", octave: "2", freq: 440 * 2 ** ((45 - 69) / 12) },
  { id: "D3", name: "D", octave: "3", freq: 440 * 2 ** ((50 - 69) / 12) },
  { id: "G3", name: "G", octave: "3", freq: 440 * 2 ** ((55 - 69) / 12) },
  { id: "B3", name: "B", octave: "3", freq: 440 * 2 ** ((59 - 69) / 12) },
  { id: "E4", name: "E", octave: "4", freq: 440 * 2 ** ((64 - 69) / 12) }
];

let failed = 0;

function check(cond, message) {
  if (cond) {
    console.log("ok  " + message);
  } else {
    failed += 1;
    console.error("FAIL " + message);
  }
}

const www = await mkdtemp(path.join(tmpdir(), "gitar-www-"));
const link = spawn("ln", ["-sfn", ROOT, path.join(www, "Gitarstemmer")]);
await new Promise((resolve, reject) => {
  link.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("ln failed"))));
});

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: www,
  stdio: "ignore"
});

const profile = await mkdtemp(path.join(tmpdir(), "gitar-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--hide-scrollbars",
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream",
  `--user-data-dir=${profile}`,
  "--remote-debugging-port=9222",
  "about:blank"
], { stdio: "ignore" });

function shutdown() {
  chrome.kill("SIGKILL");
  server.kill("SIGKILL");
}

try {
  await waitForServer();
  const wsUrl = await debuggerUrl();
  const page = await connect(wsUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  });

  await open(page, BASE);
  const idle = await evalJson(page, `({
    title: document.title,
    h1: document.querySelector("h1").textContent,
    status: document.getElementById("status").textContent,
    start: document.getElementById("start").textContent,
    tone: document.getElementById("tone").textContent,
    flat: document.getElementById("label-flat").textContent,
    sharp: document.getElementById("label-sharp").textContent,
    strings: [...document.querySelectorAll(".string")].map((b) => b.textContent),
    lang: document.documentElement.lang,
    sheet: [...document.styleSheets].some((s) => s.href && s.href.includes("/Gitarstemmer/css/tuner.css") && s.cssRules.length > 10),
    scripts: [...document.scripts].every((s) => !s.src || s.src.includes("/Gitarstemmer/js/")),
    noteSize: parseFloat(getComputedStyle(document.getElementById("note")).fontSize)
  })`);

  check(idle.title === "Gitarstemmer", "title");
  check(idle.h1 === "Gitarstemmer", "heading");
  check(idle.lang === "nb", "language nb");
  check(idle.status === "Trykk Start og spill en streng.", "idle instruction");
  check(idle.start === "Start", "start button");
  check(idle.tone === "Spill tone", "reference button");
  check(idle.flat === "for lavt" && idle.sharp === "for høyt", "meter labels");
  check(idle.strings.length === 6, "six strings, got " + idle.strings.join(","));
  check(idle.sheet, "stylesheet loaded from /Gitarstemmer/");
  check(idle.scripts, "scripts loaded from /Gitarstemmer/");
  check(idle.noteSize >= 90, "large readout (" + idle.noteSize + "px)");

  await evalValue(page, `
    window.__freq = ${STRINGS[1].freq};
    window.__cents = -18;
    window.__t = 0;
    AnalyserNode.prototype.getFloatTimeDomainData = function (arr) {
      const sr = this.context.sampleRate;
      const freq = window.__freq * Math.pow(2, (window.__cents || 0) / 1200);
      const t0 = window.__t || 0;
      for (let i = 0; i < arr.length; i++) {
        arr[i] = 0.45 * Math.sin((2 * Math.PI * freq * (t0 + i)) / sr);
      }
      window.__t = t0 + arr.length;
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      osc.connect(dest);
      osc.start();
      return dest.stream;
    };
  `);

  await evalValue(page, `document.getElementById("start").click()`);
  const flat = await waitForState(page, (state) => state.note === "A" && state.status === "for lavt" && state.cents.includes("18"));
  check(flat.ok, "flat A shows for lavt (" + JSON.stringify(flat.state) + ")");
  check(flat.state && flat.state.active === "1", "A string highlighted");
  await delay(250);

  const shotDir = process.env.SCREENSHOT_DIR || "/tmp";
  mkdirSync(shotDir, { recursive: true });
  const shotPath = path.join(shotDir, "screenshot_gitarstemmer_ui.png");
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("screenshot " + shotPath);

  for (const string of STRINGS) {
    await evalValue(page, `window.__freq = ${string.freq}; window.__cents = 0; window.__t = 0;`);
    const state = await waitForState(
      page,
      (s) => s.note === string.name && s.octave === string.octave && s.status === "stemt",
      2500
    );
    check(state.ok, string.id + " in tune (" + JSON.stringify(state.state) + ")");
  }

  await evalValue(page, `window.__freq = ${STRINGS[5].freq}; window.__cents = 22; window.__t = 0;`);
  const sharp = await waitForState(page, (s) => s.note === "E" && s.octave === "4" && s.status === "for høyt");
  check(sharp.ok, "sharp high E shows for høyt (" + JSON.stringify(sharp.state) + ")");

  await evalValue(page, `document.querySelector('[data-index="0"]').click()`);
  const locked = await evalJson(page, `({
    pressed: document.querySelector('[data-index="0"]').getAttribute("aria-pressed"),
    hint: document.getElementById("hint").textContent,
    note: document.getElementById("note").textContent
  })`);
  check(locked.pressed === "true" && locked.hint.includes("Låst") && locked.note === "E", "lock low E (" + JSON.stringify(locked) + ")");

  await evalValue(page, `document.getElementById("tone").click()`);
  await delay(150);
  const playing = await evalJson(page, `document.getElementById("tone").textContent`);
  check(typeof playing === "string" && playing.startsWith("Spiller"), "reference tone button (" + playing + ")");

  await open(page, BASE);
  await evalValue(page, `
    navigator.mediaDevices.getUserMedia = async () => {
      const err = new Error("denied");
      err.name = "NotAllowedError";
      throw err;
    };
  `);
  await evalValue(page, `document.getElementById("start").click()`);
  const denied = await waitForText(page, "message");
  check(
    denied.includes("Fikk ikke tilgang til mikrofonen"),
    "denied mic message (" + denied + ")"
  );
  const startText = await evalJson(page, `document.getElementById("start").textContent`);
  check(startText === "Start", "start button restored after denial");

  console.log(failed ? failed + " UI checks failed" : "UI checks passed");
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  shutdown();
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await delay(100);
  }
  throw new Error("server did not start");
}

async function debuggerUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("http://127.0.0.1:9222/json/list");
      const pages = await res.json();
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* retry */
    }
    await delay(100);
  }
  throw new Error("chrome debugger did not start");
}

function connect(url) {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map();
  const waits = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
      return;
    }
    if (message.method) {
      for (let i = waits.length - 1; i >= 0; i--) {
        if (waits[i].method === message.method) {
          const item = waits.splice(i, 1)[0];
          clearTimeout(item.timer);
          item.resolve(message.params || {});
        }
      }
      if (message.method === "Runtime.exceptionThrown") {
        console.error("page exception", JSON.stringify(message.params.exceptionDetails).slice(0, 500));
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        console.error("page console", JSON.stringify(message.params.args).slice(0, 400));
      }
    }
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve({
        send(method, params) {
          const id = ++next;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        wait(method, timeout = 5000) {
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error("timeout waiting for " + method)), timeout);
            waits.push({ method, resolve: res, timer });
          });
        }
      });
    });
    ws.addEventListener("error", () => reject(new Error("websocket failed")));
  });
}

async function open(page, url) {
  const loaded = page.wait("Page.loadEventFired");
  await page.send("Page.navigate", { url });
  await loaded;
  await delay(50);
}

async function evalValue(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text + " " + (result.exceptionDetails.exception && result.exceptionDetails.exception.description || ""));
  }
  return result.result.value;
}

async function evalJson(page, expression) {
  return evalValue(page, expression);
}

async function waitForState(page, predicate, timeout = 3000) {
  const start = Date.now();
  let state = null;
  while (Date.now() - start < timeout) {
    state = await evalJson(page, `({
      note: document.getElementById("note").textContent,
      octave: document.getElementById("octave").textContent,
      status: document.getElementById("status").textContent,
      cents: document.getElementById("cents").textContent,
      active: [...document.querySelectorAll(".string")].findIndex((b) => b.classList.contains("is-on")).toString(),
      tuned: document.getElementById("app").className
    })`);
    if (predicate(state)) return { ok: true, state };
    await delay(40);
  }
  return { ok: false, state };
}

async function waitForText(page, id) {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const text = await evalJson(page, `document.getElementById(${JSON.stringify(id)}).textContent`);
    if (text) return text;
    await delay(40);
  }
  return "";
}
