# 评论回复 scrollCommentArea 抖动 + 按钮误点修复设计

## 日期
2026-06-29

## 背景

上一轮修复（commits `aa31dac` / `4e627d8` / `0135277`）尝试解决两个 bug，但最新日志确认均未解决：

### Bug 1：scrollCommentArea 抖动依旧

日志证据：
```
round:1 direction:"top" scrollY:0 clientHeight:1305 scrollHeight:2041
[scrollCommentArea] reached top/bottom
direction:"top" totalMs:9776
```

虽然仅 1 轮且 scrollY=0（已在顶部），但 `cdpSmartScroll([], 3000, 'up')` 仍执行了完整动画（9.7 秒，含多次 CDP wheel scroll fallback + overshoot），造成可见抖动。

### Bug 2：点错评论（回复了 "22221" 而非 "很漂亮"）

日志时间线：
```
20.382s  [Reply::Find] Root comment located (scrollRound:2)
          → findRootCommentByUsernameContent 返回 rootMatch.y=1374（viewportHeight=1305）
20.388s  [findReplyBtnInContainer] DIAG  containerFound:false
          → :nth-child(27) 永远失败
          → elementFromPoint(1385, 1374) 返回 null（y 在视口外）
20.394s  [Reply::Find] scrolling into view
          → scrollRootIntoView → elementFromPoint 返回 null → 距离回退找到错误容器
          → 把 "22221" 滚到视口中央
20.868s  [findReplyBtnInContainer] DIAG  containerFound:false (第二次)
          → centerFallback = viewport 中心 → elementFromPoint 命中 "22221"
          → 返回 "22221" 的回复按钮坐标 → 点击错误评论
```

## 根因

### Bug 1 根因

`scrollCommentArea` 在 for 循环内**先滚动再检查边界**。即使 scrollY=0（已在顶部），`cdpSmartScroll` 仍执行完整鼠标滚动动画，造成 9.7 秒抖动。

**缺少前置边界检查。**

### Bug 2 根因（两个缺陷叠加）

**缺陷 1：`:nth-child(N)` 选择器设计性错误**

`findRootCommentByUsernameContent` 在 `page.evaluate` 内构建：
```javascript
var containerSel = sels[si] + ':nth-child(' + (ci + 1) + ')';
```

`ci` 是 `document.querySelectorAll('div[class*="container-"]')` 返回的扁平索引。但 `:nth-child(N)` 的语义是"父元素的第 N 个子元素"。这两个概念完全不同——第 27 个 `querySelectorAll` 匹配不一定是其父元素的第 27 个子元素。因此 `containerSel` 永远无法匹配，`containerFound` 始终为 false。

**缺陷 2：elementFromPoint 在视口外返回 null → 距离回退找到错误容器**

`findRootCommentByUsernameContent` 返回 `rootMatch.y = 1374`，但 `viewportHeight = 1305`。根评论中心在视口下方。

`elementFromPoint(1385, 1374)` 对视口外的坐标返回 null。`scrollRootIntoView` 回退到"最近容器距离匹配"，找到了错误的容器（"22221"），将其滚动到视口中央。后续 `findReplyBtnInContainer` 用视口中心做 `elementFromPoint`，命中了错误容器的回复按钮。

## 修复设计

### Bug 1 修复：scrollCommentArea 前置边界检查

在 for 循环前加前置检查：先读 `cdpGetDocumentScrollState`，如果已在边界，直接 `return true`，不触发任何滚动动画。

**改动位置**：`douyinCrawler.ts` `scrollCommentArea` 方法（第 3582 行附近），for 循环前。

