import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
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
const sourceDir = path.resolve(
  args.get("source") ?? path.join("output", "fixtures", "aortaseg60-young05-source")
);
const compression = args.get("compressed") ?? null;
if (compression && compression !== "jpeg2000-lossless") {
  throw new Error(`Unsupported AortaSeg DICOM compression mode: ${compression}`);
}
const jpeg2000Lossless = compression === "jpeg2000-lossless";
const targetDir = path.resolve(
  args.get("out") ??
    path.join(
      "output",
      "fixtures",
      jpeg2000Lossless ? "aortaseg60-young05-dicom-j2k" : "aortaseg60-young05-dicom"
    )
);

if (targetDir === path.resolve(".") || targetDir === path.parse(targetDir).root || targetDir === sourceDir) {
  throw new Error(`Refusing unsafe derived DICOM output directory: ${targetDir}`);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const close = (actual, expected, tolerance = 1e-5) => Math.abs(actual - expected) <= tolerance;

function parseNifti(compressed, expectedDatatype) {
  const bytes = gunzipSync(compressed);
  if (bytes.readInt32LE(0) !== 348 || bytes.subarray(344, 348).toString("binary") !== "n+1\0") {
    throw new Error("AortaSeg source is not a supported little-endian NIfTI-1 single-file volume");
  }
  const dimensions = [bytes.readInt16LE(42), bytes.readInt16LE(44), bytes.readInt16LE(46)];
  const datatype = bytes.readInt16LE(70);
  const bitpix = bytes.readInt16LE(72);
  const spacing = [bytes.readFloatLE(80), bytes.readFloatLE(84), bytes.readFloatLE(88)];
  const voxelOffset = bytes.readFloatLE(108);
  const slope = bytes.readFloatLE(112) || 1;
  const intercept = bytes.readFloatLE(116);
  const sformCode = bytes.readInt16LE(254);
  const sform = [
    [bytes.readFloatLE(280), bytes.readFloatLE(284), bytes.readFloatLE(288), bytes.readFloatLE(292)],
    [bytes.readFloatLE(296), bytes.readFloatLE(300), bytes.readFloatLE(304), bytes.readFloatLE(308)],
    [bytes.readFloatLE(312), bytes.readFloatLE(316), bytes.readFloatLE(320), bytes.readFloatLE(324)]
  ];
  if (bytes.readInt16LE(40) !== 3 || datatype !== expectedDatatype || bitpix !== (expectedDatatype === 4 ? 16 : 8)) {
    throw new Error(`Unsupported AortaSeg NIfTI datatype ${datatype}/${bitpix}`);
  }
  if (sformCode < 1 || !Number.isInteger(voxelOffset) || voxelOffset < 352) {
    throw new Error("AortaSeg NIfTI is missing a usable sform or voxel offset");
  }
  const voxelCount = dimensions[0] * dimensions[1] * dimensions[2];
  const expectedBytes = voxelOffset + voxelCount * (bitpix / 8);
  if (bytes.length !== expectedBytes) {
    throw new Error(`AortaSeg NIfTI byte length ${bytes.length} does not match ${expectedBytes}`);
  }
  return { bytes, dimensions, datatype, bitpix, spacing, voxelOffset, slope, intercept, sform, voxelCount };
}

function assertNifti(image, mask) {
  const expected = manifest.niftiExpected;
  if (image.dimensions.some((value, index) => value !== expected.dimensions[index])) {
    throw new Error(`AortaSeg image dimensions changed: ${image.dimensions.join("x")}`);
  }
  if (mask.dimensions.some((value, index) => value !== expected.dimensions[index])) {
    throw new Error("AortaSeg image and mask dimensions differ");
  }
  image.spacing.forEach((value, index) => {
    if (!close(value, expected.spacingMm[index])) throw new Error("AortaSeg spacing changed");
  });
  if (!close(image.slope, expected.rescaleSlope) || !close(image.intercept, expected.rescaleInterceptHu)) {
    throw new Error("AortaSeg HU scaling changed");
  }
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 4; column++) {
      if (!close(image.sform[row][column], expected.sformRas[row][column])) {
        throw new Error("AortaSeg image sform changed");
      }
      if (!close(mask.sform[row][column], expected.sformRas[row][column])) {
        throw new Error("AortaSeg mask is not aligned to the image sform");
      }
    }
  }

  const [width, height, depth] = image.dimensions;
  const imageData = image.bytes.subarray(image.voxelOffset);
  const maskData = mask.bytes.subarray(mask.voxelOffset);
  const histogram = new Uint32Array(65536);
  const bounds = [width, height, depth, -1, -1, -1];
  let maskVoxels = 0;
  for (let index = 0; index < maskData.length; index++) {
    if (maskData[index] === 0) continue;
    const z = Math.floor(index / (width * height));
    const inSlice = index - z * width * height;
    const y = Math.floor(inSlice / width);
    const x = inSlice - y * width;
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.min(bounds[2], z);
    bounds[3] = Math.max(bounds[3], x);
    bounds[4] = Math.max(bounds[4], y);
    bounds[5] = Math.max(bounds[5], z);
    const stored = imageData.readInt16LE(index * 2);
    const hu = Math.max(-32768, Math.min(32767, Math.round(stored * image.slope + image.intercept)));
    histogram[hu + 32768]++;
    maskVoxels++;
  }
  if (maskVoxels !== expected.maskVoxels || bounds.some((value, index) => value !== expected.maskVoxelBounds[index])) {
    throw new Error(`AortaSeg mask geometry changed: ${maskVoxels} voxels, bounds ${bounds.join(",")}`);
  }
  let cumulative = 0;
  let medianHu = -32768;
  for (let index = 0; index < histogram.length; index++) {
    cumulative += histogram[index];
    if (cumulative >= Math.ceil(maskVoxels / 2)) {
      medianHu = index - 32768;
      break;
    }
  }
  if (medianHu !== expected.maskedHuMedian) throw new Error(`AortaSeg masked median changed: ${medianHu} HU`);
  return { maskVoxels, maskVoxelBounds: bounds, maskedHuMedian: medianHu };
}

