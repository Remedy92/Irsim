import { describe, expect, it } from "vitest";
import createOpenJpegModule from "@cornerstonejs/codec-openjpeg";
import { compileAnatomy } from "../sim/anatomyDoc";
import { Lumen } from "../sim/lumen";
import { createCtSliceDecoder, decodeCtSlice } from "./dicom-volume";
import { LocalDicomProcessor } from "./process-dicom";
import { DEFAULT_VESSEL_SEGMENTATION_SETTINGS } from "./types";

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function tag(group: number, element: number): Uint8Array {
  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, element, true);
  return bytes;
}

function binary16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function binary32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function valueBytes(vr: string, value: string | number | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "number") return binary16(value);
  const raw = encoder.encode(value);
  if (raw.length % 2 === 0) return raw;
  return concat([raw, new Uint8Array([vr === "UI" ? 0 : 32])]);
}

function element(group: number, elementNumber: number, vr: string, value: string | number | Uint8Array): Uint8Array {
  const payload = valueBytes(vr, value);
  const vrBytes = encoder.encode(vr);
  const longVr = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "UC", "UN", "UR", "UT"]);
  if (longVr.has(vr)) {
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    header.set(vrBytes, 0);
    view.setUint32(4, payload.length, true);
    return concat([tag(group, elementNumber), header, payload]);
  }
  const header = new Uint8Array(4);
  header.set(vrBytes, 0);
  new DataView(header.buffer).setUint16(2, payload.length, true);
  return concat([tag(group, elementNumber), header, payload]);
}

function item(elementNumber: number, payload: Uint8Array): Uint8Array {
  return concat([tag(0xfffe, elementNumber), binary32(payload.byteLength), payload]);
}

function encapsulatedPixelData(
  frame: Uint8Array,
  basicOffsetTable = binary32(0)
): Uint8Array {
  const paddedFrame = frame.byteLength % 2 === 0 ? frame : concat([frame, new Uint8Array(1)]);
  const header = new Uint8Array(8);
  header.set(encoder.encode("OB"), 0);
  new DataView(header.buffer).setUint32(4, 0xffffffff, true);
  return concat([
    tag(0x7fe0, 0x0010),
    header,
    item(0xe000, basicOffsetTable),
    item(0xe000, paddedFrame),
    item(0xe0dd, new Uint8Array(0))
  ]);
}

function jp2CodestreamBox(frame: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, frame.byteLength + header.byteLength, false);
  view.setUint32(4, 0x6a703263, false); // "jp2c"
  return concat([header, frame]);
}

function syntheticStoredPixelBytes(
  index: number,
  secondTube = false,
  includeVessel = true,
  signed = false
): Uint8Array {
  const rows = 64;
  const columns = 64;
  const stored = new Uint16Array(rows * columns);
  const centerColumn = 32 + Math.round(Math.sin(index / 5) * 2);
  const centerRow = 35;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const inVessel = includeVessel && Math.hypot(column - centerColumn, row - centerRow) <= 5;
      const secondColumn = 45 + Math.round(Math.cos(index / 3) * 4);
      const inSecondVessel = secondTube && Math.hypot(column - secondColumn, row - 15) <= 4;
      const inBoneDecoy = Math.hypot(column - 12, row - 12) <= 7;
      const hu = inVessel ? 320 : inSecondVessel ? 380 : inBoneDecoy ? 1200 : -1000;
      stored[row * columns + column] = signed ? hu & 0xffff : hu + 1024;
    }
  }
  const pixelBytes = new Uint8Array(stored.byteLength);
  const pixelView = new DataView(pixelBytes.buffer);
  for (let i = 0; i < stored.length; i++) pixelView.setUint16(i * 2, stored[i], true);
  return pixelBytes;
}

const testOpenJpegModule = createOpenJpegModule({ print() {}, printErr() {} });

async function encodeSyntheticJpeg2000Frame(
  index: number,
  secondTube = false,
  includeVessel = true,
  signed = false
): Promise<Uint8Array> {
  const module = await testOpenJpegModule;
  const jpegEncoder = new module.J2KEncoder();
  try {
    jpegEncoder.getDecodedBuffer({
      width: 64,
      height: 64,
      bitsPerSample: 12,
      componentCount: 1,
      isSigned: signed
    }).set(syntheticStoredPixelBytes(index, secondTube, includeVessel, signed));
    jpegEncoder.encode();
    return Uint8Array.from(jpegEncoder.getEncodedBuffer());
  } finally {
    jpegEncoder.delete();
  }
}

