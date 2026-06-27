-- AlterTable: rename platform_id to platform, change play_count to BigInt, add created_at
ALTER TABLE "hot_video_candidates" RENAME COLUMN "platform_id" TO "platform";
ALTER TABLE "hot_video_candidates" ALTER COLUMN "play_count" SET DATA TYPE BIGINT;
ALTER TABLE "hot_video_candidates" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Drop old unique index and recreate with new column name
DROP INDEX IF EXISTS "uq_hot_video_platform_video";
CREATE UNIQUE INDEX "uq_hot_video_platform_video" ON "hot_video_candidates"("platform", "video_id");

-- CreateIndex
CREATE INDEX "idx_hot_video_platform_status_fetched" ON "hot_video_candidates"("platform", "status", "fetched_at");
