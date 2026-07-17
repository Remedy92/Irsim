import * as dicomParser from "dicom-parser";

const UNCOMPRESSED_TRANSFER_SYNTAXES = new Set([
  "1.2.840.10008.1.2", // Implicit VR Little Endian
  "1.2.840.10008.1.2.1", // Explicit VR Little Endian
  "1.2.840.10008.1.2.2" // Explicit VR Big Endian (retired, still encountered)
]);
const JPEG_2000_LOSSLESS_TRANSFER_SYNTAX = "1.2.840.10008.1.2.4.90";
const MIN_JPEG_2000_ENCODED_FRAME_LIMIT = 1024 * 1024;
const JPEG_2000_ENCODED_TO_DECODED_LIMIT = 4;

export const MAX_DICOM_FILES = 2000;
export const MAX_DICOM_BYTES = 768 * 1024 * 1024;
export const MAX_VOLUME_VOXELS = 300_000_000;

export interface DecodedCtSlice {
  /** Internal-only grouping key. It is discarded before a result leaves the worker. */
  seriesKey: string;
  rows: number;
  columns: number;
  imagePositionLps: [number, number, number];
  rowDirectionLps: [number, number, number];
  columnDirectionLps: [number, number, number];
  pixelSpacingMm: [row: number, column: number];
  photometricInterpretation: "MONOCHROME1" | "MONOCHROME2";
  instanceNumber: number;
  pixelsHu: Int16Array;
}

/** Short-lived worker decoder used only while building the canonical diagnostic volume. */
export interface CtSliceDecoder {
  decode(buffer: ArrayBuffer): Promise<DecodedCtSlice>;
  dispose(): void;
}

/** Identifier-free, read-only view of one canonical CT source slice. */
export interface CtSliceView {
  readonly imagePositionLps: readonly [number, number, number];
  readonly photometricInterpretation: "MONOCHROME1" | "MONOCHROME2";
  /**
   * Borrowed canonical HU storage. Callers may read it only and must not retain it after the
   * volume is disposed. JavaScript typed arrays cannot express that ownership rule in the type.
   */
  readonly pixelsHu: Int16Array;
}

/**
 * Worker-internal seam for the sole canonical diagnostic CT pixel representation.
 *
 * Decoder-specific grouping identifiers and mutable slice ownership stay behind this interface.
 * A future codec/cache adapter must satisfy the same geometry, slice-view, and disposal contract
 * rather than creating a second full decoded volume.
 */
export interface CtVolume {
  readonly rows: number;
  readonly columns: number;
  readonly sliceCount: number;
  readonly rowDirectionLps: readonly [number, number, number];
  readonly columnDirectionLps: readonly [number, number, number];
  readonly normalDirectionLps: readonly [number, number, number];
  readonly rowSpacingMm: number;
  readonly columnSpacingMm: number;
  readonly sliceSpacingMm: number;
  readonly ignoredSliceCount: number;
  readonly canonicalScalarBytes: number;
  getSlice(sliceIndex: number): CtSliceView;
  voxelCenterLps(sliceIndex: number, row: number, column: number): [number, number, number];
  dispose(): void;
}

class InMemoryCtVolume implements CtVolume {
  readonly rows: number;
  readonly columns: number;
  readonly sliceCount: number;
  readonly canonicalScalarBytes: number;
  private ownedSlices: DecodedCtSlice[] | null;

  constructor(
    slices: DecodedCtSlice[],
    readonly rowDirectionLps: readonly [number, number, number],
    readonly columnDirectionLps: readonly [number, number, number],
    readonly normalDirectionLps: readonly [number, number, number],
    readonly rowSpacingMm: number,
    readonly columnSpacingMm: number,
    readonly sliceSpacingMm: number,
    readonly ignoredSliceCount: number
  ) {
    this.ownedSlices = slices;
    this.rows = slices[0].rows;
    this.columns = slices[0].columns;
    this.sliceCount = slices.length;
    this.canonicalScalarBytes = slices.reduce((total, slice) => total + slice.pixelsHu.byteLength, 0);
  }

