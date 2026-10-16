-- Narrows the backfill in 20261018120000_contact_approval, which approved everyone in a week marked APPROVED,
-- SENDING or DONE. A week could be marked approved by the workspace's auto-approve setting, not a person, and no
-- record says which. So that approval is kept only where the workspace does not auto-approve weeks.
-- What the backfill keeps: CSV uploads, people a person approved on the approve screen, and people in weeks of
-- workspaces that approve weeks by hand.
-- Being already emailed is not a reason to approve anyone, and nobody needs it: approval gates only the first email,
-- so follow-ups and replies to people already emailed carry on whether or not approvedAt is set.
UPDATE "Contact" c SET "approvedAt" = NULL, "approvalSource" = NULL
FROM "WeeklyBatch" b, "OrgSettings" s
WHERE c."batchId" = b.id
  AND s."organizationId" = c."organizationId"
  AND s."autoApproveBatches" = true
  AND c."approvalSource" = 'review'
  AND c."approvedAt" = COALESCE(b."approvedAt", b."updatedAt");
