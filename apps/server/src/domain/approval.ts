/** Who decided a person may be emailed: they were uploaded, a person reviewed them, or the workspace auto-approves. */
export type ApprovalSource = "upload" | "review" | "auto";

export const approval = (source: ApprovalSource, at = new Date()) => ({ approvedAt: at, approvalSource: source });

/** The only test of whether a person may be emailed. Batching groups people for review; it never decides this. */
export const APPROVED = { approvedAt: { not: null } };
