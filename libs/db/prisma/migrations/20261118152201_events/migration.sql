-- CreateEnum
CREATE TYPE "event_status" AS ENUM ('ACTIVE', 'PAUSED', 'DELETED');

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "starts_at_local" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "rrule" TEXT,
    "rrule_version" INTEGER NOT NULL DEFAULT 1,
    "status" "event_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "events_user_id_status_idx" ON "events"("user_id", "status");

-- CreateIndex
CREATE INDEX "events_user_id_created_at_id_idx" ON "events"("user_id", "created_at" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
