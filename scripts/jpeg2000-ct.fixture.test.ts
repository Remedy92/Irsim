import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as dicomParser from "dicom-parser";
import { describe, expect, it } from "vitest";
import { decodeCtSlice, type DecodedCtSlice } from "../src/imaging/dicom-volume";

interface FixtureDownload {
  outputName: string;
  bytes: number;
  sha256: string;
}

interface InteroperabilityCase {
  id: string;
  compressedFile: string;
  referenceFile: string | null;
  transferSyntax: string;
  implementationVersionName: string;
  encapsulation: {
    fragmentCount: number;
    basicOffsetTableEntries: number;
    basicOffsetTableOffsets: number[];
    encodedFrameBytes: number;
    encodedFrameSha256: string;
    fragmentLengths: number[];
    fragmentSha256: string[];
    derivedEmptyBotFragmentVariant: boolean;
  };
  expected: {
    dimensions: [number, number];
    pixelSpacingMm: [number, number];
    imagePositionLps: [number, number, number];
    rowDirectionLps: [number, number, number];
    columnDirectionLps: [number, number, number];
    sourceGeometryDs: {
      pixelSpacing: string;
      imagePositionPatient: string;
      imageOrientationPatient: string;
    };
    photometricInterpretation: "MONOCHROME1" | "MONOCHROME2";
    declaredBitsStored: number;
    codestreamBitsStored: number;
    codestreamSigned: boolean;
    storedLittleEndianSha256: string;
    huLittleEndianSha256: string;
    huMinimum: number;
    huMaximum: number;
    huSum: number;
  };
}

interface InteroperabilityManifest {
  id: string;
  downloads: FixtureDownload[];
  cases: InteroperabilityCase[];
}

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(root, "fixtures/real-dicom/jpeg2000-ct-interoperability.json");
const fixtureDir = path.resolve(
  process.env.IRSIM_JPEG2000_CT_DIR ?? path.join(root, "output/fixtures/jpeg2000-ct-interoperability")
);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function item(element: number, payload: Uint8Array): Uint8Array {
  const output = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(output.buffer);
  view.setUint16(0, 0xfffe, true);
  view.setUint16(2, element, true);
  view.setUint32(4, payload.byteLength, true);
  output.set(payload, 8);
  return output;
}

function huEvidence(pixels: Int16Array) {
  const littleEndian = Buffer.allocUnsafe(pixels.length * 2);
  let minimum = 32767;
  let maximum = -32768;
  let sum = 0;
  for (let index = 0; index < pixels.length; index++) {
    const value = pixels[index];
    littleEndian.writeInt16LE(value, index * 2);
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    sum += value;
  }
  return { sha256: sha256(littleEndian), minimum, maximum, sum };
}

function codestreamEvidence(dataSet: dicomParser.DataSet, pixelElement: dicomParser.Element) {
  const encoded = pixelElement.basicOffsetTable?.length
    ? dicomParser.readEncapsulatedImageFrame(dataSet, pixelElement, 0)
    : dicomParser.readEncapsulatedPixelDataFromFragments(
        dataSet,
        pixelElement,
        0,
        pixelElement.fragments!.length
      );
  expect([...encoded.subarray(0, 4)]).toEqual([0xff, 0x4f, 0xff, 0x51]);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const sample = view.getUint8(42);
  return {
    encoded,
    width: view.getUint32(8, false) - view.getUint32(16, false),
    height: view.getUint32(12, false) - view.getUint32(20, false),
    bitsStored: (sample & 0x7f) + 1,
    signed: (sample & 0x80) !== 0
  };
}

function expectGeometry(slice: DecodedCtSlice, fixtureCase: InteroperabilityCase): void {
  const expected = fixtureCase.expected;
  expect([slice.columns, slice.rows]).toEqual(expected.dimensions);
  expect(slice.pixelSpacingMm).toEqual(expected.pixelSpacingMm);
  expect(slice.imagePositionLps).toEqual(expected.imagePositionLps);
  expect(slice.rowDirectionLps).toEqual(expected.rowDirectionLps);
  expect(slice.columnDirectionLps).toEqual(expected.columnDirectionLps);
  expect(slice.photometricInterpretation).toBe(expected.photometricInterpretation);
}

