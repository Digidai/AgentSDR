// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
export type ClassificationApplicationDecision =
  "auto_apply" | "requires_review" | "protected_customer" | "protected_stage";

/**
 * The AI only moves a record forward through the funnel.
 *
 * Once a record sits on a ranked stage, a proposal for a lower-ranked or
 * unranked subcategory is held for a person to decide rather than applied:
 * going back a step is a judgement about the deal, not about the message.
 * Equal ranks are lateral (Meeting Requested ↔ Meeting No Show). Do Not
 * Contact is exempt — suppression must never wait on a review queue. A record
 * on an unranked stage, or with no stage yet, moves freely.
 */
export function isBackwardStageMove(input: {
  currentStageRank: number | null;
  proposedStageRank: number | null;
  proposedSubcategoryKey: string | null;
}): boolean {
  if (input.currentStageRank === null) return false;
  if (input.proposedSubcategoryKey === "do_not_contact") return false;
  return (
    input.proposedStageRank === null ||
    input.proposedStageRank < input.currentStageRank
  );
}

export type ClassificationPolicyInput = {
  currentCategoryKey: string | null;
  currentCategoryLocked: boolean;
  proposedCategoryKey: string;
  confidence: number;
  autoApplyConfidence: number;
  reviewOther: boolean;
  customerRequiresReview: boolean;
  subcategoryReviewRequired: boolean;
  /** Funnel rank of the record's current subcategory; null when unranked. */
  currentStageRank: number | null;
  proposedStageRank: number | null;
  proposedSubcategoryKey: string | null;
};

/** Deterministic, data-backed AI classification policy. */
export function classificationApplicationDecision(
  input: ClassificationPolicyInput,
): ClassificationApplicationDecision {
  if (input.confidence < 0 || input.confidence > 1) {
    throw new Error("Classification confidence must be between 0 and 1");
  }
  if (input.autoApplyConfidence < 0 || input.autoApplyConfidence > 1) {
    throw new Error("Auto-apply confidence must be between 0 and 1");
  }
  if (
    input.currentCategoryLocked &&
    input.currentCategoryKey === "customer" &&
    input.proposedCategoryKey !== "customer"
  ) {
    return "protected_customer";
  }
  if (isBackwardStageMove(input)) return "protected_stage";
  if (
    input.proposedCategoryKey === "customer" &&
    input.customerRequiresReview
  ) {
    return "requires_review";
  }
  if (input.subcategoryReviewRequired) return "requires_review";
  if (input.proposedCategoryKey === "other" && input.reviewOther)
    return "requires_review";
  if (input.confidence < input.autoApplyConfidence) return "requires_review";
  return "auto_apply";
}
