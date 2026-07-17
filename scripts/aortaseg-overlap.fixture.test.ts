import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildCtVolume, decodeCtSlice, type CtVolume } from "../src/imaging/dicom-volume";
import { EditableSegmentationReview } from "../src/imaging/segmentation-review";
import { DEFAULT_VESSEL_SEGMENTATION_SETTINGS } from "../src/imaging/types";
import {
  segmentAorticCenterlineFromSeed,
  type SegmentedCenterline
} from "../src/imaging/vessel-segmentation";

interface DerivedManifest {
  download: {
    expectedDicomFiles: number;
    dicomContentSha256: string;
  };
  expected: {
    dimensions: [number, number, number];
    seededTrack: {
      seed: { sliceNumber: number; row: number; column: number };
      sourceMaskMedianHu: number;
      minimumCenterlineSamples: number;
      maximumCenterlineSamples?: number;
      minimumCoveragePercent: number;
      maximumCoveragePercent?: number;
      referenceMaskAcceptance?: {
        minimumReferenceSliceCoveragePercent: number;
        minimumTrackedSliceReferenceRecall: number;
        minimumTrackedSliceDice: number;
        minimumLabelmapPrecisionInReferenceSliceRange: number;
        minimumCenterlineInsideMaskInReferenceSliceRangePercent: number;
      };
    };
  };
}

interface SourceManifest {
  entries: {
    image: { outputName: string; sha256: string };
    mask: { outputName: string; sha256: string };
  };
  niftiExpected: {
    dimensions: [number, number, number];
    rescaleSlope: number;
    rescaleInterceptHu: number;
    maskVoxels: number;
    maskVoxelBounds: [number, number, number, number, number, number];
  };
}

const root = path.resolve(import.meta.dirname, "..");
const derivedManifestPath = path.join(root, "fixtures/real-dicom/aortaseg60-young05-derived.json");
const sourceManifestPath = path.join(root, "fixtures/real-dicom/aortaseg60-young05-source.json");
const dicomDir = path.resolve(
  process.env.IRSIM_CTA_DICOM_DIR ?? path.join(root, "output/fixtures/aortaseg60-young05-dicom")
);
const sourceDir = path.resolve(
  process.env.IRSIM_CTA_SOURCE_DIR ?? path.join(root, "output/fixtures/aortaseg60-young05-source")
);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function loadDerivedVolume(manifest: DerivedManifest): Promise<CtVolume> {
  const names = (await readdir(dicomDir))
    .filter((name) => name.toLowerCase().endsWith(".dcm"))
    .sort((a, b) => a.localeCompare(b, "en"));
  expect(names).toHaveLength(manifest.download.expectedDicomFiles);
  const contentFingerprint = createHash("sha256");
  const slices = [];
  for (const name of names) {
    const bytes = await readFile(path.join(dicomDir, name));
    contentFingerprint.update(`${sha256(bytes)}\n`, "utf8");
    const exactBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    slices.push(await decodeCtSlice(exactBuffer));
  }
  expect(contentFingerprint.digest("hex")).toBe(manifest.download.dicomContentSha256);
  return buildCtVolume(slices);
}

async function loadMask(source: SourceManifest): Promise<Uint8Array> {
  const compressed = await readFile(path.join(sourceDir, source.entries.mask.outputName));
  expect(sha256(compressed)).toBe(source.entries.mask.sha256);
  const nifti = gunzipSync(compressed);
  expect(nifti.readInt32LE(0)).toBe(348);
  expect(nifti.subarray(344, 348).toString("binary")).toBe("n+1\0");
  expect(nifti.readInt16LE(40)).toBe(3);
  expect(nifti.readInt16LE(70)).toBe(2);
  expect(nifti.readInt16LE(72)).toBe(8);
  const dimensions = [nifti.readInt16LE(42), nifti.readInt16LE(44), nifti.readInt16LE(46)];
  expect(dimensions).toEqual(source.niftiExpected.dimensions);
  const voxelOffset = nifti.readFloatLE(108);
  expect(Number.isInteger(voxelOffset)).toBe(true);
  const mask = nifti.subarray(voxelOffset);
  expect(mask).toHaveLength(dimensions[0] * dimensions[1] * dimensions[2]);
  return mask;
}

