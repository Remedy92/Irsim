import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

const manifestPath = path.resolve(
  args.get("manifest") ?? "fixtures/real-dicom/jpeg2000-ct-interoperability.json"
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const targetDir = path.resolve(
  args.get("out") ?? path.join("output", "fixtures", "jpeg2000-ct-interoperability")
);
const MAX_FIXTURE_DOWNLOAD_BYTES = 64 * 1024 * 1024;

const outputNames = new Set();
for (const entry of manifest.downloads ?? []) {
  if (
    typeof entry.outputName !== "string" ||
    !entry.outputName ||
    path.basename(entry.outputName) !== entry.outputName ||
    outputNames.has(entry.outputName)
  ) {
    throw new Error("Fixture manifest contains an unsafe or duplicate output filename");
  }
  if (
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes <= 0 ||
    entry.bytes > MAX_FIXTURE_DOWNLOAD_BYTES ||
    !/^[0-9a-f]{64}$/.test(entry.sha256)
  ) {
    throw new Error(`Fixture manifest contains invalid content bounds for ${entry.outputName}`);
  }
  let downloadUrl;
  try {
    downloadUrl = new URL(entry.url);
  } catch {
    throw new Error(`Fixture manifest contains an invalid URL for ${entry.outputName}`);
  }
  if (downloadUrl.protocol !== "https:") {
    throw new Error(`Fixture manifest requires HTTPS for ${entry.outputName}`);
  }
  outputNames.add(entry.outputName);
}
if (outputNames.size === 0) throw new Error("Fixture manifest contains no downloads");

if (targetDir === path.resolve(".") || targetDir === path.parse(targetDir).root) {
  throw new Error(`Refusing unsafe fixture output directory: ${targetDir}`);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readExactResponseBytes(response, expectedBytes) {
  if (!response.body) throw new Error("Fixture download returned no response body");
  const output = new Uint8Array(expectedBytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > expectedBytes) {
        await reader.cancel();
        throw new Error("Fixture download exceeded its pinned byte length");
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedBytes) throw new Error("Fixture download did not match its pinned byte length");
  return output;
}

async function isCurrent(directory) {
  try {
    for (const entry of manifest.downloads) {
      const filename = path.join(directory, entry.outputName);
      const metadata = await stat(filename);
      if (!metadata.isFile() || metadata.size !== entry.bytes) return false;
      if (sha256(await readFile(filename)) !== entry.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function assertReplaceableTarget(directory) {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Refusing to replace a non-directory fixture target: ${directory}`);
    }
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return;
    throw cause;
  }

  let marker;
  try {
    marker = JSON.parse(await readFile(path.join(directory, ".irsim-fixture.json"), "utf8"));
  } catch {
    throw new Error(`Refusing to replace an unrecognized fixture directory: ${directory}`);
  }
  if (marker.fixtureId !== manifest.id) {
    throw new Error(`Refusing to replace a different fixture directory: ${directory}`);
  }
}

if (await isCurrent(targetDir)) {
  console.log(`[jpeg2000-ct-fixture] verified existing ${manifest.id}`);
  console.log(targetDir);
  process.exit(0);
}

if (!args.has("accept-license")) {
  console.error("[jpeg2000-ct-fixture] download requires explicit license acceptance");
  console.error(`${manifest.license.name}: ${manifest.license.url}`);
  console.error(manifest.license.scopeNote);
  console.error("Re-run with --accept-license after reviewing those terms and the provenance limits.");
  process.exit(2);
}

await assertReplaceableTarget(targetDir);

const parent = path.dirname(targetDir);
await mkdir(parent, { recursive: true });
const temporary = await mkdtemp(path.join(parent, ".jpeg2000-ct-"));

try {
  for (const entry of manifest.downloads) {
    const response = await fetch(entry.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`Fixture download failed with HTTP ${response.status}`);
    const bytes = await readExactResponseBytes(response, entry.bytes);
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`Fixture content verification failed for ${entry.outputName}`);
    }
    await writeFile(path.join(temporary, entry.outputName), bytes);
  }

  await writeFile(
    path.join(temporary, ".irsim-fixture.json"),
    `${JSON.stringify(
      {
        fixtureId: manifest.id,
        source: manifest.source.dataRepository,
        sourceCommit: manifest.source.dataCommit,
        license: manifest.license.url,
        files: manifest.downloads.map(({ outputName, bytes, sha256 }) => ({ outputName, bytes, sha256 }))
      },
      null,
      2
    )}\n`
  );
  await rm(targetDir, { recursive: true, force: true });
  await rename(temporary, targetDir);
  console.log(`[jpeg2000-ct-fixture] fetched and verified ${manifest.id}`);
  console.log(targetDir);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