  getSlice(sliceIndex: number): CtSliceView {
    const slices = this.requireSlices();
    if (!Number.isInteger(sliceIndex) || sliceIndex < 0 || sliceIndex >= slices.length) {
      throw new Error("DICOM: source slice is outside the canonical CT volume");
    }
    const slice = slices[sliceIndex];
    return {
      imagePositionLps: slice.imagePositionLps,
      photometricInterpretation: slice.photometricInterpretation,
      pixelsHu: slice.pixelsHu
    };
  }

  voxelCenterLps(sliceIndex: number, row: number, column: number): [number, number, number] {
    if (
      !Number.isFinite(row) ||
      !Number.isFinite(column) ||
      row < 0 ||
      row >= this.rows ||
      column < 0 ||
      column >= this.columns
    ) {
      throw new Error("DICOM: voxel is outside the canonical CT volume");
    }
    const origin = this.getSlice(sliceIndex).imagePositionLps;
    return [0, 1, 2].map(
      (axis) =>
        origin[axis] +
        this.rowDirectionLps[axis] * column * this.columnSpacingMm +
        this.columnDirectionLps[axis] * row * this.rowSpacingMm
    ) as [number, number, number];
  }

  /** Best-effort release of PHI-bearing scalar buffers; JavaScript cannot promise secure erasure. */
  dispose(): void {
    if (!this.ownedSlices) return;
    for (const slice of this.ownedSlices) slice.pixelsHu.fill(0);
    this.ownedSlices = null;
  }

  private requireSlices(): DecodedCtSlice[] {
    if (!this.ownedSlices) throw new Error("DICOM: canonical CT volume has been disposed");
    return this.ownedSlices;
  }
}

function requiredNumber(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isFinite(value)) throw new Error(`DICOM: missing or invalid ${label}`);
  return value;
}

function tuple3(dataSet: dicomParser.DataSet, tag: string, label: string): [number, number, number] {
  return [
    requiredNumber(dataSet.floatString(tag, 0), label),
    requiredNumber(dataSet.floatString(tag, 1), label),
    requiredNumber(dataSet.floatString(tag, 2), label)
  ];
}

function tuple6(
  dataSet: dicomParser.DataSet,
  tag: string,
  label: string
): [[number, number, number], [number, number, number]] {
  return [
    [
      requiredNumber(dataSet.floatString(tag, 0), label),
      requiredNumber(dataSet.floatString(tag, 1), label),
      requiredNumber(dataSet.floatString(tag, 2), label)
    ],
    [
      requiredNumber(dataSet.floatString(tag, 3), label),
      requiredNumber(dataSet.floatString(tag, 4), label),
      requiredNumber(dataSet.floatString(tag, 5), label)
    ]
  ];
}

function transferSyntaxOf(dataSet: dicomParser.DataSet): string {
  return dataSet.string("x00020010")?.trim() ?? "1.2.840.10008.1.2";
}

function requiredString(dataSet: dicomParser.DataSet, tag: string, label: string): string {
  const value = dataSet.string(tag)?.trim();
  if (!value) throw new Error(`DICOM: missing ${label}`);
  return value;
}

interface StoredPixelFormat {
  rows: number;
  columns: number;
  bitsAllocated: number;
  bitsStored: number;
  highBit: number;
  signed: boolean;
  slope: number;
  intercept: number;
}

interface Jpeg2000CodestreamInfo {
  width: number;
  height: number;
  componentCount: number;
  bitsPerSample: number;
  isSigned: boolean;
}

