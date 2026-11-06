-- Leases for withLock when there is no Redis: one row per running job, so a lock no longer holds a database connection.
CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);