**伪代码**：
```typescript
// 'top' / 'bottom'：有界滚动 + 到顶/到底即停
const dir = direction === 'top' ? 'up' : 'down';

// ★ 前置边界检查：已在边界时跳过滚动，避免不必要的动画抖动
const initialState = await HumanActions.cdpGetDocumentScrollState(page);
if (initialState) {
  if (direction === 'top' && initialState.scrollY <= 0) {
    logger.info({ direction, scrollY: initialState.scrollY }, '[scrollCommentArea] already at boundary, skipping');
    return true;
  }
  if (direction === 'bottom' && initialState.scrollY + initialState.clientHeight >= initialState.scrollHeight - 10) {
    logger.info({ direction, scrollY: initialState.scrollY }, '[scrollCommentArea] already at boundary, skipping');
    return true;
  }
}

for (let round = 0; round < SCROLL_MAX_ROUNDS; round++) {
  // ... 现有循环逻辑不变
}
```

**影响范围**：所有 5 个 `'top'/'bottom'` 调用点。不影响 `number` 入参路径。

### Bug 2 修复：增强 findRootCommentByUsernameContent，同一次 evaluate 内返回回复按钮坐标

#### 核心思路

将"找到根评论"和"在该容器内找回复按钮"合并到同一个 `page.evaluate` 调用中。容器 DOM 引用在 evaluate 内始终有效，无需 `:nth-child` 选择器或 `elementFromPoint` 二次定位。

#### 改动 1：增强 findRootCommentByUsernameContent 返回值

**现有返回值**：
```typescript
{ x: number; y: number; containerSel: string; isExpanded: boolean; subReplyCountInPage: number }
```

**增强后**：
```typescript
{
  x: number;           // 根评论中心坐标（仍用于 level=2 路径）
  y: number;
  containerSel: string; // 保留（expandRootRepliesIfNeeded 类型签名需要，但实际不使用），level=1 不再依赖
  isExpanded: boolean;
  subReplyCountInPage: number;
  replyBtn: { x: number; y: number } | null; // ★ 新增：同一次 evaluate 内找到的回复按钮坐标
}
```

**evaluate 内逻辑**（两个分支 isAntiDetectionV2 + 普通都需改）：

1. 遍历容器，匹配 username + text（现有逻辑不变）
2. 匹配成功后，在该容器内查找回复按钮：
   - 遍历 `container.querySelectorAll('[class*="operations-"]')`
   - 在每个 operations 区域内遍历 `[class*="item-"]`，找 `textContent.trim() === '回复'`
   - 检查 `getBoundingClientRect()`：`width > 0 && height > 0 && top < vh`
   - 如果找到 → `replyBtn = { x: left + width/2, y: top + height/2 }`
3. 如果回复按钮不可见（可能在视口外）：
   - `container.scrollIntoView({ block: 'center', behavior: 'instant' })`
   - 重新查找回复按钮
   - 如果找到 → 返回更新后的 `replyBtn`
   - 如果仍找不到 → `replyBtn = null`
4. 返回 `{ x, y, containerSel, isExpanded, subReplyCountInPage, replyBtn }`

#### 改动 2：改写 scrollExpandAndFindTarget level=1 路径

**现有流程**（lines 5022-5065）：
```
findRootComment → findReplyBtnInContainer(containerSel, rootMatch coords)
  → null → scrollRootIntoView(rootMatch.x, rootMatch.y)
  → findReplyBtnInContainer(containerSel, viewport center)
  → null → 诊断 + return null
```

**新流程**：
```
findRootComment (增强版，内含回复按钮查找)
  → replyBtn 有值 → 直接返回 { x: replyBtn.x, y: replyBtn.y }
  → replyBtn 为 null → scrollRootIntoView(rootMatch.x, rootMatch.y) + wait
  → 重新调用增强版 findRootComment → 如果 replyBtn 有值 → 返回
  → 仍 null → 诊断 + return null
```

