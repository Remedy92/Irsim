// Headless screenshot capture for visual QA of the fluoro/UI overhaul.
// Reuses the CDP pattern from browser-physics-smoke.mjs. Run against a dev server:
//   node scripts/capture-views.mjs --url http://localhost:5174/ --out output/shots
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(a.slice(2), next);
    i++;
  } else args.set(a.slice(2), "true");
}
const url = (args.get("url") ?? "http://localhost:5174/").toString();
const outDir = path.resolve(args.get("out") ?? "output/shots");
const variant = args.get("variant"); // optional anatomy variant id (e.g. aaa-infrarenal)
const prefix = variant ? `${variant}-` : "";
const chromePath =
  args.get("chrome") ?? process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class CdpClient {
  #id = 0;
  #pending = new Map();
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (!msg.id) return;
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.ws?.close();
  }
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true;
    } catch (e) {
      last = e;
    }
    await wait(60);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
}

async function launchChrome() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "irsim-shots-"));
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
      "--hide-scrollbars",
      "--window-size=1440,900",
      url
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  chrome.stderr.on("data", (c) => (stderr += c.toString()));
  chrome.on("exit", (code) => code !== 0 && console.error(`Chrome exited ${code}\n${stderr}`));
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  let port = 0;
  await waitFor(async () => {
    const text = await readFile(portFile, "utf8");
    port = Number(text.split(/\r?\n/)[0]);
    return port > 0;
  }, 10_000, "DevTools port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((t) => t.type === "page") ?? targets[0];
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url });
  return { chrome, cdp, userDataDir };
}

const evalExpr = async (cdp, expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval exception");
  return r.result.value;
};

async function shot(cdp, file) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(file, Buffer.from(r.data, "base64"));
  console.log(`saved ${file}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const { chrome, cdp, userDataDir } = await launchChrome();
  try {
    await waitFor(() => evalExpr(cdp, "Boolean(window.__IRSIM_DEBUG__?.setState)"), 30_000, "app ready");
    // optionally switch anatomy variant first (recompiles the vessel tree), then settle
    if (variant) {
      await evalExpr(cdp, `window.__IRSIM_DEBUG__.setState({ variantId: ${JSON.stringify(variant)} }); true`);
      await wait(1000);
    }
    const pan = args.get("pan"); // "x,y" cm table pan
    if (pan) {
      const [px, py] = pan.split(",").map(Number);
      await evalExpr(cdp, `window.__IRSIM_DEBUG__.setState({ panX: ${px || 0}, panY: ${py || 0} }); true`);
      await wait(300);
    }
    // set up a visceral run, drive instruments in
    await evalExpr(
      cdp,
      "window.__IRSIM_DEBUG__.setState({ view:'fluoro', fluoroMode:'live', targetId:'t_renal_l', rao:0, cranial:0, fluoroBrightness:0, fluoroContrast:1 }); true"
    );
    await evalExpr(cdp, "window.__IRSIM_DEBUG__.setInput('sheath', { deployed: 16 }); true");
    await evalExpr(cdp, "window.__IRSIM_DEBUG__.setInput('wire', { deployed: 34, steer: 0.4 }); true");
    await wait(11_000); // rate-limited feed settle (~4 cm/s)

    await evalExpr(cdp, "window.__IRSIM_DEBUG__.inject(); true");
    await wait(1200);
    await shot(cdp, path.join(outDir, `${prefix}01-fluoro-live.png`));

    await evalExpr(cdp, "window.__IRSIM_DEBUG__.setState({ fluoroMode:'dsa' }); window.__IRSIM_DEBUG__.inject(); true");
    await wait(1200);
    await shot(cdp, path.join(outDir, `${prefix}02-fluoro-dsa.png`));

    await evalExpr(cdp, "window.__IRSIM_DEBUG__.setState({ fluoroMode:'roadmap' }); true");
    await wait(700);
    await shot(cdp, path.join(outDir, `${prefix}03-fluoro-roadmap.png`));

    await evalExpr(cdp, "window.__IRSIM_DEBUG__.setState({ view:'3d' }); true");
    await wait(700);
    await shot(cdp, path.join(outDir, `${prefix}04-view-3d.png`));

    if (args.get("measure")) {
      // verify the caliper end-to-end: enable it, click two viewport points, read the rendered cm label
      await evalExpr(cdp, "window.__IRSIM_DEBUG__.setState({ view:'fluoro', measureMode:true }); true");
      await wait(300);
      const click = async (x, y) => {
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 1, clickCount: 1 });
        await wait(150);
      };
      await click(700, 280);
      await click(700, 420);
      await wait(300);
      const label = await evalExpr(cdp, "document.querySelector('.mlabel')?.textContent ?? 'NONE'");
      const sid = await evalExpr(cdp, "window.__IRSIM_DEBUG__.getSnapshot()?.metrics?.sid ?? 0");
      console.log(`caliper: clicked 140px apart → label=${label} (sid=${sid}cm)`);
    }

    const snap = await evalExpr(cdp, "JSON.stringify(window.__IRSIM_DEBUG__.getSnapshot()?.metrics ?? {})");
    console.log("final metrics:", snap);
  } finally {
    cdp.close();
    chrome.kill("SIGKILL");
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
