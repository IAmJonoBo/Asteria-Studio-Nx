export type ReviewPaneReadyChecklist = {
  assertSelectedPageImagePresent: () => Promise<void> | void;
  assertToolPanelControlsPresent: () => Promise<void> | void;
  assertGuideLayerRenderPresent: () => Promise<void> | void;
  assertSnapFeedbackWhileDragging: () => Promise<void> | void;
};

/**
 * Shared readiness checklist for review-pane integration tests.
 */
export const assertReviewPaneReadyChecklist = async (
  checklist: ReviewPaneReadyChecklist
): Promise<void> => {
  await checklist.assertSelectedPageImagePresent();
  await checklist.assertToolPanelControlsPresent();
  await checklist.assertGuideLayerRenderPresent();
  await checklist.assertSnapFeedbackWhileDragging();
};
