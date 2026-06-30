# 评论回复 scrollCommentArea 抖动 + 按钮误点修复设计

## 日期

2026-06-29

## 背景

上一轮修复（3 commits: `aa31dac`/`4e627d8`/`0135277`）后用户重新执行，两个 bug 均未解决：

- **Bug 1（滚动抖动）**：`scrollCommentArea('top')` 仍造成可见抖动
- **Bug 2（点错评论）**：从"找不到回复按钮"变形为"回复了错误评论"（回复了 lqq 的 "22221" 而非目标 "很漂亮"）

## 根因分析

### Bug 1：scrollCommentArea 缺少前置边界检查

`scrollCommentArea('top')` 的 'top'/'bottom' 分支在 for 循环内先调用 `cdpSmartScroll(page, [], 3000, dir)` **再**检查 `scrollY`。即使页面已在顶部（`scrollY:0`），`cdpSmartScroll` 仍执行完整的鼠标滚动动画（含多次 CDP wheel scroll fallback + overshoot），耗时 9.7 秒并造成可见抖动。

日志证据：
```
round:1 direction:"top" scrollY:0 clientHeight:1305 scrollHeight:2041
msg:"[scrollCommentArea] reached top/bottom"
direction:"top" totalMs:9776
```

仅 1 轮，`scrollY` 已为 0，但 `cdpSmartScroll` 已执行完毕 → 9.7 秒抖动。

### Bug 2：:nth-child(N) 选择器设计性错误 + elementFromPoint 坐标超出视口

**4 步连锁失败：**

1. **`:nth-child(N)` 选择器永远失效** — `findRootCommentByUsernameContent` 在 `page.evaluate` 内用 `querySelectorAll('div[class*="container-"]')` 遍历所有匹配元素，用 `ci` 作为索引拼出 `sels[si] + ':nth-child(' + (ci + 1) + ')'`。但 `querySelectorAll` 的第 N 个匹配 ≠ 父元素的第 N 个子元素（`:nth-child` 语义）。因此 `containerSel` 永远无法被 `document.querySelector` 命中 → `containerFound: false`。

2. **`elementFromPoint` 坐标超出视口** — `findRootCommentByUsernameContent` 返回 `rootMatch.y = 1374`，但 `viewportHeight = 1305`。根评论中心在视口下方。`elementFromPoint(1385, 1374)` 返回 `null`。

3. **`scrollRootIntoView` 距离回退找到错误容器** — `elementFromPoint` 返回 null 后，`scrollRootIntoView` 回退到"遍历所有容器找最近的"策略。距离 `(1385, 1374)` 最近的容器是 "22221" 的评论（非目标 "很漂亮"），将其 `scrollIntoView({block:'center'})` 滚到视口中央。

4. **第二次 `findReplyBtnInContainer` 用视口中心命中错误容器** — 调用方在 `scrollRootIntoView` 后用 `{x: vp.w/2, y: vp.h/2}` 作为 `fallbackCoords`。此时视口中央是 "22221"（被错误滚过来的），`elementFromPoint` 命中 "22221" 的容器 → 找到 "22221" 的回复按钮 → 点击 → 回复了错误评论。

日志证据：
```
20.382s  [Reply::Find] Root comment located (scrollRound:2)
          → rootMatch.y=1374, viewportHeight=1305

20.388s  [findReplyBtnInContainer] DIAG  containerFound:false
          → :nth-child(27) 失效, elementFromPoint(1385,1374)=null

20.394s  [Reply::Find] Root found but reply btn off-viewport, scrolling into view
          → scrollRootIntoView 距离回退找到 "22221"

20.868s  [findReplyBtnInContainer] DIAG  containerFound:false (第二次)
          → centerFallback elementFromPoint 命中 "22221"

20.872s  [Reply::Find] Root reply btn located  → "22221" 的回复按钮
```

## 设计

### Bug 1 修复：scrollCommentArea 前置边界检查