function norm(vector) {
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length <= 0) throw new Error("Invalid NIfTI direction vector");
  return vector.map((value) => value / length);
}

const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const rasVectorToLps = (vector) => [-vector[0], -vector[1], vector[2]];

function geometryFromSform(image) {
  const columnAxisLps = rasVectorToLps(image.sform.map((row) => row[0]));
  const rowAxisLps = rasVectorToLps(image.sform.map((row) => row[1]));
  const sliceAxisLps = rasVectorToLps(image.sform.map((row) => row[2]));
  const sourceOriginLps = rasVectorToLps(image.sform.map((row) => row[3]));
  const rowDirectionLps = norm(columnAxisLps);
  const sourceColumnDirectionLps = norm(rowAxisLps);
  const sourceNormalDirectionLps = norm(cross(rowDirectionLps, sourceColumnDirectionLps));
  const columnSpacingMm = Math.hypot(...columnAxisLps);
  const rowSpacingMm = Math.hypot(...rowAxisLps);
  const sliceSpacingMm = Math.hypot(...sliceAxisLps);
  const handedness = dot(sourceNormalDirectionLps, norm(sliceAxisLps));
  if (
    Math.abs(dot(rowDirectionLps, sourceColumnDirectionLps)) > 1e-6 ||
    Math.abs(Math.abs(handedness) - 1) > 1e-6
  ) {
    throw new Error("AortaSeg affine is oblique/sheared beyond the deterministic conversion envelope");
  }
  // NIfTI commonly uses a left-handed voxel lattice (qfac=-1). DICOM derives slice direction from
  // row×column, so preserve physical coordinates while flipping stored rows into a conventional,
  // right-handed LPS axial layout. IRsim's v1 canvas displays acquisition pixels as stored.
  const flipRows = handedness < 0;
  const columnDirectionLps = flipRows
    ? sourceColumnDirectionLps.map((value) => -value)
    : sourceColumnDirectionLps;
  const originLps = flipRows
    ? sourceOriginLps.map((value, axis) => value + rowAxisLps[axis] * (image.dimensions[1] - 1))
    : sourceOriginLps;
  const normalDirectionLps = norm(cross(rowDirectionLps, columnDirectionLps));
  const outputHandedness = dot(normalDirectionLps, norm(sliceAxisLps));
  return {
    columnAxisLps,
    rowAxisLps,
    sliceAxisLps,
    originLps,
    rowDirectionLps,
    columnDirectionLps,
    normalDirectionLps,
    columnSpacingMm,
    rowSpacingMm,
    sliceSpacingMm,
    flipRows,
    sourceSliceOrder: outputHandedness < 0 ? "descending" : "ascending"
  };
}