async function verifyEverySourceVoxel(volume: CtVolume, source: SourceManifest): Promise<number> {
  const compressed = await readFile(path.join(sourceDir, source.entries.image.outputName));
  expect(sha256(compressed)).toBe(source.entries.image.sha256);
  const nifti = gunzipSync(compressed);
  expect(nifti.readInt32LE(0)).toBe(348);
  expect(nifti.subarray(344, 348).toString("binary")).toBe("n+1\0");
  expect(nifti.readInt16LE(40)).toBe(3);
  expect(nifti.readInt16LE(70)).toBe(4);
  expect(nifti.readInt16LE(72)).toBe(16);
  const dimensions = [nifti.readInt16LE(42), nifti.readInt16LE(44), nifti.readInt16LE(46)];
  expect(dimensions).toEqual(source.niftiExpected.dimensions);
  const voxelOffset = nifti.readFloatLE(108);
  const slope = nifti.readFloatLE(112) || 1;
  const intercept = nifti.readFloatLE(116);
  expect(slope).toBe(source.niftiExpected.rescaleSlope);
  expect(intercept).toBe(source.niftiExpected.rescaleInterceptHu);
  const [width, height, depth] = source.niftiExpected.dimensions;
  const sourcePixels = nifti.subarray(voxelOffset);
  expect(sourcePixels).toHaveLength(width * height * depth * 2);
  let verified = 0;
  for (let sliceIndex = 0; sliceIndex < depth; sliceIndex++) {
    const decoded = volume.getSlice(sliceIndex).pixelsHu;
    for (let storedRow = 0; storedRow < height; storedRow++) {
      const sourceRow = height - 1 - storedRow;
      const sourceBase = (sliceIndex * width * height + sourceRow * width) * 2;
      const decodedBase = storedRow * width;
      for (let column = 0; column < width; column++) {
        const stored = sourcePixels.readInt16LE(sourceBase + column * 2);
        const expectedHu = Math.max(-32768, Math.min(32767, Math.round(stored * slope + intercept)));
        if (decoded[decodedBase + column] !== expectedHu) {
          throw new Error(
            `Derived DICOM HU mismatch at source voxel (${column},${sourceRow},${sliceIndex}): ` +
              `${decoded[decodedBase + column]} !== ${expectedHu}`
          );
        }
        verified++;
      }
    }
  }
  return verified;
}

function maskIndex(
  dimensions: readonly number[],
  sliceIndex: number,
  storedDicomRow: number,
  column: number
): number {
  const [width, height] = dimensions;
  const sourceNiftiRow = height - 1 - storedDicomRow;
  return sliceIndex * width * height + sourceNiftiRow * width + column;
}

