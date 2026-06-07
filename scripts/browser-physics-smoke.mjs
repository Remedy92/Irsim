import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i++;
  } else {
    args.set(key, "true");
  }
}

const url = args.get("url") ?? process.env.IRSIM_URL ?? "http://localhost:5179/";
const chromePath =
  args.get("chrome") ??
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = path.resolve(args.get("out") ?? "output");
const thresholds = {
  maxWallPenetrationCm: Number(args.get("max-pen") ?? 0.05),
  maxSegmentErrorCm: Number(args.get("max-seg-error") ?? 0.15),
  maxSettleSpeedCmS: Number(args.get("max-settle-speed") ?? 2),
  minWireExitCm: Number(args.get("min-wire-exit") ?? 3),
  maxCoveredRhoSlackCm: Number(args.get("max-covered-rho-slack") ?? 0.02)
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function removeDirBestEffort(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) {
        console.warn(`[browser-physics] Could not remove temp Chrome profile: ${error.message}`);
        return;
      }
      await wait(100 * (attempt + 1));
    }
  }
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

class CdpClient {
  #id = 0;
  #pending = new Map();

  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (!msg.id) {
        if (
          msg.method === "Runtime.consoleAPICalled" ||
          msg.method === "Runtime.exceptionThrown" ||
          msg.method === "Log.entryAdded"
        ) {
          this.events.push(msg);
        }
        return;
      }
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.message}: ${msg.error.data ?? ""}`));
      else pending.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.#id;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 10_000);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.ws.send(payload);
    });
  }

  close() {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(new Error("CDP connection closed"));
    }
    this.ws?.close();
  }
}

async function launchChrome() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "irsim-chrome-"));
  const chrome = spawn(
    chromePath,
    [
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "--headless=new",
      "--enable-unsafe-swiftshader",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,1000",
      url
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  chrome.on("exit", (code) => {
    if (code !== 0) console.error(`[browser-physics] Chrome exited with ${code}\n${stderr}`);
  });

  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const port = await waitFor(async () => {
    const text = await readFile(portFile, "utf8");
    return Number(text.split(/\r?\n/)[0]);
  }, 10_000, "Chrome DevTools port");

  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((t) => t.type === "page") ?? targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error("No page target found in Chrome");
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url });
  return { chrome, cdp, userDataDir };
}

async function evalValue(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate exception");
  }
  return result.result.value;
}

async function press(cdp, key, code, keyCode, text = "") {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyDown", text });
  await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

const summaryExpression = (name) => `
(() => {
  const h = window.__IRSIM_DEBUG__.getHistory();
  const s = window.__IRSIM_DEBUG__.getSnapshot();
  const max = (fn) => Math.max(...h.map(fn));
  const min = (fn) => Math.min(...h.map(fn));
  const bad = h.filter((x) =>
    !x.rods.wire.finite ||
    !x.rods.sheath.finite ||
    x.rods.wire.maxWallPenetration > ${thresholds.maxWallPenetrationCm} ||
    x.rods.sheath.maxWallPenetration > ${thresholds.maxWallPenetrationCm} ||
    x.rods.wire.maxSegmentLengthError > ${thresholds.maxSegmentErrorCm} ||
    x.rods.sheath.maxSegmentLengthError > ${thresholds.maxSegmentErrorCm}
  );
  return {
    name: ${JSON.stringify(name)},
    frames: h.length,
    final: s,
    summary: {
      wireCommandMin: min((x) => x.inputs.wire.deployed),
      wireCommandMax: max((x) => x.inputs.wire.deployed),
      wireActualMin: min((x) => x.rods.wire.deployed),
      wireActualMax: max((x) => x.rods.wire.deployed),
      sheathCommandMin: min((x) => x.inputs.sheath.deployed),
      sheathCommandMax: max((x) => x.inputs.sheath.deployed),
      sheathActualMin: min((x) => x.rods.sheath.deployed),
      sheathActualMax: max((x) => x.rods.sheath.deployed),
      wireTipYMin: min((x) => x.rods.wire.tip[1]),
      wireTipYMax: max((x) => x.rods.wire.tip[1]),
      wireMaxPen: max((x) => x.rods.wire.maxWallPenetration),
      sheathMaxPen: max((x) => x.rods.sheath.maxWallPenetration),
      wireMaxSegErr: max((x) => x.rods.wire.maxSegmentLengthError),
      sheathMaxSegErr: max((x) => x.rods.sheath.maxSegmentLengthError),
      wireMaxTipSpeed: max((x) => x.rods.wire.tipSpeed),
      sheathMaxTipSpeed: max((x) => x.rods.sheath.tipSpeed),
      coaxMaxLoad: max((x) => x.coax.normalLoad),
      coaxMaxContacts: max((x) => x.coax.activeContacts),
      coaxInnerClearance: s.coax.innerClearance,
      coaxMaxCoveredRho: max((x) => x.coax.maxCoveredInnerRho),
      wireExitPastOuterTipMin: min((x) => x.coax.innerExitPastOuterTip),
      wireExitPastOuterTipMax: max((x) => x.coax.innerExitPastOuterTip),
      wireExitPastOuterTipFinal: s.coax.innerExitPastOuterTip,
      badFrameCount: bad.length,
      firstBad: bad[0] ?? null
    }
  };
})()
`;

function assertScenario(report) {
  const { summary } = report;
  const failures = [];
  if (summary.badFrameCount !== 0) failures.push(`${report.name}: ${summary.badFrameCount} bad telemetry frames`);
  if (summary.wireMaxPen > thresholds.maxWallPenetrationCm) {
    failures.push(`${report.name}: wire penetration ${summary.wireMaxPen.toFixed(4)}cm`);
  }
  if (summary.sheathMaxPen > thresholds.maxWallPenetrationCm) {
    failures.push(`${report.name}: sheath penetration ${summary.sheathMaxPen.toFixed(4)}cm`);
  }
  if (summary.wireMaxSegErr > thresholds.maxSegmentErrorCm) {
    failures.push(`${report.name}: wire segment error ${summary.wireMaxSegErr.toFixed(4)}cm`);
  }
  if (summary.sheathMaxSegErr > thresholds.maxSegmentErrorCm) {
    failures.push(`${report.name}: sheath segment error ${summary.sheathMaxSegErr.toFixed(4)}cm`);
  }
  if (report.name === "reset-rebuild") {
    if (summary.wireMaxTipSpeed > thresholds.maxSettleSpeedCmS) {
      failures.push(`${report.name}: wire reset settling speed ${summary.wireMaxTipSpeed.toFixed(4)}cm/s`);
    }
    if (summary.sheathMaxTipSpeed > thresholds.maxSettleSpeedCmS) {
      failures.push(`${report.name}: sheath reset settling speed ${summary.sheathMaxTipSpeed.toFixed(4)}cm/s`);
    }
  }
  if (summary.coaxMaxCoveredRho > summary.coaxInnerClearance + thresholds.maxCoveredRhoSlackCm) {
    failures.push(
      `${report.name}: covered wire radial offset ${summary.coaxMaxCoveredRho.toFixed(4)}cm exceeds catheter clearance`
    );
  }
  if (report.name === "wire-forward-28x-w" && summary.wireExitPastOuterTipFinal < thresholds.minWireExitCm) {
    failures.push(
      `${report.name}: wire only exits ${summary.wireExitPastOuterTipFinal.toFixed(4)}cm past catheter tip`
    );
  }
  return failures;
}

async function captureScreenshot(cdp, file) {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(file, Buffer.from(shot.data, "base64"));
}

async function pageDiagnostics(cdp) {
  const page = await evalValue(
    cdp,
    `(() => ({
      href: location.href,
      readyState: document.readyState,
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 2000) ?? "",
      hasCanvas: Boolean(document.querySelector("canvas")),
      hasDebugApi: Boolean(window.__IRSIM_DEBUG__),
      hasSnapshot: Boolean(window.__IRSIM_DEBUG__?.getSnapshot?.()),
      scriptSources: Array.from(document.scripts).map((s) => s.src).filter(Boolean)
    }))()`
  );
  return { page, events: cdp.events.slice(-50) };
}

let browser;
let userDataDir;
let cdp;
const reports = [];
try {
  ({ chrome: browser, cdp, userDataDir } = await launchChrome());
  try {
    await waitFor(
      () => evalValue(cdp, "Boolean(window.__IRSIM_DEBUG__?.getSnapshot())"),
      30_000,
      "IRsim debug API"
    );
  } catch (error) {
    await mkdir(outDir, { recursive: true });
    const diagnostics = await pageDiagnostics(cdp);
    await captureScreenshot(cdp, path.join(outDir, "browser-physics-debug-timeout.png"));
    await writeFile(
      path.join(outDir, "browser-physics-debug-timeout.json"),
      JSON.stringify({ url, diagnostics }, null, 2)
    );
    throw error;
  }
  await wait(1_000);

  await evalValue(cdp, "window.__IRSIM_DEBUG__.clearHistory(); true");
  for (let i = 0; i < 28; i++) {
    await press(cdp, "w", "KeyW", 87, "w");
    await wait(120);
  }
  await wait(3_000);
  await mkdir(outDir, { recursive: true });
  await captureScreenshot(cdp, path.join(outDir, "browser-physics-wire-exit.png"));
  reports.push(await evalValue(cdp, summaryExpression("wire-forward-28x-w")));

  await press(cdp, "r", "KeyR", 82, "r");
  await wait(1_500);
  reports.push(await evalValue(cdp, summaryExpression("reset-rebuild")));
  const resetFinal = reports.at(-1).final;
  if (Math.abs(resetFinal.inputs.wire.deployed - 8) > 1e-6 || Math.abs(resetFinal.rods.wire.deployed - 8) > 0.05) {
    reports.at(-1).summary.badFrameCount += 1;
    reports.at(-1).summary.firstBad ??= resetFinal;
  }

  await evalValue(cdp, "window.__IRSIM_DEBUG__.clearHistory(); true");
  for (let i = 0; i < 8; i++) {
    await press(cdp, "ArrowUp", "ArrowUp", 38);
    await wait(160);
  }
  await wait(2_000);
  reports.push(await evalValue(cdp, summaryExpression("sheath-forward-8x-arrowup")));

  await mkdir(outDir, { recursive: true });
  await captureScreenshot(cdp, path.join(outDir, "browser-physics-smoke.png"));
  await writeFile(path.join(outDir, "browser-physics-smoke.json"), JSON.stringify({ url, thresholds, reports }, null, 2));

  const failures = reports.flatMap(assertScenario);
  console.log(JSON.stringify({ url, thresholds, reports }, null, 2));
  if (failures.length) {
    console.error(`\n[browser-physics] FAILED\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n[browser-physics] ok");
  }
} finally {
  cdp?.close();
  browser?.kill();
  await wait(250);
  if (userDataDir) await removeDirBestEffort(userDataDir);
}
