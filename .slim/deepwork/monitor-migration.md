# Monitor Migration: my_folder → social_media_complete

**Goal**: Fully migrate the 3-phase video comment monitoring system from the my_folder reference project into the current social_media_complete project, replacing the current stub implementations (`Math.floor(Math.random() * ...)`).

## Current State

### Stub implementations to replace
- `apps/ts-api-gateway/src/services/monitorService.ts:129-158` — `crawlDouyin()`, `crawlKuaishou()`, `crawlXiaohongshu()` all return random numbers
- `packages/browser-core/src/interceptor.ts` — Exists and is nearly identical to my_folder version; already has extractors, validators, pagination support

### Already available (can reuse directly)
- `packages/browser-core/src/humanActions.ts` — CDP-level anti-detection browser operations (mouse, keyboard, scroll, click)
- `packages/browser-core/src/selectorConfig.ts` — SelectorReader for dynamic selectors (different format from my_folder's selectors, but same concept)
- `packages/browser-core/src/interceptor.ts` — RequestInterceptor already exists, identical API
- `packages/browser-core/src/exitStrategy.ts` — Already has xhs exit strategies
- `packages/browser-core/src/pageStateManager.ts` — Already has platform page states
- `packages/browser-core/src/cdpMouse.ts`, `cdpScroller.ts` — Low-level operations
- Prisma schema already matches my_folder schema (User, Video, Comment, ScheduleRule, etc.)

### Already exists in current project
- `packages/browser-core/src/browserManager.ts` — BrowserManager (CDP connect to RoxyBrowser/BitBrowser)
- `apps/ts-api-gateway/src/lib/browserManager.ts` — Thin wrapper
- `apps/ts-api-gateway/src/lib/redlock.ts` — WindowMutex

## Reference Implementation (my_folder)

### 3-Phase Architecture
1. **Phase 1 (Discovery)**: Navigate to creator center → register API interceptor → navigate to video list → scroll to load → compare comment_counts with DB → enqueue videos with new comments
2. **Phase 2 (Navigate to Comment Management)**: Click menu chain to reach "评论管理" page
3. **Phase 3 (Fetch Comment Details)**: For each enqueued video: open "选择作品"/"选择视频" drawer → find video by description → click → intercept comment API → parse & store

### Platform differences
| Platform | Phase 1 API Pattern | Phase 2 | Phase 3 | Crawl Modes |
|----------|-------------------|---------|---------|-------------|
| douyin | `/work_list` or `/item/list` | Yes | Yes (drawer) | deep/light |
| kuaishou | `/rest/cp/works/v2/video/pc/photo/list` | Yes | Yes (drawer) | deep/light |
| xiaohongshu | `/api/galaxy/v2/creator/note/user/posted` | No | No | light only |

### Key files to port
- `my_folder/src/crawler/douyinCrawler.ts` (1328 lines) → `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`
- `my_folder/src/crawler/kuaishouCrawler.ts` (1342 lines) → `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`
- `my_folder/src/crawler/xiaohongshuCrawler.ts` (652 lines) → `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`
- `my_folder/src/crawler/selectors.ts` (475 lines) → `apps/ts-api-gateway/src/crawlers/selectors.ts`
- `my_folder/src/scheduler/scheduler.ts` (869 lines) — orchestration logic for the 3-phase flow
- `my_folder/src/db/database.ts` → `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` (Prisma-based)

### Key adaptations needed
1. Replace SQLite calls (`this.db.upsertVideosBatch()`, etc.) with Prisma equivalents
2. Replace `my_folder`'s BrowserManager with the current project's BrowserManager (same API)
3. Replace `my_folder`'s HumanActions with `@social-media/browser-core` HumanActions (same API)
4. Keep `my_folder`'s `RequestInterceptor` — but the current project already has an identical copy in `packages/browser-core/src/interceptor.ts`
5. Replace `my_folder`'s exit strategy with the existing one in `packages/browser-core/src/exitStrategy.ts`