function refragmentWithEmptyBasicOffsetTable(bytes: Uint8Array, fragmentCount: number): Uint8Array {
  const dataSet = dicomParser.parseDicom(bytes);
  const pixelElement = dataSet.elements.x7fe00010;
  if (!pixelElement?.encapsulatedPixelData || !pixelElement.fragments?.length) {
    throw new Error("fixture is not encapsulated");
  }
  const frame = pixelElement.basicOffsetTable?.length
    ? dicomParser.readEncapsulatedImageFrame(dataSet, pixelElement, 0)
    : dicomParser.readEncapsulatedPixelDataFromFragments(
        dataSet,
        pixelElement,
        0,
        pixelElement.fragments.length
      );
  if (fragmentCount !== 3) throw new Error("fixture helper currently pins three fragments");
  const firstEnd = Math.floor(frame.byteLength / 6) * 2;
  const secondEnd = Math.floor(frame.byteLength / 3) * 2;
  const fragments = [frame.subarray(0, firstEnd), frame.subarray(firstEnd, secondEnd), frame.subarray(secondEnd)];
  if (fragments.some((fragment) => fragment.byteLength === 0 || fragment.byteLength % 2 !== 0)) {
    throw new Error("fixture fragment split is not DICOM-aligned");
  }
  return concat([
    bytes.subarray(0, pixelElement.dataOffset),
    item(0xe000, new Uint8Array(0)),
    ...fragments.map((fragment) => item(0xe000, fragment)),
    item(0xe0dd, new Uint8Array(0))
  ]);
}

