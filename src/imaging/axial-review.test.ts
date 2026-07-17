import { describe, expect, it } from "vitest";
import { renderAxialReview } from "./axial-review";

function pixelAt(rgba: Uint8ClampedArray, columns: number, row: number, column: number): number[] {
  const offset = (row * columns + column) * 4;
  return Array.from(rgba.subarray(offset, offset + 4));
}

describe("renderAxialReview", () => {
  it("applies the DICOM LINEAR window endpoints and center", () => {
    const rgba = renderAxialReview({
      pixels: new Int16Array([-1, 0, 128, 255, 256]),
      rows: 1,
      columns: 5,
      photometric: "MONOCHROME2",
      windowCenter: 128,
      windowWidth: 256
    });

    expect(pixelAt(rgba, 5, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(rgba, 5, 0, 1)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(rgba, 5, 0, 2)).toEqual([128, 128, 128, 255]);
    expect(pixelAt(rgba, 5, 0, 3)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(rgba, 5, 0, 4)).toEqual([255, 255, 255, 255]);
  });

  it("handles the valid width-one threshold without dividing by zero", () => {
    const rgba = renderAxialReview({
      pixels: new Int16Array([4, 5]),
      rows: 1,
      columns: 2,
      photometric: "MONOCHROME2",
      windowCenter: 5,
      windowWidth: 1
    });

    expect(pixelAt(rgba, 2, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(rgba, 2, 0, 1)).toEqual([255, 255, 255, 255]);
  });

  it("inverts the windowed display value for MONOCHROME1", () => {
    const rgba = renderAxialReview({
      pixels: new Int16Array([0, 64, 255]),
      rows: 1,
      columns: 3,
      photometric: "MONOCHROME1",
      windowCenter: 128,
      windowWidth: 256
    });

    expect(pixelAt(rgba, 3, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(rgba, 3, 0, 1)).toEqual([191, 191, 191, 255]);
    expect(pixelAt(rgba, 3, 0, 2)).toEqual([0, 0, 0, 255]);
  });

  it("composites the overlay only inside the declared row spans", () => {
    const input = {
      pixels: new Int16Array(12).fill(128),
      rows: 3,
      columns: 4,
      photometric: "MONOCHROME2" as const,
      windowCenter: 128,
      windowWidth: 256,
      overlaySpans: [[1, 1, 3]] as const
    };
    const withoutOverlay = renderAxialReview({ ...input, overlaySpans: undefined });
    const withOverlay = renderAxialReview(input);

    for (let row = 0; row < input.rows; row++) {
      for (let column = 0; column < input.columns; column++) {
        const isCovered = row === 1 && column >= 1 && column < 3;
        if (isCovered) {
          expect(pixelAt(withOverlay, input.columns, row, column)).not.toEqual(
            pixelAt(withoutOverlay, input.columns, row, column)
          );
        } else {
          expect(pixelAt(withOverlay, input.columns, row, column)).toEqual(
            pixelAt(withoutOverlay, input.columns, row, column)
          );
        }
      }
    }
    expect(renderAxialReview(input)).toEqual(withOverlay);
  });

  it("draws a deterministic clipped seed circle and cross for an in-bounds center", () => {
    const plainInput = {
      pixels: new Int16Array(25).fill(128),
      rows: 5,
      columns: 5,
      photometric: "MONOCHROME2" as const,
      windowCenter: 128,
      windowWidth: 256
    };
    const plain = renderAxialReview(plainInput);
    const marked = renderAxialReview({
      ...plainInput,
      seed: { row: 0, column: 0, radius: 2 }
    });

    expect(pixelAt(marked, 5, 0, 0)).not.toEqual(pixelAt(plain, 5, 0, 0));
    expect(pixelAt(marked, 5, 0, 2)).not.toEqual(pixelAt(plain, 5, 0, 2));
    expect(pixelAt(marked, 5, 2, 0)).not.toEqual(pixelAt(plain, 5, 2, 0));
    expect(pixelAt(marked, 5, 4, 4)).toEqual(pixelAt(plain, 5, 4, 4));
  });

  it("rejects an out-of-bounds seed instead of silently accepting it", () => {
    expect(() =>
      renderAxialReview({
        pixels: new Int16Array(4),
        rows: 2,
        columns: 2,
        photometric: "MONOCHROME2",
        windowCenter: 0,
        windowWidth: 400,
        seed: { row: 2, column: 0 }
      })
    ).toThrow(/seed/i);
  });

  it.each([
    { pixels: new Int16Array(0), rows: 0, columns: 1, windowCenter: 0, windowWidth: 400 },
    { pixels: new Int16Array(4), rows: 2, columns: 3, windowCenter: 0, windowWidth: 400 },
    { pixels: new Int16Array(1), rows: 1.5, columns: 1, windowCenter: 0, windowWidth: 400 },
    { pixels: new Int16Array(1), rows: 1, columns: 1, windowCenter: 0, windowWidth: 0 },
    { pixels: new Int16Array(1), rows: 1, columns: 1, windowCenter: Number.NaN, windowWidth: 400 }
  ])("rejects invalid dimensions or window values: %o", (invalid) => {
    expect(() =>
      renderAxialReview({
        ...invalid,
        photometric: "MONOCHROME2"
      })
    ).toThrow();
  });

  it("rejects malformed overlay spans", () => {
    expect(() =>
      renderAxialReview({
        pixels: new Int16Array(4),
        rows: 2,
        columns: 2,
        photometric: "MONOCHROME2",
        windowCenter: 0,
        windowWidth: 400,
        overlaySpans: [[1, 1, 3]]
      })
    ).toThrow(/overlay/i);
  });
});