function syntheticCtSlice(
  index: number,
  transferSyntax = "1.2.840.10008.1.2.1",
  seriesUid = "1.2.826.0.1.3680043.10.999.42",
  secondTube = false,
  photometric = "MONOCHROME2",
  includeVessel = true,
  encapsulatedFrame?: Uint8Array,
  signed = false,
  declaredFormat?: { bitsStored?: number; signed?: boolean },
  basicOffsetTable?: Uint8Array
): ArrayBuffer {
  const rows = 64;
  const columns = 64;
  const pixelBytes = syntheticStoredPixelBytes(index, secondTube, includeVessel, signed);

  const preamble = new Uint8Array(132);
  preamble.set(encoder.encode("DICM"), 128);
  const metaBody = concat([
    element(0x0002, 0x0001, "OB", new Uint8Array([0, 1])),
    element(0x0002, 0x0010, "UI", transferSyntax),
    element(0x0002, 0x0012, "UI", "1.2.826.0.1.3680043.10.999")
  ]);
  const groupLength = new Uint8Array(4);
  new DataView(groupLength.buffer).setUint32(0, metaBody.length, true);
  const meta = concat([element(0x0002, 0x0000, "UL", groupLength), metaBody]);
  const dataSet = concat([
    element(0x0008, 0x0060, "CS", "CT"),
    element(0x0010, 0x0010, "PN", "CANARY^PATIENT"),
    element(0x0020, 0x000d, "UI", "1.2.826.0.1.3680043.10.999.7"),
    element(0x0020, 0x000e, "UI", seriesUid),
    element(0x0020, 0x0013, "IS", String(index + 1)),
    element(0x0020, 0x0032, "DS", `0\\0\\${-20 + index}`),
    element(0x0020, 0x0037, "DS", "1\\0\\0\\0\\1\\0"),
    element(0x0028, 0x0002, "US", 1),
    element(0x0028, 0x0004, "CS", photometric),
    element(0x0028, 0x0010, "US", rows),
    element(0x0028, 0x0011, "US", columns),
    element(0x0028, 0x0030, "DS", "1\\1"),
    element(0x0028, 0x0100, "US", 16),
    element(0x0028, 0x0101, "US", declaredFormat?.bitsStored ?? 12),
    element(0x0028, 0x0102, "US", (declaredFormat?.bitsStored ?? 12) - 1),
    element(0x0028, 0x0103, "US", (declaredFormat?.signed ?? signed) ? 1 : 0),
    element(0x0028, 0x1052, "DS", signed ? "0" : "-1024"),
    element(0x0028, 0x1053, "DS", "1"),
    encapsulatedFrame
      ? encapsulatedPixelData(encapsulatedFrame, basicOffsetTable)
      : element(0x7fe0, 0x0010, "OW", pixelBytes)
  ]);
  return concat([preamble, meta, dataSet]).buffer as ArrayBuffer;
}

async function syntheticJpeg2000CtSlice(
  index: number,
  transferSyntax = "1.2.840.10008.1.2.4.90",
  signed = false
): Promise<ArrayBuffer> {
  const frame = await encodeSyntheticJpeg2000Frame(index, false, true, signed);
  return syntheticCtSlice(index, transferSyntax, undefined, false, undefined, true, frame, signed);
}

