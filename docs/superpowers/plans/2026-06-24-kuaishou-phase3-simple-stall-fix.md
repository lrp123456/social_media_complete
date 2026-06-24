# Kuaishou Phase3 Simple Stall Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Kuaishou Phase3 Simple mode so a missing drawer, fragile drawer match, or missing `commentList` response does not stall the whole comment collection queue.

**Architecture:** Add a small pure utility module for Kuaishou drawer matching/stop decisions, then wire it into the existing `KuaishouCrawler`. Keep the fix local to Kuaishou Phase3 Simple mode: drawer opening must converge to visible/failed, drawer search must fail fast on empty DOM and avoid premature “scrolled past”, and Simple mode must short-wait the first `commentList` before collecting paginated root comments.

**Tech Stack:** TypeScript, Jest/ts-jest, Patchright `Page`, existing `RequestInterceptor`, existing `HumanActions` CDP helpers.

---

## File Structure

- Create: `apps/ts-api-gateway/src/crawlers/kuaishouDrawerUtils.ts`
  - Pure helpers for text normalization, normalized drawer title matching, and drawer search stop decisions.
- Create: `apps/ts-api-gateway/src/crawlers/__tests__/kuaishouDrawerUtils.test.ts`
  - Unit tests for NBSP/newline normalization, short hashtag matching, non-match cases, and stop-decision edge cases.
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`
  - Import utility helpers.
  - Make `openSelectVideoDrawer` return false unless the drawer is actually visible.
  - Replace inline drawer description matching with normalized matching.
  - Add `loadedItems=0` and no-growth stop decisions.
  - Add a short comment response wait path for Simple mode.
  - Change `processCommentsQueueSimple` to skip immediately if the first short wait gets no `commentList`.

---

### Task 1: Add Kuaishou Drawer Utility Tests

**Files:**
- Create: `apps/ts-api-gateway/src/crawlers/__tests__/kuaishouDrawerUtils.test.ts`
- Create later: `apps/ts-api-gateway/src/crawlers/kuaishouDrawerUtils.ts`

- [ ] **Step 1: Create failing tests for text normalization and drawer matching**

Create `apps/ts-api-gateway/src/crawlers/__tests__/kuaishouDrawerUtils.test.ts` with:

```ts
import {
  isKuaishouDrawerVideoTextMatch,
  normalizeKuaishouVideoText,
  shouldStopKuaishouDrawerSearch,
} from '../kuaishouDrawerUtils';

describe('normalizeKuaishouVideoText', () => {
  it('removes normal whitespace, newlines, and NBSP while lowercasing text', () => {
    expect(normalizeKuaishouVideoText('  #Air\n空气 清新 环境优美  ')).toBe('#air空气清新环境优美');
  });

  it('keeps Chinese characters, numbers, and hashtag markers', () => {
    expect(normalizeKuaishouVideoText('#好心情 2026 No.1')).toBe('#好心情2026no.1');
  });
});

describe('isKuaishouDrawerVideoTextMatch', () => {
  it('matches hashtag-only titles with trailing NBSP differences', () => {
    expect(isKuaishouDrawerVideoTextMatch('#空气清新环境优美', '#空气清新环境优美 ')).toBe(true);
  });

  it('matches multiline descriptions when the drawer DOM contains the normalized prefix', () => {
    const target = '奶油风客厅，温柔自成一派\n柔和线条，低饱和配色\n阳光透过纱帘，日子慢得刚好';
    const domText = '奶油风客厅，温柔自成一派 柔和线条 2026-06-19 12:07:35';
    expect(isKuaishouDrawerVideoTextMatch(domText, target)).toBe(true);
  });

  it('does not match a completely different drawer title', () => {
    expect(isKuaishouDrawerVideoTextMatch('雪山下的小屋 2026-06-19 12:07:35', '#空气清新环境优美')).toBe(false);
  });
});

