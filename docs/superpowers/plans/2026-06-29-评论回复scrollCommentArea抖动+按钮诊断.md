# 评论回复：scrollCommentArea 抖动 + 按钮点不到 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修两个仍未解决的症状 —— (1) `scrollCommentArea(page, 'top')` 在 douyin 评论详情页来回抖动 ~11s（`direction="top" totalMs=11261`），8 轮全跑满；(2) `findReplyBtnInContainer` 即使 `scrollRootIntoView` 后仍返回 null，导致 `[Reply] Target not found`。

**Architecture:** Task 1 给 `scrollCommentArea` 的 'top'/'bottom' 分支也用空 selectors 强制 `scrollPage`（与 `tryExpandMoreAndScroll` 上一轮同一模式）。Task 2 给 `findReplyBtnInContainer` 及其调用点加详细诊断日志（container HTML 摘要、operations 节点数、可见/隐藏 item 数、hover-state），便于排 bug 2。Task 3 暂不修 bug 2 — 等待 Task 2 部署后用户跑一次拿到日志再定。两任务独立，依次提交。

**Tech Stack:** TypeScript, patchright/playwright, CDP, Prisma, Jest。

**Spec (源):** `docs/superpowers/specs/2026-06-29-评论滚动回复与卡片刷新修复-design.md`（含根因分析）

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 抖音 crawler | 改 `scrollCommentArea` string 分支；加日志到 `findReplyBtnInContainer` + `scrollExpandAndFindTarget` 失败路径 |

---

## Task 1: 修 `scrollCommentArea` 'top'/'bottom' 写错容器

**根因：** 当前 `scrollCommentArea` (L3583-3592) 'top'/'bottom' 分支仍调用 `cdpSmartScroll(page, tabs-content selectors, ...)`。`findScrollContainer` 在 `cdpSmartScroll` 内部命中 tabs-content (rect 50×100+ 满足) → `scrollInContainer` 滚 inner 容器，**document 不动**。读 document 状态永远是同一 scrollY（不在顶）→ 8 轮跑满 → 总耗时 8 × 1.4s ≈ 11.3s。**这与上一轮 `tryExpandMoreAndScroll` 是完全相同的 bug，只是发生在 string 分支。**

**Step 1: 改 `scrollCommentArea` 'top'/'bottom' 分支**

文件：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

定位：`grep -n "SCROLL_MAX_ROUNDS" apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` 找到 'top' / 'bottom' 段（约 L3580-3592）。

原代码（关键 2 行）：
```typescript
    const dir = direction === 'top' ? 'up' : 'down';
    for (let round = 0; round < SCROLL_MAX_ROUNDS; round++) {
      await HumanActions.cdpSmartScroll(page, selectors, SCROLL_BOUNDED_PX, dir);
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));

      // 读取 document 滚动状态
      const state = await HumanActions.cdpGetDocumentScrollState(page);
      if (!state) break;
      if (direction === 'top' && state.scrollY <= 0) break;
      if (direction === 'bottom' && state.scrollY + state.clientHeight >= state.scrollHeight - 10) break;
    }
```

替换为：
```typescript
    const dir = direction === 'top' ? 'up' : 'down';
    for (let round = 0; round < SCROLL_MAX_ROUNDS; round++) {
      // ★ 修复：与 tryExpandMoreAndScroll 同模式 — 走空 selectors 强制 scrollPage，
      // 避免 findScrollContainer 命中 tabs-content inner 容器导致 document 不动。
      await HumanActions.cdpSmartScroll(page, [], SCROLL_BOUNDED_PX, dir);
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));

      // 读取 document 滚动状态
      const state = await HumanActions.cdpGetDocumentScrollState(page);
      if (!state) {
        logger.warn({ round, direction }, '[scrollCommentArea] document state read failed, abort');
        break;
      }
      logger.debug({ round, direction, scrollY: state.scrollY, clientHeight: state.clientHeight, scrollHeight: state.scrollHeight }, '[scrollCommentArea] round state');
      if (direction === 'top' && state.scrollY <= 0) {
        logger.info({ round, scrollY: state.scrollY }, '[scrollCommentArea] reached top');
        break;
      }
      if (direction === 'bottom' && state.scrollY + state.clientHeight >= state.scrollHeight - 10) {
        logger.info({ round, scrollY: state.scrollY, scrollHeight: state.scrollHeight }, '[scrollCommentArea] reached bottom');
        break;
      }
    }
```

