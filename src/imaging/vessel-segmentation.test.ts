import { describe, expect, it } from "vitest";
import { buildCtVolume, type CtVolume, type DecodedCtSlice } from "./dicom-volume";
import {
  applySegmentationBrush,
  segmentAorticCenterlineFromSeed,
  type SegmentedCenterline
} from "./vessel-segmentation";
import { DEFAULT_VESSEL_SEGMENTATION_SETTINGS } from "./types";

function crowdedVolume(): CtVolume {
  const rows = 128;
  const columns = 128;
  const centers: [number, number][] = [];
  for (let gridRow = 0; gridRow < 6; gridRow++) {
    for (let gridColumn = 0; gridColumn < 10; gridColumn++) {
      centers.push([8 + gridRow * 20, 8 + gridColumn * 12]);
    }
  }
  const slices: DecodedCtSlice[] = Array.from({ length: 12 }, (_, sliceIndex) => {
    const pixelsHu = new Int16Array(rows * columns);
    pixelsHu.fill(-1000);
    for (const [centerRow, centerColumn] of centers) {
      for (let row = centerRow - 3; row <= centerRow + 3; row++) {
        for (let column = centerColumn - 3; column <= centerColumn + 3; column++) {
          if (Math.hypot(row - centerRow, column - centerColumn) <= 3) {
            pixelsHu[row * columns + column] = 320;
          }
        }
      }
    }
    return {
      seriesKey: "test",
      rows,
      columns,
      imagePositionLps: [0, 0, sliceIndex],
      rowDirectionLps: [1, 0, 0],
      columnDirectionLps: [0, 1, 0],
      pixelSpacingMm: [1, 1],
      photometricInterpretation: "MONOCHROME2",
      instanceNumber: sliceIndex + 1,
      pixelsHu
    };
  });
  return buildCtVolume(slices);
}

function annulusVolume(): CtVolume {
  const rows = 32;
  const columns = 32;
  const slices: DecodedCtSlice[] = Array.from({ length: 12 }, (_, sliceIndex) => {
    const pixelsHu = new Int16Array(rows * columns);
    pixelsHu.fill(-1000);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const radius = Math.hypot(row - 16, column - 16);
        if (radius >= 3 && radius <= 6) pixelsHu[row * columns + column] = 320;
      }
    }
    return {
      seriesKey: "annulus",
      rows,
      columns,
      imagePositionLps: [0, 0, sliceIndex],
      rowDirectionLps: [1, 0, 0],
      columnDirectionLps: [0, 1, 0],
      pixelSpacingMm: [1, 1],
      photometricInterpretation: "MONOCHROME2",
      instanceNumber: sliceIndex + 1,
      pixelsHu
    };
  });
  return buildCtVolume(slices);
}

function anisotropicBrushVolume(): CtVolume {
  const rows = 7;
  const columns = 7;
  const slices: DecodedCtSlice[] = Array.from({ length: 5 }, (_, sliceIndex) => ({
    seriesKey: "anisotropic",
    rows,
    columns,
    imagePositionLps: [0, 0, sliceIndex * 3],
    rowDirectionLps: [1, 0, 0],
    columnDirectionLps: [0, 1, 0],
    pixelSpacingMm: [2, 1],
    photometricInterpretation: "MONOCHROME2",
    instanceNumber: sliceIndex + 1,
    pixelsHu: new Int16Array(rows * columns)
  }));
  return buildCtVolume(slices);
}

function thinTrackedLabelmap(): SegmentedCenterline {
  const voxelPoints = Array.from({ length: 5 }, (_, sliceIndex) => ({
    sliceIndex,
    row: 3,
    column: 3
  }));
  return {
    pointsLpsMm: voxelPoints.map((point) => [3, 6, point.sliceIndex * 3] as [number, number, number]),
    radiiMm: voxelPoints.map(() => 1),
    voxelPoints,
    sliceIndices: voxelPoints.map((point) => point.sliceIndex),
    components: voxelPoints.map((point) => ({ sliceIndex: point.sliceIndex, spans: [[3, 3, 3]] })),
    seed: { sliceIndex: 2, row: 3, column: 3 },
    confidence: "high",
    warnings: []
  };
}

describe("operator-seeded vessel tracking", () => {
  it("retains continuity for a seeded corner component in a slice with more than 48 valid candidates", () => {
    const segmentation = segmentAorticCenterlineFromSeed(
      crowdedVolume(),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
      { sliceIndex: 6, row: 8, column: 8 }
    );

    expect(segmentation.voxelPoints).toHaveLength(12);
    expect(segmentation.voxelPoints.every((point) => Math.abs(point.row - 8) < 0.1)).toBe(true);
    expect(segmentation.voxelPoints.every((point) => Math.abs(point.column - 8) < 0.1)).toBe(true);
  });

  it("emits exact per-row runs instead of painting across holes in a connected component", () => {
    const segmentation = segmentAorticCenterlineFromSeed(
      annulusVolume(),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
      { sliceIndex: 6, row: 16, column: 10 }
    );
    const centerRowSpans = segmentation.components
      .find((component) => component.sliceIndex === 6)!
      .spans.filter(([row]) => row === 16);

    expect(centerRowSpans).toEqual([
      [16, 10, 13],
      [16, 19, 22]
    ]);
  });

  it("uses physical millimetres for a bounded 3D brush on anisotropic voxels", () => {
    const edited = applySegmentationBrush(
      anisotropicBrushVolume(),
      thinTrackedLabelmap(),
      { sliceIndex: 2, row: 3, column: 4 },
      "add",
      2
    );

    expect(edited.affectedSliceCount).toBe(1);
    expect(edited.changedVoxelCount).toBe(6);
    expect(edited.segmentation.components.find((component) => component.sliceIndex === 2)?.spans).toEqual([
      [2, 4, 4],
      [3, 2, 6],
      [4, 4, 4]
    ]);
    expect(edited.segmentation.components.find((component) => component.sliceIndex === 1)?.spans).toEqual([
      [3, 3, 3]
    ]);
  });
});