describe('shouldStopKuaishouDrawerSearch', () => {
  it('stops after repeated empty drawer item lists', () => {
    expect(shouldStopKuaishouDrawerSearch({
      itemCount: 0,
      emptyRounds: 2,
      noGrowthRounds: 0,
      hasScrolled: true,
      minTimestamp: null,
      targetCreateTime: 1779930199,
      tolerance: 60,
    })).toMatchObject({ stop: true, reason: 'empty-list' });
  });

  it('does not stop only because the oldest loaded timestamp is older than the target', () => {
    expect(shouldStopKuaishouDrawerSearch({
      itemCount: 30,
      emptyRounds: 0,
      noGrowthRounds: 0,
      hasScrolled: true,
      minTimestamp: 1779265282,
      targetCreateTime: 1779930199,
      tolerance: 60,
    })).toMatchObject({ stop: false });
  });

  it('stops when the list has stopped growing after scrolling and has moved past the target window', () => {
    expect(shouldStopKuaishouDrawerSearch({
      itemCount: 30,
      emptyRounds: 0,
      noGrowthRounds: 2,
      hasScrolled: true,
      minTimestamp: 1779265282,
      targetCreateTime: 1779930199,
      tolerance: 60,
    })).toMatchObject({ stop: true, reason: 'no-growth-past-target' });
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter ts-api-gateway test -- kuaishouDrawerUtils.test.ts
```

Expected: FAIL because `../kuaishouDrawerUtils` does not exist yet.

---

### Task 2: Implement Kuaishou Drawer Utility Functions

**Files:**
- Create: `apps/ts-api-gateway/src/crawlers/kuaishouDrawerUtils.ts`
- Test: `apps/ts-api-gateway/src/crawlers/__tests__/kuaishouDrawerUtils.test.ts`

- [ ] **Step 1: Create the utility module**

Create `apps/ts-api-gateway/src/crawlers/kuaishouDrawerUtils.ts` with:

```ts
export type KuaishouDrawerStopReason = 'empty-list' | 'no-growth-past-target';

export interface KuaishouDrawerStopInput {
  itemCount: number;
  emptyRounds: number;
  noGrowthRounds: number;
  hasScrolled: boolean;
  minTimestamp: number | null;
  targetCreateTime: number;
  tolerance: number;
}

export interface KuaishouDrawerStopDecision {
  stop: boolean;
  reason?: KuaishouDrawerStopReason;
}

export function normalizeKuaishouVideoText(text: string): string {
  return String(text || '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function isKuaishouDrawerVideoTextMatch(domText: string, targetDescription: string): boolean {
  const normalizedDom = normalizeKuaishouVideoText(domText);
  const normalizedTarget = normalizeKuaishouVideoText(targetDescription);

  if (!normalizedDom || !normalizedTarget) return false;

  const primaryPrefix = normalizedTarget.slice(0, Math.min(20, normalizedTarget.length));
  if (primaryPrefix.length >= 8 && normalizedDom.includes(primaryPrefix)) return true;

  const shortPrefix = normalizedTarget.slice(0, Math.min(10, normalizedTarget.length));
  if (shortPrefix.length >= 6 && normalizedDom.includes(shortPrefix)) return true;

  const hashtagParts = normalizedTarget
    .split('#')
    .map(part => part.trim())
    .filter(part => part.length >= 4)
    .map(part => `#${part}`);

  return hashtagParts.some(part => normalizedDom.includes(part));
}

export function shouldStopKuaishouDrawerSearch(input: KuaishouDrawerStopInput): KuaishouDrawerStopDecision {
  if (input.itemCount === 0 && input.emptyRounds >= 2) {
    return { stop: true, reason: 'empty-list' };
  }

  const passedTargetWindow = input.minTimestamp !== null
    && Number.isFinite(input.minTimestamp)
    && input.minTimestamp < input.targetCreateTime - input.tolerance;

  if (input.itemCount > 0 && input.hasScrolled && input.noGrowthRounds >= 2 && passedTargetWindow) {
    return { stop: true, reason: 'no-growth-past-target' };
  }

  return { stop: false };
}
```

- [ ] **Step 2: Run the focused utility test**

Run:

```bash
pnpm --filter ts-api-gateway test -- kuaishouDrawerUtils.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit utility tests and implementation**

Run:

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouDrawerUtils.ts apps/ts-api-gateway/src/crawlers/__tests__/kuaishouDrawerUtils.test.ts
git commit -m "test(kuaishou): add drawer matching utilities"
```

---

### Task 3: Make Kuaishou Drawer Opening Require Visible Drawer

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:1915-1945`

- [ ] **Step 1: Update `openSelectVideoDrawer` to retry when the drawer is not visible**

Replace the `if (clicked) { ... } else { ... }` body in `openSelectVideoDrawer` with:

```ts
      if (clicked) {
        logger.info({ attempt }, '[Drawer] Button click succeeded, waiting for drawer');
        await HumanActions.wait(page, 1500, 3000);

        const drawerVisible = await this.isDrawerVisible(page);
        if (drawerVisible) {
          logger.info('[Drawer] Kuaishou drawer confirmed visible');
          return true;
        }

        logger.warn({ attempt }, '[Drawer] Click succeeded but drawer not visible, retrying');
        await HumanActions.wait(page, 1000, 2000);
        continue;
      }

      logger.warn({ attempt }, '[Drawer] All click methods failed');
      await HumanActions.wait(page, 1000, 2000);
```

This removes the old unsafe `return true` after `Click succeeded but drawer not detected`.

- [ ] **Step 2: Run a static check for the removed unsafe log**

Run:

```bash
rg -n "proceeding anyway|Click succeeded but drawer not detected" apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
```

Expected: no output.

- [ ] **Step 3: Commit drawer opening change**

Run:

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "fix(kuaishou): require visible drawer before searching"
```

---

### Task 4: Use Robust Drawer Matching and Stop Decisions

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:1-17`
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:2015-2127`
- Test: `apps/ts-api-gateway/src/crawlers/__tests__/kuaishouDrawerUtils.test.ts`

- [ ] **Step 1: Import the drawer utility helpers**

Add this import near the existing crawler imports:

```ts
import { isKuaishouDrawerVideoTextMatch, shouldStopKuaishouDrawerSearch } from './kuaishouDrawerUtils';
```

- [ ] **Step 2: Add drawer search state counters**

Inside `findAndClickVideoInDrawer`, after the constants, add:

```ts
    let lastLoadedItems = -1;
    let noGrowthRounds = 0;
    let emptyRounds = 0;
    let hasScrolled = false;
```

- [ ] **Step 3: Replace page-evaluate matching with normalized text matching**

Replace the `page.evaluate` callback body in `findAndClickVideoInDrawer` so it no longer computes `scrolledPast`. The callback should return candidates that were matched by timestamp and use a normalized match helper outside the browser context:

```ts
      const matchResult = await page.evaluate(({ createTimeNum, tolerance }: { createTimeNum: number; tolerance: number }) => {
        const items = document.querySelectorAll('.video-item');
        let minTimestamp = Infinity;
        let maxTimestamp = -Infinity;
        let itemCount = 0;
        const candidates: Array<{ domTimestamp: number; title: string; dateText: string; fullText: string }> = [];

        for (const item of items) {
          const titleEl = item.querySelector('.video-info__content__title');
          const dateEl = item.querySelector('.video-info__content__date');
          const title = titleEl?.textContent?.trim() || '';
          const dateText = dateEl?.textContent?.trim() || '';
          const fullText = `${title} ${dateText}`;

          const dateMatch = dateText.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
          if (!dateMatch) continue;
          const [, y, m, d, h, min, s] = dateMatch;
          const domTimestamp = Math.floor(new Date(`${y}-${m}-${d}T${h}:${min}:${s}+08:00`).getTime() / 1000);

          itemCount++;
          if (domTimestamp < minTimestamp) minTimestamp = domTimestamp;
          if (domTimestamp > maxTimestamp) maxTimestamp = domTimestamp;

          if (Math.abs(domTimestamp - createTimeNum) <= tolerance) {
            candidates.push({ domTimestamp, title: title.substring(0, 80), dateText, fullText });
          }
        }

        return {
          found: false,
          itemCount,
          minTimestamp: Number.isFinite(minTimestamp) ? minTimestamp : null,
          maxTimestamp: Number.isFinite(maxTimestamp) ? maxTimestamp : null,
          candidates,
        };
      }, { createTimeNum: createTime, tolerance: TIMESTAMP_TOLERANCE });
```

- [ ] **Step 4: Click the timestamp-matched candidate only after normalized text match**

After the diagnostic log and before stop checks, add:

```ts
      const matchedCandidate = matchResult.candidates.find(candidate =>
        isKuaishouDrawerVideoTextMatch(candidate.fullText, description),
      );

      if (matchedCandidate) {
        const clicked = await page.evaluate((targetDateText: string) => {
          const items = document.querySelectorAll('.video-item');
          for (const item of items) {
            const dateEl = item.querySelector('.video-info__content__date');
            if (dateEl?.textContent?.trim() === targetDateText) {
              (dateEl as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, matchedCandidate.dateText);

        if (!clicked) {
          logger.warn({ awemeId, dateText: matchedCandidate.dateText }, '[Drawer] Matched candidate but date click failed');
          return false;
        }

        await HumanActions.wait(page, 500, 800);
        const currentUrl = page.url();
        if (currentUrl.includes('kuaishou.com/short-video/') || currentUrl.includes('kuaishou.com/video/')) {
          logger.warn({ awemeId, currentUrl, expectedUrl: 'cp.kuaishou.com/article/comment' }, '[Drawer] 误点击导致跳转到视频详情页，返回评论管理页面');
          await page.goto('https://cp.kuaishou.com/article/comment', { waitUntil: 'domcontentloaded', timeout: 15000 });
          await HumanActions.wait(page, 2000, 3000);
          const drawerOpened = await this.openSelectVideoDrawer(page);
          if (!drawerOpened) {
            logger.error({ awemeId }, '[Drawer] 返回后重新打开抽屉失败');
            return false;
          }
          const retryKey = `retry_${awemeId}`;
          const retryCount = (this as any)[retryKey] || 0;
          if (retryCount >= 3) {
            logger.error({ awemeId, retryCount }, '[Drawer] 连续误点击超过3次，跳过该视频');
            delete (this as any)[retryKey];
            return false;
          }
          (this as any)[retryKey] = retryCount + 1;
          continue;
        }

        logger.info({ awemeId, domTimestamp: matchedCandidate.domTimestamp, createTime, matchType: 'timestamp+normalized-description' }, '[Drawer] 匹配成功');
        return true;
      }
```

- [ ] **Step 5: Replace old `scrolledPast` stop check with utility stop decision**

Remove the old block:

```ts
      if (matchResult.scrolledPast) {
        logger.warn({ awemeId, createTime, oldestTimestamp: matchResult.minTimestamp }, '[Drawer] 已滚动过头，停止搜索');
        break;
      }
```

Add this state update and stop decision before scrolling:

```ts
      if (matchResult.itemCount === 0) {
        emptyRounds++;
      } else {
        emptyRounds = 0;
      }

      if (matchResult.itemCount === lastLoadedItems) {
        noGrowthRounds++;
      } else {
        noGrowthRounds = 0;
      }
      lastLoadedItems = matchResult.itemCount;

      const stopDecision = shouldStopKuaishouDrawerSearch({
        itemCount: matchResult.itemCount,
        emptyRounds,
        noGrowthRounds,
        hasScrolled,
        minTimestamp: matchResult.minTimestamp,
        targetCreateTime: createTime,
        tolerance: TIMESTAMP_TOLERANCE,
      });

      if (stopDecision.stop) {
        if (stopDecision.reason === 'empty-list') {
          logger.warn({ awemeId, emptyRounds }, '[Drawer] Empty video list repeated — stopping search');
        } else {
          logger.warn({ awemeId, noGrowthRounds, oldestTimestamp: matchResult.minTimestamp }, '[Drawer] No growth after scrolling and passed target window — stopping search');
        }
        break;
      }
```

Then, immediately after `await this.scrollDrawerForMoreKuaishou(page, scrollAttempt);`, add:

```ts
        hasScrolled = true;
```

- [ ] **Step 6: Run focused tests and build**

Run:

```bash
pnpm --filter ts-api-gateway test -- kuaishouDrawerUtils.test.ts
pnpm --filter ts-api-gateway build
```

Expected: both commands pass.

- [ ] **Step 7: Commit drawer matching change**

Run:

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/crawlers/kuaishouDrawerUtils.ts apps/ts-api-gateway/src/crawlers/__tests__/kuaishouDrawerUtils.test.ts
git commit -m "fix(kuaishou): harden drawer video matching"
```

---

### Task 5: Add Short CommentList Wait for Simple Mode

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:2223-2239`
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:3043-3076`
- Modify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:3114-3159`

- [ ] **Step 1: Make comment response waiting accept a timeout parameter**

Change the signature of `waitForCommentResponse` from:

```ts
  private async waitForCommentResponse(page: Page): Promise<InterceptedResponse | null> {
    const timeout = 20000;
```

to:

```ts
  private async waitForCommentResponse(page: Page, timeout = 20000): Promise<InterceptedResponse | null> {
```

Keep the rest of the loop unchanged so non-Simple callers still get the existing 20s default.

- [ ] **Step 2: Allow `collectAllCommentResponses` to receive the first response from Simple mode**

Change the signature from:

```ts
  private async collectAllCommentResponses(page: Page): Promise<InterceptedResponse[]> {
    const allResponses: InterceptedResponse[] = [];
    let response = await this.waitForCommentResponse(page);
    if (!response) return [];
    allResponses.push(response);
```

to:

```ts
  private async collectAllCommentResponses(page: Page, initialResponse?: InterceptedResponse): Promise<InterceptedResponse[]> {
    const allResponses: InterceptedResponse[] = [];
    let response = initialResponse || await this.waitForCommentResponse(page);
    if (!response) return [];
    allResponses.push(response);
```

This lets Simple mode avoid waiting 20s just to discover the first response is missing.

- [ ] **Step 3: Replace the Simple mode empty-response while loop with one short first-response wait**

In `processCommentsQueueSimple`, after `await HumanActions.wait(page, 3000, 5000);`, add:

```ts
        const firstCommentResponse = await this.waitForCommentResponse(page, 8000);
        if (!firstCommentResponse) {
          logger.warn({ awemeId: item.awemeId }, '[Simple] No commentList after selecting video — skipping');
          results.push({ awemeId: item.awemeId, success: false, error: 'No commentList after selecting video' });
          continue;
        }
```

Then replace the `while (hasMore && allComments.length < maxRootComments && consecutiveNoNew < 5) { ... }` block with:

```ts
        const responses = await this.collectAllCommentResponses(page, firstCommentResponse);

        const allComments = responses.flatMap(r => r.body?.data?.list || [])
          .filter(c => !existingCidSet.has(String(c.commentId)));

        if (allComments.length > maxRootComments) {
          allComments.length = maxRootComments;
        }
```

Leave the existing `const commentsToStore = allComments.slice(0, maxRootComments);` line in place. It remains correct.

- [ ] **Step 4: Run static checks for the removed long empty-response logs**

Run:

```bash
rg -n "No API response, incrementing counter|consecutiveNoNew < 5" apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
```

Expected: no output.

- [ ] **Step 5: Run build**

Run:

```bash
pnpm --filter ts-api-gateway build
```

Expected: PASS.

- [ ] **Step 6: Commit Simple mode short wait change**

Run:

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "fix(kuaishou): short-circuit simple mode without commentList"
```

---

### Task 6: Final Verification

**Files:**
- Verify: `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`
- Verify: `apps/ts-api-gateway/src/crawlers/kuaishouDrawerUtils.ts`
- Verify: `apps/ts-api-gateway/src/crawlers/__tests__/kuaishouDrawerUtils.test.ts`

- [ ] **Step 1: Run all ts-api-gateway tests**

Run:

```bash
pnpm --filter ts-api-gateway test
```

Expected: PASS.

- [ ] **Step 2: Run ts-api-gateway build**

Run:

```bash
pnpm --filter ts-api-gateway build
```

Expected: PASS.

- [ ] **Step 3: Static regression checks**

Run:

```bash
rg -n "proceeding anyway|Click succeeded but drawer not detected|No API response, incrementing counter|consecutiveNoNew < 5|matchType: 'timestamp\+description'" apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
```

Expected: no output.

Run:

```bash
rg -n "timestamp\+normalized-description|No commentList after selecting video|Empty video list repeated" apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
```

Expected: matches for the new logs.

- [ ] **Step 4: Commit final verification note if any tracked files remain staged or modified**

Run:

```bash
git status --short
```

Expected: only unrelated pre-existing working-tree changes remain. If the Kuaishou fix files are still modified, commit them with:

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/crawlers/kuaishouDrawerUtils.ts apps/ts-api-gateway/src/crawlers/__tests__/kuaishouDrawerUtils.test.ts
git commit -m "fix(kuaishou): verify phase3 simple stall fix"
```

---

## Self-Review

- Spec coverage: covered drawer visibility convergence, normalized matching, empty-list fuse, removal of premature scrolled-past stop, short `commentList` wait, queue continuation, tests, build, and runtime log expectations.
- Placeholder scan: no `TBD`, `TODO`, `implement later`, or vague test instructions remain in this plan.
- Type consistency: utility names are consistent across tests, imports, and crawler usage: `normalizeKuaishouVideoText`, `isKuaishouDrawerVideoTextMatch`, `shouldStopKuaishouDrawerSearch`.