const encoder = new TextEncoder();
const longVrs = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UN", "UR", "UT"]);

function tag(group, element) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt16LE(group, 0);
  bytes.writeUInt16LE(element, 2);
  return bytes;
}

function binaryValue(vr, value) {
  if (Buffer.isBuffer(value)) return value.length % 2 === 0 ? value : Buffer.concat([value, Buffer.from([0])]);
  if (vr === "US") {
    const bytes = Buffer.allocUnsafe(2);
    bytes.writeUInt16LE(value, 0);
    return bytes;
  }
  if (vr === "UL") {
    const bytes = Buffer.allocUnsafe(4);
    bytes.writeUInt32LE(value, 0);
    return bytes;
  }
  const raw = Buffer.from(encoder.encode(String(value)));
  if (raw.length % 2 === 0) return raw;
  return Buffer.concat([raw, Buffer.from([vr === "UI" ? 0 : 32])]);
}

function element(group, number, vr, value) {
  const payload = binaryValue(vr, value);
  if (longVrs.has(vr)) {
    const header = Buffer.alloc(8);
    header.write(vr, 0, 2, "ascii");
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([tag(group, number), header, payload]);
  }
  const header = Buffer.allocUnsafe(4);
  header.write(vr, 0, 2, "ascii");
  header.writeUInt16LE(payload.length, 2);
  return Buffer.concat([tag(group, number), header, payload]);
}