**伪代码**：
```typescript
if (target.level === 1) {
  const rootMatch = await this.findRootCommentByUsernameContent(page, target, rootContainerSels);
  // ... (rootMatch null 处理不变)
  
  if (rootMatch.replyBtn) {
    // ★ 同一次 evaluate 内已找到回复按钮，直接返回
    logger.info({ elapsedMs: Date.now() - startT0 }, '[Reply::Find] Root reply btn located');
    return rootMatch.replyBtn;
  }
  
  // replyBtn 为 null：滚 root 到视口中间再重试
  logger.warn('[Reply::Find] Root found but reply btn not found, scrolling into view');
  await this.scrollRootIntoView(page, rootMatch.x, rootMatch.y);
  await HumanActions.wait(page, 300, 600);
  
  // 重新调用增强版 findRootComment（不依赖 :nth-child，按内容重新匹配）
  const rootMatch2 = await this.findRootCommentByUsernameContent(page, target, rootContainerSels);
  if (rootMatch2?.replyBtn) {
    logger.info({ elapsedMs: Date.now() - startT0 }, '[Reply::Find] Root reply btn located after scroll');
    return rootMatch2.replyBtn;
  }
  
  // 仍找不到：诊断 + return null
  logger.error({ ... }, '[Reply::Find] Root found but reply btn still missing after scrollIntoView');
  return null;
}
```

#### 消除的代码

- `:nth-child(N)` 选择器拼接（2 处：isAntiDetectionV2 分支 + 普通分支）
- level=1 路径对 `findReplyBtnInContainer` 的 2 处调用（lines 5025, 5034）
- `elementFromPoint` 5x5 网格回退在 level=1 路径不再执行（`findReplyBtnInContainer` 函数体保留，但 level=1 不再调用）

#### 保留的代码

- `findReplyBtnInContainer` 函数体 — 保留，level=1 不再调用但不删除（避免影响潜在的其他调用者）
- `scrollRootIntoView` — 保留，用于 `replyBtn=null` 的回退和 level=2 路径
- `expandRootRepliesIfNeeded` — 不变（level=2 路径不在本次修复范围）
- 诊断日志（DIAG）— 暂时保留便于观察

#### 不在本次修复范围

- `expandRootRepliesIfNeeded` 中的 `elementFromPoint` 模式（level=2 路径）— 同样存在坐标失效风险，但本次 bug 仅涉及 level=1
- `scrollRootIntoView` 的距离回退逻辑 — 保留现有实现，但因 level=1 路径改为按内容重新匹配，距离回退找到错误容器的影响降低（重新 evaluate 会按 username+text 匹配到正确容器）

## 测试计划

### Bug 1 测试

更新 `scrollBounded.test.ts` 中 scrollCommentArea 的 2 个测试用例：
- 模拟 `cdpGetDocumentScrollState` 返回 `scrollY: 0`（已在顶部）
- 断言 `cdpSmartScroll` **不被调用**
- 断言 `scrollCommentArea` 返回 `true`

新增测试用例：
- 模拟 `cdpGetDocumentScrollState` 返回 `scrollY: 500`（不在边界）
- 断言 `cdpSmartScroll` **被调用**
- 断言正常滚动流程

### Bug 2 测试

新增 `findRootCommentByUsernameContent` 增强版测试：
- 模拟 evaluate 返回 `replyBtn: { x: 100, y: 200 }`
- 断言 `findReplyBtnInContainer` 不被调用
- 断言 `scrollRootIntoView` 不被调用
- 断言返回 `{ x: 100, y: 200 }`

新增 `replyBtn: null` 回退测试：
- 第一次 evaluate 返回 `replyBtn: null`
- 断言 `scrollRootIntoView` 被调用
- 第二次 evaluate 返回 `replyBtn: { x: 100, y: 200 }`
- 断言返回 `{ x: 100, y: 200 }`

## 验证标准

1. `scrollCommentArea('top')` 在 scrollY=0 时不触发 `cdpSmartScroll`，totalMs < 100ms
2. `findRootCommentByUsernameContent` 返回 `replyBtn` 有值时，不调用 `findReplyBtnInContainer`
3. level=1 回复流程点击的回复按钮属于目标评论（username+text 匹配），而非相邻评论
4. 现有 `scrollBounded.test.ts` 测试通过
5. Docker 重建后日志中不再出现 `containerFound: false` + 9.7 秒 scrollCommentArea
