import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
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
  args.get("manifest") ?? "fixtures/real-dicom/tcia-pancreas-ct.json"
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const targetDir = path.resolve(args.get("out") ?? path.join("output", "fixtures", "tcia-pancreas-ct"));
const sourceArchive = args.has("archive") ? path.resolve(args.get("archive")) : null;

if (targetDir === path.resolve(".") || targetDir === path.parse(targetDir).root) {
  throw new Error(`Refusing unsafe fixture output directory: ${targetDir}`);
}

async function dicomFiles(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dcm"))
    .map((entry) => path.join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b, "en"));
}

async function hashFile(filename) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filename), hash);
  return hash.digest("hex");
}

async function contentFingerprint(directory) {
  const files = await dicomFiles(directory);
  const aggregate = createHash("sha256");
  for (const file of files) aggregate.update(`${await hashFile(file)}\n`, "utf8");
  return { files, digest: aggregate.digest("hex") };
}

async function isCurrent(directory) {
  try {
    const fingerprint = await contentFingerprint(directory);
    return (
      fingerprint.files.length === manifest.download.expectedDicomFiles &&
      fingerprint.digest === manifest.download.dicomContentSha256 &&
      (await stat(path.join(directory, "LICENSE"))).isFile()
    );
  } catch {
    return false;
  }
}

if (await isCurrent(targetDir)) {
  console.log(`[real-dicom-fixture] verified existing ${manifest.id}`);
  console.log(targetDir);
  process.exit(0);
}

if (!args.has("accept-license")) {
  console.error(`[real-dicom-fixture] download requires explicit license acceptance`);
  console.error(`${manifest.license.name}: ${manifest.license.url}`);
  console.error(`TCIA policy: ${manifest.license.tciaDataUsagePolicy}`);
  console.error(`Re-run with --accept-license after reviewing those terms.`);
  process.exit(2);
}

const parent = path.dirname(targetDir);
await mkdir(parent, { recursive: true });
const temporary = await mkdtemp(path.join(parent, ".real-dicom-"));
const archive = path.join(temporary, "series.zip");
const extracted = path.join(temporary, "extracted");

try {
  if (sourceArchive) {
    await copyFile(sourceArchive, archive);
  } else {
    const response = await fetch(manifest.download.url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`TCIA download failed with HTTP ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  }

  await mkdir(extracted, { recursive: true });
  const unzip = spawnSync("unzip", ["-q", "-o", archive, "-d", extracted], { encoding: "utf8" });
  if (unzip.error) throw unzip.error;
  if (unzip.status !== 0) throw new Error(`unzip failed: ${unzip.stderr || unzip.stdout}`);

  const fingerprint = await contentFingerprint(extracted);
  if (fingerprint.files.length !== manifest.download.expectedDicomFiles) {
    throw new Error(
      `Fixture contains ${fingerprint.files.length} DICOM files; expected ${manifest.download.expectedDicomFiles}`
    );
  }
  if (fingerprint.digest !== manifest.download.dicomContentSha256) {
    throw new Error(`Fixture content fingerprint mismatch: ${fingerprint.digest}`);
  }
  if (!(await stat(path.join(extracted, "LICENSE"))).isFile()) {
    throw new Error("TCIA archive did not include its LICENSE file");
  }

  await writeFile(
    path.join(extracted, ".irsim-fixture.json"),
    JSON.stringify(
      {
        fixtureId: manifest.id,
        source: manifest.source.collectionUrl,
        license: manifest.license.url,
        dicomContentSha256: fingerprint.digest
      },
      null,
      2
    )
  );
  await rm(targetDir, { recursive: true, force: true });
  await rename(extracted, targetDir);
  console.log(`[real-dicom-fixture] fetched and verified ${manifest.id}`);
  console.log(targetDir);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