function uid(label) {
  const bytes = createHash("sha256").update(`${manifest.id}\0${label}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return `2.25.${BigInt(`0x${bytes.toString("hex")}`).toString(10)}`;
}

function ds(value) {
  if (Math.abs(value) < 5e-10) return "0";
  let result = value.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  if (result.length > 16) result = value.toPrecision(9).replace(/0+e/, "e");
  if (result.length > 16) throw new Error(`DICOM DS value is too long: ${result}`);
  return result;
}

const joinDs = (values) => values.map(ds).join("\\");

function item(number, payload) {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(payload.length, 0);
  return Buffer.concat([tag(0xfffe, number), length, payload]);
}

function encapsulatedPixelData(frame) {
  const paddedFrame = frame.length % 2 === 0 ? frame : Buffer.concat([frame, Buffer.alloc(1)]);
  const header = Buffer.alloc(8);
  header.write("OB", 0, 2, "ascii");
  header.writeUInt32LE(0xffffffff, 4);
  const basicOffsetTable = Buffer.alloc(4);
  return Buffer.concat([
    tag(0x7fe0, 0x0010),
    header,
    item(0xe000, basicOffsetTable),
    item(0xe000, paddedFrame),
    item(0xe0dd, Buffer.alloc(0))
  ]);
}

let openJpegModulePromise = null;
async function encodeJpeg2000Lossless(pixelData, width, height) {
  openJpegModulePromise ??= import("@cornerstonejs/codec-openjpeg").then(
    ({ default: createOpenJpegModule }) => createOpenJpegModule({ print() {}, printErr() {} })
  );
  const module = await openJpegModulePromise;
  const jpegEncoder = new module.J2KEncoder();
  try {
    jpegEncoder
      .getDecodedBuffer({
        width,
        height,
        bitsPerSample: manifest.derivedDicom.bitsStored,
        componentCount: 1,
        isSigned: manifest.derivedDicom.pixelRepresentation === "signed"
      })
      .set(pixelData);
    jpegEncoder.encode();
    return Buffer.from(jpegEncoder.getEncodedBuffer());
  } finally {
    jpegEncoder.delete();
  }
}

function dicomSlice({ pixelData, encodedFrame, sourceK, instanceNumber, geometry, dimensions, slope, intercept }) {
  const sopClassUid = manifest.derivedDicom.sopClass;
  const sopInstanceUid = uid(`sop:${sourceK}`);
  const studyUid = uid("study");
  const seriesUid = uid("series");
  const frameUid = uid("frame-of-reference");
  const implementationUid = uid("implementation");
  const position = geometry.originLps.map(
    (value, axis) => value + geometry.sliceAxisLps[axis] * sourceK
  );
  const orientation = [...geometry.rowDirectionLps, ...geometry.columnDirectionLps];
  const metaBody = Buffer.concat([
    element(0x0002, 0x0001, "OB", Buffer.from([0, 1])),
    element(0x0002, 0x0002, "UI", sopClassUid),
    element(0x0002, 0x0003, "UI", sopInstanceUid),
    element(0x0002, 0x0010, "UI", encodedFrame ? "1.2.840.10008.1.2.4.90" : manifest.derivedDicom.transferSyntax),
    element(0x0002, 0x0012, "UI", implementationUid),
    element(0x0002, 0x0013, "SH", "IRSIM_0_1")
  ]);
  const preamble = Buffer.alloc(132);
  preamble.write("DICM", 128, 4, "ascii");
  const dataSet = Buffer.concat([
    element(0x0008, 0x0008, "CS", "DERIVED\\SECONDARY\\AXIAL"),
    element(0x0008, 0x0016, "UI", sopClassUid),
    element(0x0008, 0x0018, "UI", sopInstanceUid),
    element(0x0008, 0x0020, "DA", ""),
    element(0x0008, 0x0021, "DA", ""),
    element(0x0008, 0x0030, "TM", ""),
    element(0x0008, 0x0031, "TM", ""),
    element(0x0008, 0x0050, "SH", ""),
    element(0x0008, 0x0060, "CS", "CT"),
    element(0x0008, 0x0064, "CS", "WSD"),
    element(0x0008, 0x1030, "LO", "IRsim public fixture derivation"),
    element(0x0008, 0x103e, "LO", "AortaSeg-60 Young_05 derived CTA"),
    element(0x0008, 0x2111, "ST", "Deterministic identifier-neutral derivation from the pinned public AortaSeg-60 Young_05 NIfTI volume."),
    element(0x0010, 0x0010, "PN", ""),
    element(0x0010, 0x0020, "LO", ""),
    element(0x0010, 0x0030, "DA", ""),
    element(0x0010, 0x0040, "CS", ""),
    element(0x0012, 0x0062, "CS", "YES"),
    element(0x0012, 0x0063, "LO", "No source DICOM attributes available; synthetic derived fixture metadata only"),
    element(0x0018, 0x0050, "DS", ds(geometry.sliceSpacingMm)),
    element(0x0018, 0x0088, "DS", ds(geometry.sliceSpacingMm)),
    element(0x0020, 0x000d, "UI", studyUid),
    element(0x0020, 0x000e, "UI", seriesUid),
    element(0x0020, 0x0010, "SH", "IRSIM"),
    element(0x0020, 0x0011, "IS", "1"),
    element(0x0020, 0x0013, "IS", String(instanceNumber)),
    element(0x0020, 0x0032, "DS", joinDs(position)),
    element(0x0020, 0x0037, "DS", joinDs(orientation)),
    element(0x0020, 0x0052, "UI", frameUid),
    element(0x0020, 0x1041, "DS", ds(dot(position, geometry.normalDirectionLps))),
    element(0x0028, 0x0002, "US", 1),
    element(0x0028, 0x0004, "CS", manifest.derivedDicom.photometricInterpretation),
    element(0x0028, 0x0010, "US", dimensions[1]),
    element(0x0028, 0x0011, "US", dimensions[0]),
    element(0x0028, 0x0030, "DS", joinDs([geometry.rowSpacingMm, geometry.columnSpacingMm])),
    element(0x0028, 0x0100, "US", manifest.derivedDicom.bitsAllocated),
    element(0x0028, 0x0101, "US", manifest.derivedDicom.bitsStored),
    element(0x0028, 0x0102, "US", manifest.derivedDicom.bitsStored - 1),
    element(0x0028, 0x0103, "US", 1),
    element(0x0028, 0x0301, "CS", "NO"),
    element(0x0028, 0x1050, "DS", "300"),
    element(0x0028, 0x1051, "DS", "700"),
    element(0x0028, 0x1052, "DS", ds(intercept)),
    element(0x0028, 0x1053, "DS", ds(slope)),
    element(0x0028, 0x1054, "LO", "HU"),
    encodedFrame ? encapsulatedPixelData(encodedFrame) : element(0x7fe0, 0x0010, "OW", pixelData)
  ]);
  return Buffer.concat([preamble, element(0x0002, 0x0000, "UL", metaBody.length), metaBody, dataSet]);
}

async function contentFingerprint(directory) {
  const files = (await readdir(directory))
    .filter((name) => name.toLowerCase().endsWith(".dcm"))
    .sort((a, b) => a.localeCompare(b, "en"));
  const aggregate = createHash("sha256");
  let totalBytes = 0;
  for (const name of files) {
    const bytes = await readFile(path.join(directory, name));
    totalBytes += bytes.length;
    aggregate.update(`${sha256(bytes)}\n`, "utf8");
  }
  return { files, totalBytes, digest: aggregate.digest("hex") };
}

const imagePath = path.join(sourceDir, manifest.entries.image.outputName);
const maskPath = path.join(sourceDir, manifest.entries.mask.outputName);
const imageCompressed = await readFile(imagePath);
const maskCompressed = await readFile(maskPath);
if (sha256(imageCompressed) !== manifest.entries.image.sha256 || sha256(maskCompressed) !== manifest.entries.mask.sha256) {
  throw new Error("Pinned AortaSeg source hashes do not match; run fixture:cta:fetch again");
}

const image = parseNifti(imageCompressed, 4);
const mask = parseNifti(maskCompressed, 2);
const maskEvidence = assertNifti(image, mask);
const geometry = geometryFromSform(image);
const [width, height, depth] = image.dimensions;
const sliceBytes = width * height * 2;
const rowBytes = width * 2;
const imageData = image.bytes.subarray(image.voxelOffset);

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
for (let outputIndex = 0; outputIndex < depth; outputIndex++) {
  const sourceK = geometry.sourceSliceOrder === "descending" ? depth - 1 - outputIndex : outputIndex;
  const sourcePixels = imageData.subarray(sourceK * sliceBytes, (sourceK + 1) * sliceBytes);
  let pixels = sourcePixels;
  if (geometry.flipRows) {
    pixels = Buffer.allocUnsafe(sliceBytes);
    for (let row = 0; row < height; row++) {
      sourcePixels.copy(pixels, row * rowBytes, (height - 1 - row) * rowBytes, (height - row) * rowBytes);
    }
  }
  const encodedFrame = jpeg2000Lossless
    ? await encodeJpeg2000Lossless(pixels, width, height)
    : null;
  const dicom = dicomSlice({
    pixelData: pixels,
    encodedFrame,
    sourceK,
    instanceNumber: outputIndex + 1,
    geometry,
    dimensions: image.dimensions,
    slope: image.slope,
    intercept: image.intercept
  });
  await writeFile(path.join(targetDir, `${String(outputIndex + 1).padStart(6, "0")}.dcm`), dicom);
  if (jpeg2000Lossless && ((outputIndex + 1) % 25 === 0 || outputIndex + 1 === depth)) {
    console.log(`[aortaseg-dicom] encoded ${outputIndex + 1}/${depth} JPEG 2000 Lossless slices`);
  }
  if (pixels !== sourcePixels) pixels.fill(0);
  encodedFrame?.fill(0);
}

await copyFile(path.join(sourceDir, "SOURCE_README.md"), path.join(targetDir, "SOURCE_README.md"));
const fingerprint = await contentFingerprint(targetDir);
if (fingerprint.files.length !== manifest.derivedDicom.expectedFiles) {
  throw new Error(`Derived ${fingerprint.files.length} DICOM slices; expected ${manifest.derivedDicom.expectedFiles}`);
}
if (
  !jpeg2000Lossless &&
  manifest.derivedDicom.dicomContentSha256 &&
  fingerprint.digest !== manifest.derivedDicom.dicomContentSha256
) {
  throw new Error(`Derived DICOM fingerprint changed: ${fingerprint.digest}`);
}
if (
  jpeg2000Lossless &&
  (fingerprint.digest !== manifest.derivedDicom.jpeg2000Lossless?.dicomContentSha256 ||
    fingerprint.totalBytes !== manifest.derivedDicom.jpeg2000Lossless?.expectedBytes)
) {
  throw new Error(
    `Derived JPEG 2000 DICOM fingerprint changed: ${fingerprint.digest} / ${fingerprint.totalBytes} bytes`
  );
}

const report = {
  fixtureId: manifest.id,
  sourceRecord: manifest.source.recordUrl,
  sourceImageSha256: manifest.entries.image.sha256,
  sourceMaskSha256: manifest.entries.mask.sha256,
  effectiveLicensePolicy: manifest.license.effectiveFixturePolicy,
  dimensions: image.dimensions,
  spacingMm: [geometry.columnSpacingMm, geometry.rowSpacingMm, geometry.sliceSpacingMm],
  sourceSformRas: image.sform,
  dicomGeometryLps: {
    origin: geometry.originLps,
    rowDirection: geometry.rowDirectionLps,
    columnDirection: geometry.columnDirectionLps,
    normalDirection: geometry.normalDirectionLps,
    sourceSliceOrder: geometry.sourceSliceOrder,
    storedRowFlipFromSource: geometry.flipRows
  },
  rescaleSlope: image.slope,
  rescaleInterceptHu: image.intercept,
  transferSyntax: jpeg2000Lossless
    ? "1.2.840.10008.1.2.4.90"
    : manifest.derivedDicom.transferSyntax,
  encodingEvidence: jpeg2000Lossless
    ? {
        codec: manifest.derivedDicom.jpeg2000Lossless.encoder,
        mode: "JPEG 2000 Lossless raw codestream",
        basicOffsetTableEntries: manifest.derivedDicom.jpeg2000Lossless.basicOffsetTableEntries,
        fragmentsPerFrame: manifest.derivedDicom.jpeg2000Lossless.fragmentsPerFrame,
        claimLimit: manifest.derivedDicom.jpeg2000Lossless.claimLimit
      }
    : null,
  maskEvidence,
  studyInstanceUid: uid("study"),
  seriesInstanceUid: uid("series"),
  dicomFiles: fingerprint.files.length,
  dicomBytes: fingerprint.totalBytes,
  dicomContentSha256: fingerprint.digest
};
await writeFile(path.join(targetDir, "DERIVATION.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log("\n[aortaseg-dicom] ok");
