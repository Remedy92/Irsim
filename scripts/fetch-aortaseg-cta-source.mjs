import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
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
  args.get("manifest") ?? "fixtures/real-dicom/aortaseg60-young05-source.json"
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const targetDir = path.resolve(
  args.get("out") ?? path.join("output", "fixtures", "aortaseg60-young05-source")
);

if (targetDir === path.resolve(".") || targetDir === path.parse(targetDir).root) {
  throw new Error(`Refusing unsafe fixture output directory: ${targetDir}`);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fileMatches(filename, expected) {
  try {
    return sha256(await readFile(filename)) === expected;
  } catch {
    return false;
  }
}

async function current() {
  return (
    (await fileMatches(path.join(targetDir, manifest.entries.image.outputName), manifest.entries.image.sha256)) &&
    (await fileMatches(path.join(targetDir, manifest.entries.mask.outputName), manifest.entries.mask.sha256)) &&
    (await fileMatches(path.join(targetDir, "SOURCE_README.md"), manifest.readme.sha256))
  );
}

if (await current()) {
  console.log(`[aortaseg-source] verified existing ${manifest.id}`);
  console.log(targetDir);
  process.exit(0);
}

if (!args.has("accept-license")) {
  console.error("[aortaseg-source] download requires explicit license/provenance acceptance");
  console.error(`Zenodo metadata: ${manifest.license.zenodoMetadata}`);
  console.error(`Included README: ${manifest.license.includedReadme}`);
  console.error(manifest.license.effectiveFixturePolicy);
  console.error("Re-run with --accept-license after reviewing those terms.");
  process.exit(2);
}

async function rangedBytes(start, end) {
  const response = await fetch(manifest.archive.url, {
    headers: { Range: `bytes=${start}-${end}` },
    redirect: "follow"
  });
  if (response.status !== 206) {
    throw new Error(`AortaSeg range request returned HTTP ${response.status}; expected 206`);
  }
  const expectedRange = `bytes ${start}-${end}/${manifest.archive.bytes}`;
  if (response.headers.get("content-range") !== expectedRange) {
    throw new Error(`Unexpected Content-Range: ${response.headers.get("content-range")}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== end - start + 1) throw new Error("AortaSeg range response was truncated");
  return bytes;
}

async function fetchEntry(entry, destination) {
  const end = entry.localHeaderOffset + entry.localHeaderBytes + entry.compressedBytes - 1;
  const range = await rangedBytes(entry.localHeaderOffset, end);
  if (range.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP local header missing for ${entry.zipName}`);
  const method = range.readUInt16LE(8);
  const nameLength = range.readUInt16LE(26);
  const extraLength = range.readUInt16LE(28);
  const headerBytes = 30 + nameLength + extraLength;
  const name = range.subarray(30, 30 + nameLength).toString("utf8");
  if (name !== entry.zipName) throw new Error(`ZIP entry mismatch: ${name}`);
  if (method !== entry.compressionMethod || method !== 8) throw new Error(`Unsupported ZIP method for ${name}`);
  if (headerBytes !== entry.localHeaderBytes) throw new Error(`ZIP local header changed for ${name}`);
  const compressed = range.subarray(headerBytes, headerBytes + entry.compressedBytes);
  const output = inflateRawSync(compressed);
  if (output.length !== entry.uncompressedBytes) throw new Error(`ZIP entry size changed for ${name}`);
  if (sha256(output) !== entry.sha256) throw new Error(`ZIP entry content changed for ${name}`);
  await writeFile(destination, output);
}

const parent = path.dirname(targetDir);
await mkdir(parent, { recursive: true });
const temporary = await mkdtemp(path.join(parent, ".aortaseg-source-"));

try {
  const readmeResponse = await fetch(manifest.readme.url, { redirect: "follow" });
  if (!readmeResponse.ok) throw new Error(`AortaSeg README returned HTTP ${readmeResponse.status}`);
  const readme = Buffer.from(await readmeResponse.arrayBuffer());
  if (readme.length !== manifest.readme.bytes || sha256(readme) !== manifest.readme.sha256) {
    throw new Error("AortaSeg README content changed");
  }
  await writeFile(path.join(temporary, "SOURCE_README.md"), readme);
  await fetchEntry(manifest.entries.mask, path.join(temporary, manifest.entries.mask.outputName));
  await fetchEntry(manifest.entries.image, path.join(temporary, manifest.entries.image.outputName));
  await writeFile(
    path.join(temporary, ".irsim-source.json"),
    JSON.stringify(
      {
        fixtureId: manifest.id,
        source: manifest.source.recordUrl,
        effectiveLicensePolicy: manifest.license.effectiveFixturePolicy,
        imageSha256: manifest.entries.image.sha256,
        maskSha256: manifest.entries.mask.sha256
      },
      null,
      2
    )
  );
  await rm(targetDir, { recursive: true, force: true });
  await rename(temporary, targetDir);
  console.log(`[aortaseg-source] fetched and verified ${manifest.id} using byte ranges only`);
  console.log(targetDir);
} finally {
  try {
    if ((await stat(temporary)).isDirectory()) await rm(temporary, { recursive: true, force: true });
  } catch {
    // Successful rename removes the temporary path.
  }
}
