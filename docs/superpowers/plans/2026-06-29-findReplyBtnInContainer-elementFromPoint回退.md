# 评论回复：findReplyBtnInContainer 用 elementFromPoint 回退修按钮点不到 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修 bug 2（按钮点不到）。根因已确认：`findRootCommentByUsernameContent` 拼出的 `div[class*="container-"]:nth-child(27)` 选择器在两次 evaluate 之间 DOM 变化（评论加载/重排）后失效，导致 `findReplyBtnInContainer` 找不到容器，回复按钮无法定位。

**Architecture:** 让 `findReplyBtnInContainer` 接收 `rootX, rootY` 作为位置回退坐标。当 `document.querySelector(containerSel)` 返回 null 时，用 `elementFromPoint` 在 5x5 网格内找元素，再 `closest('div[class*="container-"]')` 上溯到根评论容器（与 `expandRootRepliesIfNeeded` L5459-5461 同一模式）。一次 commit。

**Tech Stack:** TypeScript, patchright/playwright, CDP, Prisma, Jest。

---

## 根因（日志证据）

docker 日志显示：
```
containerSel: "div[class*=\"container-\"]:nth-child(27)"
diag: {"containerFound":false,"viewportHeight":1305}
htmlDiag: {"containerOuter":null,"operationsHtml":null}
```

- 第一次 `findReplyBtnInContainer` (`scrollRound=2` 之后)：`containerFound:false` → 调用 `scrollRootIntoView`
- 第二次 `findReplyBtnInContainer`（scrollIntoView 之后）：`containerFound:false` → 失败 → `Target not found`

`:nth-child(27)` 是 `findRootCommentByUsernameContent` 在 `sels[si] + ':nth-child(' + (ci + 1) + ')'` 拼出来的。两次 evaluate 之间 DOM 变化（评论加载/展开/重排）让第 27 个子元素不再是目标 root。

`expandRootRepliesIfNeeded` 已经用 `elementFromPoint(coords.x, coords.y).closest('div[class*="container-"]')` 解决同样的脆弱性（L5459-5461）。`findReplyBtnInContainer` 没复用这一模式。

**Bug 1（顶部抖动 11s）实际已修复**：日志显示 `totalMs:3186` + `round:0 scrollY:0 reached top/bottom`，1 轮退出。用户报告"两个bug均为解决"可能基于旧测试；本计划专注 bug 2。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 抖音 crawler | 改 `findReplyBtnInContainer` 加位置回退 + 改 `scrollExpandAndFindTarget` 传 rootX/rootY |

---

## Task 1: findReplyBtnInContainer 加 elementFromPoint 回退

**Step 1: 改 `findReplyBtnInContainer` 签名 + 实现**

文件：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

定位：`grep -n "private async findReplyBtnInContainer" apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` 找到函数（带 Task 2 加的 DIAG 块，约 L5299-5448 区域）。用实际位置。

**1.1 改签名**：增加 `fallbackCoords?: {x: number; y: number}` 第三个参数：

```typescript
  private async findReplyBtnInContainer(
    page: Page,
    containerSel: string,
    fallbackCoords?: { x: number; y: number },
  ): Promise<{ x: number; y: number } | null> {
```

**1.2 改 `safeEvaluate`/`page.evaluate` 内部**：先尝试 selector，失败时用 elementFromPoint + closest 回退。**两套（anti-detection v2 / 非 v2）都要改**。

替换 `safeEvaluate` 那个分支（保留原 reason 字符串 `'在容器内查找回复按钮'`，保留原 diag 收集块**不动** — diag 在调用前已经收集完）：

```typescript
    if (isAntiDetectionV2()) {
      return await HumanActions.safeEvaluate(page, function(params: { sel: string; coords: {x: number; y: number} | null }) {
        var sel = params.sel;
        var coords = params.coords;
        var container: Element | null = document.querySelector(sel);
        // ★ 修复：selector 失败时用 elementFromPoint + closest 回退（与 expandRootRepliesIfNeeded 模式一致）
        if (!container && coords) {
          for (var dx = -2; dx <= 2 && !container; dx += 2) {
            for (var dy = -2; dy <= 2 && !container; dy += 2) {
              var el = document.elementFromPoint(coords.x + dx, coords.y + dy);
              if (el) container = el.closest('div[class*="container-"]');
            }
          }
        }
        if (!container) return null;
        var vh = window.innerHeight;
        var opsAreas = container.querySelectorAll('[class*="operations-"]');
        for (var oi = 0; oi < opsAreas.length; oi++) {
          var items = opsAreas[oi].querySelectorAll('[class*="item-"]');
          for (var ri = 0; ri < items.length; ri++) {
            if ((items[ri].textContent || '').trim() === '回复') {
              var r = items[ri].getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && r.top < vh) {
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              }
            }
          }
        }
        return null;
      }, { reason: '在容器内查找回复按钮', world: 'main', args: [{ sel: containerSel, coords: fallbackCoords || null }] }) as { x: number; y: number } | null;
    } else {
      return await page.evaluate(function(params: { sel: string; coords: {x: number; y: number} | null }) {
        var sel = params.sel;
        var coords = params.coords;
        var container: Element | null = document.querySelector(sel);
        if (!container && coords) {
          for (var dx = -2; dx <= 2 && !container; dx += 2) {
            for (var dy = -2; dy <= 2 && !container; dy += 2) {
              var el = document.elementFromPoint(coords.x + dx, coords.y + dy);
              if (el) container = el.closest('div[class*="container-"]');
            }
          }
        }
        if (!container) return null;
        var vh = window.innerHeight;
        var opsAreas = container.querySelectorAll('[class*="operations-"]');
        for (var oi = 0; oi < opsAreas.length; oi++) {
          var items = opsAreas[oi].querySelectorAll('[class*="item-"]');
          for (var ri = 0; ri < items.length; ri++) {
            if ((items[ri].textContent || '').trim() === '回复') {
              var r = items[ri].getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && r.top < vh) {
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              }
            }
          }
        }
        return null;
      }, { sel: containerSel, coords: fallbackCoords || null });
    }
  }
```

