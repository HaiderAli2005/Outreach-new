-- The From name is always the sending mailbox's own persona, so it matches the address. The customer sender-name
-- override (setup and Settings) is gone, with the columns that held it.
ALTER TABLE "OrgSettings" DROP COLUMN IF EXISTS "senderName";
ALTER TABLE "Onboarding" DROP COLUMN IF EXISTS "senders";
ALTER TABLE "sends" DROP COLUMN IF EXISTS "from_name_overridden";