/** Read the mandatory SIZ marker before the codec can allocate decoded output. */
function inspectJpeg2000Codestream(encoded: Uint8Array): Jpeg2000CodestreamInfo {
  // DICOM PS3.5 requires the raw JPEG 2000 codestream in encapsulated Pixel Data; a JP2 file
  // header/box structure is non-conformant and intentionally rejected rather than recovered.
  const codestream = encoded;
  if (
    codestream.byteLength < 45 ||
    codestream[0] !== 0xff ||
    codestream[1] !== 0x4f ||
    codestream[2] !== 0xff ||
    codestream[3] !== 0x51
  ) {
    throw new Error("missing JPEG 2000 SOC/SIZ markers");
  }
  const view = new DataView(codestream.buffer, codestream.byteOffset, codestream.byteLength);
  const sizLength = view.getUint16(4, false);
  const componentCount = view.getUint16(40, false);
  if (
    componentCount < 1 ||
    sizLength !== 38 + 3 * componentCount ||
    4 + sizLength > codestream.byteLength
  ) {
    throw new Error("invalid JPEG 2000 SIZ marker");
  }
  const imageRight = view.getUint32(8, false);
  const imageBottom = view.getUint32(12, false);
  const imageLeft = view.getUint32(16, false);
  const imageTop = view.getUint32(20, false);
  if (imageRight <= imageLeft || imageBottom <= imageTop) {
    throw new Error("invalid JPEG 2000 image bounds");
  }
  const sample = view.getUint8(42);
  return {
    width: imageRight - imageLeft,
    height: imageBottom - imageTop,
    componentCount,
    bitsPerSample: (sample & 0x7f) + 1,
    isSigned: (sample & 0x80) !== 0
  };
}

