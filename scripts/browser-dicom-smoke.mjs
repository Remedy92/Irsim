import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const value = process.argv[index];
  if (!value.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(value.slice(2), next);
    index++;
  } else args.set(value.slice(2), "true");
}

const url = new URL(args.get("url") ?? process.env.IRSIM_URL ?? "http://localhost:5179/").toString();
const chromePath =
  args.get("chrome") ??
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = path.resolve(args.get("out") ?? "output");
const fixtureDir = args.has("fixture-dir") ? path.resolve(args.get("fixture-dir")) : null;
const fixtureManifestPath = args.has("fixture-manifest") ? path.resolve(args.get("fixture-manifest")) : null;
const fixtureManifest = fixtureManifestPath
  ? JSON.parse(await readFile(fixtureManifestPath, "utf8"))
  : null;
const fixtureReportPath = args.has("fixture-report") ? path.resolve(args.get("fixture-report")) : null;
const fixtureReport = fixtureReportPath
  ? JSON.parse(await readFile(fixtureReportPath, "utf8"))
  : null;
const studyBenchmark = args.has("study-benchmark");
const compression = args.get("compressed") ?? null;
if (compression && compression !== "jpeg2000-lossless") {
  throw new Error(`Unsupported generated-fixture compression mode: ${compression}`);
}
if (fixtureDir && compression) {
  throw new Error("Generated-fixture compression cannot be combined with a real fixture directory");
}
if (studyBenchmark && (!fixtureDir || !fixtureManifest || !fixtureReport)) {
  throw new Error("Full-study benchmark requires --fixture-dir, --fixture-manifest, and --fixture-report");
}
const compressedSyntax = compression === "jpeg2000-lossless";
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(callback, timeoutMs, label) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (cause) {
      lastError = cause;
    }
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function removeDirBestEffort(directory) {
  if (!directory) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch {
      await wait(100 * (attempt + 1));
    }
  }
}

class CdpClient {
  id = 0;
  pending = new Map();
  events = [];

  constructor(wsUrl) {
    this.wsUrl = wsUrl;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}, sessionId = null) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (cause) => {
          clearTimeout(timeout);
          reject(cause);
        }
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  workerSessions() {
    const sessions = new Map();
    for (const event of this.events) {
      if (event.method === "Target.attachedToTarget" && event.params.targetInfo?.type === "worker") {
        sessions.set(event.params.sessionId, event.params.targetInfo.targetId);
      }
      if (event.method === "Target.detachedFromTarget") sessions.delete(event.params.sessionId);
    }
    return sessions;
  }

  close() {
    this.ws?.close();
  }
}

async function launchChrome() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "irsim-dicom-chrome-"));
  const browser = spawn(
    chromePath,
    [
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "--headless=new",
      "--enable-unsafe-swiftshader",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,1100",
      url
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let stderr = "";
  browser.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  browser.on("exit", (code) => {
    if (code !== 0) console.error(`[browser-dicom] Chrome exited with ${code}\n${stderr}`);
  });
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  const port = await waitFor(async () => {
    const text = await import("node:fs/promises").then(({ readFile }) => readFile(portFile, "utf8"));
    return Number(text.split(/\r?\n/)[0]);
  }, 10_000, "Chrome DevTools port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((item) => item.type === "page") ?? targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error("No page target found in Chrome");
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: "worker", exclude: false }, { exclude: true }]
  });
  await cdp.send("Page.navigate", { url });
  return { browser, cdp, userDataDir };
}

async function evalValue(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "Runtime.evaluate failed");
  return response.result.value;
}

const encoder = new TextEncoder();
const concat = (parts) => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};
const tag = (group, element) => {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, element, true);
  return bytes;
};
const binary16 = (value) => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
};
const binary32 = (value) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};
const valueBytes = (vr, value) => {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "number") return binary16(value);
  const raw = encoder.encode(value);
  return raw.length % 2 === 0 ? raw : concat([raw, new Uint8Array([vr === "UI" ? 0 : 32])]);
};
const element = (group, elementNumber, vr, value) => {
  const payload = valueBytes(vr, value);
  const long = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UN", "UR", "UT"]);
  if (long.has(vr)) {
    const header = new Uint8Array(8);
    header.set(encoder.encode(vr), 0);
    new DataView(header.buffer).setUint32(4, payload.length, true);
    return concat([tag(group, elementNumber), header, payload]);
  }
  const header = new Uint8Array(4);
  header.set(encoder.encode(vr), 0);
  new DataView(header.buffer).setUint16(2, payload.length, true);
  return concat([tag(group, elementNumber), header, payload]);
};

const item = (elementNumber, payload) =>
  concat([tag(0xfffe, elementNumber), binary32(payload.byteLength), payload]);

function encapsulatedPixelData(frame) {
  const paddedFrame = frame.byteLength % 2 === 0 ? frame : concat([frame, new Uint8Array(1)]);
  const header = new Uint8Array(8);
  header.set(encoder.encode("OB"), 0);
  new DataView(header.buffer).setUint32(4, 0xffffffff, true);
  return concat([
    tag(0x7fe0, 0x0010),
    header,
    item(0xe000, binary32(0)),
    item(0xe000, paddedFrame),
    item(0xe0dd, new Uint8Array(0))
  ]);
}

function syntheticStoredPixelBytes(index) {
  const rows = 64;
  const columns = 64;
  const stored = new Uint16Array(rows * columns);
  const centerColumn = 32 + Math.round(Math.sin(index / 5) * 2);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const vessel = Math.hypot(column - centerColumn, row - 35) <= 5;
      const correctionCandidate = index === 12 && Math.hypot(column - 50, row - 15) <= 4;
      const bone = Math.hypot(column - 12, row - 12) <= 7;
      stored[row * columns + column] = (vessel ? 320 : correctionCandidate ? 380 : bone ? 1200 : -1000) + 1024;
    }
  }
  const pixels = new Uint8Array(stored.byteLength);
  const pixelView = new DataView(pixels.buffer);
  for (let pixel = 0; pixel < stored.length; pixel++) pixelView.setUint16(pixel * 2, stored[pixel], true);
  return pixels;
}

let openJpegModulePromise = null;
async function encodeJpeg2000Lossless(pixels) {
  openJpegModulePromise ??= import("@cornerstonejs/codec-openjpeg").then(({ default: createOpenJpegModule }) =>
    createOpenJpegModule({ print() {}, printErr() {} })
  );
  const module = await openJpegModulePromise;
  const jpegEncoder = new module.J2KEncoder();
  try {
    jpegEncoder.getDecodedBuffer({
      width: 64,
      height: 64,
      bitsPerSample: 12,
      componentCount: 1,
      isSigned: false
    }).set(pixels);
    jpegEncoder.encode();
    return Uint8Array.from(jpegEncoder.getEncodedBuffer());
  } finally {
    jpegEncoder.delete();
  }
}

