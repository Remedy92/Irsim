import { describe, expect, it } from "vitest";
import { buildCtVolume, type CtVolume, type DecodedCtSlice } from "./dicom-volume";
import {
  patientMprPlaneIndexForVoxel,
  renderPatientMprReview,
  sourceVoxelFromPatientMprPoint,
  type PatientMprFrameMapping
} from "./patient-mpr";
import type { SegmentedCenterline } from "./vessel-segmentation";

type Point3 = readonly [number, number, number];

function dot(a: Point3, b: Point3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function pointAt(mapping: PatientMprFrameMapping, imageRow: number, imageColumn: number): [number, number, number] {
  return [0, 1, 2].map(
    (axis) =>
      mapping.originLps[axis] +
      mapping.horizontalDirectionLps[axis] * imageColumn * mapping.spacingMm +
      mapping.verticalDirectionLps[axis] * imageRow * mapping.spacingMm
  ) as [number, number, number];
}

function displayedPointForVoxel(volume: CtVolume, mapping: PatientMprFrameMapping, voxel: { sliceIndex: number; row: number; column: number }) {
  const point = volume.voxelCenterLps(voxel.sliceIndex, voxel.row, voxel.column);
  const relative = point.map((value, axis) => value - mapping.originLps[axis]) as [number, number, number];
  return {
    imageRow: Math.round(dot(relative, mapping.verticalDirectionLps) / mapping.spacingMm),
    imageColumn: Math.round(dot(relative, mapping.horizontalDirectionLps) / mapping.spacingMm)
  };
}

function windowByte(value: number, center: number, width: number): number {
  const lower = center - 0.5 - (width - 1) / 2;
  const upper = center - 0.5 + (width - 1) / 2;
  if (value <= lower) return 0;
  if (value > upper) return 255;
  return Math.round(((value - (center - 0.5)) / (width - 1) + 0.5) * 255);
}

function axisAlignedVolume(photometric: "MONOCHROME1" | "MONOCHROME2" = "MONOCHROME2"): CtVolume {
  return buildCtVolume(
    Array.from({ length: 4 }, (_, sliceIndex): DecodedCtSlice => ({
      seriesKey: "patient-mpr",
      rows: 5,
      columns: 6,
      imagePositionLps: [0, 0, sliceIndex * 2],
      rowDirectionLps: [1, 0, 0],
      columnDirectionLps: [0, 1, 0],
      pixelSpacingMm: [1, 1],
      photometricInterpretation: photometric,
      instanceNumber: sliceIndex + 1,
      pixelsHu: Int16Array.from(
        { length: 30 },
        (_, offset) => sliceIndex * 100 + Math.floor(offset / 6) * 10 + (offset % 6)
      )
    }))
  );
}

function tiltedVolume(): { volume: CtVolume; positions: number[]; origins: Point3[] } {
  const diagonal = Math.SQRT1_2;
  const rowDirection: [number, number, number] = [diagonal, diagonal, 0];
  const columnDirection: [number, number, number] = [0, 0, 1];
  const normal: [number, number, number] = [diagonal, -diagonal, 0];
  const positions = [0, 2, 4.1, 6.1];
  const origins = positions.map((position, sliceIndex) => {
    const drift = sliceIndex * 0.2;
    return [
      normal[0] * position + rowDirection[0] * drift,
      normal[1] * position + rowDirection[1] * drift,
      0
    ] as [number, number, number];
  });
  const volume = buildCtVolume(
    origins.map((imagePositionLps, sliceIndex): DecodedCtSlice => ({
      seriesKey: "tilted-patient-mpr",
      rows: 5,
      columns: 6,
      imagePositionLps,
      rowDirectionLps: rowDirection,
      columnDirectionLps: columnDirection,
      pixelSpacingMm: [1.5, 1],
      photometricInterpretation: "MONOCHROME2",
      instanceNumber: sliceIndex + 1,
      pixelsHu: Int16Array.from(
        { length: 30 },
        (_, offset) => sliceIndex * 100 + Math.floor(offset / 6) * 10 + (offset % 6)
      )
    }))
  );
  return { volume, positions, origins };
}

function expectedTiltedHu(point: Point3, positions: number[], origins: Point3[], volume: CtVolume): number {
  const position = dot(point, volume.normalDirectionLps);
  let low = 0;
  while (low + 1 < positions.length && positions[low + 1] <= position) low++;
  const high = Math.min(positions.length - 1, low + 1);
  const fraction = high === low ? 0 : (position - positions[low]) / (positions[high] - positions[low]);
  const origin = origins[low].map(
    (value, axis) => value + (origins[high][axis] - value) * fraction
  ) as [number, number, number];
  const relative = point.map((value, axis) => value - origin[axis]) as [number, number, number];
  const row = dot(relative, volume.columnDirectionLps) / volume.rowSpacingMm;
  const column = dot(relative, volume.rowDirectionLps) / volume.columnSpacingMm;
  return (low + fraction) * 100 + row * 10 + column;
}

function oneVoxelSegmentation(voxel: { sliceIndex: number; row: number; column: number }): SegmentedCenterline {
  return {
    pointsLpsMm: [[0, 0, 0]],
    radiiMm: [1],
    voxelPoints: [voxel],
    sliceIndices: [voxel.sliceIndex],
    components: [
      { sliceIndex: voxel.sliceIndex, spans: [[voxel.row, voxel.column, voxel.column]] }
    ],
    seed: { sliceIndex: 0, row: 0, column: 0 },
    confidence: "high",
    warnings: []
  };
}

describe("patient-axis MPR", () => {
  it("trilinearly samples a rotated, tilted, irregularly spaced linear phantom", () => {
    const { volume, positions, origins } = tiltedVolume();
    const target = { sliceIndex: 1, row: 2, column: 3 };
    const rendered = renderPatientMprReview(volume, null, {
      plane: "patient-coronal",
      locator: { kind: "through-voxel", voxel: target },
      windowCenterHu: 200,
      windowWidthHu: 1000
    });
    const display = displayedPointForVoxel(volume, rendered.mapping, target);
    const patientPoint = pointAt(rendered.mapping, display.imageRow, display.imageColumn);
    const expectedHu = Math.round(expectedTiltedHu(patientPoint, positions, origins, volume));
    const rgbaOffset = (display.imageRow * rendered.frame.width + display.imageColumn) * 4;
    expect(rendered.frame.rgba[rgbaOffset]).toBe(windowByte(expectedHu, 200, 1000));
    expect(rendered.frame.horizontalPixelSpacingMm).toBe(rendered.frame.verticalPixelSpacingMm);
    expect(volume.canonicalScalarBytes).toBe(4 * 5 * 6 * Int16Array.BYTES_PER_ELEMENT);
  });

  it("maps a displayed patient point back to the deterministic nearest canonical voxel", () => {
    const { volume } = tiltedVolume();
    const target = { sliceIndex: 2, row: 2, column: 3 };
    const rendered = renderPatientMprReview(volume, null, {
      plane: "patient-sagittal",
      locator: { kind: "through-voxel", voxel: target },
      windowCenterHu: 200,
      windowWidthHu: 1000
    });
    const display = displayedPointForVoxel(volume, rendered.mapping, target);
    expect(
      sourceVoxelFromPatientMprPoint(
        volume,
        rendered.mapping,
        display.imageRow,
        display.imageColumn
      )
    ).toEqual(target);
  });

  it("keeps labelmap sampling discrete and rejects clicks in tilted-volume padding", () => {
    const { volume } = tiltedVolume();
    const target = { sliceIndex: 1, row: 2, column: 3 };
    const rendered = renderPatientMprReview(volume, oneVoxelSegmentation(target), {
      plane: "patient-coronal",
      locator: { kind: "through-voxel", voxel: target },
      windowCenterHu: 200,
      windowWidthHu: 1000
    });
    expect(rendered.frame.hasOverlay).toBe(true);
    const blackOffsets: Array<[number, number]> = [];
    for (let row = 0; row < rendered.frame.height; row++) {
      for (let column = 0; column < rendered.frame.width; column++) {
        const offset = (row * rendered.frame.width + column) * 4;
        if (
          rendered.frame.rgba[offset] === 0 &&
          rendered.frame.rgba[offset + 1] === 0 &&
          rendered.frame.rgba[offset + 2] === 0
        ) {
          blackOffsets.push([row, column]);
        }
      }
    }
    expect(blackOffsets.length).toBeGreaterThan(0);
    expect(() =>
      sourceVoxelFromPatientMprPoint(volume, rendered.mapping, ...blackOffsets[0])
    ).toThrow(/outside sampled CT anatomy/);
  });

  it("uses fixed LPS labels and inferior-to-superior ordering even for a negative acquisition normal", () => {
    const volume = buildCtVolume(
      Array.from({ length: 3 }, (_, sliceIndex): DecodedCtSlice => ({
        seriesKey: "negative-normal",
        rows: 3,
        columns: 3,
        imagePositionLps: [0, 0, -sliceIndex],
        rowDirectionLps: [1, 0, 0],
        columnDirectionLps: [0, -1, 0],
        pixelSpacingMm: [1, 1],
        photometricInterpretation: "MONOCHROME2",
        instanceNumber: sliceIndex + 1,
        pixelsHu: new Int16Array(9)
      }))
    );
    expect(
      patientMprPlaneIndexForVoxel(volume, "patient-axial", { sliceIndex: 2, row: 1, column: 1 })
    ).toBeLessThan(
      patientMprPlaneIndexForVoxel(volume, "patient-axial", { sliceIndex: 0, row: 1, column: 1 })
    );
    expect(
      renderPatientMprReview(volume, null, {
        plane: "patient-axial",
        locator: { kind: "center" },
        windowCenterHu: 0,
        windowWidthHu: 400
      }).frame.orientationLabels
    ).toEqual({ top: "A", bottom: "P", left: "R", right: "L" });
  });

  it("preserves MONOCHROME1 polarity and rejects mixed presentation semantics at volume build", () => {
    const mono2 = renderPatientMprReview(axisAlignedVolume(), null, {
      plane: "patient-axial",
      locator: { kind: "center" },
      windowCenterHu: 150,
      windowWidthHu: 500
    });
    const mono1 = renderPatientMprReview(axisAlignedVolume("MONOCHROME1"), null, {
      plane: "patient-axial",
      locator: { kind: "center" },
      windowCenterHu: 150,
      windowWidthHu: 500
    });
    const validOffset = Math.floor(mono2.frame.rgba.length / 8) * 4;
    expect(mono1.frame.rgba[validOffset]).toBe(255 - mono2.frame.rgba[validOffset]);

    const slices: DecodedCtSlice[] = Array.from({ length: 3 }, (_, sliceIndex) => ({
      seriesKey: "mixed-photometric",
      rows: 2,
      columns: 2,
      imagePositionLps: [0, 0, sliceIndex],
      rowDirectionLps: [1, 0, 0],
      columnDirectionLps: [0, 1, 0],
      pixelSpacingMm: [1, 1],
      photometricInterpretation: sliceIndex === 1 ? "MONOCHROME1" : "MONOCHROME2",
      instanceNumber: sliceIndex,
      pixelsHu: new Int16Array(4)
    }));
    expect(() => buildCtVolume(slices)).toThrow(/inconsistent photometric/);
  });
});
