-- Mailbox and domain prices become editable unit prices (they were fixed in code). Defaults match the old constants.
ALTER TABLE "CostSettings" ADD COLUMN "mailboxMonthUsd" DECIMAL(8,2) NOT NULL DEFAULT 4.00;
ALTER TABLE "CostSettings" ADD COLUMN "repliesOnlyMailboxMonthUsd" DECIMAL(8,2) NOT NULL DEFAULT 3.00;
ALTER TABLE "CostSettings" ADD COLUMN "domainYearUsd" DECIMAL(8,2) NOT NULL DEFAULT 15.00;