**Step 2: 跑测试确认无回归**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest src/crawlers/__tests__/ 2>&1 | tail -30
```

预期：除 `findTargetBudget.test.ts` 已知预存超时外全过。本次仅加日志（不改逻辑），理论上无破坏。

**Step 3: 类型检查**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "douyinCrawler" | head
```

预期：无错误

**Step 4: 提交**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix(douyin): scrollCommentArea top/bottom scrolls page, not tabs-content inner container"
```

---

## Task 2: 给 `findReplyBtnInContainer` 加详细诊断日志

**根因（待验证）：** `findReplyBtnInContainer` 在 `scrollRootIntoView` 之后仍返回 null。最可能的原因（基于代码审查）：
- (a) `[class*="operations-"]` 节点是 hover 才显示（`display: none` 或 `visibility: hidden`），按钮 `r.width === 0` 被跳过
- (b) "回复" 文本不在 `[class*="item-"]` 的直接 textContent 里（被嵌套元素污染或 trim 后不匹配）
- (c) containerSel（如 `div[class*="container-"]:nth-child(N)`）匹配到错的容器

加日志让真实原因暴露。

**Step 1: 改 `findReplyBtnInContainer` 加详细诊断**

文件：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

定位：`grep -n "findReplyBtnInContainer\|still missing after scrollIntoView" apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

在 `findReplyBtnInContainer` 函数开头（`page.evaluate(...)` 之前）加日志收集：

