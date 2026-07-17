import { describe, expect, it } from "vitest";
import { canLoadReviewedLocalDicom } from "./review-gate";

describe("local DICOM review commit gate", () => {
  const passingResult = {
    seedConfirmed: true as const,
    doc: {} as never,
    review: { topologyStatus: "pass" as const }
  };

  it.each([
    [null, false, false, false, false, false],
    [null, true, false, true, true, false],
    [passingResult, false, false, true, true, false],
    [passingResult, true, true, true, true, false],
    [passingResult, true, false, false, true, false],
    [passingResult, true, false, true, false, false],
    [passingResult, true, false, true, true, true]
  ])(
    "requires a seeded result, acquisition and patient-MPR review, separate approval, and an idle worker",
    (result, approved, busy, axialComplete, orthogonalComplete, expected) => {
      expect(canLoadReviewedLocalDicom(result, approved, busy, axialComplete, orthogonalComplete)).toBe(expected);
    }
  );

  it("blocks a seed-confirmed result with unresolved edited-topology blockers", () => {
    expect(
      canLoadReviewedLocalDicom(
        {
          seedConfirmed: true,
          doc: null,
          review: { topologyStatus: "block" }
        },
        true,
        false,
        true,
        true
      )
    ).toBe(false);
  });

  it("blocks a topology-passing result when no simulator document was produced", () => {
    expect(
      canLoadReviewedLocalDicom(
        { seedConfirmed: true, doc: null, review: { topologyStatus: "pass" } },
        true,
        false,
        true,
        true
      )
    ).toBe(false);
  });
});