function measureOverlap(
  segmentation: SegmentedCenterline,
  mask: Uint8Array,
  dimensions: readonly [number, number, number],
  seedHu: number
) {
  const [width, height, depth] = dimensions;
  let segmentedVoxels = 0;
  let intersectionVoxels = 0;
  const trackedSlices = new Set(segmentation.components.map((component) => component.sliceIndex));
  const referenceVoxelsBySlice = new Uint32Array(depth);
  let maskVoxels = 0;
  for (let sliceIndex = 0; sliceIndex < depth; sliceIndex++) {
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        if (mask[maskIndex(dimensions, sliceIndex, row, column)] === 0) continue;
        referenceVoxelsBySlice[sliceIndex]++;
        maskVoxels++;
      }
    }
  }
  const referenceSlices = [...referenceVoxelsBySlice.keys()].filter((sliceIndex) => referenceVoxelsBySlice[sliceIndex] > 0);
  const firstReferenceSlice = referenceSlices[0];
  const lastReferenceSlice = referenceSlices.at(-1)!;
  let segmentedVoxelsInReferenceSliceRange = 0;
  let intersectionVoxelsInReferenceSliceRange = 0;
  for (const component of segmentation.components) {
    for (const [row, firstColumn, lastColumn] of component.spans) {
      segmentedVoxels += lastColumn - firstColumn + 1;
      if (component.sliceIndex >= firstReferenceSlice && component.sliceIndex <= lastReferenceSlice) {
        segmentedVoxelsInReferenceSliceRange += lastColumn - firstColumn + 1;
      }
      for (let column = firstColumn; column <= lastColumn; column++) {
        if (mask[maskIndex(dimensions, component.sliceIndex, row, column)] !== 0) {
          intersectionVoxels++;
          intersectionVoxelsInReferenceSliceRange++;
        }
      }
    }
  }
  const referenceVoxelsOnTrackedSlices = referenceVoxelsBySlice.reduce(
    (sum, count, sliceIndex) => sum + (trackedSlices.has(sliceIndex) ? count : 0),
    0
  );
  const trackedReferenceSliceCount = referenceSlices.filter((sliceIndex) => trackedSlices.has(sliceIndex)).length;
  let centerlinePointsInsideMask = 0;
  let centerlinePointsInReferenceSliceRange = 0;
  let centerlinePointsInsideMaskInReferenceSliceRange = 0;
  const insideSlices: number[] = [];
  for (const point of segmentation.voxelPoints) {
    const row = Math.max(0, Math.min(height - 1, Math.round(point.row)));
    const column = Math.max(0, Math.min(width - 1, Math.round(point.column)));
    const inReferenceSliceRange = point.sliceIndex >= firstReferenceSlice && point.sliceIndex <= lastReferenceSlice;
    if (inReferenceSliceRange) centerlinePointsInReferenceSliceRange++;
    if (mask[maskIndex(dimensions, point.sliceIndex, row, column)] !== 0) {
      centerlinePointsInsideMask++;
      if (inReferenceSliceRange) centerlinePointsInsideMaskInReferenceSliceRange++;
      insideSlices.push(point.sliceIndex);
    }
  }
  return {
    seedHu,
    samples: segmentation.pointsLpsMm.length,
    sourceSliceRange: [segmentation.sliceIndices[0], segmentation.sliceIndices.at(-1)],
    referenceSourceSliceRange: [firstReferenceSlice, lastReferenceSlice],
    insideSourceSliceRange: insideSlices.length ? [Math.min(...insideSlices), Math.max(...insideSlices)] : null,
    coveragePercent: (segmentation.pointsLpsMm.length / depth) * 100,
    segmentedVoxels,
    referenceMaskVoxels: maskVoxels,
    intersectionVoxels,
    labelmapPrecision: intersectionVoxels / segmentedVoxels,
    fullMaskRecall: intersectionVoxels / maskVoxels,
    dice: (2 * intersectionVoxels) / (segmentedVoxels + maskVoxels),
    centerlineInsideMaskPercent: (centerlinePointsInsideMask / segmentation.voxelPoints.length) * 100,
    referenceVoxelsOnTrackedSlices,
    trackedReferenceSliceCount,
    referenceSliceCoveragePercent: (trackedReferenceSliceCount / referenceSlices.length) * 100,
    trackedSliceReferenceRecall: intersectionVoxels / referenceVoxelsOnTrackedSlices,
    trackedSliceDice:
      (2 * intersectionVoxels) / (segmentedVoxelsInReferenceSliceRange + referenceVoxelsOnTrackedSlices),
    labelmapPrecisionInReferenceSliceRange:
      intersectionVoxelsInReferenceSliceRange / segmentedVoxelsInReferenceSliceRange,
    centerlineInsideMaskInReferenceSliceRangePercent:
      (centerlinePointsInsideMaskInReferenceSliceRange / centerlinePointsInReferenceSliceRange) * 100
  };
}