```typescript
  private async findReplyBtnInContainer(
    page: Page,
    containerSel: string,
  ): Promise<{ x: number; y: number } | null> {
    await this.injectEsbuildPolyfill(page);

    // ★ 诊断：先打印容器匹配 + 关键结构统计
    const diag = await (async () => {
      if (isAntiDetectionV2()) {
        return HumanActions.safeEvaluate(page, function(sel: string) {
          var container = document.querySelector(sel);
          if (!container) {
            return { containerFound: false, sel: sel };
          }
          var vh = window.innerHeight;
          var cr = container.getBoundingClientRect();
          var opsAll = container.querySelectorAll('[class*="operations-"]');
          var opsVisible: Array<{ rect: any; itemsText: string[]; replyItemCount: number }> = [];
          var opsHidden = 0;
          for (var oi = 0; oi < opsAll.length; oi++) {
            var or_ = opsAll[oi].getBoundingClientRect();
            if (or_.width === 0 || or_.height === 0) { opsHidden++; continue; }
            var items = opsAll[oi].querySelectorAll('[class*="item-"]');
            var texts: string[] = [];
            var replyCount = 0;
            for (var ii = 0; ii < items.length; ii++) {
              var t = (items[ii].textContent || '').trim();
              texts.push(t);
              if (t === '回复') replyCount++;
            }
            opsVisible.push({ rect: { top: or_.top, bottom: or_.bottom, width: or_.width, height: or_.height }, itemsText: texts, replyItemCount: replyCount });
          }
          // 找容器内所有含"回复"文本的 item（不限 visible）
          var allItems = container.querySelectorAll('[class*="operations-"] [class*="item-"]');
          var allReplyTexts: Array<{ text: string; rect: any; className: string }> = [];
          for (var i = 0; i < allItems.length; i++) {
            var t2 = (allItems[i].textContent || '').trim();
            if (t2 !== '回复') continue;
            var r2 = allItems[i].getBoundingClientRect();
            allReplyTexts.push({ text: t2, rect: { top: r2.top, bottom: r2.bottom, width: r2.width, height: r2.height, left: r2.left }, className: (allItems[i] as HTMLElement).className || '' });
          }
          return {
            containerFound: true,
            containerRect: { top: cr.top, bottom: cr.bottom, width: cr.width, height: cr.height },
            viewportHeight: vh,
            opsAreasTotal: opsAll.length,
            opsAreasHidden: opsHidden,
            opsAreasVisible: opsVisible,
            allReplyItemsInContainer: allReplyTexts,
          };
        }, { reason: '诊断 findReplyBtnInContainer 容器结构', world: 'main', args: [containerSel] });
      } else {
        return page.evaluate(function(sel: string) {
          var container = document.querySelector(sel);
          if (!container) return { containerFound: false, sel: sel };
          var vh = window.innerHeight;
          var cr = container.getBoundingClientRect();
          var opsAll = container.querySelectorAll('[class*="operations-"]');
          var opsVisible: Array<{ rect: any; itemsText: string[]; replyItemCount: number }> = [];
          var opsHidden = 0;
          for (var oi = 0; oi < opsAll.length; oi++) {
            var or_ = opsAll[oi].getBoundingClientRect();
            if (or_.width === 0 || or_.height === 0) { opsHidden++; continue; }
            var items = opsAll[oi].querySelectorAll('[class*="item-"]');
            var texts: string[] = [];
            var replyCount = 0;
            for (var ii = 0; ii < items.length; ii++) {
              var t = (items[ii].textContent || '').trim();
              texts.push(t);
              if (t === '回复') replyCount++;
            }
            opsVisible.push({ rect: { top: or_.top, bottom: or_.bottom, width: or_.width, height: or_.height }, itemsText: texts, replyItemCount: replyCount });
          }
          var allItems = container.querySelectorAll('[class*="operations-"] [class*="item-"]');
          var allReplyTexts: Array<{ text: string; rect: any; className: string }> = [];
          for (var i = 0; i < allItems.length; i++) {
            var t2 = (allItems[i].textContent || '').trim();
            if (t2 !== '回复') continue;
            var r2 = allItems[i].getBoundingClientRect();
            allReplyTexts.push({ text: t2, rect: { top: r2.top, bottom: r2.bottom, width: r2.width, height: r2.height, left: r2.left }, className: (allItems[i] as HTMLElement).className || '' });
          }
          return {
            containerFound: true,
            containerRect: { top: cr.top, bottom: cr.bottom, width: cr.width, height: cr.height },
            viewportHeight: vh,
            opsAreasTotal: opsAll.length,
            opsAreasHidden: opsHidden,
            opsAreasVisible: opsVisible,
            allReplyItemsInContainer: allReplyTexts,
          };
        }, containerSel);
      }
    })();
    logger.warn({ containerSel, diag }, '[findReplyBtnInContainer] DIAG');

    // 保留原逻辑
    if (isAntiDetectionV2()) {
      return await HumanActions.safeEvaluate(page, function(sel: string) {
        // ...原函数体不动
      }, { reason: '在容器内查找回复按钮', world: 'main', args: [containerSel] }) as { x: number; y: number } | null;
    } else {
      return await page.evaluate(function(sel) {
        // ...原函数体不动
      }, containerSel);
    }
  }
```

注：上面给的两个 evaluate 块（anti-detect v2 / 非 v2）保留**原函数体**（不替换），仅在前面加了 diag 收集与日志。

**Step 2: 在 `scrollExpandAndFindTarget` 失败路径加 "container HTML 摘要" 日志**

定位：`grep -n "still missing after scrollIntoView" apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` 找到失败日志（约 L5010 区域）。

把 `logger.warn('[Reply::Find] Root found but reply btn still missing after scrollIntoView');` 替换为：