function syntheticCtSlice(index, pixels, compressedFrame = null) {
  const rows = 64;
  const columns = 64;
  const preamble = new Uint8Array(132);
  preamble.set(encoder.encode("DICM"), 128);
  const metaBody = concat([
    element(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
    element(0x0002, 0x0010, "UI", compressedFrame ? "1.2.840.10008.1.2.4.90" : "1.2.840.10008.1.2.1"),
    element(0x0002, 0x0012, "UI", "1.2.826.0.1.3680043.10.999")
  ]);
  const groupLength = new Uint8Array(4);
  new DataView(groupLength.buffer).setUint32(0, metaBody.length, true);
  return concat([
    preamble,
    element(0x0002, 0x0000, "UL", groupLength),
    metaBody,
    element(0x0008, 0x0060, "CS", "CT"),
    element(0x0010, 0x0010, "PN", "BROWSER_CANARY^PATIENT"),
    element(0x0020, 0x000d, "UI", "1.2.826.0.1.3680043.10.999.7"),
    element(0x0020, 0x000e, "UI", "1.2.826.0.1.3680043.10.999.42"),
    element(0x0020, 0x0013, "IS", String(index + 1)),
    element(0x0020, 0x0032, "DS", `0\\0\\${-20 + index}`),
    element(0x0020, 0x0037, "DS", "1\\0\\0\\0\\1\\0"),
    element(0x0028, 0x0002, "US", 1),
    element(0x0028, 0x0004, "CS", "MONOCHROME2"),
    element(0x0028, 0x0010, "US", rows),
    element(0x0028, 0x0011, "US", columns),
    element(0x0028, 0x0030, "DS", "1\\1"),
    element(0x0028, 0x0100, "US", 16),
    element(0x0028, 0x0101, "US", 12),
    element(0x0028, 0x0102, "US", 11),
    element(0x0028, 0x0103, "US", 0),
    element(0x0028, 0x1052, "DS", "-1024"),
    element(0x0028, 0x1053, "DS", "1"),
    compressedFrame
      ? encapsulatedPixelData(compressedFrame)
      : element(0x7fe0, 0x0010, "OW", pixels)
  ]);
}

async function createSeries() {
  const directory = await mkdtemp(path.join(tmpdir(), "irsim-browser-dicom-"));
  const files = [];
  for (let index = 0; index < 24; index++) {
    const file = path.join(directory, `BROWSER_CANARY_${String(index).padStart(3, "0")}.dcm`);
    const pixels = syntheticStoredPixelBytes(index);
    const compressedFrame = compressedSyntax ? await encodeJpeg2000Lossless(pixels) : null;
    await writeFile(file, syntheticCtSlice(index, pixels, compressedFrame));
    files.push(file);
  }
  return { directory, files };
}

async function fingerprintDicomFiles(files) {
  const aggregate = createHash("sha256");
  let totalBytes = 0;
  for (const file of files) {
    const bytes = await readFile(file);
    totalBytes += bytes.length;
    aggregate.update(`${createHash("sha256").update(bytes).digest("hex")}\n`, "utf8");
  }
  return { totalBytes, dicomContentSha256: aggregate.digest("hex") };
}

async function openSeries() {
  if (!fixtureDir) {
    const generated = await createSeries();
    return { ...generated, owned: true, fingerprint: await fingerprintDicomFiles(generated.files) };
  }
  const files = (await readdir(fixtureDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dcm"))
    .map((entry) => path.join(fixtureDir, entry.name))
    .sort((a, b) => a.localeCompare(b, "en"));
  if (files.length < 3) throw new Error(`Real DICOM fixture contains only ${files.length} .dcm files: ${fixtureDir}`);
  if (fixtureManifest && files.length !== fixtureManifest.download.expectedDicomFiles) {
    throw new Error(
      `Real DICOM fixture contains ${files.length} files; manifest expects ${fixtureManifest.download.expectedDicomFiles}`
    );
  }
  const fingerprint = await fingerprintDicomFiles(files);
  const trackedCompressed = studyBenchmark ? fixtureManifest?.download.jpeg2000Lossless : null;
  if (
    studyBenchmark &&
    (fixtureReport.dicomContentSha256 !== trackedCompressed?.dicomContentSha256 ||
      fixtureReport.dicomBytes !== trackedCompressed?.expectedBytes)
  ) {
    throw new Error("Compressed derivation report does not match the tracked fixture manifest");
  }
  const expectedFingerprint =
    trackedCompressed?.dicomContentSha256 ??
    fixtureReport?.dicomContentSha256 ??
    fixtureManifest?.download.dicomContentSha256 ??
    null;
  if (expectedFingerprint && fingerprint.dicomContentSha256 !== expectedFingerprint) {
    throw new Error(`DICOM fixture content fingerprint changed: ${fingerprint.dicomContentSha256}`);
  }
  if (trackedCompressed && fingerprint.totalBytes !== trackedCompressed.expectedBytes) {
    throw new Error(`DICOM fixture byte count changed: ${fingerprint.totalBytes}`);
  }
  return { directory: fixtureDir, files, owned: false, fingerprint };
}

async function clickButton(cdp, text, stableTimeoutMs = 10_000) {
  const expression = `(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(${JSON.stringify(text)}));
    if (!button || button.disabled) return null;
    button.scrollIntoView({ block: "center", inline: "center" });
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  const target = await waitFor(
    async () => {
      if (!(await evalValue(cdp, expression))) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return evalValue(cdp, expression);
    },
    stableTimeoutMs,
    `stable enabled button ${text}`
  );
  await dispatchPrimaryClick(cdp, target.x, target.y);
}

async function dispatchPrimaryClick(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1
  });
}

async function stableCanvasPixelTarget(cdp, column, row, columns, rows) {
  const expression = `(() => {
    const canvas = document.querySelector(".axial-review canvas");
    if (!canvas) return null;
    canvas.scrollIntoView({ block: "center", inline: "center" });
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + rect.width * (${column + 0.5} / ${columns});
    const y = rect.top + rect.height * (${row + 0.5} / ${rows});
    return document.elementFromPoint(x, y) === canvas ? { x, y } : null;
  })()`;
  return waitFor(
    async () => {
      if (!(await evalValue(cdp, expression))) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return evalValue(cdp, expression);
    },
    5_000,
    "stable source-review canvas target"
  );
}

async function selectCanvasVoxel(cdp, column, row, columns = 64, rows = 64) {
  const target = await stableCanvasPixelTarget(cdp, column, row, columns, rows);
  await dispatchPrimaryClick(cdp, target.x, target.y);
}

async function navigateToSourceSlice(cdp, sliceIndex, totalSlices) {
  const changed = await evalValue(
    cdp,
    `(() => {
      const input = document.querySelector(".axial-slice-control input[type=range]");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, String(${sliceIndex}));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`
  );
  if (!changed) throw new Error("Unable to navigate to a required source slice");
  await waitFor(
    () => evalValue(
      cdp,
      `document.querySelector(".axial-slice-control span")?.textContent?.replace(/\\s+/g, " ").trim() === "Source slice ${sliceIndex + 1} / ${totalSlices}" && document.querySelector(".axial-canvas-shell")?.dataset.state === "ready"`
    ),
    10_000,
    `source slice ${sliceIndex + 1}`
  );
}

async function reviewRequiredCheckpoints(cdp, captureDirectory = null) {
  const initial = await evalValue(
    cdp,
    `(() => {
      const buttons = [...document.querySelectorAll(".review-checkpoints button[data-slice-index]")];
      const orthogonal = [...document.querySelectorAll(".review-checkpoints button[data-orthogonal-plane]")];
      return {
        total: buttons.length,
        reviewed: buttons.filter((button) => button.dataset.reviewed === "true").length,
        orthogonalTotal: orthogonal.length,
        orthogonalReviewed: orthogonal.filter((button) => button.dataset.reviewed === "true").length
      };
    })()`
  );
  if (initial.total < 2) throw new Error(`Expected multiple source-image checkpoints; found ${initial.total}`);
  if (initial.orthogonalTotal !== 2) {
    throw new Error(`Expected two orthogonal source-image checkpoints; found ${initial.orthogonalTotal}`);
  }
  for (let attempt = 0; attempt < initial.total + 2; attempt++) {
    const next = await evalValue(
      cdp,
      `(() => {
        const buttons = [...document.querySelectorAll(".review-checkpoints button[data-slice-index]")];
        const pending = buttons.find((button) => button.dataset.reviewed !== "true");
        if (!pending) return null;
        const sliceIndex = Number(pending.dataset.sliceIndex);
        pending.click();
        return sliceIndex;
      })()`
    );
    if (next === null) break;
    await waitFor(
      () => evalValue(
        cdp,
        `document.querySelector('.review-checkpoints button[data-slice-index="${next}"]')?.dataset.reviewed === "true"`
      ),
      10_000,
      `rendered checkpoint slice ${next + 1}`
    );
  }
  let orthogonalGateObserved = false;
  if (initial.orthogonalReviewed < initial.orthogonalTotal) {
    const axialOnlyGate = await evalValue(
      cdp,
      `(() => ({
        approvalDisabled: Boolean(document.querySelector(".dicom-approval input")?.disabled),
        loadDisabled: Boolean([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Load reviewed anatomy"))?.disabled)
      }))()`
    );
    if (!axialOnlyGate.approvalDisabled || !axialOnlyGate.loadDisabled) {
      throw new Error(`Acquisition-only review bypassed the patient-MPR checkpoint gate: ${JSON.stringify(axialOnlyGate)}`);
    }
    orthogonalGateObserved = true;
  }
  for (let attempt = 0; attempt < initial.orthogonalTotal + 1; attempt++) {
    const next = await evalValue(
      cdp,
      `(() => {
        const buttons = [...document.querySelectorAll(".review-checkpoints button[data-orthogonal-plane]")];
        const pending = buttons.find((button) => button.dataset.reviewed !== "true");
        if (!pending) return null;
        const plane = pending.dataset.orthogonalPlane;
        const planeIndex = Number(pending.dataset.planeIndex);
        pending.click();
        return { plane, planeIndex };
      })()`
    );
    if (next === null) break;
    await waitFor(
      () =>
        evalValue(
          cdp,
          `document.querySelector('.review-checkpoints button[data-orthogonal-plane="${next.plane}"][data-plane-index="${next.planeIndex}"]')?.dataset.reviewed === "true"`
        ),
      10_000,
      `rendered ${next.plane} checkpoint ${next.planeIndex + 1}`
    );
  }
  const completed = await evalValue(
    cdp,
    `(() => {
      const buttons = [...document.querySelectorAll(".review-checkpoints button[data-slice-index]")];
      const orthogonal = [...document.querySelectorAll(".review-checkpoints button[data-orthogonal-plane]")];
      return {
        total: buttons.length,
        reviewed: buttons.filter((button) => button.dataset.reviewed === "true").length,
        orthogonalTotal: orthogonal.length,
        orthogonalReviewed: orthogonal.filter((button) => button.dataset.reviewed === "true").length,
        text: document.querySelector(".review-checkpoints")?.textContent?.replace(/\\s+/g, " ").trim() ?? ""
      };
    })()`
  );
  if (
    completed.reviewed !== completed.total ||
    completed.orthogonalReviewed !== completed.orthogonalTotal
  ) {
    throw new Error(`Source-image checkpoint review remained incomplete: ${JSON.stringify(completed)}`);
  }
  const artifacts = [];
  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true });
    const slices = await evalValue(
      cdp,
      `[...document.querySelectorAll(".review-checkpoints button[data-slice-index]")].map((button) => Number(button.dataset.sliceIndex))`
    );
    for (const sliceIndex of slices) {
      await evalValue(
        cdp,
        `(() => { document.querySelector('.review-checkpoints button[data-slice-index="${sliceIndex}"]')?.click(); return true; })()`
      );
      await waitFor(
        () => evalValue(
          cdp,
          `document.querySelector(".axial-slice-control b")?.textContent?.trim() === "${sliceIndex + 1}" && document.querySelector(".axial-canvas-shell")?.dataset.state === "ready"`
        ),
        10_000,
        `capturable checkpoint slice ${sliceIndex + 1}`
      );
      const imageDataUrl = await evalValue(
        cdp,
        `document.querySelector(".axial-review canvas")?.toDataURL("image/png") ?? ""`
      );
      const prefix = "data:image/png;base64,";
      if (!imageDataUrl.startsWith(prefix)) throw new Error(`Unable to capture checkpoint slice ${sliceIndex + 1}`);
      const bytes = Buffer.from(imageDataUrl.slice(prefix.length), "base64");
      const name = `source-slice-${String(sliceIndex + 1).padStart(4, "0")}.png`;
      await writeFile(path.join(captureDirectory, name), bytes);
      artifacts.push({
        sourceSliceNumber: sliceIndex + 1,
        file: name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex")
      });
    }
  }
  await clickButton(cdp, "Axial source");
  await waitFor(
    () =>
      evalValue(
        cdp,
        `document.querySelector(".axial-slice-control span")?.textContent?.trim().startsWith("Source slice") && document.querySelector(".axial-canvas-shell")?.dataset.state === "ready"`
      ),
    10_000,
    "return to axial review after checkpoint set"
  );
  return { ...completed, orthogonalGateObserved, artifacts };
}

async function exercisePatientMprReview(cdp, seed, dimensions, captureDirectory) {
  await mkdir(captureDirectory, { recursive: true });
  const planeSpecs = [
    {
      button: "Patient coronal",
      label: "Anterior → posterior plane",
      file: "patient-coronal-seed.png",
      orientation: { top: "H", bottom: "F", left: "R", right: "L" }
    },
    {
      button: "Patient sagittal",
      label: "Right → left plane",
      file: "patient-sagittal-seed.png",
      orientation: { top: "H", bottom: "F", left: "A", right: "P" }
    }
  ];
  const evidence = [];
  for (const plane of planeSpecs) {
    await clickButton(cdp, plane.button);
    await wait(100);
    await waitFor(
      () =>
        evalValue(
          cdp,
          `document.querySelector(".axial-slice-control span")?.textContent?.replace(/\\s+/g, " ").trim().startsWith(${JSON.stringify(plane.label)}) && document.querySelector(".axial-canvas-shell")?.dataset.state === "ready"`
        ),
      15_000,
      `${plane.button} seed plane`
    );
    const frame = await evalValue(
      cdp,
      `(() => {
        const canvas = document.querySelector(".axial-review canvas");
        const context = canvas?.getContext("2d", { willReadFrequently: true });
        if (!canvas || !context) return null;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let cyanCount = 0;
        const orangeRows = new Map();
        const orangeColumns = new Map();
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const red = pixels[offset];
          const green = pixels[offset + 1];
          const blue = pixels[offset + 2];
          const pixel = offset / 4;
          const column = pixel % canvas.width;
          const row = Math.floor(pixel / canvas.width);
          if (blue >= 150 && green >= red + 35 && blue >= red + 35) cyanCount++;
          if (red === 255 && green === 184 && blue === 0) {
            orangeRows.set(row, (orangeRows.get(row) ?? 0) + 1);
            orangeColumns.set(column, (orangeColumns.get(column) ?? 0) + 1);
          }
        }
        const mostFrequent = (counts) => [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
        return {
          width: canvas.width,
          height: canvas.height,
          cyanCount,
          markerRow: mostFrequent(orangeRows),
          markerColumn: mostFrequent(orangeColumns),
          displayedPlane: document.querySelector(".axial-slice-control span")?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
          orientation: Object.fromEntries(
            [...document.querySelectorAll(".mpr-orientation")].map((label) => [
              [...label.classList].find((name) => ["top", "bottom", "left", "right"].includes(name)),
              label.textContent?.trim()
            ])
          )
        };
      })()`
    );
    if (
      !frame ||
      frame.width < 2 ||
      frame.width > 2048 ||
      frame.height < 2 ||
      frame.height > 2048 ||
      frame.cyanCount < 1 ||
      frame.markerRow === null ||
      frame.markerColumn === null
    ) {
      throw new Error(`Unreviewable ${plane.button}: ${JSON.stringify(frame)}`);
    }
    if (JSON.stringify(frame.orientation) !== JSON.stringify(plane.orientation)) {
      throw new Error(`Incorrect ${plane.button} patient orientation: ${JSON.stringify(frame.orientation)}`);
    }
    const target = await stableCanvasPixelTarget(
      cdp,
      frame.markerColumn,
      frame.markerRow,
      frame.width,
      frame.height
    );
    await dispatchPrimaryClick(cdp, target.x, target.y);
    const expectedSelection =
      `Selected seed: slice ${seed.sliceIndex + 1}, row ${seed.row}, column ${seed.column}`;
    await waitFor(
      async () => {
        const text = await evalValue(
          cdp,
          `document.querySelector(".selected-seed-status")?.textContent?.replace(/\\s+/g, " ").trim() ?? ""`
        );
        return text === expectedSelection ? text : null;
      },
      5_000,
      `${plane.button} canonical voxel mapping`
    );
    const imageDataUrl = await evalValue(
      cdp,
      `document.querySelector(".axial-review canvas")?.toDataURL("image/png") ?? ""`
    );
    const prefix = "data:image/png;base64,";
    if (!imageDataUrl.startsWith(prefix)) throw new Error(`Unable to capture ${plane.button}`);
    const bytes = Buffer.from(imageDataUrl.slice(prefix.length), "base64");
    await writeFile(path.join(captureDirectory, plane.file), bytes);
    evidence.push({
      plane: plane.button,
      ...frame,
      mappedSourceVoxel: { ...seed },
      file: plane.file,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  await clickButton(cdp, "Axial source");
  await waitFor(
    () =>
      evalValue(
        cdp,
        `document.querySelector(".axial-slice-control span")?.textContent?.replace(/\\s+/g, " ").trim() === "Source slice ${seed.sliceIndex + 1} / ${dimensions[2]}" && document.querySelector(".axial-canvas-shell")?.dataset.state === "ready"`
      ),
    10_000,
    "return to axial source plane"
  );
  return { canonicalVoxelMappingPassed: true, patientAxes: true, artifacts: evidence };
}

async function exerciseTrimUndo(cdp, seedSliceIndex, originalSamples) {
  const boundary = await evalValue(
    cdp,
    `(() => {
      const slices = [...document.querySelectorAll(".review-checkpoints button[data-slice-index]")]
        .map((button) => Number(button.dataset.sliceIndex))
        .filter((sliceIndex) => sliceIndex < ${seedSliceIndex})
        .sort((a, b) => a - b);
      return slices[1] ?? null;
    })()`
  );
  if (boundary === null) throw new Error("No safe pre-seed checkpoint was available for the trim acceptance exercise");
  await evalValue(
    cdp,
    `(() => { document.querySelector('.review-checkpoints button[data-slice-index="${boundary}"]')?.click(); return true; })()`
  );
  await waitFor(
    () => evalValue(
      cdp,
      `document.querySelector(".axial-slice-control b")?.textContent?.trim() === "${boundary + 1}" && document.querySelector(".axial-canvas-shell")?.dataset.state === "ready"`
    ),
    10_000,
    `trim boundary slice ${boundary + 1}`
  );
  await waitFor(
    () =>
      evalValue(
        cdp,
        `document.querySelector(".trim-before-slice") instanceof HTMLButtonElement && !document.querySelector(".trim-before-slice").disabled`
      ),
    10_000,
    `enabled pre-seed trim on tracked slice ${boundary + 1}`
  );
  await clickButton(cdp, "Keep from this slice");
  await waitFor(
    () => evalValue(
      cdp,
      `document.querySelector(".segmentation-edit-history")?.textContent?.includes("discarded tracked samples before") && Number.parseInt(document.querySelector(".dicom-result-head b")?.textContent ?? "", 10) < ${originalSamples}`
    ),
    10_000,
    "trimmed endpoint result"
  );
  const trimmed = await evalValue(
    cdp,
    `(() => ({
      samples: Number.parseInt(document.querySelector(".dicom-result-head b")?.textContent ?? "", 10),
      approvalDisabled: Boolean(document.querySelector(".dicom-approval input")?.disabled),
      approvalChecked: Boolean(document.querySelector(".dicom-approval input")?.checked),
      loadDisabled: Boolean([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Load reviewed anatomy"))?.disabled),
      history: document.querySelector(".segmentation-edit-history")?.textContent?.replace(/\\s+/g, " ").trim() ?? ""
    }))()`
  );
  if (!trimmed.approvalDisabled || trimmed.approvalChecked || !trimmed.loadDisabled) {
    throw new Error(`Trim did not invalidate checkpoint review and attestation: ${JSON.stringify(trimmed)}`);
  }
  const trimmedCheckpointReview = await reviewRequiredCheckpoints(cdp);
  const trimmedReady = await evalValue(
    cdp,
    `(() => ({ approvalDisabled: Boolean(document.querySelector(".dicom-approval input")?.disabled), loadDisabled: Boolean([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Load reviewed anatomy"))?.disabled) }))()`
  );
  if (trimmedReady.approvalDisabled || !trimmedReady.loadDisabled) {
    throw new Error("Trimmed revision bypassed or failed the separate attestation gate");
  }
  await clickButton(cdp, "Undo last edit");
  await waitFor(
    () => evalValue(
      cdp,
      `Number.parseInt(document.querySelector(".dicom-result-head b")?.textContent ?? "", 10) === ${originalSamples} && document.querySelector(".segmentation-edit-history")?.textContent?.includes("Revision 2")`
    ),
    10_000,
    "trim undo restoration"
  );
  const restored = await evalValue(
    cdp,
    `(() => ({ approvalDisabled: Boolean(document.querySelector(".dicom-approval input")?.disabled), approvalChecked: Boolean(document.querySelector(".dicom-approval input")?.checked), loadDisabled: Boolean([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Load reviewed anatomy"))?.disabled) }))()`
  );
  if (!restored.approvalDisabled || restored.approvalChecked || !restored.loadDisabled) {
    throw new Error(`Trim undo did not require renewed review: ${JSON.stringify(restored)}`);
  }
  const restoredCheckpointReview = await reviewRequiredCheckpoints(cdp);
  return {
    boundarySourceSliceNumber: boundary + 1,
    originalSamples,
    trimmedSamples: trimmed.samples,
    trimHistory: trimmed.history,
    trimmedCheckpointReview,
    restoredCheckpointReview
  };
}

async function exerciseBrushUndo(cdp, totalSlices, originalSamples) {
  const center = { sliceIndex: 12, row: 35, column: 39 };
  await navigateToSourceSlice(cdp, center.sliceIndex, totalSlices);
  await selectCanvasVoxel(cdp, center.column, center.row, 64, 64);
  const radiusChanged = await evalValue(
    cdp,
    `(() => {
      const input = document.querySelector("input.brush-radius-mm");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`
  );
  if (!radiusChanged) throw new Error("Unable to configure the physical 3D brush radius");
  await waitFor(
    () => evalValue(cdp, `!document.querySelector("button.add-segmentation-brush")?.disabled`),
    5_000,
    "enabled 3D add brush"
  );
  await clickButton(cdp, "Add 3D brush");
  await waitFor(
    () =>
      evalValue(
        cdp,
        `document.querySelector(".segmentation-edit-history")?.textContent?.includes("Revision 1") && document.querySelector(".segmentation-edit-history")?.textContent?.includes("added 1.0 mm 3D brush") && document.querySelector("#topology-review-title")?.textContent?.includes("passed") && document.querySelector(".axial-canvas-shell")?.dataset.state === "ready"`
      ),
    10_000,
    "topology-passing 3D brush revision"
  );
  await waitFor(
    () =>
      evalValue(
        cdp,
        `(() => {
          const canvas = document.querySelector(".axial-review canvas");
          const pixel = canvas?.getContext("2d", { willReadFrequently: true })?.getImageData(40, 35, 1, 1).data;
          return Boolean(pixel && pixel[2] > pixel[0]);
        })()`
      ),
    10_000,
    "edited 3D brush overlay voxel"
  );
  const brushed = await evalValue(
    cdp,
    `(() => {
      const canvas = document.querySelector(".axial-review canvas");
      const pixel = canvas?.getContext("2d", { willReadFrequently: true })?.getImageData(40, 35, 1, 1).data;
      return {
        samples: Number.parseInt(document.querySelector(".dicom-result-head b")?.textContent ?? "", 10),
        overlayAtAddedVoxel: Boolean(pixel && pixel[2] > pixel[0]),
        approvalDisabled: Boolean(document.querySelector(".dicom-approval input")?.disabled),
        loadDisabled: Boolean([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Load reviewed anatomy"))?.disabled),
        history: document.querySelector(".segmentation-edit-history")?.textContent?.replace(/\\s+/g, " ").trim() ?? ""
      };
    })()`
  );
  if (
    brushed.samples !== originalSamples ||
    !brushed.overlayAtAddedVoxel ||
    !brushed.approvalDisabled ||
    !brushed.loadDisabled
  ) {
    throw new Error(`3D brush did not update the reviewed overlay and invalidate review: ${JSON.stringify(brushed)}`);
  }
  const brushedCheckpointReview = await reviewRequiredCheckpoints(cdp);
  await clickButton(cdp, "Undo last edit");
  await waitFor(
    () =>
      evalValue(
        cdp,
        `document.querySelector(".segmentation-edit-history")?.textContent?.includes("Revision 2") && document.querySelector("#topology-review-title")?.textContent?.includes("passed")`
      ),
    10_000,
    "exact brush undo revision"
  );
  const restored = await evalValue(
    cdp,
    `(() => ({
      samples: Number.parseInt(document.querySelector(".dicom-result-head b")?.textContent ?? "", 10),
      approvalDisabled: Boolean(document.querySelector(".dicom-approval input")?.disabled),
      loadDisabled: Boolean([...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Load reviewed anatomy"))?.disabled)
    }))()`
  );
  if (restored.samples !== originalSamples || !restored.approvalDisabled || !restored.loadDisabled) {
    throw new Error(`3D brush undo did not restore samples and renew review: ${JSON.stringify(restored)}`);
  }
  const restoredCheckpointReview = await reviewRequiredCheckpoints(cdp);
  return {
    center: { sourceSliceNumber: center.sliceIndex + 1, row: center.row, column: center.column },
    radiusMm: 1,
    originalSamples,
    history: brushed.history,
    overlayAtAddedVoxel: brushed.overlayAtAddedVoxel,
    brushedCheckpointReview,
    restoredCheckpointReview
  };
}

async function screenshot(cdp, filename) {
  const image = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(filename, Buffer.from(image.data, "base64"));
}

function emptyHeapMaximum() {
  return { usedSize: 0, totalSize: 0, embedderHeapUsedSize: 0, backingStorageSize: 0 };
}

function mergeHeapMaximum(maximum, sample) {
  for (const key of Object.keys(maximum)) maximum[key] = Math.max(maximum[key], sample[key] ?? 0);
}

function startStudyMemorySampler(cdp) {
  const startedAt = performance.now();
  let active = true;
  let firstWorkerAttachedAtMs = null;
  const evidence = {
    method: "Chrome DevTools Protocol Runtime.getHeapUsage sampled from the page and auto-attached dedicated worker; maxima are sampled observations, not exact peaks.",
    samplingIntervalMs: 100,
    successfulSamples: 0,
    samplingErrors: 0,
    maximumAttachedWorkers: 0,
    pageMaximum: emptyHeapMaximum(),
    workerMaximum: emptyHeapMaximum(),
    milestones: []
  };

  const sample = async (milestone = null) => {
    const workers = cdp.workerSessions();
    evidence.maximumAttachedWorkers = Math.max(evidence.maximumAttachedWorkers, workers.size);
    if (workers.size > 0 && firstWorkerAttachedAtMs === null) {
      firstWorkerAttachedAtMs = performance.now() - startedAt;
    }
    const requests = [
      { kind: "page", promise: cdp.send("Runtime.getHeapUsage") },
      ...[...workers.keys()].map((sessionId) => ({
        kind: "worker",
        promise: cdp.send("Runtime.getHeapUsage", {}, sessionId)
      }))
    ];
    const settled = await Promise.allSettled(requests.map((request) => request.promise));
    const snapshot = { atMs: performance.now() - startedAt, milestone, attachedWorkers: workers.size };
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        evidence.samplingErrors++;
        return;
      }
      evidence.successfulSamples++;
      const kind = requests[index].kind;
      mergeHeapMaximum(kind === "page" ? evidence.pageMaximum : evidence.workerMaximum, result.value);
      if (milestone) snapshot[kind] = result.value;
    });
    if (milestone) evidence.milestones.push(snapshot);
  };

  const loop = (async () => {
    while (active) {
      await sample();
      if (active) await wait(evidence.samplingIntervalMs);
    }
  })();

  return {
    evidence,
    startedAt,
    sample,
    async stop() {
      active = false;
      await loop;
      evidence.firstWorkerAttachedAtMs = firstWorkerAttachedAtMs;
    }
  };
}

let browser;
let cdp;
let userDataDir;
let seriesDirectory;
let seriesDirectoryOwned = false;
let studyMemorySampler = null;
let benchmarkTimings = null;
try {
  const series = await openSeries();
  seriesDirectory = series.directory;
  seriesDirectoryOwned = series.owned;
  ({ browser, cdp, userDataDir } = await launchChrome());
  if (studyBenchmark) studyMemorySampler = startStudyMemorySampler(cdp);
  await waitFor(() => evalValue(cdp, "document.readyState === 'complete' && Boolean(document.body)"), 30_000, "app shell");
  await clickButton(cdp, "Import local DICOM CT");
  await waitFor(() => evalValue(cdp, "Boolean(document.querySelector('.dicom-picker input[type=file]'))"), 10_000, "DICOM file picker");

  const documentNode = await cdp.send("DOM.getDocument", { depth: -1 });
  const fileInput = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: ".dicom-picker input[type=file]"
  });
  if (!fileInput.nodeId) throw new Error("DICOM file input node was not found");
  const importEventIndex = cdp.events.length;
  if (studyBenchmark) {
    benchmarkTimings = { importStartedAtEpochMs: Date.now() };
    await studyMemorySampler.sample("before-file-selection");
    benchmarkTimings.importStartedAt = performance.now();
  }
  await cdp.send("DOM.setFileInputFiles", { nodeId: fileInput.nodeId, files: series.files });

  // Harness patience only (NOT a gated SLO): the benchmark decodes a 538-slice JPEG 2000 Lossless
  // study in the browser worker, which on slower hardware exceeds the 30 s that native/single-slice
  // paths need. The measured first-reviewable-frame time is recorded below as a sampled observation;
  // this wait just bounds how long the harness sits before giving up.
  await waitFor(
    () => evalValue(cdp, "document.body.innerText.includes('Confirm the intended vascular trunk')"),
    studyBenchmark ? 240_000 : 30_000,
    "axial source review"
  );
  await waitFor(
    () => evalValue(cdp, "document.querySelector('.axial-canvas-shell')?.dataset.state === 'ready'"),
    10_000,
    "initial axial source frame"
  );
  if (studyBenchmark) {
    benchmarkTimings.firstReviewableFrameMs = performance.now() - benchmarkTimings.importStartedAt;
    await studyMemorySampler.sample("first-reviewable-source-frame");
  }
  const proposalGate = await evalValue(
    cdp,
    `(() => { const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy")); return { disabled: button?.disabled, text: document.body.innerText, canvas: Boolean(document.querySelector(".axial-review canvas")) }; })()`
  );
  if (!proposalGate.disabled || !proposalGate.canvas) throw new Error("Automatic proposal bypassed the review gate");
  if (proposalGate.text.includes("BROWSER_CANARY")) throw new Error("DICOM identifier canary reached the DOM");

  if (fixtureDir) {
    const review = await evalValue(
      cdp,
      `(() => {
        const canvas = document.querySelector(".axial-review canvas");
        const context = canvas?.getContext("2d", { willReadFrequently: true });
        const pixels = canvas && context ? context.getImageData(0, 0, canvas.width, canvas.height).data : null;
        let cyanCount = 0;
        let minColumn = Infinity;
        let maxColumn = -Infinity;
        let minRow = Infinity;
        let maxRow = -Infinity;
        if (pixels) {
          for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index];
            const green = pixels[index + 1];
            const blue = pixels[index + 2];
            if (blue < 150 || green < red + 35 || blue < red + 35) continue;
            const pixel = index / 4;
            const column = pixel % canvas.width;
            const row = Math.floor(pixel / canvas.width);
            cyanCount++;
            minColumn = Math.min(minColumn, column);
            maxColumn = Math.max(maxColumn, column);
            minRow = Math.min(minRow, row);
            maxRow = Math.max(maxRow, row);
          }
        }
        const sliceText = document.querySelector(".axial-slice-control span")?.textContent ?? "";
        return {
          width: canvas?.width ?? 0,
          height: canvas?.height ?? 0,
          cyanCount,
          cyanBounds: cyanCount ? { minColumn, maxColumn, minRow, maxRow } : null,
          sliceText,
          state: document.querySelector(".review-state")?.textContent?.trim() ?? "",
          bodyText: document.body.innerText
        };
      })()`
    );
    const expected = fixtureManifest?.expected;
    const expectedDimensions = expected?.dimensions ?? [512, 512, series.files.length];
    if (review.width !== expectedDimensions[0] || review.height !== expectedDimensions[1]) {
      throw new Error(
        `Real fixture rendered ${review.width}x${review.height}; expected ${expectedDimensions[0]}x${expectedDimensions[1]}`
      );
    }
    if (!review.bodyText.includes(expectedDimensions.join(" × "))) {
      throw new Error(`Real fixture summary did not report the expected ${expectedDimensions.join("x")} volume`);
    }
    if (review.state !== "Automatic proposal" || review.cyanCount < 20 || !review.cyanBounds) {
      throw new Error(`Real fixture did not produce a reviewable automatic overlay: ${JSON.stringify(review)}`);
    }
    if (expected) {
      if (review.sliceText !== `Source slice ${expected.proposalOverlay.sliceNumber} / ${expectedDimensions[2]}`) {
        throw new Error(`Real fixture proposal moved to an unexpected slice: ${review.sliceText}`);
      }
      if (!review.bodyText.includes(expected.displaySpacingText)) {
        throw new Error(`Real fixture spacing changed; expected ${expected.displaySpacingText}`);
      }
      const [minimumCyan, maximumCyan] = expected.proposalOverlay.cyanPixelCount;
      if (review.cyanCount < minimumCyan || review.cyanCount > maximumCyan) {
        throw new Error(`Real fixture overlay area changed: ${review.cyanCount} cyan pixels`);
      }
      for (const key of ["minColumn", "maxColumn", "minRow", "maxRow"]) {
        const [minimum, maximum] = expected.proposalOverlay.cyanBounds[key];
        if (review.cyanBounds[key] < minimum || review.cyanBounds[key] > maximum) {
          throw new Error(`Real fixture overlay ${key} changed: ${review.cyanBounds[key]} not in [${minimum}, ${maximum}]`);
        }
      }
    }
    let seededReview = null;
    if (expected?.seededTrack) {
      const tracked = expected.seededTrack;
      if (tracked.seed.sliceNumber !== expected.proposalOverlay.sliceNumber) {
        const changed = await evalValue(
          cdp,
          `(() => {
            const input = document.querySelector(".axial-slice-control input[type=range]");
            if (!input) return false;
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            setter?.call(input, String(${tracked.seed.sliceNumber - 1}));
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          })()`
        );
        if (!changed) throw new Error("Unable to navigate to the real-fixture reference seed slice");
        await waitFor(
          () => evalValue(
            cdp,
            `document.querySelector(".axial-slice-control span")?.textContent?.replace(/\\s+/g, " ").trim() === "Source slice ${tracked.seed.sliceNumber} / ${expectedDimensions[2]}" && document.querySelector(".axial-canvas-shell")?.dataset.state === "ready"`
          ),
          10_000,
          "real-fixture reference seed slice"
        );
      }
      await selectCanvasVoxel(
        cdp,
        tracked.seed.column,
        tracked.seed.row,
        expectedDimensions[0],
        expectedDimensions[1]
      );
      await waitFor(
        () => evalValue(
          cdp,
          `[...document.querySelectorAll("button")].some((item) => item.textContent?.includes("Track vessel") && !item.disabled)`
        ),
        10_000,
        "enabled real-fixture seed tracker"
      );
      await clickButton(cdp, "Track vessel");
      await waitFor(
        () => evalValue(cdp, "document.querySelector('.dicom-result-head small')?.textContent === 'Seed-confirmed result'"),
        30_000,
        "real-fixture seeded result"
      );
      if (studyBenchmark) {
        benchmarkTimings.seededResultMs = performance.now() - benchmarkTimings.importStartedAt;
        await studyMemorySampler.sample("seeded-result");
      }
      const orthogonalReview = await exercisePatientMprReview(
        cdp,
        {
          sliceIndex: tracked.seed.sliceNumber - 1,
          row: tracked.seed.row,
          column: tracked.seed.column
        },
        expectedDimensions,
        path.join(outDir, "source-reformats")
      );
      if (studyBenchmark) {
        benchmarkTimings.patientMprReviewMs = performance.now() - benchmarkTimings.importStartedAt;
        await studyMemorySampler.sample("patient-mpr-review");
      }
      const checkpointReview = await reviewRequiredCheckpoints(cdp, path.join(outDir, "source-checkpoints"));
      seededReview = await evalValue(
        cdp,
        `(() => {
          const samplesText = document.querySelector(".dicom-result-head b")?.textContent ?? "";
          const terms = [...document.querySelectorAll(".dicom-review dl > div")];
          const coverage = terms.find((item) => item.querySelector("dt")?.textContent === "Path coverage")?.querySelector("dd")?.textContent ?? "";
          const load = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"));
          return {
            centerlineSamples: Number.parseInt(samplesText, 10),
            coveragePercent: Number.parseFloat(coverage),
            topology: document.querySelector("#topology-review-title")?.textContent?.trim() ?? "",
            attestationPresent: Boolean(document.querySelector(".dicom-approval input")),
            attestationDisabled: Boolean(document.querySelector(".dicom-approval input")?.disabled),
            attestationChecked: Boolean(document.querySelector(".dicom-approval input")?.checked),
            loadDisabled: Boolean(load?.disabled)
          };
        })()`
      );
      seededReview.checkpointReview = checkpointReview;
      seededReview.orthogonalReview = orthogonalReview;
      if (seededReview.centerlineSamples < tracked.minimumCenterlineSamples) {
        throw new Error(`Real fixture seeded track is too short: ${seededReview.centerlineSamples} samples`);
      }
      if (
        tracked.maximumCenterlineSamples !== undefined &&
        seededReview.centerlineSamples > tracked.maximumCenterlineSamples
      ) {
        throw new Error(`Real fixture seeded track is too long: ${seededReview.centerlineSamples} samples`);
      }
      if (seededReview.coveragePercent < tracked.minimumCoveragePercent) {
        throw new Error(`Real fixture seeded coverage is too low: ${seededReview.coveragePercent}%`);
      }
      if (
        tracked.maximumCoveragePercent !== undefined &&
        seededReview.coveragePercent > tracked.maximumCoveragePercent
      ) {
        throw new Error(`Real fixture seeded coverage is too high: ${seededReview.coveragePercent}%`);
      }
      if (
        tracked.requiresPassingSingleTrunkTopology &&
        seededReview.topology !== "Single-trunk topology checks passed"
      ) {
        throw new Error(`Real fixture seeded topology did not pass: ${seededReview.topology}`);
      }
      if (
        tracked.requiresCheckpointReview &&
        (checkpointReview.total < 5 || checkpointReview.reviewed !== checkpointReview.total || seededReview.attestationDisabled)
      ) {
        throw new Error(`Real fixture checkpoint review did not complete: ${JSON.stringify(seededReview)}`);
      }
      if (
        tracked.requiresSeparateAttestation &&
        (!seededReview.attestationPresent ||
          seededReview.attestationDisabled ||
          seededReview.attestationChecked ||
          !seededReview.loadDisabled)
      ) {
        throw new Error(`Real fixture bypassed separate attestation: ${JSON.stringify(seededReview)}`);
      }
      seededReview.trimExercise = await exerciseTrimUndo(
        cdp,
        tracked.seed.sliceNumber - 1,
        seededReview.centerlineSamples
      );
    }
    const storage = await evalValue(
      cdp,
      `(async () => ({ local: localStorage.length, session: sessionStorage.length, indexedDb: (await indexedDB.databases()).length, caches: (await caches.keys()).length, serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length }))()`
    );
    const postImportRequests = cdp.events
      .slice(importEventIndex)
      .filter((event) => event.method === "Network.requestWillBeSent")
      .map((event) => ({ url: event.params.request.url, method: event.params.request.method }));
    const appOrigin = new URL(url).origin;
    const prohibitedRequests = postImportRequests.filter(
      (request) => request.method !== "GET" || new URL(request.url).origin !== appOrigin
    );
    if (Object.values(storage).some((count) => count !== 0)) {
      throw new Error(`Browser storage was created: ${JSON.stringify(storage)}`);
    }
    if (prohibitedRequests.length) throw new Error(`Prohibited import traffic: ${JSON.stringify(prohibitedRequests)}`);
    await mkdir(outDir, { recursive: true });
    await screenshot(cdp, path.join(outDir, "browser-real-dicom-smoke.png"));
    let postCloseStorage = null;
    let runtimeEnvironment = null;
    if (studyBenchmark) {
      runtimeEnvironment = {
        chrome: await cdp.send("Browser.getVersion"),
        host: { platform: platform(), release: release(), architecture: arch() }
      };
      await studyMemorySampler.sample("before-session-close");
      // The benchmark deliberately measures the imaging worker WITHOUT loading anatomy into the
      // simulator (it never attests), so the post-load "Close case & clear session" button never
      // exists on this path. The active review dialog is dismissed through its own close control
      // (aria-label "Close DICOM import"), whose handler aborts the controller and disposes the
      // session — the exact worker-termination path this benchmark asserts. Slower hardware may still
      // be re-rendering after the trim/undo exercise, so wait for the control to be present/stable.
      const dialogCloseTarget = await waitFor(
        async () => {
          const expression = `(() => {
            const button = document.querySelector('button[aria-label="Close DICOM import"]');
            if (!button || button.disabled) return null;
            button.scrollIntoView({ block: "center", inline: "center" });
            const rect = button.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          })()`;
          if (!(await evalValue(cdp, expression))) return null;
          await new Promise((resolve) => setTimeout(resolve, 100));
          return evalValue(cdp, expression);
        },
        120_000,
        "stable enabled review-dialog close control"
      );
      await dispatchPrimaryClick(cdp, dialogCloseTarget.x, dialogCloseTarget.y);
      await waitFor(
        () => evalValue(cdp, "document.body.innerText.includes('Built-in public demo')"),
        10_000,
        "public fallback after benchmark"
      );
      // Guard the termination assertion against a vacuous pass: if CDP auto-attach had silently
      // failed, no worker session would ever have been recorded and `size === 0` would be trivially
      // true. Require evidence that the dedicated worker actually attached before proving it left.
      if ((studyMemorySampler.evidence?.maximumAttachedWorkers ?? 0) < 1) {
        throw new Error("Benchmark never observed the dedicated DICOM worker attach; termination check would be vacuous");
      }
      await waitFor(() => cdp.workerSessions().size === 0, 10_000, "dedicated DICOM worker termination");
      await studyMemorySampler.sample("after-worker-termination");
      await studyMemorySampler.stop();
      benchmarkTimings.sessionClosedMs = performance.now() - benchmarkTimings.importStartedAt;
      benchmarkTimings.workerTerminated = true;
      postCloseStorage = await evalValue(
        cdp,
        `(async () => ({ local: localStorage.length, session: sessionStorage.length, indexedDb: (await indexedDB.databases()).length, caches: (await caches.keys()).length, serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length }))()`
      );
      if (Object.values(postCloseStorage).some((count) => count !== 0)) {
        throw new Error(`Browser storage remained after benchmark close: ${JSON.stringify(postCloseStorage)}`);
      }
    }
    const { bodyText: _bodyText, ...reviewEvidence } = review;
    const report = {
      url,
      fixtureId: fixtureManifest?.id ?? null,
      fixtureDir,
      files: series.files.length,
      fixtureFingerprint: series.fingerprint,
      transferSyntax: fixtureReport?.transferSyntax ?? null,
      proposalBlocked: true,
      review: reviewEvidence,
      seededReview,
      storage,
      postImportRequests,
      ...(studyBenchmark
        ? {
            benchmark: {
              scope:
                "Sampled engineering evidence for a deterministic real-pixel-derived 538-slice JPEG 2000 Lossless study in the production browser worker; not a clinical SLO, exact peak, independent-codec, scanner-vendor, or diagnostic-performance claim.",
              timings: benchmarkTimings,
              sampledMemory: studyMemorySampler.evidence,
              runtimeEnvironment,
              postCloseStorage
            }
          }
        : {})
    };
    await writeFile(
      path.join(outDir, studyBenchmark ? "browser-compressed-study-benchmark.json" : "browser-real-dicom-smoke.json"),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report, null, 2));
    console.log("\n[browser-real-dicom] ok");
  } else {
    await selectCanvasVoxel(cdp, 33, 35);
  await waitFor(
    () => evalValue(cdp, `[...document.querySelectorAll("button")].some((item) => item.textContent?.includes("Track vessel") && !item.disabled)`),
    10_000,
    "enabled seed tracker"
  );
  await clickButton(cdp, "Track vessel");
  await waitFor(
    () => evalValue(cdp, "document.querySelector('.dicom-result-head small')?.textContent === 'Seed-confirmed result'"),
    30_000,
    "seeded result"
  );
  const orthogonalReview = await exercisePatientMprReview(
    cdp,
    { sliceIndex: 12, row: 35, column: 33 },
    [64, 64, 24],
    path.join(outDir, "source-reformats")
  );
  const beforeCheckpointReview = await evalValue(
    cdp,
    `(() => ({ approvalDisabled: document.querySelector(".dicom-approval input")?.disabled, loadDisabled: [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"))?.disabled }))()`
  );
  if (!beforeCheckpointReview.approvalDisabled || !beforeCheckpointReview.loadDisabled) {
    throw new Error("Seeded result bypassed source-image checkpoint review");
  }
  const initialCheckpointReview = await reviewRequiredCheckpoints(cdp);
  const beforeApproval = await evalValue(
    cdp,
    `(() => ({ approvalDisabled: document.querySelector(".dicom-approval input")?.disabled, loadDisabled: [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"))?.disabled }))()`
  );
  if (beforeApproval.approvalDisabled || !beforeApproval.loadDisabled) {
    throw new Error("Completed checkpoint review bypassed or failed the separate attestation gate");
  }
  await evalValue(cdp, `document.querySelector(".dicom-approval input").click(); true`);
  await waitFor(
    () => evalValue(cdp, `![...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"))?.disabled`),
    5_000,
    "approved load gate"
  );

  const trimExercise = await exerciseTrimUndo(cdp, 12, 24);
  await evalValue(cdp, `document.querySelector(".dicom-approval input").click(); true`);
  await waitFor(
    () => evalValue(cdp, `![...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"))?.disabled`),
    5_000,
    "post-trim-undo approval gate"
  );

  await navigateToSourceSlice(cdp, 12, 24);
  await selectCanvasVoxel(cdp, 50, 15);
  await waitFor(
    () => evalValue(cdp, `(() => ({ approved: document.querySelector(".dicom-approval input")?.checked, loadDisabled: [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"))?.disabled, replaceEnabled: !document.querySelector("button.replace-slice-component")?.disabled }))()`)
      .then((state) => !state.approved && state.loadDisabled && state.replaceEnabled),
    5_000,
    "edit selection approval invalidation"
  );
  await clickButton(cdp, "Replace selected slice component");
  await waitFor(
    () => evalValue(cdp, "document.body.innerText.includes('Topology review blocks loading')"),
    10_000,
    "topology-blocked edited labelmap"
  );
  const blockedEdit = await evalValue(
    cdp,
    `(() => ({ approvalDisabled: document.querySelector(".dicom-approval input")?.disabled, loadDisabled: [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"))?.disabled, history: document.querySelector(".segmentation-edit-history")?.textContent ?? "" }))()`
  );
  if (!blockedEdit.approvalDisabled || !blockedEdit.loadDisabled || !blockedEdit.history.includes("Revision 3")) {
    throw new Error("A topology-blocked labelmap edit did not fail closed with provenance");
  }
  await clickButton(cdp, "Undo last edit");
  await waitFor(
    () => evalValue(cdp, "document.body.innerText.includes('Single-trunk topology checks passed') && document.querySelector('.segmentation-edit-history')?.textContent.includes('Revision 4')"),
    10_000,
    "topology-restoring undo"
  );
  const restoredEdit = await evalValue(
    cdp,
    `(() => ({ approved: document.querySelector(".dicom-approval input")?.checked, approvalDisabled: document.querySelector(".dicom-approval input")?.disabled, loadDisabled: [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"))?.disabled }))()`
  );
  if (restoredEdit.approved || !restoredEdit.approvalDisabled || !restoredEdit.loadDisabled) {
    throw new Error("Undo restored topology without requiring renewed checkpoint review");
  }
  const postUndoCheckpointReview = await reviewRequiredCheckpoints(cdp);
  await evalValue(cdp, `document.querySelector(".dicom-approval input").click(); true`);
  await waitFor(
    () => evalValue(cdp, `![...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"))?.disabled`),
    5_000,
    "post-undo approval gate"
  );
  await clickButton(cdp, "Re-track entire trunk");
  await waitFor(
    () => evalValue(cdp, `[...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"))?.disabled`),
    5_000,
    "re-track invalidation gate"
  );
  await waitFor(
    () => evalValue(cdp, "document.querySelector('.dicom-result-head small')?.textContent === 'Seed-confirmed result'"),
    30_000,
    "re-tracked result"
  );
  const afterRetrack = await evalValue(
    cdp,
    `(() => ({ approved: document.querySelector(".dicom-approval input")?.checked, disabled: [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"))?.disabled }))()`
  );
  if (afterRetrack.approved || !afterRetrack.disabled) throw new Error("Re-tracking preserved a stale review attestation");
  const retrackCheckpointReview = await reviewRequiredCheckpoints(cdp);
  const brushExercise = await exerciseBrushUndo(cdp, 24, 24);
  await evalValue(cdp, `document.querySelector(".dicom-approval input").click(); true`);
  await waitFor(
    () => evalValue(cdp, `![...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Load reviewed anatomy"))?.disabled`),
    5_000,
    "re-approved load gate"
  );
  await clickButton(cdp, "Load reviewed anatomy");
  await waitFor(() => evalValue(cdp, "document.body.innerText.includes('Local case · session only')"), 10_000, "loaded local case");

  const storage = await evalValue(
    cdp,
    `(async () => ({ local: localStorage.length, session: sessionStorage.length, indexedDb: (await indexedDB.databases()).length, caches: (await caches.keys()).length, serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length }))()`
  );
  const postImportRequests = cdp.events
    .slice(importEventIndex)
    .filter((event) => event.method === "Network.requestWillBeSent")
    .map((event) => ({ url: event.params.request.url, method: event.params.request.method }));
  const appOrigin = new URL(url).origin;
  const prohibitedRequests = postImportRequests.filter(
    (request) => request.method !== "GET" || new URL(request.url).origin !== appOrigin
  );
  const codecRequests = postImportRequests.filter((request) => /openjpeg/i.test(request.url));
  if (Object.values(storage).some((count) => count !== 0)) throw new Error(`Browser storage was created: ${JSON.stringify(storage)}`);
  if (prohibitedRequests.length) throw new Error(`Prohibited import traffic: ${JSON.stringify(prohibitedRequests)}`);
  if (codecRequests.some((request) => /\.wasm(?:$|[?#])/i.test(request.url))) {
    throw new Error(`JPEG 2000 import made an unexpected WASM fetch: ${JSON.stringify(codecRequests)}`);
  }

  await clickButton(cdp, "Close case & clear session");
  await waitFor(() => evalValue(cdp, "document.body.innerText.includes('Built-in public demo')"), 10_000, "public fallback");
  await mkdir(outDir, { recursive: true });
  await screenshot(cdp, path.join(outDir, "browser-dicom-smoke.png"));
  const report = {
    url,
    transferSyntax: compressedSyntax ? "JPEG 2000 Lossless" : "Explicit VR Little Endian",
    files: series.files.length,
    proposalBlocked: true,
    checkpointReviewRequired: true,
    checkpointReviews: {
      initial: initialCheckpointReview,
      trim: trimExercise.trimmedCheckpointReview,
      trimUndo: trimExercise.restoredCheckpointReview,
      topologyUndo: postUndoCheckpointReview,
      retrack: retrackCheckpointReview,
      brush: brushExercise.brushedCheckpointReview,
      brushUndo: brushExercise.restoredCheckpointReview
    },
    endpointTrimAppliedAndUndone: true,
    trimExercise,
    brushExercise,
    physicalBrushAppliedAndUndone: true,
    orthogonalReview,
    attestationRequired: true,
    editInvalidatesApproval: true,
    topologyEditBlocked: true,
    undoRestoresTopology: true,
    retrackInvalidatesApproval: true,
    storage,
    postImportRequests,
    codecRequests,
    returnedToPublicDemo: true
  };
  await writeFile(path.join(outDir, "browser-dicom-smoke.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log("\n[browser-dicom] ok");
  }
} catch (cause) {
  await mkdir(outDir, { recursive: true });
  const diagnostics = cdp
    ? await evalValue(
        cdp,
        `(() => ({ bodyText: document.body?.innerText ?? "", html: document.querySelector(".dicom-dialog")?.outerHTML?.slice(0, 20000) ?? "" }))()`
      ).catch(() => null)
    : null;
  if (cdp) await screenshot(cdp, path.join(outDir, "browser-dicom-failure.png")).catch(() => undefined);
  await writeFile(
    path.join(outDir, "browser-dicom-failure.json"),
    JSON.stringify({ error: cause instanceof Error ? cause.stack : String(cause), diagnostics, events: cdp?.events.slice(-100) }, null, 2)
  );
  throw cause;
} finally {
  await studyMemorySampler?.stop().catch(() => undefined);
  cdp?.close();
  browser?.kill();
  await wait(250);
  await removeDirBestEffort(userDataDir);
  if (seriesDirectoryOwned) await removeDirBestEffort(seriesDirectory);
}
