# Composite PK User Isolation — Deepwork

## Goal
Fix cross-window comment tree binding by changing `videos` table PK from `id` to composite `(id, userId)`, adding `userId` to `comments` and related tables, and filtering all queries by userId.

## Root Cause
- `videos.id` (exportId) is globally unique PK
- Two users monitoring same platform/account share the same video record
- `comments.video_id` references `videos.id` without user scoping
- Comment tree query `where: { videoId: id }` doesn't filter by user

## Current DB State
- Window `68a25962...`: 4 users (id=2 tencent, id=3 douyin, id=4 kuaishou, id=5 xiaohongshu)
- Window `43dc0983...`: 1 user (id=7 douyin)
- userId=3 has 20 videos + 97 comments; userId=7 has 0 videos (not yet crawled)

## Schema Changes Required

### 1. Video model
- `@@id([id, userId])` composite PK (was `@id` on `id`)
- Prisma `where` changes: `{ id: "x" }` → `{ id_userId: { id: "x", userId: N } }`

### 2. Comment model
- Add `userId Int @map("user_id")`
- FK: `fields: [videoId, userId], references: [id, userId]`
- Unique: `@@unique([cid, userId])` (was `@@unique([cid])`)
- Prisma `where` changes: `{ cid: "x" }` → `{ cid_userId: { cid: "x", userId: N } }`

### 3. VideoRootCommentCount model
- Add `userId Int @map("user_id")`
- Unique: `@@unique([videoId, userId, cid])` (was `@@unique([videoId, cid])`)
- No FK relation to Video (plain string column)

### 4. VideoCommentCount model (legacy, mostly cleanup)
- Add `userId Int @map("user_id")`
- Unique: `@@unique([platform, videoId, userId])` (was `@@unique([platform, videoId])`)

### 5. VideoCommentRecord model (legacy)
- Add `userId Int? @map("user_id")` (already has a `userId String?` column — need to check conflict)

## Migration Steps
1. Add `user_id` columns to comments, video_root_comment_counts, video_comment_counts
2. Backfill `user_id` from `videos.user_id` via `video_id` join
3. Drop existing constraints (PK on videos, unique on comments.cid, FK)
4. Create new composite constraints
5. Run `prisma migrate`

## Affected Files (by category)

### A. Video upsert/findUnique/delete (need composite key)
- `monitorDatabaseService.ts`: upsertVideosBatch (L44), updateCommentCount (L140), reconcileVideosForUser (L201,237), truncateVideosByUser (L152,166)
- `douyinCrawler.ts`: delete (L1245), findUnique (L1257)
- `kuaishouCrawler.ts`: delete (L1267), findUnique (L1278)
- `xiaohongshuCrawler.ts`: findUnique (L660)
- `tencentCrawler.ts`: delete (L874), findUnique (L899)
- `monitorService.ts`: findMany (L287), findUnique (L1816)

### B. Comment upsert/findUnique/findFirst (need userId)
- `monitorDatabaseService.ts`: upsertComment (L102), upsertCommentTree (L603), batchUpsertComments (L662), upsertLightModeComment (L292), getLastCommentTime (L128), markCommentsAsNotified (L277), getCommentForNotification (L775), getCommentForReply (L803), updateCommentSuggestion (L838,854,871)
- `douyinCrawler.ts`: updateMany (L1764), findMany (L1846,1890)
- `monitorService.ts`: findMany (L298), findFirst (L1578,1609,1618,1627)
- `matrix.ts`: findMany (L821), updateMany (L882,947), findUnique (L914,978,1034), update (L919,1011,1053)
- `monitor.ts`: findMany (L138), findUnique (L203,275), update (L208), updateMany (L240,313)
- `llmReply.ts`: findUnique (L29,130,218), findFirst (L44,51,144,148)
- `wechatBotService.ts`: updateMany (L847)
- `system.ts`: count (L19)

### C. VideoRootCommentCount (need userId)
- `monitorDatabaseService.ts`: findMany (L702), upsert (L721,738), deleteMany (L162,220,757,762)
- `monitorService.ts`: findFirst (L1618,1627)
- `matrix.ts`: deleteMany (L1293,1330)
- `operators.ts`: deleteMany (L80,152,670)

### D. Video list queries (already filter by userId, but need composite key for joins)
- `matrix.ts`: findMany (L784,1322,1402), count (L749), aggregate (L663,752)
- `monitor.ts`: findMany (L97), count (L65), aggregate (L68)
- `unifiedQueue.ts`: count (L276), aggregate (L277)

### E. Delete operations
- `matrix.ts`: deleteMany (L1293-1297, 1330-1335)
- `operators.ts`: deleteMany (L80-82, 152-154, 670-672)

### F. Frontend
- `admin-dashboard/src/hooks/useApi.ts`: useVideoComments — API call needs userId context

## Key Design Decisions
- `update` clause in upsert CANNOT change userId (part of PK) — this is correct behavior
- `findUnique` and `upsert` require composite key: `{ id_userId: { id, userId } }`
- `updateMany` and `deleteMany` can still use `where: { id: { in: [...] }, userId }` 
- `findMany` already filters by userId in most cases — minimal changes needed
- Comment `cid` uniqueness changes to `(cid, userId)` — same comment from different users stored separately

## Open Questions — RESOLVED
1. VideoCommentRecord's `user_id` is `varchar(64)` = platform commenter's ID, NOT monitoring user. Legacy table, leave as-is.
2. Orphan comments: 0 — safe to backfill.
3. Duplicate cid values: 0 — safe to change unique constraint.

## Phased Implementation Plan

### Phase 1: Prisma Schema + Migration (MUST be first, blocks all)
- Modify `prisma/schema.prisma`: Video composite PK, Comment add userId, VideoRootCommentCount add userId, VideoCommentCount add userId
- Create SQL migration: add columns, backfill, drop old constraints, create new constraints
- Run `npx prisma migrate dev --name user-isolation-composite-pk`
- Verify migration succeeds

### Phase 2: monitorDatabaseService.ts (core DB layer, blocks crawlers)
- All `prisma.video.upsert` → composite key `id_userId`
- All `prisma.video.findUnique` → composite key
- All `prisma.video.delete` → composite key
- All `prisma.comment.upsert` → composite key `cid_userId`
- All `prisma.comment.findFirst/findMany` → add `userId` filter
- All `prisma.comment.updateMany` → add `userId` filter
- All `prisma.videoRootCommentCount.*` → add `userId`
- Add `userId` parameter to function signatures where missing

### Phase 3: Crawler files (parallel, 4 files)
- `douyinCrawler.ts`: findUnique/delete composite key, comment queries add userId
- `kuaishouCrawler.ts`: same
- `xiaohongshuCrawler.ts`: same
- `tencentCrawler.ts`: same

### Phase 4: Routes + Services (parallel with Phase 3)
- `matrix.ts`: comment tree query, video queries, delete operations
- `monitor.ts`: same
- `llmReply.ts`: comment lookups
- `wechatBotService.ts`: comment updateMany
- `system.ts`: comment count
- `unifiedQueue.ts`: video count/aggregate
- `operators.ts`: deleteMany operations
- `monitorService.ts`: comment findMany/findFirst, video findUnique

### Phase 5: Frontend + Verification
- `admin-dashboard/src/hooks/useApi.ts`: pass userId to comment tree API
- Build check: `npx tsc --noEmit`
- DB verification: check migration applied correctly
- Runtime test: monitor a platform and verify comment tree isolation