**文件**：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`
**位置**：`scrollCommentArea` 方法，'top'/'bottom' 分支，for 循环前（约 line 3582）

在 for 循环开始前，先读取 `cdpGetDocumentScrollState`。如果已在边界，直接 `return true`，不触发任何滚动：

```typescript
// 前置边界检查：已在顶部/底部时跳过滚动动画，避免抖动
const initialState = await HumanActions.cdpGetDocumentScrollState(page);
if (initialState) {
  if (direction === 'top' && initialState.scrollY <= 0) {
    logger.info({ direction, scrollY: initialState.scrollY, clientHeight: initialState.clientHeight, scrollHeight: initialState.scrollHeight }, '[scrollCommentArea] already at boundary, skipping');
    return true;
  }
  if (direction === 'bottom' && initialState.scrollY + initialState.clientHeight >= initialState.scrollHeight - 10) {
    logger.info({ direction, scrollY: initialState.scrollY, clientHeight: initialState.clientHeight, scrollHeight: initialState.scrollHeight }, '[scrollCommentArea] already at boundary, skipping');
    return true;
  }
}
```

**影响范围**：所有 5 个 `'top'/'bottom'` 调用点（lines 2795, 3631, 4112, 4988, 5108）。不影响 `number` 入参路径。

### Bug 2 修复：消除 :nth-child 选择器，同一次 evaluate 内返回回复按钮坐标

**文件**：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

#### 改动 1：增强 findRootCommentByUsernameContent 的返回值

**位置**：lines ~5083-5338（isAntiDetectionV2 分支 + 普通分支）

现有返回值结构：
```typescript
{ x: number; y: number; containerSel: string; isExpanded: boolean; subReplyCountInPage: number }
```

增强后：
```typescript
{ x: number; y: number; containerSel: string; isExpanded: boolean; subReplyCountInPage: number; replyBtn: { x: number; y: number } | null }
```

在 `page.evaluate` 内，找到匹配容器后（现有 username + text 匹配逻辑不变），在该容器内查找回复按钮：

1. 遍历 `container.querySelectorAll('[class*="operations-"]')` → `querySelectorAll('[class*="item-"]')`
2. 找 `textContent.trim() === '回复'` 且 `rect.width > 0 && rect.height > 0 && rect.top < vh` 的按钮
3. 如果找到 → 返回 `replyBtn: { x: rect.left + rect.width/2, y: rect.top + rect.height/2 }`
4. 如果没找到（按钮可能在视口外）→ `container.scrollIntoView({ block: 'center', behavior: 'instant' })` → 重新查找 → 返回更新后的坐标或 `null`

**关键点**：回复按钮查找在同一个 `page.evaluate` 内完成，使用容器的 DOM 引用（非选择器），不会命中其他评论的回复按钮。`scrollIntoView` 也在 evaluate 内执行，作用于正确的 DOM 元素，不依赖 `elementFromPoint`。

**两个分支都需修改**：`isAntiDetectionV2()` 分支（`HumanActions.safeEvaluate`）和普通分支（`page.evaluate`）。

#### 改动 2：改写 scrollExpandAndFindTarget level=1 路径

**位置**：lines 5022-5065

现有流程：
```
findRootCommentByUsernameContent → rootMatch
findReplyBtnInContainer(rootMatch.containerSel, {x: rootMatch.x, y: rootMatch.y})
  → null → scrollRootIntoView(rootMatch.x, rootMatch.y)
  → findReplyBtnInContainer(rootMatch.containerSel, viewportCenter)
```

新流程：
```
findRootCommentByUsernameContent (增强版) → rootMatch
if (rootMatch.replyBtn) → 直接返回 rootMatch.replyBtn
if (!rootMatch.replyBtn) → scrollRootIntoView(rootMatch.x, rootMatch.y) → 重新调用增强版 findRootCommentByUsernameContent → 返回 replyBtn
```

**消除的调用**：
- `findReplyBtnInContainer` 的 2 处调用（lines 5025, 5034）
- `:nth-child(N)` 选择器拼接（2 处 evaluate 内）
- `elementFromPoint` 5x5 网格回退（findReplyBtnInContainer 内，level=1 不再调用）

#### 改动 3：保留的代码

- `findReplyBtnInContainer` 函数本体 — 保留（不在 level=1 路径调用，但不删除以防其他场景需要）
- `scrollRootIntoView` — 保留，用于 `replyBtn=null` 的回退和 level=2 路径
- `expandRootRepliesIfNeeded` — 不变（level=2 路径不在本次修复范围）
- 诊断日志（DIAG）— 暂时保留便于观察

### 不在本次修复范围

- `expandRootRepliesIfNeeded` 中的 `elementFromPoint` 模式（level=2 路径）— 风险较低，用户未报告 level=2 问题
- `scrollRootIntoView` 的距离回退策略 — 仍保留作为最后手段，但因增强版 evaluate 内已做 `scrollIntoView`，回退路径极少触发
- `cdpSmartScroll` 的 9.7 秒性能问题 — 前置检查已避免在边界时触发，非边界场景的性能优化超出本次范围

## 测试计划

### Bug 1 测试

**文件**：`apps/ts-api-gateway/src/crawlers/__tests__/scrollBounded.test.ts`

更新现有 2 个 scrollCommentArea 测试用例：
- 模拟 `cdpGetDocumentScrollState` 返回 `{ scrollY: 0, clientHeight: 800, scrollHeight: 2000 }`
- 断言 `cdpSmartScroll` **不被调用**
- 断言 `scrollCommentArea` 返回 `true`

新增用例：
- 模拟 `scrollY: 500`（不在边界）→ 断言 `cdpSmartScroll` **被调用**

### Bug 2 测试

**文件**：新增或扩展 `__tests__/` 下的测试文件

用例 1：`findRootCommentByUsernameContent` 返回 `replyBtn: {x, y}`
- 断言 `findReplyBtnInContainer` **不被调用**
- 断言 `scrollRootIntoView` **不被调用**
- 断言 `scrollExpandAndFindTarget` 返回 `replyBtn` 的坐标

用例 2：`findRootCommentByUsernameContent` 返回 `replyBtn: null`
- 断言 `scrollRootIntoView` **被调用**
- 断言第二次 `findRootCommentByUsernameContent` 被调用
- 断言返回第二次的 `replyBtn` 坐标

## 成功标准

1. `scrollCommentArea('top')` 在 `scrollY:0` 时不触发 `cdpSmartScroll`，`totalMs < 500`
2. 回复 lqq 的 "很漂亮" 评论时，点击的回复按钮属于 "很漂亮" 而非 "22221"
3. `findReplyBtnInContainer` 在 level=1 路径不被调用
4. 现有 `scrollBounded.test.ts` 测试通过
5. 新增测试通过
