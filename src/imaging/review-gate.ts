import type { LocalDicomResult } from "./types";

/** Safety-critical commit gate shared by the UI state and its tests. */
export function canLoadReviewedLocalDicom(
  result: (Pick<LocalDicomResult, "seedConfirmed" | "doc"> & {
    review: Pick<LocalDicomResult["review"], "topologyStatus">;
  }) | null,
  reviewApproved: boolean,
  busy: boolean,
  axialCheckpointReviewComplete: boolean,
  orthogonalCheckpointReviewComplete: boolean
): boolean {
  return (
    result?.seedConfirmed === true &&
    result.doc !== null &&
    result.review.topologyStatus === "pass" &&
    axialCheckpointReviewComplete &&
    orthogonalCheckpointReviewComplete &&
    reviewApproved &&
    !busy
  );
}
