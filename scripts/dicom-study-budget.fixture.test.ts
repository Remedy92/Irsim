import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalDicomProcessor,
  type DicomFileSource
} from "../src/imaging/process-dicom";
import { DEFAULT_VESSEL_SEGMENTATION_SETTINGS } from "../src/imaging/types";

interface StudyBudget {
  expectedCanonicalScalarBytes: number;
  maximumSingleSourceBytes: number;
  maximumWallTimeMs: number;
  maximumPeakRssDeltaBytes: number;
  maximumPeakArrayBufferDeltaBytes: number;
  requiresSequentialReadAndPriorBufferClearing: boolean;
}

interface DerivedManifest {
  download: { expectedDicomFiles: number; dicomContentSha256: string };
  expected: {
    dimensions: [number, number, number];
    fullStudyProductionIntakeBudget: StudyBudget;
  };
}

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(root, "fixtures/real-dicom/aortaseg60-young05-derived.json");
const dicomDir = path.resolve(
  process.env.IRSIM_CTA_DICOM_DIR ?? path.join(root, "output/fixtures/aortaseg60-young05-dicom")
);

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isZeroed(buffer: ArrayBuffer): boolean {
  return new Uint8Array(buffer).every((value) => value === 0);
}

describe("full-study production intake budget", () => {
  it("keeps the 538-slice arterial study sequential, cleared, and within broad resource ceilings", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DerivedManifest;
    const budget = manifest.expected.fullStudyProductionIntakeBudget;
    const names = (await readdir(dicomDir))
      .filter((name) => name.toLowerCase().endsWith(".dcm"))
      .sort((a, b) => a.localeCompare(b, "en"));
    expect(names).toHaveLength(manifest.download.expectedDicomFiles);

    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    gc?.();
    const baseline = process.memoryUsage();
    let peakRssBytes = baseline.rss;
    let peakArrayBufferBytes = baseline.arrayBuffers;
    let peakHeapUsedBytes = baseline.heapUsed;
    let peakExternalBytes = baseline.external;
    let previousSourceBuffer: ArrayBuffer | null = null;
    let verifiedClearedSourceBuffers = 0;
    let maximumSingleSourceBytes = 0;
    let sourceReads = 0;
    const contentFingerprint = createHash("sha256");

    const sampleMemory = () => {
      const current = process.memoryUsage();
      peakRssBytes = Math.max(peakRssBytes, current.rss);
      peakArrayBufferBytes = Math.max(peakArrayBufferBytes, current.arrayBuffers);
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, current.heapUsed);
      peakExternalBytes = Math.max(peakExternalBytes, current.external);
    };

    const sources: DicomFileSource[] = names.map((name) => ({
      async arrayBuffer() {
        if (previousSourceBuffer) {
          expect(isZeroed(previousSourceBuffer)).toBe(true);
          verifiedClearedSourceBuffers++;
          previousSourceBuffer = null;
        }
        const bytes = await readFile(path.join(dicomDir, name));
        contentFingerprint.update(`${createHash("sha256").update(bytes).digest("hex")}\n`, "utf8");
        const buffer = exactArrayBuffer(bytes);
        maximumSingleSourceBytes = Math.max(maximumSingleSourceBytes, buffer.byteLength);
        sourceReads++;
        previousSourceBuffer = buffer;
        sampleMemory();
        return buffer;
      }
    }));

    const startedAt = performance.now();
    const processor = await LocalDicomProcessor.openFiles(
      sources,
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
      sampleMemory
    );
    const wallTimeMs = performance.now() - startedAt;
    sampleMemory();

    expect(sourceReads).toBe(names.length);
    expect(contentFingerprint.digest("hex")).toBe(manifest.download.dicomContentSha256);
    expect(previousSourceBuffer).not.toBeNull();
    expect(isZeroed(previousSourceBuffer!)).toBe(true);
    verifiedClearedSourceBuffers++;
    previousSourceBuffer = null;
    expect(verifiedClearedSourceBuffers).toBe(names.length);
    expect(processor.summary.selectedSliceCount).toBe(names.length);
    expect(processor.summary.dimensions).toEqual(manifest.expected.dimensions);

    const canonicalScalarBytes =
      manifest.expected.dimensions[0] *
      manifest.expected.dimensions[1] *
      manifest.expected.dimensions[2] *
      Int16Array.BYTES_PER_ELEMENT;
    const evidence = {
      sourceReads,
      verifiedClearedSourceBuffers,
      maximumSingleSourceBytes,
      canonicalScalarBytes,
      wallTimeMs,
      baselineRssBytes: baseline.rss,
      peakRssBytes,
      peakRssDeltaBytes: Math.max(0, peakRssBytes - baseline.rss),
      baselineArrayBufferBytes: baseline.arrayBuffers,
      peakArrayBufferBytes,
      peakArrayBufferDeltaBytes: Math.max(0, peakArrayBufferBytes - baseline.arrayBuffers),
      peakHeapUsedBytes,
      peakExternalBytes
    };
    console.log(`[dicom-study-budget] ${JSON.stringify(evidence)}`);

    expect(canonicalScalarBytes).toBe(budget.expectedCanonicalScalarBytes);
    expect(maximumSingleSourceBytes).toBeLessThanOrEqual(budget.maximumSingleSourceBytes);
    expect(wallTimeMs).toBeLessThanOrEqual(budget.maximumWallTimeMs);
    expect(evidence.peakRssDeltaBytes).toBeLessThanOrEqual(budget.maximumPeakRssDeltaBytes);
    expect(evidence.peakArrayBufferDeltaBytes).toBeLessThanOrEqual(
      budget.maximumPeakArrayBufferDeltaBytes
    );
    expect(budget.requiresSequentialReadAndPriorBufferClearing).toBe(true);

    processor.dispose();
    gc?.();
  });
});