function referenceSeedForSlice(
  volume: CtVolume,
  mask: Uint8Array,
  dimensions: readonly [number, number, number],
  sliceIndex: number
) {
  const [width, height] = dimensions;
  let rowSum = 0;
  let columnSum = 0;
  let count = 0;
  const eligible: { row: number; column: number; hu: number }[] = [];
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      if (mask[maskIndex(dimensions, sliceIndex, row, column)] === 0) continue;
      rowSum += row;
      columnSum += column;
      count++;
      const hu = volume.getSlice(sliceIndex).pixelsHu[row * width + column];
      if (hu >= DEFAULT_VESSEL_SEGMENTATION_SETTINGS.huMin && hu <= DEFAULT_VESSEL_SEGMENTATION_SETTINGS.huMax) {
        eligible.push({ row, column, hu });
      }
    }
  }
  if (!count || !eligible.length) return null;
  const centroid = { row: rowSum / count, column: columnSum / count };
  const selected = eligible.reduce((best, item) =>
    Math.hypot(item.row - centroid.row, item.column - centroid.column) <
    Math.hypot(best.row - centroid.row, best.column - centroid.column)
      ? item
      : best
  );
  return { sliceIndex, row: selected.row, column: selected.column, hu: selected.hu };
}

describe("AortaSeg-60 Young_05 derived DICOM evidence", () => {
  it("round-trips through the production decoder and quantifies seeded overlap with the pinned mask", async () => {
    const derived = JSON.parse(await readFile(derivedManifestPath, "utf8")) as DerivedManifest;
    const source = JSON.parse(await readFile(sourceManifestPath, "utf8")) as SourceManifest;
    const volume = await loadDerivedVolume(derived);
    const verifiedHuVoxels = await verifyEverySourceVoxel(volume, source);
    const mask = await loadMask(source);
    const [width, height, depth] = derived.expected.dimensions;

    expect([volume.columns, volume.rows, volume.sliceCount]).toEqual([width, height, depth]);
    expect(verifiedHuVoxels).toBe(width * height * depth);
    expect(volume.columnSpacingMm).toBeCloseTo(0.4902339876, 6);
    expect(volume.rowSpacingMm).toBeCloseTo(0.4902339876, 6);
    expect(volume.sliceSpacingMm).toBeCloseTo(1.25, 6);
    expect(volume.rowDirectionLps).toEqual([1, 0, 0]);
    expect(volume.columnDirectionLps).toEqual([0, 1, 0]);
    expect(volume.normalDirectionLps).toEqual([0, 0, 1]);
    expect(volume.getSlice(0).imagePositionLps[0]).toBeCloseTo(-121.0039978, 5);
    expect(volume.getSlice(0).imagePositionLps[1]).toBeCloseTo(-125.5000004, 5);
    expect(volume.getSlice(0).imagePositionLps[2]).toBeCloseTo(-658.0980225, 5);

    const configuredSeed = derived.expected.seededTrack.seed;
    const seed = {
      sliceIndex: configuredSeed.sliceNumber - 1,
      row: configuredSeed.row,
      column: configuredSeed.column
    };
    const seedMaskIndex = maskIndex(derived.expected.dimensions, seed.sliceIndex, seed.row, seed.column);
    expect(mask[seedMaskIndex]).toBeGreaterThan(0);
    const seedHu = volume.getSlice(seed.sliceIndex).pixelsHu[seed.row * width + seed.column];
    expect(seedHu).toBeGreaterThanOrEqual(DEFAULT_VESSEL_SEGMENTATION_SETTINGS.huMin);
    expect(seedHu).toBeLessThanOrEqual(DEFAULT_VESSEL_SEGMENTATION_SETTINGS.huMax);

    const segmentation = segmentAorticCenterlineFromSeed(
      volume,
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
      seed
    );
    const review = new EditableSegmentationReview(
      volume,
      segmentation,
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    ).review;
    expect(review.topologyStatus).toBe("pass");
    expect(segmentation.pointsLpsMm.length).toBeGreaterThanOrEqual(
      derived.expected.seededTrack.minimumCenterlineSamples
    );
    if (derived.expected.seededTrack.maximumCenterlineSamples !== undefined) {
      expect(segmentation.pointsLpsMm.length).toBeLessThanOrEqual(
        derived.expected.seededTrack.maximumCenterlineSamples
      );
    }
    expect((segmentation.pointsLpsMm.length / depth) * 100).toBeGreaterThanOrEqual(
      derived.expected.seededTrack.minimumCoveragePercent
    );
    if (derived.expected.seededTrack.maximumCoveragePercent !== undefined) {
      expect((segmentation.pointsLpsMm.length / depth) * 100).toBeLessThanOrEqual(
        derived.expected.seededTrack.maximumCoveragePercent
      );
    }

    const evidence = {
      verifiedHuVoxels,
      ...measureOverlap(segmentation, mask, derived.expected.dimensions, seedHu)
    };
    expect(evidence.referenceMaskVoxels).toBe(source.niftiExpected.maskVoxels);
    console.log(`[aortaseg-overlap] ${JSON.stringify(evidence)}`);

    if (process.env.IRSIM_CTA_DIAGNOSTIC_SWEEP === "1") {
      for (const maxCenterJumpMm of [4, 6, 8, 10, 12]) {
        for (const [huMin, huMax] of [[120, 650], [140, 650], [160, 500], [160, 650], [160, 800], [180, 650]]) {
          try {
            const settings = {
              ...DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
              huMin,
              huMax,
              maxCenterJumpMm
            };
            const variant = segmentAorticCenterlineFromSeed(volume, settings, seed);
            console.log(
              `[aortaseg-sweep] ${JSON.stringify({ settings, ...measureOverlap(variant, mask, derived.expected.dimensions, seedHu) })}`
            );
          } catch (error) {
            console.log(`[aortaseg-sweep] ${JSON.stringify({ huMin, huMax, maxCenterJumpMm, error: String(error) })}`);
          }
        }
      }
    }
    if (process.env.IRSIM_CTA_DIAGNOSTIC_SEEDS === "1") {
      for (const sliceIndex of [200, 220, 250, 275, 300, 325, 350, 375, 400, 425, 450, 475]) {
        const referenceSeed = referenceSeedForSlice(volume, mask, derived.expected.dimensions, sliceIndex);
        if (!referenceSeed) {
          console.log(`[aortaseg-seed] ${JSON.stringify({ sliceIndex, error: "no in-range reference voxel" })}`);
          continue;
        }
        try {
          const variant = segmentAorticCenterlineFromSeed(
            volume,
            DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
            referenceSeed
          );
          console.log(
            `[aortaseg-seed] ${JSON.stringify({ referenceSeed, ...measureOverlap(variant, mask, derived.expected.dimensions, referenceSeed.hu) })}`
          );
        } catch (error) {
          console.log(`[aortaseg-seed] ${JSON.stringify({ referenceSeed, error: String(error) })}`);
        }
      }
    }

    const acceptance = derived.expected.seededTrack.referenceMaskAcceptance;
    if (acceptance) {
      expect(evidence.referenceSliceCoveragePercent).toBeGreaterThanOrEqual(
        acceptance.minimumReferenceSliceCoveragePercent
      );
      expect(evidence.trackedSliceReferenceRecall).toBeGreaterThanOrEqual(
        acceptance.minimumTrackedSliceReferenceRecall
      );
      expect(evidence.trackedSliceDice).toBeGreaterThanOrEqual(acceptance.minimumTrackedSliceDice);
      expect(evidence.labelmapPrecisionInReferenceSliceRange).toBeGreaterThanOrEqual(
        acceptance.minimumLabelmapPrecisionInReferenceSliceRange
      );
      expect(evidence.centerlineInsideMaskInReferenceSliceRangePercent).toBeGreaterThanOrEqual(
        acceptance.minimumCenterlineInsideMaskInReferenceSliceRangePercent
      );
    }
    await writeFile(
      path.join(dicomDir, "REFERENCE-OVERLAP.json"),
      `${JSON.stringify(
        {
          fixture: "aortaseg60-v1.1-young-05-derived-dicom",
          scope:
            "Engineering regression against the uncorrected TotalSegmentator aorta mask on source slices where both the seeded track and reference mask exist; not clinical or whole-aorta validation.",
          settings: DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
          acceptance,
          evidence
        },
        null,
        2
      )}\n`
    );
  });
});
