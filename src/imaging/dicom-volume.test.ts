import { describe, expect, it } from "vitest";
import { buildCtVolume, type DecodedCtSlice } from "./dicom-volume";

function decodedSlices(): DecodedCtSlice[] {
  return Array.from({ length: 3 }, (_, sliceIndex) => ({
    seriesKey: "CANARY_STUDY_UID|CANARY_SERIES_UID",
    rows: 2,
    columns: 3,
    imagePositionLps: [10, 20, 30 + sliceIndex * 2],
    rowDirectionLps: [0, 1, 0],
    columnDirectionLps: [-1, 0, 0],
    pixelSpacingMm: [2, 0.5],
    photometricInterpretation: "MONOCHROME2",
    instanceNumber: sliceIndex + 1,
    pixelsHu: Int16Array.from({ length: 6 }, (_, index) => sliceIndex * 100 + index)
  }));
}

describe("canonical diagnostic CT volume", () => {
  it("takes ownership without copying and exposes identifier-free slice views", () => {
    const decoded = decodedSlices();
    const originalPixels = decoded[1].pixelsHu;
    const volume = buildCtVolume(decoded);

    expect(volume.sliceCount).toBe(3);
    expect(volume.canonicalScalarBytes).toBe(3 * 2 * 3 * Int16Array.BYTES_PER_ELEMENT);
    expect(volume.getSlice(1).pixelsHu).toBe(originalPixels);
    expect(Object.keys(volume.getSlice(1)).sort()).toEqual([
      "imagePositionLps",
      "photometricInterpretation",
      "pixelsHu"
    ]);
    expect(JSON.stringify(volume.getSlice(1))).not.toContain("CANARY");
    expect(decoded.every((slice) => slice.seriesKey === "")).toBe(true);
  });

  it("owns patient-space voxel geometry behind the same interface", () => {
    const volume = buildCtVolume(decodedSlices());

    expect(volume.rowDirectionLps).toEqual([0, 1, 0]);
    expect(volume.columnDirectionLps).toEqual([-1, 0, 0]);
    expect(volume.normalDirectionLps[0]).toBeCloseTo(0);
    expect(volume.normalDirectionLps[1]).toBeCloseTo(0);
    expect(volume.normalDirectionLps[2]).toBeCloseTo(1);
    expect(volume.voxelCenterLps(1, 1, 2)).toEqual([8, 21, 32]);
    expect(() => volume.voxelCenterLps(1, 2, 0)).toThrow(/outside/);
    expect(() => volume.getSlice(3)).toThrow(/outside/);
  });

  it("best-effort clears its only scalar representation and fails closed after disposal", () => {
    const decoded = decodedSlices();
    const ownedBuffers = decoded.map((slice) => slice.pixelsHu);
    const volume = buildCtVolume(decoded);

    volume.dispose();
    volume.dispose();

    expect(ownedBuffers.every((pixels) => pixels.every((value) => value === 0))).toBe(true);
    expect(() => volume.getSlice(0)).toThrow(/disposed/);
    expect(() => volume.voxelCenterLps(0, 0, 0)).toThrow(/disposed/);
  });
});
