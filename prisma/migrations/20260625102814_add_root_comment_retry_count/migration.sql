-- AlterTable: Add rootCommentRetryCount column to videos table
ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "root_comment_retry_count" INTEGER NOT NULL DEFAULT 0;
