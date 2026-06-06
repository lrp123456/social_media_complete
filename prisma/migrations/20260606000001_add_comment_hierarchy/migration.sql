-- Add hierarchy columns to comments table
ALTER TABLE "comments" 
  ADD COLUMN IF NOT EXISTS "root_id" text,
  ADD COLUMN IF NOT EXISTS "parent_id" text,
  ADD COLUMN IF NOT EXISTS "level" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "reply_to_name" text;

-- Create new index for video + root comment lookups
CREATE INDEX IF NOT EXISTS "idx_comments_video_root" ON "comments"("video_id", "root_id");

-- Create VideoRootCommentCount model table
CREATE TABLE IF NOT EXISTS "video_root_comment_counts" (
    "id" text NOT NULL DEFAULT gen_random_uuid()::text,
    "video_id" text NOT NULL,
    "cid" text NOT NULL,
    "reply_count" integer NOT NULL DEFAULT 0,
    "created_at" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "video_root_comment_counts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "video_root_comment_counts_video_id_cid_key" UNIQUE ("video_id", "cid")
);
