import { describe, expect, it } from "vitest";
import { buildCtVolume, type DecodedCtSlice } from "./dicom-volume";
import { renderSourceReview, sourceVoxelFromRenderedFrame } from "./source-plane-review";
import type { SegmentedCenterline } from "./vessel-segmentation";

function volume() {
  const slices: DecodedCtSlice[] = Array.from({ length: 3 }, (_, sliceIndex) => ({
    seriesKey: "test",
    rows: 3,
    columns: 4,
    imagePositionLps: [0, 0, sliceIndex * 3],
    rowDirectionLps: [1, 0, 0],
    columnDirectionLps: [0, 1, 0],
    pixelSpacingMm: [2, 1],
    photometricInterpretation: "MONOCHROME2",
    instanceNumber: sliceIndex + 1,
    pixelsHu: Int16Array.from({ length: 12 }, (_, index) => sliceIndex * 100 + index)
  }));
  return buildCtVolume(slices);
}

function segmentation(): SegmentedCenterline {
  return {
    pointsLpsMm: [[2, 2, 0], [2, 2, 3], [2, 2, 6]],
    radiiMm: [1, 1, 1],
    voxelPoints: [0, 1, 2].map((sliceIndex) => ({ sliceIndex, row: 1, column: 2 })),
    sliceIndices: [0, 1, 2],
    components: [0, 1, 2].map((sliceIndex) => ({
      sliceIndex,
      spans: [[1, 1, 2] as [number, number, number]]
    })),
    seed: { sliceIndex: 1, row: 1, column: 2 },
    confidence: "high",
    warnings: []
  };
}

describe("unified source-plane review", () => {
  it("renders axial through one frame interface and maps clicks without exporting geometry", () => {
    const sourceVolume = volume();
    const rendered = renderSourceReview(
      sourceVolume,
      segmentation(),
      {
        plane: "axial",
        planeIndex: 1,
        windowCenterHu: 100,
        windowWidthHu: 400,
        overlay: "seeded"
      },
      11
    );

    expect(rendered.frame).toMatchObject({
      frameToken: 11,
      plane: "axial",
      planeIndex: 1,
      planeCount: 3,
      width: 4,
      height: 3,
      hasOverlay: true
    });
    expect(Object.keys(rendered.frame)).not.toContain("topSliceIndex");
    expect(
      sourceVoxelFromRenderedFrame(sourceVolume, rendered.mapping, {
        frameToken: 11,
        imageRow: 2,
        imageColumn: 3
      })
    ).toEqual({ sliceIndex: 1, row: 2, column: 3 });
  });

  it("uses the same opaque frame interface for seed-aligned patient coronal and sagittal MPR", () => {
    const sourceVolume = volume();
    const seed = segmentation().seed!;
    const coronal = renderSourceReview(
      sourceVolume,
      segmentation(),
      {
        plane: "patient-coronal",
        locator: { kind: "through-voxel", voxel: seed },
        windowCenterHu: 100,
        windowWidthHu: 400,
        overlay: "seeded"
      },
      12
    );
    const sagittal = renderSourceReview(
      sourceVolume,
      segmentation(),
      {
        plane: "patient-sagittal",
        locator: { kind: "through-voxel", voxel: seed },
        windowCenterHu: 100,
        windowWidthHu: 400,
        overlay: "seeded"
      },
      13
    );

    expect(coronal.frame).toMatchObject({
      plane: "patient-coronal",
      width: 4,
      height: 9,
      orientationLabels: { top: "H", bottom: "F", left: "R", right: "L" }
    });
    expect(sagittal.frame).toMatchObject({
      plane: "patient-sagittal",
      width: 6,
      height: 9,
      orientationLabels: { top: "H", bottom: "F", left: "A", right: "P" }
    });
    if (coronal.mapping.plane === "axial" || sagittal.mapping.plane === "axial") {
      throw new Error("expected patient MPR mappings");
    }
    const seedPoint = sourceVolume.voxelCenterLps(seed.sliceIndex, seed.row, seed.column);
    const imagePointFor = (mapping: typeof coronal.mapping.frame) => {
      const relative = seedPoint.map((value, axis) => value - mapping.originLps[axis]);
      return {
        imageRow: Math.round(
          relative.reduce((sum, value, axis) => sum + value * mapping.verticalDirectionLps[axis], 0) /
            mapping.spacingMm
        ),
        imageColumn: Math.round(
          relative.reduce((sum, value, axis) => sum + value * mapping.horizontalDirectionLps[axis], 0) /
            mapping.spacingMm
        )
      };
    };
    expect(
      sourceVoxelFromRenderedFrame(sourceVolume, coronal.mapping, {
        frameToken: 12,
        ...imagePointFor(coronal.mapping.frame)
      })
    ).toEqual({ sliceIndex: 1, row: 1, column: 2 });
    expect(
      sourceVoxelFromRenderedFrame(sourceVolume, sagittal.mapping, {
        frameToken: 13,
        ...imagePointFor(sagittal.mapping.frame)
      })
    ).toEqual({ sliceIndex: 1, row: 1, column: 2 });
  });

  it("fails closed for invalid tokens, planes, and selections", () => {
    expect(() =>
      renderSourceReview(
        volume(),
        null,
        {
          plane: "oblique" as never,
          locator: { kind: "center" },
          windowCenterHu: 100,
          windowWidthHu: 400,
          overlay: "proposal"
        },
        0
      )
    ).toThrow(/token/);
    expect(() =>
      renderSourceReview(
        volume(),
        null,
        {
          plane: "oblique" as never,
          locator: { kind: "center" },
          windowCenterHu: 100,
          windowWidthHu: 400,
          overlay: "proposal"
        },
        1
      )
    ).toThrow(/unsupported/);

    const rendered = renderSourceReview(
      volume(),
      null,
      {
        plane: "axial",
        planeIndex: 0,
        windowCenterHu: 100,
        windowWidthHu: 400,
        overlay: "proposal"
      },
      1
    );
    expect(() =>
      sourceVoxelFromRenderedFrame(volume(), rendered.mapping, {
        frameToken: 1,
        imageRow: Number.NaN,
        imageColumn: 0
      })
    ).toThrow(/invalid/);
  });
});