describe("content-pinned JPEG 2000 Lossless CT interoperability", () => {
  it("matches independent HU and geometry oracles across DCMTK and GDCM objects", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as InteroperabilityManifest;
    const downloads = new Map(manifest.downloads.map((entry) => [entry.outputName, entry]));

    for (const fixtureCase of manifest.cases) {
      const download = downloads.get(fixtureCase.compressedFile)!;
      const bytes = await readFile(path.join(fixtureDir, fixtureCase.compressedFile));
      expect(bytes).toHaveLength(download.bytes);
      expect(sha256(bytes)).toBe(download.sha256);

      const dataSet = dicomParser.parseDicom(bytes);
      const pixelElement = dataSet.elements.x7fe00010;
      expect(dataSet.string("x00020010")?.trim()).toBe(fixtureCase.transferSyntax);
      expect(dataSet.string("x00020013")?.trim()).toBe(fixtureCase.implementationVersionName);
      expect(dataSet.uint16("x00280101")).toBe(fixtureCase.expected.declaredBitsStored);
      expect(pixelElement.fragments).toHaveLength(fixtureCase.encapsulation.fragmentCount);
      expect(pixelElement.basicOffsetTable).toHaveLength(
        fixtureCase.encapsulation.basicOffsetTableEntries
      );
      expect(pixelElement.basicOffsetTable).toEqual(fixtureCase.encapsulation.basicOffsetTableOffsets);
      expect(dataSet.string("x00280030")).toBe(fixtureCase.expected.sourceGeometryDs.pixelSpacing);
      expect(dataSet.string("x00200032")).toBe(
        fixtureCase.expected.sourceGeometryDs.imagePositionPatient
      );
      expect(dataSet.string("x00200037")).toBe(
        fixtureCase.expected.sourceGeometryDs.imageOrientationPatient
      );
      const codestream = codestreamEvidence(dataSet, pixelElement);
      expect(codestream.encoded).toHaveLength(fixtureCase.encapsulation.encodedFrameBytes);
      expect(sha256(codestream.encoded)).toBe(fixtureCase.encapsulation.encodedFrameSha256);
      const fragmentBytes = pixelElement.fragments!.map(
        (fragment) =>
          new Uint8Array(
            dataSet.byteArray.buffer,
            dataSet.byteArray.byteOffset + fragment.position,
            fragment.length
          )
      );
      expect(fragmentBytes.map((fragment) => fragment.byteLength)).toEqual(
        fixtureCase.encapsulation.fragmentLengths
      );
      expect(fragmentBytes.map(sha256)).toEqual(fixtureCase.encapsulation.fragmentSha256);
      expect([codestream.width, codestream.height]).toEqual(fixtureCase.expected.dimensions);
      expect(codestream.bitsStored).toBe(fixtureCase.expected.codestreamBitsStored);
      expect(codestream.signed).toBe(fixtureCase.expected.codestreamSigned);

      const decoded = await decodeCtSlice(exactArrayBuffer(bytes));
      expectGeometry(decoded, fixtureCase);
      expect(huEvidence(decoded.pixelsHu)).toEqual({
        sha256: fixtureCase.expected.huLittleEndianSha256,
        minimum: fixtureCase.expected.huMinimum,
        maximum: fixtureCase.expected.huMaximum,
        sum: fixtureCase.expected.huSum
      });

      if (fixtureCase.referenceFile) {
        const referenceDownload = downloads.get(fixtureCase.referenceFile)!;
        const referenceBytes = await readFile(path.join(fixtureDir, fixtureCase.referenceFile));
        expect(referenceBytes).toHaveLength(referenceDownload.bytes);
        expect(sha256(referenceBytes)).toBe(referenceDownload.sha256);
        const referenceDataSet = dicomParser.parseDicom(referenceBytes);
        const referencePixelElement = referenceDataSet.elements.x7fe00010;
        const referencePixelBytes = new Uint8Array(
          referenceDataSet.byteArray.buffer,
          referenceDataSet.byteArray.byteOffset + referencePixelElement.dataOffset,
          fixtureCase.expected.dimensions[0] * fixtureCase.expected.dimensions[1] * 2
        );
        expect(sha256(referencePixelBytes)).toBe(fixtureCase.expected.storedLittleEndianSha256);
        const reference = await decodeCtSlice(exactArrayBuffer(referenceBytes));
        expectGeometry(reference, fixtureCase);
        expect(decoded.pixelsHu).toEqual(reference.pixelsHu);
        reference.pixelsHu.fill(0);
      }
      decoded.pixelsHu.fill(0);
    }
  });

  it("decodes a deterministic three-fragment empty-BOT variant of the real-pixel DCMTK frame", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as InteroperabilityManifest;
    const fixtureCase = manifest.cases.find((entry) => entry.encapsulation.derivedEmptyBotFragmentVariant)!;
    const bytes = await readFile(path.join(fixtureDir, fixtureCase.compressedFile));
    const refragmented = refragmentWithEmptyBasicOffsetTable(bytes, 3);
    const dataSet = dicomParser.parseDicom(refragmented);
    expect(dataSet.elements.x7fe00010.fragments).toHaveLength(3);
    expect(dataSet.elements.x7fe00010.basicOffsetTable).toHaveLength(0);

    const decoded = await decodeCtSlice(exactArrayBuffer(refragmented));
    expectGeometry(decoded, fixtureCase);
    expect(huEvidence(decoded.pixelsHu).sha256).toBe(fixtureCase.expected.huLittleEndianSha256);
    decoded.pixelsHu.fill(0);
  });

  it("rejects a bounded truncation corpus without reflecting source identifiers", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as InteroperabilityManifest;
    for (const fixtureCase of manifest.cases) {
      const bytes = await readFile(path.join(fixtureDir, fixtureCase.compressedFile));
      for (const removedBytes of [16, 257, Math.floor(bytes.byteLength / 3)]) {
        const truncated = bytes.subarray(0, bytes.byteLength - removedBytes);
        let message = "";
        try {
          const decoded = await decodeCtSlice(exactArrayBuffer(truncated));
          decoded.pixelsHu.fill(0);
          throw new Error("truncated fixture unexpectedly decoded");
        } catch (cause) {
          message = cause instanceof Error ? cause.message : String(cause);
        }
        expect(message).toMatch(/^DICOM:/);
        expect(message).not.toContain(fixtureCase.compressedFile);
        expect(message).not.toContain(manifest.id);
      }
    }
  });
});