```typescript
        // 诊断：dump 容器外层 HTML 摘要（限 800 字符），便于排 bug 2
        const htmlDiag = await (async () => {
          try {
            return await HumanActions.safeEvaluate(page, function(sel: string) {
              var c = document.querySelector(sel);
              if (!c) return null;
              // 取容器外层 + 第一个 operations- 区域 HTML（限长）
              var ops = c.querySelector('[class*="operations-"]');
              var opsHtml = ops ? (ops as HTMLElement).outerHTML : null;
              return {
                containerOuter: (c as HTMLElement).outerHTML.slice(0, 1500),
                operationsHtml: opsHtml ? opsHtml.slice(0, 1500) : null,
              };
            }, { reason: '诊断 root 容器 HTML', world: 'main', args: [rootMatch.containerSel] });
          } catch { return null; }
        })();
        logger.error({
          containerSel: rootMatch.containerSel,
          htmlDiag,
        }, '[Reply::Find] Root found but reply btn still missing after scrollIntoView');
        return null;
```

**Step 3: 跑测试确认无回归**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest src/crawlers/__tests__/ 2>&1 | tail -30
```

预期：除已知预存问题外全过（仅加日志）

**Step 4: 类型检查**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "douyinCrawler" | head
```

预期：无错误

**Step 5: 提交**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "chore(douyin): add diagnostic logs to findReplyBtnInContainer + scrollExpandAndFindTarget failure path"
```

---

## Task 3: 等用户跑一次收集日志后再决定 bug 2 修法

**Files:** 暂无改动。

- [ ] **Step 1: 用户重新构建镜像 + 跑一次评论回复**
  ```bash
  cd /home/lrp/social_media_complete
  docker compose up -d --build sm-ts-api
  docker logs -f sm-ts-api 2>&1 | grep -E "DIAG|still missing|scrollCommentArea.*round state|reached top|reached bottom"
  ```

- [ ] **Step 2: 抓取 `findReplyBtnInContainer] DIAG` 日志**

  期望看到：
  - `containerFound: true/false`（如果 false，containerSel 不匹配）
  - `opsAreasTotal` / `opsAreasHidden` / `opsAreasVisible` 数量
  - `allReplyItemsInContainer` 数组（包含 rect 和 className）— 揭示按钮是否在 DOM 中、是否 visible

- [ ] **Step 3: 根据日志决定 bug 2 修法**

  可能的诊断结论与对应修法（届时再写新 plan）：

  | 诊断 | 修法 |
  |------|------|
  | `opsAreasHidden > 0 && opsAreasVisible === 0` | hover 才显示 → 改为先 hover 容器再读；或 `display: none` 时也读 |
  | `allReplyItemsInContainer` 中 `rect.top >= vh` 仍有 | scrollIntoView 没成功把按钮带进视口 → 检查 `scrollRootIntoView` 是否实际滚了；可能改用 `scrollIntoView` 容器内 `[class*="item-"]` 文本=回复 |
  | `allReplyItemsInContainer` 中 `rect.width === 0` | 按钮在 DOM 但 0 尺寸 → 强制 hover 后再读 |
  | `containerFound: false` | containerSel 错（`:nth-child(N)` 在重渲染后失效）→ 改用 root x/y 重新定位容器 |

- [ ] **Step 4: 写新 plan 实施修法（不在本次范围）**

---

## Self-Review

- **覆盖对应根因：**
  - Bug 1（顶部抖动 11s）→ Task 1（string 分支也走空 selectors 强制 scrollPage）
  - Bug 2（按钮点不到）→ Task 2（先加日志，Task 3 收集日志后定修法）
- **未引入新方法：** `cdpSmartScroll(page, [], ...)` 模式与上一轮一致；`safeEvaluate` 沿用。
- **诊断日志设计：** 输出 `containerFound/opsAreasTotal/Hidden/Visible/allReplyItemsInContainer[].{text,rect,className}` — 覆盖了 (a)(b)(c) 三个最可能原因。
- **HTML 日志限长：** 1500 字符 / 项，防止日志爆掉。
- **回归风险：** Task 1 改的是 `scrollCommentArea` string 分支，与 `findTargetBudget` 测试无关（它 mock 整个 `tryExpandMoreAndScroll`），且 `scrollBounded.test.ts` 测试的是 number 分支的 `tryExpandMoreAndScroll`，string 分支无单测覆盖。
- **未覆盖：** level=2 路径中子评论回复按钮 — 同 Task 1 模式，bug 1 修复后预期会变好，但需在 bug 2 修完后再看。