describe("stateful local DICOM review processor", () => {
  it("opens source-image review even when no automatic overlay proposal is available", async () => {
    const processor = await LocalDicomProcessor.open(
      Array.from({ length: 12 }, (_, index) => syntheticCtSlice(index, undefined, undefined, false, undefined, false)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );

    expect(processor.summary.segmentationOverlayAvailable).toBe(false);
    expect(processor.summary.segmentedSliceCount).toBe(0);
    expect(
      processor.renderSourcePlane({ plane: "axial", planeIndex: 6, windowCenterHu: 300, windowWidthHu: 700, overlay: "proposal" })
        .hasOverlay
    ).toBe(false);
    processor.dispose();
  });

  it("reads production File inputs sequentially without exposing filenames in the public summary", async () => {
    const files = Array.from(
      { length: 12 },
      (_, index) => new File([syntheticCtSlice(index)], `CANARY_PATIENT_${index}.dcm`)
    );
    const stages = new Set<string>();
    const processor = await LocalDicomProcessor.openFiles(
      files,
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
      (progress) => stages.add(progress.stage)
    );

    expect(stages).toEqual(new Set(["reading", "decoding", "segmenting"]));
    expect(JSON.stringify(processor.summary)).not.toContain("CANARY_PATIENT");
    processor.dispose();
  });

  it("zeroes a just-read File buffer when a decoding progress callback aborts intake", async () => {
    const sourceBuffer = syntheticCtSlice(0);
    await expect(
      LocalDicomProcessor.openFiles(
        [{ arrayBuffer: async () => sourceBuffer }],
        DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
        (progress) => {
          if (progress.stage === "decoding") throw new Error("test File progress abort");
        }
      )
    ).rejects.toThrow(/test File progress abort/);

    expect(new Uint8Array(sourceBuffer).every((value) => value === 0)).toBe(true);
  });

  it("zeroes every supplied raw buffer when intake aborts unexpectedly", async () => {
    const buffers = Array.from({ length: 4 }, (_, index) => syntheticCtSlice(index));
    const originalBuffers = [...buffers];
    await expect(
      LocalDicomProcessor.open(
        buffers,
        DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
        (progress) => {
          if (progress.stage === "decoding" && progress.completed === 1) {
            throw new Error("test progress abort");
          }
        }
      )
    ).rejects.toThrow(/test progress abort/);

    expect(buffers.every((buffer) => buffer.byteLength === 0)).toBe(true);
    expect(
      originalBuffers.every((buffer) => new Uint8Array(buffer).every((value) => value === 0))
    ).toBe(true);
  });

  it("opens, renders, seed-tracks, validates and releases a synthetic CT series end to end", async () => {
    const buffers = Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index));
    const stages = new Set<string>();
    const processor = await LocalDicomProcessor.open(buffers, DEFAULT_VESSEL_SEGMENTATION_SETTINGS, (progress) => {
      stages.add(progress.stage);
    });

    expect(processor.summary.selectedSliceCount).toBe(24);
    expect(processor.summary.segmentedSliceCount).toBeGreaterThanOrEqual(20);
    expect(processor.summary.coveragePercent).toBeGreaterThan(80);
    const frame = processor.renderSourcePlane({
      plane: "axial",
      planeIndex: processor.summary.suggestedSliceIndex,
      windowCenterHu: 300,
      windowWidthHu: 700,
      overlay: "proposal"
    });
    expect(frame.rgba).toHaveLength(64 * 64 * 4);
    expect(frame.hasOverlay).toBe(true);

    const seed = { sliceIndex: 12, row: 35, column: 33 };
    const result = processor.segmentFromSeed(seed, DEFAULT_VESSEL_SEGMENTATION_SETTINGS, (progress) => {
      stages.add(progress.stage);
    });
    expect(result.seedConfirmed).toBe(true);
    expect(result.seed).toEqual(seed);
    expect(result.doc?.access).toHaveLength(1);
    expect(result.doc?.targets).toHaveLength(1);
    expect(stages).toEqual(new Set(["decoding", "segmenting", "centerline", "validating"]));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("CANARY");
    expect(serialized).not.toContain("1.2.826.0.1.3680043.10.999.42");

    const anatomy = compileAnatomy(result.doc!);
    expect(anatomy.branches).toHaveLength(1);
    expect(anatomy.access[0].branchId).toBe("segmented_trunk");
    expect(new Lumen(anatomy).edges.length).toBeGreaterThan(10);

    processor.dispose();
    processor.dispose();
    expect(() =>
      processor.renderSourcePlane({
        plane: "axial",
        planeIndex: 0,
        windowCenterHu: 300,
        windowWidthHu: 700,
        overlay: "proposal"
      })
    ).toThrow(/disposed/);
  });

  it("tracks different connected trunks when the operator chooses different seeds", async () => {
    const processor = await LocalDicomProcessor.open(
      Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index, undefined, undefined, true)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    const first = processor.segmentFromSeed(
      { sliceIndex: 12, row: 35, column: 33 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    const second = processor.segmentFromSeed(
      { sliceIndex: 12, row: 15, column: 42 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );

    expect(first.seed).not.toEqual(second.seed);
    expect(first.doc!.branches[0].controls).not.toEqual(second.doc!.branches[0].controls);
    processor.dispose();
  });

  it("keeps source-frame geometry worker-local and expires bounded mappings on revision change", async () => {
    const processor = await LocalDicomProcessor.open(
      Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    const first = processor.renderSourcePlane({
      plane: "axial",
      planeIndex: 12,
      windowCenterHu: 300,
      windowWidthHu: 700,
      overlay: "proposal"
    });
    expect(processor.mapSourceReviewPoint({ frameToken: first.frameToken, imageRow: 35, imageColumn: 33 }))
      .toEqual({ sliceIndex: 12, row: 35, column: 33 });

    for (let index = 0; index < 8; index++) {
      processor.renderSourcePlane({
        plane: "axial",
        planeIndex: index,
        windowCenterHu: 300,
        windowWidthHu: 700,
        overlay: "proposal"
      });
    }
    expect(() =>
      processor.mapSourceReviewPoint({ frameToken: first.frameToken, imageRow: 35, imageColumn: 33 })
    ).toThrow(/expired/);

    const current = processor.renderSourcePlane({
      plane: "axial",
      planeIndex: 12,
      windowCenterHu: 300,
      windowWidthHu: 700,
      overlay: "proposal"
    });
    processor.segmentFromSeed(
      { sliceIndex: 12, row: 35, column: 33 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    expect(() =>
      processor.mapSourceReviewPoint({ frameToken: current.frameToken, imageRow: 35, imageColumn: 33 })
    ).toThrow(/expired/);
    processor.dispose();
  });

  it("retains a slice-component correction and blocks a discontinuous edited topology", async () => {
    const processor = await LocalDicomProcessor.open(
      Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index, undefined, undefined, true)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    const initial = processor.segmentFromSeed(
      { sliceIndex: 12, row: 35, column: 33 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );

    expect(initial.review.topologyStatus).toBe("pass");
    expect(initial.review.editHistory).toEqual([]);
    expect(initial.review.requiredSourceSliceCheckpoints).toEqual([0, 6, 12, 17, 23]);
    expect(initial.review.requiredOrthogonalCheckpoints).toEqual([
      { plane: "patient-coronal", planeIndex: 35 },
      { plane: "patient-sagittal", planeIndex: 33 }
    ]);

    const edited = processor.replaceSegmentedSliceComponent(
      { sliceIndex: 12, row: 15, column: 42 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );

    expect(edited.seed).toEqual(initial.seed);
    expect(edited.review.topologyStatus).toBe("block");
    expect(edited.review.topologyBlockers).toContain(
      "Edited trunk has a centerline jump above the configured continuity limit."
    );
    expect(edited.review.editHistory).toEqual([
      { revision: 1, action: "replace-slice-component", sliceIndex: 12 }
    ]);
    expect(edited.doc).toBeNull();

    const correctedFrame = processor.renderSourcePlane({
      plane: "axial",
      planeIndex: 12,
      windowCenterHu: 300,
      windowWidthHu: 700,
      overlay: "seeded"
    });
    const correctedPixel = (15 * 64 + 42) * 4;
    const oldPixel = (35 * 64 + 28) * 4;
    expect(correctedFrame.rgba[correctedPixel + 2]).toBeGreaterThan(correctedFrame.rgba[correctedPixel]);
    expect(correctedFrame.rgba[oldPixel]).toBe(correctedFrame.rgba[oldPixel + 2]);
    processor.dispose();
  });

  it("undoes the last labelmap correction without erasing session edit provenance", async () => {
    const processor = await LocalDicomProcessor.open(
      Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index, undefined, undefined, true)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    const initial = processor.segmentFromSeed(
      { sliceIndex: 12, row: 35, column: 33 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    processor.replaceSegmentedSliceComponent(
      { sliceIndex: 12, row: 15, column: 42 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );

    const restored = processor.undoLastSegmentationEdit();

    expect(restored.review.topologyStatus).toBe("pass");
    expect(restored.review.canUndo).toBe(false);
    expect(restored.review.editHistory).toEqual([
      { revision: 1, action: "replace-slice-component", sliceIndex: 12 },
      { revision: 2, action: "undo", sliceIndex: 12 }
    ]);
    expect(restored.doc!.branches[0].controls).toEqual(initial.doc!.branches[0].controls);
    processor.dispose();
  });

  it("applies a physical 3D add brush across tracked slices and restores exact geometry on undo", async () => {
    const processor = await LocalDicomProcessor.open(
      Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    const initial = processor.segmentFromSeed(
      { sliceIndex: 12, row: 35, column: 33 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );

    const brushed = processor.applySegmentationBrush(
      { sliceIndex: 12, row: 35, column: 39 },
      "add",
      1
    );

    expect(brushed.review.topologyStatus).toBe("pass");
    expect(brushed.review.editHistory).toEqual([
      {
        revision: 1,
        action: "brush-add",
        sliceIndex: 12,
        brushRadiusMm: 1,
        affectedSliceCount: 2,
        changedVoxelCount: 5,
        brushCenterRow: 35,
        brushCenterColumn: 39
      }
    ]);
    expect(brushed.summary.warnings.some((warning) => warning.includes("3D brush"))).toBe(true);
    expect(brushed.doc!.branches[0].controls).not.toEqual(initial.doc!.branches[0].controls);
    const frame = processor.renderSourcePlane({
      plane: "axial",
      planeIndex: 12,
      windowCenterHu: 300,
      windowWidthHu: 700,
      overlay: "seeded"
    });
    const addedPixel = (35 * 64 + 40) * 4;
    expect(frame.rgba[addedPixel + 2]).toBeGreaterThan(frame.rgba[addedPixel]);

    const restored = processor.undoLastSegmentationEdit();
    expect(restored.review.topologyStatus).toBe("pass");
    expect(restored.doc!.branches[0].controls).toEqual(initial.doc!.branches[0].controls);
    expect(restored.review.editHistory.at(-1)).toEqual({
      revision: 2,
      action: "undo",
      sliceIndex: 12
    });
    processor.dispose();
  });

  it("fails closed when a 3D brush creates a disconnected labelmap island", async () => {
    const processor = await LocalDicomProcessor.open(
      Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    processor.segmentFromSeed(
      { sliceIndex: 12, row: 35, column: 33 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );

    const disconnected = processor.applySegmentationBrush(
      { sliceIndex: 12, row: 15, column: 42 },
      "add",
      1
    );

    expect(disconnected.review.topologyStatus).toBe("block");
    expect(disconnected.review.topologyBlockers).toContain(
      "Edited trunk contains more than one disconnected reviewed region on a source slice."
    );
    expect(disconnected.doc).toBeNull();
    processor.dispose();
  });

  it("rejects brush edits that erase the confirmed seed, are no-ops, or have invalid bounds", async () => {
    const processor = await LocalDicomProcessor.open(
      Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    processor.segmentFromSeed(
      { sliceIndex: 12, row: 35, column: 33 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );

    expect(() =>
      processor.applySegmentationBrush({ sliceIndex: 12, row: 35, column: 33 }, "remove", 0.5)
    ).toThrow(/erase the confirmed vascular seed/);
    expect(() =>
      processor.applySegmentationBrush({ sliceIndex: 12, row: 35, column: 33 }, "add", 0.5)
    ).toThrow(/does not change/);
    expect(() =>
      processor.applySegmentationBrush({ sliceIndex: 12, row: 35, column: 39 }, "add", 11)
    ).toThrow(/between 0.5 and 10 mm/);
    expect(() =>
      processor.applySegmentationBrush({ sliceIndex: 12, row: 35, column: 39 }, "paint" as never, 1)
    ).toThrow(/invalid brush mode/);
    processor.dispose();
  });

  it("trims reviewed endpoints around the confirmed seed and regenerates geometry, checkpoints, and provenance", async () => {
    const processor = await LocalDicomProcessor.open(
      Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    const initial = processor.segmentFromSeed(
      { sliceIndex: 12, row: 35, column: 33 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );

    const trimmed = processor.trimSegmentedTrunk(4, "before");

    expect(trimmed.seed).toEqual(initial.seed);
    expect(trimmed.summary.segmentedSliceCount).toBe(20);
    expect(trimmed.summary.coveragePercent).toBeCloseTo((20 / 24) * 100);
    expect(trimmed.summary.warnings).toContain(
      "Operator-trimmed scope: only tracked source slices 5–24 are retained."
    );
    expect(trimmed.review.topologyStatus).toBe("pass");
    expect(trimmed.review.requiredSourceSliceCheckpoints).toEqual([4, 9, 12, 14, 18, 23]);
    expect(trimmed.review.requiredOrthogonalCheckpoints).toEqual(initial.review.requiredOrthogonalCheckpoints);
    expect(trimmed.review.editHistory).toEqual([
      { revision: 1, action: "trim-before", sliceIndex: 4 }
    ]);
    expect(trimmed.doc).not.toBeNull();
    expect(trimmed.doc!.branches[0].controls[0]).not.toEqual(initial.doc!.branches[0].controls[0]);
    expect(
      processor.renderSourcePlane({ plane: "axial", planeIndex: 0, windowCenterHu: 300, windowWidthHu: 700, overlay: "seeded" })
        .hasOverlay
    ).toBe(false);
    expect(
      processor.renderSourcePlane({ plane: "axial", planeIndex: 4, windowCenterHu: 300, windowWidthHu: 700, overlay: "seeded" })
        .hasOverlay
    ).toBe(true);

    const restored = processor.undoLastSegmentationEdit();
    expect(restored.summary.segmentedSliceCount).toBe(initial.summary.segmentedSliceCount);
    expect(restored.doc!.branches[0].controls).toEqual(initial.doc!.branches[0].controls);
    expect(restored.review.editHistory).toEqual([
      { revision: 1, action: "trim-before", sliceIndex: 4 },
      { revision: 2, action: "undo", sliceIndex: 4 }
    ]);
    processor.dispose();
  });

  it("rejects trim boundaries that remove the confirmed seed, do nothing, or leave an unsafe short path", async () => {
    const processor = await LocalDicomProcessor.open(
      Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    processor.segmentFromSeed(
      { sliceIndex: 12, row: 35, column: 33 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );

    expect(() => processor.trimSegmentedTrunk(13, "before")).toThrow(/remove the confirmed seed/);
    expect(() => processor.trimSegmentedTrunk(11, "after")).toThrow(/remove the confirmed seed/);
    expect(() => processor.trimSegmentedTrunk(0, "before")).toThrow(/does not remove/);
    expect(() => processor.trimSegmentedTrunk(6, "invalid" as never)).toThrow(/invalid trim side/);
    processor.dispose();

    const short = await LocalDicomProcessor.open(
      Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    short.segmentFromSeed(
      { sliceIndex: 4, row: 35, column: 33 },
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    expect(() => short.trimSegmentedTrunk(6, "after")).toThrow(/keep a longer reviewed trunk/);
    short.dispose();
  });

  it("rejects a seed outside the selected attenuation range without replacing the proposal", async () => {
    const processor = await LocalDicomProcessor.open(
      Array.from({ length: 24 }, (_, index) => syntheticCtSlice(index)),
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    expect(() =>
      processor.segmentFromSeed({ sliceIndex: 12, row: 0, column: 0 }, DEFAULT_VESSEL_SEGMENTATION_SETTINGS)
    ).toThrow(/outside the selected HU range/);
    expect(
      processor.renderSourcePlane({
        plane: "axial",
        planeIndex: processor.summary.suggestedSliceIndex,
        windowCenterHu: 300,
        windowWidthHu: 700,
        overlay: "proposal"
      }).hasOverlay
    ).toBe(true);
    processor.dispose();
  });

  it("fails closed for non-finite or non-positive geometric settings", async () => {
    const buffers = Array.from({ length: 12 }, (_, index) => syntheticCtSlice(index));
    await expect(
      LocalDicomProcessor.open(buffers, {
        ...DEFAULT_VESSEL_SEGMENTATION_SETTINGS,
        maxCenterJumpMm: Number.NaN
      })
    ).rejects.toThrow(/maximum center jump/);
  });

  it("decodes an encapsulated JPEG 2000 Lossless slice exactly like its native source", async () => {
    for (const signed of [false, true]) {
      const native = await decodeCtSlice(
        syntheticCtSlice(7, undefined, undefined, false, undefined, true, undefined, signed)
      );
      const compressed = await decodeCtSlice(await syntheticJpeg2000CtSlice(7, undefined, signed));
      const { pixelsHu: nativePixels, ...nativeMetadata } = native;
      const { pixelsHu: compressedPixels, ...compressedMetadata } = compressed;

      expect(compressedMetadata).toEqual(nativeMetadata);
      expect(compressedPixels).toEqual(nativePixels);
      nativePixels.fill(0);
      compressedPixels.fill(0);
    }
  });

  it("uses preflighted JPEG 2000 precision and sign when DICOM pixel attributes disagree", async () => {
    const frame = await encodeSyntheticJpeg2000Frame(7, false, true, true);
    const native = await decodeCtSlice(
      syntheticCtSlice(7, undefined, undefined, false, undefined, true, undefined, true)
    );
    const compressed = await decodeCtSlice(
      syntheticCtSlice(
        7,
        "1.2.840.10008.1.2.4.90",
        undefined,
        false,
        undefined,
        true,
        frame,
        true,
        { bitsStored: 16, signed: false }
      )
    );

    expect(compressed.pixelsHu).toEqual(native.pixelsHu);
    native.pixelsHu.fill(0);
    compressed.pixelsHu.fill(0);
  });

  it("fails closed with an identifier-free error for a corrupt JPEG 2000 codestream", async () => {
    const corrupt = syntheticCtSlice(
      0,
      "1.2.840.10008.1.2.4.90",
      undefined,
      false,
      undefined,
      true,
      new Uint8Array([0xff, 0x4f, 0xff, 0x51])
    );
    let message = "";
    try {
      await decodeCtSlice(corrupt);
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toBe("DICOM: unable to decode JPEG 2000 Lossless Pixel Data");
    expect(message).not.toContain("CANARY");
  });

  it("rejects a non-conformant JP2 box wrapper inside DICOM Pixel Data", async () => {
    const frame = await encodeSyntheticJpeg2000Frame(0);
    await expect(
      decodeCtSlice(
        syntheticCtSlice(
          0,
          "1.2.840.10008.1.2.4.90",
          undefined,
          false,
          undefined,
          true,
          jp2CodestreamBox(frame)
        )
      )
    ).rejects.toThrow(/unable to decode JPEG 2000 Lossless Pixel Data/);
  });

  it("rejects non-conformant single-frame Basic Offset Tables", async () => {
    const frame = await encodeSyntheticJpeg2000Frame(7);
    const invalidTables = [concat([binary32(0), binary32(0)]), binary32(8)];
    for (const basicOffsetTable of invalidTables) {
      const slice = syntheticCtSlice(
        7,
        "1.2.840.10008.1.2.4.90",
        undefined,
        false,
        undefined,
        true,
        frame,
        false,
        undefined,
        basicOffsetTable
      );
      await expect(decodeCtSlice(slice)).rejects.toThrow(/invalid Basic Offset Table/);
    }
  });

  it("preflights JPEG 2000 dimensions and encoded size before codec allocation", async () => {
    const mismatchedFrame = await encodeSyntheticJpeg2000Frame(0);
    expect([...mismatchedFrame.subarray(0, 4)]).toEqual([0xff, 0x4f, 0xff, 0x51]);
    new DataView(
      mismatchedFrame.buffer,
      mismatchedFrame.byteOffset,
      mismatchedFrame.byteLength
    ).setUint32(8, 65, false);
    await expect(
      decodeCtSlice(
        syntheticCtSlice(
          0,
          "1.2.840.10008.1.2.4.90",
          undefined,
          false,
          undefined,
          true,
          mismatchedFrame
        )
      )
    ).rejects.toThrow(/codestream does not match the declared image/);

    const validFrame = await encodeSyntheticJpeg2000Frame(0);
    const oversizedFrame = concat([validFrame, new Uint8Array(1024 * 1024)]);
    await expect(
      decodeCtSlice(
        syntheticCtSlice(
          0,
          "1.2.840.10008.1.2.4.90",
          undefined,
          false,
          undefined,
          true,
          oversizedFrame
        )
      )
    ).rejects.toThrow(/exceeds the decoder safety limit/);
  });

  it("keeps compressed and uncompressed production File workflows deterministic", async () => {
    const nativeFiles: File[] = [];
    const compressedFiles: File[] = [];
    for (let index = 0; index < 24; index++) {
      nativeFiles.push(new File([syntheticCtSlice(index)], `NATIVE_CANARY_${index}.dcm`));
      compressedFiles.push(
        new File([await syntheticJpeg2000CtSlice(index)], `JPEG2000_CANARY_${index}.dcm`)
      );
    }
    const native = await LocalDicomProcessor.openFiles(
      nativeFiles,
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );
    const compressed = await LocalDicomProcessor.openFiles(
      compressedFiles,
      DEFAULT_VESSEL_SEGMENTATION_SETTINGS
    );

    expect(compressed.summary).toEqual(native.summary);
    const seed = { sliceIndex: 12, row: 35, column: 33 };
    for (const request of [
      { plane: "axial" as const, planeIndex: 12 },
      { plane: "patient-coronal" as const, locator: { kind: "through-voxel" as const, voxel: seed } },
      { plane: "patient-sagittal" as const, locator: { kind: "through-voxel" as const, voxel: seed } }
    ]) {
      const common = {
        ...request,
        windowCenterHu: 300,
        windowWidthHu: 700,
        overlay: "proposal" as const
      };
      const nativeFrame = native.renderSourcePlane(common);
      const compressedFrame = compressed.renderSourcePlane(common);
      expect(compressedFrame).toEqual(nativeFrame);
    }

    const nativeResult = native.segmentFromSeed(seed, DEFAULT_VESSEL_SEGMENTATION_SETTINGS);
    const compressedResult = compressed.segmentFromSeed(seed, DEFAULT_VESSEL_SEGMENTATION_SETTINGS);
    expect(compressedResult).toEqual({
      ...nativeResult,
      doc: nativeResult.doc && compressedResult.doc
        ? { ...nativeResult.doc, id: compressedResult.doc.id }
        : nativeResult.doc
    });
    expect(JSON.stringify(compressed.summary)).not.toContain("CANARY");
    native.dispose();
    compressed.dispose();
  });

  it("rejects the lossy JPEG 2000 UID and disposed decoder sessions without source identifiers", async () => {
    const lossyUidBuffer = await syntheticJpeg2000CtSlice(0, "1.2.840.10008.1.2.4.91");
    let lossyMessage = "";
    try {
      await decodeCtSlice(lossyUidBuffer);
    } catch (cause) {
      lossyMessage = cause instanceof Error ? cause.message : String(cause);
    }
    expect(lossyMessage).toMatch(/^DICOM: unsupported transfer syntax/);
    expect(lossyMessage).not.toContain("1.2.840");

    const decoder = createCtSliceDecoder();
    decoder.dispose();
    await expect(decoder.decode(syntheticCtSlice(0))).rejects.toThrow(/decoder has been disposed/);
  });

  it("fails closed when JPEG 2000 Lossless declares native instead of encapsulated Pixel Data", async () => {
    await expect(decodeCtSlice(syntheticCtSlice(0, "1.2.840.10008.1.2.4.90"))).rejects.toThrow(
      /not encapsulated correctly/
    );
  });

  it("retains MONOCHROME1 presentation semantics for source-image rendering", async () => {
    expect(
      (await decodeCtSlice(syntheticCtSlice(0, undefined, undefined, false, "MONOCHROME1")))
        .photometricInterpretation
    ).toBe("MONOCHROME1");
  });

  it("does not reflect malformed metadata values into operator-facing parser errors", async () => {
    let message = "";
    try {
      await decodeCtSlice(syntheticCtSlice(0, "CANARY_PATIENT_TRANSFER_SYNTAX"));
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).not.toContain("CANARY_PATIENT");
    expect(message).toMatch(/^DICOM:/);
  });

  it("fails closed when files from more than one series are selected", async () => {
    const buffers = [
      ...Array.from({ length: 4 }, (_, index) => syntheticCtSlice(index)),
      ...Array.from({ length: 4 }, (_, index) =>
        syntheticCtSlice(index + 4, "1.2.840.10008.1.2.1", "1.2.826.0.1.3680043.10.999.43")
      )
    ];
    await expect(LocalDicomProcessor.open(buffers, DEFAULT_VESSEL_SEGMENTATION_SETTINGS)).rejects.toThrow(
      /multiple series or inconsistent matrices/
    );
  });
});
