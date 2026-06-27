-- CreateTable
CREATE TABLE "hot_video_candidates" (
    "id" TEXT NOT NULL,
    "platform_id" VARCHAR(64) NOT NULL,
    "video_id" VARCHAR(256) NOT NULL,
    "title" VARCHAR(512),
    "author" VARCHAR(256),
    "play_count" INTEGER,
    "cover" VARCHAR(1024),
    "video_url" VARCHAR(1024),
    "publish_time" TIMESTAMP(3),
    "raw_json" JSONB,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "style" VARCHAR(64),

    CONSTRAINT "hot_video_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_hot_video_fetched_at" ON "hot_video_candidates"("fetched_at");

-- CreateIndex
CREATE INDEX "idx_hot_video_status" ON "hot_video_candidates"("status");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "uq_hot_video_platform_video" ON "hot_video_candidates"("platform_id", "video_id");
