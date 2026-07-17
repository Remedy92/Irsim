import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalDicomProcessor, type DicomFileSource } from "../src/imaging/process-dicom";
import { DEFAULT_VESSEL_SEGMENTATION_SETTINGS } from "../src/imaging/types";

interface FixtureManifest {
  download: {
    expectedDicomFiles: number;
    jpeg2000Lossless: {
      transferSyntax: string;
      expectedBytes: number;
      dicomContentSha256: string;
      claimLimit: string;
    };
  };
  expected: {
    dimensions: [number, number, number];
    proposalOverlay: {
      sliceNumber: number;
      cyanPixelCount: [number, number];
      cyanBounds: Record<"minColumn" | "maxColumn" | "minRow" | "maxRow", [number, number]>;
    };
    seededTrack: {
      seed: { sliceNumber: number; row: number; column: number };
      minimumCenterlineSamples: number;
      maximumCenterlineSamples: number;
    };
  };
}

interface DerivationReport {
  dimensions: [number, number, number];
  transferSyntax: string;
  dicomFiles: number;
  dicomBytes: number;
  dicomContentSha256: string;
  encodingEvidence: { claimLimit: string };
}

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(root, "fixtures/real-dicom/aortaseg60-young05-derived.json");
const dicomDir = path.resolve(
  process.env.IRSIM_CTA_J2K_DICOM_DIR ??
    path.join(root, "output/fixtures/aortaseg60-young05-dicom-j2k")
);

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function cyanEvidence(rgba: Uint8ClampedArray, width: number) {
  let count = 0;
  let minColumn = Infinity;
  let maxColumn = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    if (blue < 150 || green < red + 35 || blue < red + 35) continue;
    const pixel = offset / 4;
    const column = pixel % width;
    const row = Math.floor(pixel / width);
    count++;
    minColumn = Math.min(minColumn, column);
    maxColumn = Math.max(maxColumn, column);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
  }
  return { count, minColumn, maxColumn, minRow, maxRow };
}

describe("compressed full-study production path", () => {
  it("decodes and reviews all 538 deterministic JPEG 2000 Lossless slices", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureManifest;
    const report = JSON.parse(
      await readFile(path.join(dicomDir, "DERIVATION.json"), "utf8")
    ) as DerivationReport;
    const names = (await readdir(dicomDir))
      .filter((name) => name.toLowerCase().endsWith(".dcm"))
      .sort((left, right) => left.localeCompare(right, "en"));
    expect(names).toHaveLength(manifest.download.expectedDicomFiles);
    expect(report.dicomFiles).toBe(names.length);
    expect(report.dimensions).toEqual(manifest.expected.dimensions);
    expect(report.transferSyntax).toBe(manifest.download.jpeg2000Lossless.transferSyntax);
    expect(report.dicomBytes).toBe(manifest.download.jpeg2000Lossless.expectedBytes);
    expect(report.dicomContentSha256).toBe(
      manifest.download.jpeg2000Lossless.dicomContentSha256
    );
    expect(report.encodingEvidence.claimLimit).toMatch(/not independent-codec/);

    const contentFingerprint = createHash("sha256");
    let sourceBytes = 0;
    const sources: DicomFileSource[] = names.map((name) => ({
      async arrayBuffer() {
        const bytes = await readFile(path.join(dicomDir, name));
        sourceBytes += bytes.length;
        contentFingerprint.update(`${createHash("sha256").update(bytes).digest("hex")}\n`, "utf8");
        return exactArrayBuffer(bytes);
      }
    }));
    const startedAt = performance.now();
    const processor = await LocalDicomProcessor.openFiles(
      sources,
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    const intakeMs = performance.now() - startedAt;
    expect(contentFingerprint.digest("hex")).toBe(report.dicomContentSha256);
    expect(sourceBytes).toBe(report.dicomBytes);
    expect(processor.summary.dimensions).toEqual(manifest.expected.dimensions);
    expect(processor.summary.selectedSliceCount).toBe(names.length);

    const proposal = manifest.expected.proposalOverlay;
    const axial = processor.renderSourcePlane({
      plane: "axial",
      planeIndex: proposal.sliceNumber - 1,
      windowCenterHu: 300,
      windowWidthHu: 700,
      overlay: "proposal"
    });
    const cyan = cyanEvidence(axial.rgba, axial.width);
    expect(cyan.count).toBeGreaterThanOrEqual(proposal.cyanPixelCount[0]);
    expect(cyan.count).toBeLessThanOrEqual(proposal.cyanPixelCount[1]);
    for (const key of ["minColumn", "maxColumn", "minRow", "maxRow"] as const) {
      expect(cyan[key]).toBeGreaterThanOrEqual(proposal.cyanBounds[key][0]);
      expect(cyan[key]).toBeLessThanOrEqual(proposal.cyanBounds[key][1]);
    }

    const tracked = manifest.expected.seededTrack;
    const seed = {
      sliceIndex: tracked.seed.sliceNumber - 1,
      row: tracked.seed.row,
      column: tracked.seed.column
    };
    const result = processor.segmentFromSeed(seed, DEFAULT_VESSEL_SEGMENTATION_SETTINGS);
    expect(result.summary.segmentedSliceCount).toBeGreaterThanOrEqual(tracked.minimumCenterlineSamples);
    expect(result.summary.segmentedSliceCount).toBeLessThanOrEqual(tracked.maximumCenterlineSamples);
    for (const plane of ["patient-coronal", "patient-sagittal"] as const) {
      const frame = processor.renderSourcePlane({
        plane,
        locator: { kind: "through-voxel", voxel: seed },
        windowCenterHu: 300,
        windowWidthHu: 700,
        overlay: "seeded"
      });
      expect(frame.width).toBeGreaterThan(1);
      expect(frame.height).toBeGreaterThan(1);
      expect(frame.width).toBeLessThanOrEqual(2048);
      expect(frame.height).toBeLessThanOrEqual(2048);
      expect(frame.hasOverlay).toBe(true);
      expect(frame.horizontalPixelSpacingMm).toBe(frame.verticalPixelSpacingMm);
    }

    console.log(
      `[dicom-compressed-study] ${JSON.stringify({
        files: names.length,
        sourceBytes,
        canonicalScalarBytes:
          manifest.expected.dimensions[0] *
          manifest.expected.dimensions[1] *
          manifest.expected.dimensions[2] *
          Int16Array.BYTES_PER_ELEMENT,
        intakeMs,
        centerlineSamples: result.summary.segmentedSliceCount,
        claimLimit: report.encodingEvidence.claimLimit
      })}`
    );
    processor.dispose();
  }, 120_000);
});
