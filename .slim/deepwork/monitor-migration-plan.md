# Implementation Plan: Monitor Migration (v2 - Post Oracle Review)

## Key Decisions from Review

1. **Selector file**: Name it `menuSelectors.ts` to avoid collision with existing `selectorConfig.ts`/`selectorStore.ts`
2. **Shared `resolveAndClick` + `tryClickBySelector`**: Extract into `crawlers/menuNavigator.ts` to avoid triplication
3. **Phase 5 expanded**: Full orchestrator with warmup, 3-phase flow, risk handling, notifications, error recovery
4. **Prisma patterns**: Use `upsert()` for comments, two-step delete for truncation
5. **No tests exist**: Verification = TypeScript compile check + manual review

## Final Phases

### Phase 1: Foundation (selectors + DB + menu navigator)
Create 3 files:

1. `apps/ts-api-gateway/src/crawlers/menuSelectors.ts`
   - Port from `my_folder/src/crawler/selectors.ts` 
   - Douyin, Kuaishou, Xiaohongshu menu chains, scroll containers, drawer selectors, exit submenu keys
   - Functions: `getSelector()`, `getSelectorChain()`, `getRandomExitSubmenuKey()`, `getRandomExitSubmenuKeyForPlatform()`

2. `apps/ts-api-gateway/src/services/monitorDatabaseService.ts`
   - Prisma-based singleton
   - Methods: `getVideosByUserId()`, `upsertVideosBatch()`, `upsertComment()` (use upsert not create), `getLastCommentTime()`, `updateCommentCount()`, `truncateVideosByUser()` (two-step: findMany → deleteMany), `setUserCooldown()`, `updateUserStatus()`, `markCommentsAsNotified()`, `getCrawlMode()`, `isUserBlocked()`, `isUserInCooldown()`, `getAllActiveUsers()`, `updateConsecutiveNoUpdate()`

3. `apps/ts-api-gateway/src/crawlers/menuNavigator.ts`
   - Shared `resolveAndClick(page, selectorKey, platform)` — walks menu chain
   - Shared `tryClickBySelector(page, def, platform)` — 3-layer CSS/text fallback
   - Uses `HumanActions.cdpClick()`, `cdpClickByText()`, `cdpClickByTextFiltered()`, `cdpIsElementVisible()`, `cdpIsMenuExpanded()`

### Phase 2: Douyin Crawler
Create `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`
Source: my_folder douyinCrawler.ts (1328 lines)
- Phase 1: `checkForUpdates()` → intercept `/work_list` or `/item/list`, scroll, compare
- Phase 2: `navigateToCommentManage()` → menu chain to 评论管理
- Phase 3: `processCommentsQueue()` → drawer open → find video → click → intercept `/comment/list/select` → parse → store
- Support: `warmUp()`, `navigateToCreatorHome()`, `registerListener()`/`unregisterListener()`, `detectRiskControlAsync()`, `captureRiskScene()`, `executeExitStrategy()`

### Phase 3: Kuaishou Crawler
Create `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`
Source: my_folder kuaishouCrawler.ts (1342 lines)
- Phase 1: `checkForUpdates()` → intercept `/rest/cp/works/v2/video/pc/photo/list`
- Phase 2: `navigateToCommentManage()` → menu chain
- Phase 3: `processCommentsQueue()` → drawer open → find video by description/XPath → click → intercept `/rest/cp/comment/pc/list`

### Phase 4: Xiaohongshu Crawler
Create `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`
Source: my_folder xiaohongshuCrawler.ts (652 lines)
- Light mode only (no Phase 2/3)
- `checkForUpdates()` → intercept `/api/galaxy/v2/creator/note/user/posted`
- Note: xiaohongshu CANNOT do deep mode (enforced at scheduler level)

### Phase 5: Orchestrator & Wiring
Update `apps/ts-api-gateway/src/services/monitorService.ts`:
- Import & instantiate 3 crawlers + monitorDatabaseService
- Replace stub `crawlDouyin()`, `crawlKuaishou()`, `crawlXiaohongshu()` with:
  - Full warmup flow (per-window, only once)
  - 3-phase execution per platform
  - Risk control detection → screenshot → block user → 30min cooldown
  - Comment notification (stub via prisma operation log for now)
  - Consecutive no-update tracking
  - Error recovery + exit strategy
  - Crawl mode enforcement (light for xhs)
- Make `executeMonitorCheck()` the real implementation

### Phase 6: Verification
- TypeScript compile check for ts-api-gateway
- Validate all imports resolve
- Verify no circular dependencies