function copyStoredPixelsToHu(
  bytes: Uint8Array | Uint8ClampedArray,
  decodedBitsAllocated: 8 | 16,
  decodedHighBit: number,
  littleEndian: boolean,
  format: StoredPixelFormat,
  targetHu: Int16Array
): void {
  const pixelCount = format.rows * format.columns;
  const expectedBytes = pixelCount * (decodedBitsAllocated / 8);
  if (bytes.byteLength !== expectedBytes || targetHu.length !== pixelCount) {
    throw new Error("DICOM: decoded Pixel Data does not match the declared matrix");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const storedMask = format.bitsStored === 16 ? 0xffff : (1 << format.bitsStored) - 1;
  const signBit = 1 << (format.bitsStored - 1);

  for (let index = 0; index < pixelCount; index++) {
    let stored =
      decodedBitsAllocated === 8
        ? view.getUint8(index)
        : view.getUint16(index * 2, littleEndian);
    if (decodedHighBit + 1 !== format.bitsStored) {
      stored >>>= decodedHighBit + 1 - format.bitsStored;
    }
    stored &= storedMask;
    if (format.signed && (stored & signBit) !== 0) stored -= 1 << format.bitsStored;
    const hu = Math.round(stored * format.slope + format.intercept);
    targetHu[index] = Math.max(-32768, Math.min(32767, hu));
  }
}

function decodeUncompressedInto(
  dataSet: dicomParser.DataSet,
  pixelElement: dicomParser.Element,
  transferSyntax: string,
  format: StoredPixelFormat,
  targetHu: Int16Array
): void {
  if (pixelElement.encapsulatedPixelData) {
    throw new Error("DICOM: uncompressed transfer syntax contains encapsulated Pixel Data");
  }
  const expectedBytes = format.rows * format.columns * (format.bitsAllocated / 8);
  if (pixelElement.length < expectedBytes) {
    throw new Error("DICOM: Pixel Data is shorter than the declared matrix");
  }
  if (pixelElement.length > expectedBytes + (expectedBytes % 2)) {
    throw new Error("DICOM: Pixel Data is longer than the declared single-frame matrix");
  }
  const source = dataSet.byteArray as Uint8Array;
  copyStoredPixelsToHu(
    new Uint8Array(source.buffer, source.byteOffset + pixelElement.dataOffset, expectedBytes),
    format.bitsAllocated as 8 | 16,
    format.highBit,
    transferSyntax !== "1.2.840.10008.1.2.2",
    format,
    targetHu
  );
}

class SessionCtSliceDecoder implements CtSliceDecoder {
  private disposed = false;
  private openJpegModulePromise: Promise<
    import("@cornerstonejs/codec-openjpeg/decode").OpenJpegModule
  > | null = null;

  async decode(buffer: ArrayBuffer): Promise<DecodedCtSlice> {
    if (this.disposed) throw new Error("DICOM: slice decoder has been disposed");
    let dataSet: dicomParser.DataSet;
    try {
      dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
    } catch {
      // Parser diagnostics can contain malformed source bytes. Keep operator errors identifier-free.
      throw new Error("DICOM: unable to parse Part 10 object");
    }

    const modality = dataSet.string("x00080060")?.trim();
    if (modality !== "CT") throw new Error("DICOM: unsupported or missing modality; accepts CT only");

    const transferSyntax = transferSyntaxOf(dataSet);
    const isJpeg2000Lossless = transferSyntax === JPEG_2000_LOSSLESS_TRANSFER_SYNTAX;
    if (!UNCOMPRESSED_TRANSFER_SYNTAXES.has(transferSyntax) && !isJpeg2000Lossless) {
      throw new Error("DICOM: unsupported transfer syntax; use uncompressed or JPEG 2000 Lossless CT");
    }

    const rows = requiredNumber(dataSet.uint16("x00280010"), "Rows");
    const columns = requiredNumber(dataSet.uint16("x00280011"), "Columns");
    if (rows < 2 || columns < 2 || rows > 2048 || columns > 2048) {
      throw new Error(`DICOM: unsupported matrix ${columns}×${rows}`);
    }

    const samplesPerPixel = dataSet.uint16("x00280002") ?? 1;
    const photometric = dataSet.string("x00280004")?.trim() ?? "MONOCHROME2";
    const frames = dataSet.intString("x00280008") ?? 1;
    if (
      samplesPerPixel !== 1 ||
      (photometric !== "MONOCHROME1" && photometric !== "MONOCHROME2") ||
      frames !== 1
    ) {
      throw new Error("DICOM: accepts single-frame monochrome CT slices only");
    }

    const bitsAllocated = requiredNumber(dataSet.uint16("x00280100"), "Bits Allocated");
    const bitsStored = dataSet.uint16("x00280101") ?? bitsAllocated;
    const highBit = dataSet.uint16("x00280102") ?? bitsStored - 1;
    const signed = (dataSet.uint16("x00280103") ?? 0) === 1;
    if (
      (bitsAllocated !== 8 && bitsAllocated !== 16) ||
      bitsStored < 1 ||
      bitsStored > bitsAllocated ||
      highBit < bitsStored - 1 ||
      highBit >= bitsAllocated ||
      (isJpeg2000Lossless && highBit !== bitsStored - 1)
    ) {
      throw new Error(`DICOM: unsupported pixel format (${bitsAllocated} allocated, ${bitsStored} stored)`);
    }

    const imagePositionLps = tuple3(dataSet, "x00200032", "Image Position Patient");
    const [rowDirectionLps, columnDirectionLps] = tuple6(
      dataSet,
      "x00200037",
      "Image Orientation Patient"
    );
    const pixelSpacingMm: [number, number] = [
      requiredNumber(dataSet.floatString("x00280030", 0), "Pixel Spacing"),
      requiredNumber(dataSet.floatString("x00280030", 1), "Pixel Spacing")
    ];
    if (pixelSpacingMm.some((value) => value <= 0 || value > 20)) {
      throw new Error("DICOM: implausible Pixel Spacing");
    }

    const slope = requiredNumber(dataSet.floatString("x00281053") ?? 1, "Rescale Slope");
    const intercept = requiredNumber(dataSet.floatString("x00281052") ?? 0, "Rescale Intercept");
    const studyUid = requiredString(dataSet, "x0020000d", "Study Instance UID");
    const seriesUid = requiredString(dataSet, "x0020000e", "Series Instance UID");
    const pixelElement = dataSet.elements.x7fe00010;
    if (!pixelElement) throw new Error("DICOM: missing Pixel Data");

    const format: StoredPixelFormat = {
      rows,
      columns,
      bitsAllocated,
      bitsStored,
      highBit,
      signed,
      slope,
      intercept
    };
    // Allocate the final canonical slice exactly once. Pixel Adapters decode/rescale into it; only
    // one codec-owned byte view may coexist transiently for a compressed frame.
    const pixelsHu = new Int16Array(rows * columns);
    try {
      if (isJpeg2000Lossless) {
        await this.decodeJpeg2000LosslessInto(dataSet, pixelElement, format, pixelsHu);
      } else {
        decodeUncompressedInto(dataSet, pixelElement, transferSyntax, format, pixelsHu);
      }
    } catch (cause) {
      pixelsHu.fill(0);
      throw cause;
    }

    return {
      seriesKey: `${studyUid}|${seriesUid}`,
      rows,
      columns,
      imagePositionLps,
      rowDirectionLps,
      columnDirectionLps,
      pixelSpacingMm,
      photometricInterpretation: photometric,
      instanceNumber: dataSet.intString("x00200013") ?? 0,
      pixelsHu
    };
  }

  dispose(): void {
    this.disposed = true;
    // Each per-slice J2KDecoder is deleted after use. Dropping this final module reference makes its
    // codec heap collectible before segmentation; production also terminates the owning worker.
    this.openJpegModulePromise = null;
  }

  private async openJpegModule(): Promise<
    import("@cornerstonejs/codec-openjpeg/decode").OpenJpegModule
  > {
    if (!this.openJpegModulePromise) {
      this.openJpegModulePromise = import("@cornerstonejs/codec-openjpeg/decode")
        .then(({ default: createOpenJpegModule }) =>
          createOpenJpegModule({ print() {}, printErr() {} })
        )
        .catch(() => {
          throw new Error("DICOM: unable to initialize the JPEG 2000 Lossless decoder");
        });
    }
    const module = await this.openJpegModulePromise;
    if (this.disposed) throw new Error("DICOM: slice decoder has been disposed");
    return module;
  }

  private async decodeJpeg2000LosslessInto(
    dataSet: dicomParser.DataSet,
    pixelElement: dicomParser.Element,
    format: StoredPixelFormat,
    targetHu: Int16Array
  ): Promise<void> {
    if (!pixelElement.encapsulatedPixelData || !pixelElement.fragments?.length) {
      throw new Error("DICOM: JPEG 2000 Lossless Pixel Data is not encapsulated correctly");
    }
    const basicOffsetTable = pixelElement.basicOffsetTable ?? [];
    if (
      basicOffsetTable.length > 1 ||
      (basicOffsetTable.length === 1 && basicOffsetTable[0] !== 0)
    ) {
      throw new Error("DICOM: invalid Basic Offset Table for single-frame Pixel Data");
    }

    let encoded: Uint8Array;
    try {
      encoded =
        pixelElement.basicOffsetTable?.length
          ? dicomParser.readEncapsulatedImageFrame(dataSet, pixelElement, 0)
          : dicomParser.readEncapsulatedPixelDataFromFragments(
              dataSet,
              pixelElement,
              0,
              pixelElement.fragments.length
            );
    } catch {
      throw new Error("DICOM: unable to extract JPEG 2000 Lossless Pixel Data");
    }
    if (!encoded.byteLength) throw new Error("DICOM: JPEG 2000 Lossless Pixel Data is empty");

    try {
      // Bound the encoded frame against the largest decoded representation this Adapter supports.
      // JPEG 2000's SIZ marker, not potentially inconsistent DICOM Bits Stored/Pixel
      // Representation attributes, controls the actual decoded sample representation.
      const maximumDecodedBytes = format.rows * format.columns * 2;
      const encodedFrameLimit = Math.max(
        MIN_JPEG_2000_ENCODED_FRAME_LIMIT,
        maximumDecodedBytes * JPEG_2000_ENCODED_TO_DECODED_LIMIT
      );
      if (encoded.byteLength > encodedFrameLimit) {
        throw new Error("DICOM: JPEG 2000 Lossless frame exceeds the decoder safety limit");
      }
      let codestreamInfo: Jpeg2000CodestreamInfo;
      try {
        codestreamInfo = inspectJpeg2000Codestream(encoded);
      } catch {
        throw new Error("DICOM: unable to decode JPEG 2000 Lossless Pixel Data");
      }
      if (
        codestreamInfo.width !== format.columns ||
        codestreamInfo.height !== format.rows ||
        codestreamInfo.componentCount !== 1 ||
        codestreamInfo.bitsPerSample < 1 ||
        codestreamInfo.bitsPerSample > 16
      ) {
        throw new Error("DICOM: JPEG 2000 Lossless codestream does not match the declared image");
      }

      const decodedBitsAllocated: 8 | 16 = codestreamInfo.bitsPerSample <= 8 ? 8 : 16;
      const expectedBytes = format.rows * format.columns * (decodedBitsAllocated / 8);
      const codestreamFormat: StoredPixelFormat = {
        ...format,
        bitsAllocated: decodedBitsAllocated,
        bitsStored: codestreamInfo.bitsPerSample,
        highBit: codestreamInfo.bitsPerSample - 1,
        signed: codestreamInfo.isSigned
      };

      const module = await this.openJpegModule();
      let decoder: import("@cornerstonejs/codec-openjpeg/decode").OpenJpegDecoder | null = null;
      let codecEncoded: Uint8Array | null = null;
      let decoded: Uint8ClampedArray | null = null;
      try {
        decoder = new module.J2KDecoder();
        codecEncoded = decoder.getEncodedBuffer(encoded.byteLength);
        codecEncoded.set(encoded);
        decoder.decode();
        const frame = decoder.getFrameInfo();
        if (
          frame.width !== format.columns ||
          frame.height !== format.rows ||
          frame.componentCount !== 1 ||
          frame.bitsPerSample !== codestreamInfo.bitsPerSample ||
          frame.isSigned !== codestreamInfo.isSigned ||
          decoder.getIsReversible() !== true
        ) {
          throw new Error("codec metadata mismatch");
        }
        decoded = decoder.getDecodedBuffer();
        if (decoded.byteLength !== expectedBytes) throw new Error("codec output size mismatch");
        copyStoredPixelsToHu(
          decoded,
          decodedBitsAllocated,
          codestreamFormat.highBit,
          true,
          codestreamFormat,
          targetHu
        );
      } catch {
        throw new Error("DICOM: unable to decode JPEG 2000 Lossless Pixel Data");
      } finally {
        // Codec heap views can otherwise retain both compressed and decoded PHI after the JS source
        // copy is released. Clearing remains best-effort because embind may detach a view on error.
        try {
          codecEncoded?.fill(0);
          decoded?.fill(0);
        } catch {
          // The owning worker is still terminated when the session closes.
        }
        try {
          decoder?.delete();
        } catch {
          // Embind cleanup is best-effort; do not leak codec diagnostics into operator errors.
        }
      }
    } finally {
      // Encapsulated-frame helpers materialize a contiguous source copy. Clear that transient copy
      // on preflight, codec-init, decode, and success paths; this remains best-effort memory hygiene.
      encoded.fill(0);
    }
  }
}

export function createCtSliceDecoder(): CtSliceDecoder {
  return new SessionCtSliceDecoder();
}

/** Decode one single-frame CT Part 10 object without reading patient attributes. */
export async function decodeCtSlice(buffer: ArrayBuffer): Promise<DecodedCtSlice> {
  const decoder = createCtSliceDecoder();
  try {
    return await decoder.decode(buffer);
  } finally {
    decoder.dispose();
  }
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(v: readonly number[]): [number, number, number] {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (n < 0.9) throw new Error("DICOM: invalid image orientation vectors");
  return [v[0] / n, v[1] / n, v[2] / n];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 1;
}

/** Require one coherent CT series and order it in patient space. */
export function buildCtVolume(decoded: DecodedCtSlice[]): CtVolume {
  if (decoded.length < 3) throw new Error("DICOM: select at least three CT slices from one series");
  const groups = new Map<string, DecodedCtSlice[]>();
  for (const slice of decoded) {
    const key = `${slice.seriesKey}|${slice.rows}x${slice.columns}`;
    const group = groups.get(key) ?? [];
    group.push(slice);
    groups.set(key, group);
    // Study/Series UIDs are needed only to prove coherent selection. Do not retain those DICOM
    // identifiers in the long-lived canonical volume once the grouping key has been captured.
    slice.seriesKey = "";
  }
  if (groups.size !== 1) {
    throw new Error("DICOM: multiple series or inconsistent matrices selected; choose one CT acquisition only");
  }
  const selected = groups.values().next().value as DecodedCtSlice[] | undefined;
  if (!selected || selected.length < 3) throw new Error("DICOM: no coherent CT series found");
  if (selected.length * selected[0].rows * selected[0].columns > MAX_VOLUME_VOXELS) {
    throw new Error("DICOM: selected volume is too large for the browser safety limit");
  }

  const row = norm(selected[0].rowDirectionLps);
  const column = norm(selected[0].columnDirectionLps);
  if (Math.abs(dot(row, column)) > 0.01) throw new Error("DICOM: image orientation vectors are not orthogonal");
  const normal = norm(cross(row, column));
  const rowSpacingMm = selected[0].pixelSpacingMm[0];
  const columnSpacingMm = selected[0].pixelSpacingMm[1];
  const photometricInterpretation = selected[0].photometricInterpretation;

  for (const slice of selected) {
    if (dot(row, norm(slice.rowDirectionLps)) < 0.999 || dot(column, norm(slice.columnDirectionLps)) < 0.999) {
      throw new Error("DICOM: selected series has inconsistent image orientation");
    }
    if (
      Math.abs(slice.pixelSpacingMm[0] - rowSpacingMm) > 0.01 ||
      Math.abs(slice.pixelSpacingMm[1] - columnSpacingMm) > 0.01
    ) {
      throw new Error("DICOM: selected series has inconsistent pixel spacing");
    }
    if (slice.photometricInterpretation !== photometricInterpretation) {
      throw new Error("DICOM: selected series has inconsistent photometric interpretation");
    }
  }

  selected.sort((a, b) => {
    const spatial = dot(a.imagePositionLps, normal) - dot(b.imagePositionLps, normal);
    return Math.abs(spatial) > 1e-4 ? spatial : a.instanceNumber - b.instanceNumber;
  });
  const spacings: number[] = [];
  for (let i = 1; i < selected.length; i++) {
    const spacing = Math.abs(
      dot(selected[i].imagePositionLps, normal) - dot(selected[i - 1].imagePositionLps, normal)
    );
    if (spacing <= 1e-4) throw new Error("DICOM: selected series contains duplicate slice positions");
    spacings.push(spacing);
  }
  const sliceSpacingMm = median(spacings);
  if (!Number.isFinite(sliceSpacingMm) || sliceSpacingMm <= 0 || sliceSpacingMm > 20) {
    throw new Error("DICOM: invalid or unsupported slice spacing");
  }
  const spacingTolerance = Math.max(0.2, sliceSpacingMm * 0.1);
  if (spacings.some((spacing) => Math.abs(spacing - sliceSpacingMm) > spacingTolerance)) {
    throw new Error("DICOM: selected series has inconsistent slice spacing");
  }

  return new InMemoryCtVolume(
    selected,
    row,
    column,
    normal,
    rowSpacingMm,
    columnSpacingMm,
    sliceSpacingMm,
    0
  );
}