**注意：**
- 保留 Task 2 加的 `DIAG` 收集块**不动**（在函数开头 `if (isAntiDetectionV2())` 之前那段）
- 保留 `await this.injectEsbuildPolyfill(page);` 不动
- 保留 `logger.warn({ containerSel, diag }, ...)` 不动

**Step 2: 改 `scrollExpandAndFindTarget` level=1 失败路径传 rootX/rootY**

定位：`grep -n "findReplyBtnInContainer" apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` 找到调用点（约 L5010 区域）。

**两处调用都要改**（失败后的重试 + 初次调用）：

将：
```typescript
        let replyBtn = await this.findReplyBtnInContainer(page, rootMatch.containerSel);
        if (!replyBtn) {
          // 按钮在视口外 → 滚 root 到视口中间再重试
          logger.warn('[Reply::Find] Root found but reply btn off-viewport, scrolling into view');
          await this.scrollRootIntoView(page, rootMatch.x, rootMatch.y);
          await HumanActions.wait(page, 300, 600);
          replyBtn = await this.findReplyBtnInContainer(page, rootMatch.containerSel);
        }
```

改为：
```typescript
        // ★ 修复：传 rootX, rootY 作为位置回退（应对 :nth-child 失效）
        const fallback = { x: rootMatch.x, y: rootMatch.y };
        let replyBtn = await this.findReplyBtnInContainer(page, rootMatch.containerSel, fallback);
        if (!replyBtn) {
          // 按钮在视口外 → 滚 root 到视口中间再重试
          logger.warn('[Reply::Find] Root found but reply btn off-viewport, scrolling into view');
          await this.scrollRootIntoView(page, rootMatch.x, rootMatch.y);
          await HumanActions.wait(page, 300, 600);
          // 滚完后用 viewport 中心作为回退坐标（root 此时在视口中间）
          const vp = await HumanActions.withCDPContext(page, async (ctx) => ctx.cdp.getLayoutViewport());
          const centerFallback = { x: Math.round(vp.clientWidth / 2), y: Math.round(vp.clientHeight / 2) };
          replyBtn = await this.findReplyBtnInContainer(page, rootMatch.containerSel, centerFallback);
        }
```

**Step 3: 跑测试**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx jest src/crawlers/__tests__/ 2>&1 | tail -30
```
预期：除 `findTargetBudget.test.ts` 已知预存超时外全过。本次仅改 `findReplyBtnInContainer` 行为（加回退），其他测试不应受影响。

**Step 4: 类型检查**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep "douyinCrawler" | head
```
预期：无错误

**Step 5: 提交**

```bash
cd /home/lrp/social_media_complete
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix(douyin): findReplyBtnInContainer falls back to elementFromPoint when :nth-child selector fails"
```

---

## Task 2: 端到端验证

- [ ] **Step 1: 重新构建 + 跑一次**

```bash
cd /home/lrp/social_media_complete
git checkout fix/douyin-comment-reply-jitter-and-button
docker compose up -d --build sm-ts-api
```

触发一次评论回复（你之前的目标 `lqq/很漂亮` 或类似）。

- [ ] **Step 2: 抓诊断日志**

```bash
docker logs --since 2m sm-ts-api 2>&1 | grep -E "DIAG|still missing|Reply\] 点击了|Target not found|Root comment located" > /tmp/diag2.log
```

预期（修复后）：
- `DIAG.containerFound: true`（即使 `containerSel` 失败，回退也找到容器）— 或日志不再出现 "containerFound:false"
- `Root comment located` 之后出现 `Root reply btn located`（不是 `still missing after scrollIntoView`）
- 接着 `[Reply] 点击了回复按钮` 成功坐标（应在目标 root 附近）

- [ ] **Step 3: 确认 Bug 1 也已修**

```bash
docker logs --since 2m sm-ts-api 2>&1 | grep "scrollCommentArea" | head -10
```
预期：`[scrollCommentArea] reached top/bottom` 在 1 轮内出现，`totalMs < 5000`。

---

## Self-Review

- **覆盖根因：** `:nth-child(N)` 失效 → elementFromPoint + closest 回退，绕过脆弱 selector。
- **复用现有模式：** 与 `expandRootRepliesIfNeeded` (L5459-5461) 和 `scrollRootIntoView` (L5459-5461) 同款 5x5 网格 + closest 模式。
- **保留诊断日志：** Task 2 加的 DIAG 块不动，便于以后观察 `containerFound: true` 情况。
- **坐标策略：**
  - 初次调用用 `rootMatch.x, rootMatch.y`（root 当前位置）
  - scrollRootIntoView 后用 viewport 中心（root 被滚到视口中间，center 必在 root 内）
- **回归风险：** 唯一调用点是 `scrollExpandAndFindTarget` level=1 失败路径；测试覆盖在 `findTargetBudget.test.ts`（mock 了 `findRootCommentByUsernameContent` 走不到这分支），无影响。
- **未覆盖：** level=2 路径（子评论回复按钮）使用 `findSubCommentInRoot` + 不同逻辑 — 不在本次范围。如果用户后续发现子评论同样问题，可同样扩展 elementFromPoint 模式。
