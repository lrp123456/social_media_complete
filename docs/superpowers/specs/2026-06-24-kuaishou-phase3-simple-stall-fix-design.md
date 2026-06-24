# 快手 Phase3 Simple 模式卡顿修复设计规格

**日期**: 2026-06-24
**状态**: 已确认
**范围**: 修复快手视频采集第三阶段（Simple 模式根评论采集）中选择视频抽屉状态不收敛、抽屉匹配过严、无 commentList 响应长等待导致任务看似卡住的问题。

---

## 1. 背景

最新日志显示，快手 `Phase3 Simple` 模式处理 `userId=22` 时出现明显卡顿：

1. 第一个入队视频 `3xpc7hfnfv3ws82` 在抽屉内匹配成功后，没有捕获到新的 `commentList` 响应。当前逻辑每次等待 `20s`，连续空响应计数达到 `5` 才退出，单个视频最坏消耗约 `100s`。
2. 第二个入队视频 `3xpxixudjituky2`（`#空气清新环境优美 `）滚动后已加载到覆盖目标发布时间的范围，但由于描述匹配/特殊空白/文本截断等原因未命中，并被 `minTimestamp < targetCreateTime - tolerance` 过早判定为“滚动过头”。
3. 第三个入队视频 `3xpkg6q3xk9d7ei` 打开抽屉时出现 `Click succeeded but drawer not detected, proceeding anyway`，随后 `findAndClickVideoInDrawer` 在没有 `.video-item` 的状态下持续滚动，日志表现为多轮 `loadedItems:0`。
4. 用户观察到页面短暂切换/显示“雪山下的小屋，阳光洒落的瞬间太治愈了！ #美景让人向往 #自然风光欣赏 #木质小屋”。日志确认该视频 `3xqfngs9s7fvzry` 的 `commentCount=0`，Phase1 已按 `new_video_without_comments` 跳过，并未进入 Phase3 队列；它只是快手选择视频抽屉列表中的可见项。

目标是让快手 Phase3 Simple 模式具备“单个视频快速失败、队列继续”的行为，避免无响应视频或异常抽屉状态拖住整轮任务。

---

## 2. 设计决策

### 2.1 采用“快速失败 + 抽屉匹配鲁棒化”方案

**决策**：修复范围限定在快手 `Phase3 Simple` 模式、选择视频抽屉打开/匹配、`commentList` 等待逻辑。不重构为 API 驱动选择，不扩大评论采集范围。

| 项 | 决策 |
|---|---|
| 单个视频无 `commentList` | 短等待 1-2 次后跳过，继续下一个视频 |
| 抽屉打开 | 点击后必须确认抽屉可见，未确认则重试/失败 |
| 抽屉空列表 | 连续多轮 `loadedItems=0` 快速熔断 |
| 文本匹配 | 新增归一化，兼容换行、NBSP、普通空白、短话题标题 |
| 滚动过头 | 不再只凭 `minTimestamp < target - tolerance` 退出 |
| 其他平台 | 不修改 |

**理由**：该方案直接覆盖日志确认的三个卡顿/误判点，改动集中，风险低；相比 API 驱动重构更适合短期修复。

### 2.2 局部失败，不中断队列

**决策**：快手 Simple 模式每个视频独立处理。抽屉打开失败、目标未找到、点击后无 `commentList` 都只影响当前视频，后续队列继续。

**理由**：本轮队列中 4 个视频只有部分视频异常。终止整个 Phase3 会丢失后续可采集视频；继续队列能最大化保留有效数据。

---

## 3. 改动范围

### 3.1 修改文件

**主要文件**：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`

涉及方法：

1. `openSelectVideoDrawer(page)`
   - 删除“点击成功但抽屉不可见仍返回 true”的行为。
   - 点击后必须通过 `isDrawerVisible` 或抽屉内容特征确认。
   - 未确认时继续重试；重试耗尽返回 `false`。

2. `findAndClickVideoInDrawer(page, awemeId, description, createTime)`
   - 使用归一化文本匹配。
   - 增加连续空列表熔断。
   - 修改滚动过头判定。
   - 匹配成功日志标注 `matchType: timestamp+normalized-description`。

3. `processCommentsQueueSimple(page, queue, maxRootComments)`
   - 点击目标视频后改为短等待 `commentList`。
   - 无响应时直接跳过当前视频，不再进入 `20s * 5` 空响应长轮询。

4. `waitForCommentResponse(page)` 或新增短等待包装
   - 保留现有通用等待函数给非 Simple 流程使用，避免影响完整评论树流程。
   - 为 Simple 模式新增短超时等待函数，例如 `waitForCommentResponseShort(page, timeoutMs)`，默认 `5000-8000ms`。

### 3.2 建议新增文件

**新增测试/工具文件**：

- `apps/ts-api-gateway/src/crawlers/kuaishouDrawerUtils.ts`
- `apps/ts-api-gateway/src/crawlers/__tests__/kuaishouDrawerUtils.test.ts`

拆出纯函数便于测试：

1. `normalizeKuaishouVideoText(text: string): string`
2. `isKuaishouDrawerVideoTextMatch(domText: string, targetDescription: string): boolean`
3. `shouldStopKuaishouDrawerSearch(input): boolean`

如果实现时更适合保持单文件，也可以把纯函数放在 `kuaishouCrawler.ts` 底部并导出；但推荐独立工具文件，避免继续增大 crawler 文件。

---

## 4. 详细设计

### 4.1 抽屉打开状态收敛

当前问题代码位于 `openSelectVideoDrawer`：

```ts
logger.warn({ attempt }, '[Drawer] Click succeeded but drawer not detected, proceeding anyway');
return true;
```

新行为：

```text
for attempt in maxRetries:
  点击“选择视频”
  如果点击失败：等待后重试
  如果点击成功：等待抽屉渲染
    如果 isDrawerVisible(page)：return true
    否则记录 warning，继续下一轮重试
return false
```

日志建议：

- `[Drawer] Click succeeded but drawer not visible, retrying`
- `[Drawer] Failed to open kuaishou drawer after all retries`

这样可以避免进入没有 `.video-item` 的查找循环。

### 4.2 抽屉文本归一化匹配

新增纯函数：

```ts
export function normalizeKuaishouVideoText(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}
```

匹配策略：

1. 先解析 DOM 发布时间，与目标 `createTime` 做 ±60 秒容差匹配。
2. 时间命中后，再用归一化后的 DOM 文本与目标描述匹配。
3. 目标描述前 20 个归一化字符优先匹配。
4. 对短话题标题，允许前 8-12 个归一化字符匹配。
5. 完全不同标题不能通过。

示例：

```text
目标：#空气清新环境优美 
DOM：#空气清新环境优美
归一化后：#空气清新环境优美
结果：匹配
```

### 4.3 滚动过头判定调整

当前逻辑：

```ts
if (minTimestamp < createTimeNum - tolerance) {
  return { found: false, scrolledPast: true, ... };
}
```

问题是：快手抽屉一次滚动可能加载 20-30 条。当前 DOM 时间范围覆盖目标时，仅凭存在更旧视频就退出，会错过因文本归一化问题未命中的目标。

新策略：

- 不再在 `page.evaluate` 内只凭 `minTimestamp` 返回 `scrolledPast=true`。
- 在外层维护：
  - `lastLoadedItems`
  - `noGrowthRounds`
  - `emptyRounds`
  - `hasScrolled`
- 停止条件：
  1. 连续 `emptyRounds >= 2`：抽屉空列表熔断；
  2. 已滚动至少一次，`loadedItems` 连续无增长，且最旧时间明显早于目标：判定无法继续加载到目标；
  3. 达到 `MAX_SCROLL_ATTEMPTS` 兜底。

日志建议：

- `[Drawer] Empty video list repeated — stopping search`
- `[Drawer] No growth after scrolling and passed target window — stopping search`
- `[Drawer] 滚动穷尽仍未匹配`

### 4.4 Simple 模式短等待 commentList

当前 Simple 模式流程在 `processCommentsQueueSimple` 中：

```text
点击视频
等待 3-5s
while hasMore && allComments.length < maxRootComments && consecutiveNoNew < 5:
  collectAllCommentResponses()
```

而 `collectAllCommentResponses()` 首次调用 `waitForCommentResponse()`，每次最多等 `20s`。无响应时会重复 5 轮。

新行为：

```text
点击视频
等待 2-4s
短等待 commentList，最多 1-2 次
  收到响应：进入分页采集
  未收到：记录并跳过当前视频
```

关键点：

- Simple 模式不要在没有首个 `commentList` 的情况下进入分页循环。
- 首个响应缺失通常说明点击未触发目标视频切换、页面状态异常或该视频无可见评论接口响应；继续长等收益低。
- 保留完整模式的 `waitForCommentResponse(20s)` 行为，避免影响非 Simple 流程。

建议新增：

```ts
private async waitForCommentResponseShort(timeoutMs = 8000): Promise<InterceptedResponse | null>
```

或者将现有 `waitForCommentResponse` 改为接收可选 timeout 参数，并只在 Simple 模式传短超时。

---

## 5. 数据流

```text
Phase3 Simple queue item
  ├─ clear ALL_KUAISHOU_COMMENT_PATTERNS
  ├─ openSelectVideoDrawer
  │   ├─ visible -> continue
  │   └─ not visible after retries -> result error, next item
  ├─ findAndClickVideoInDrawer
  │   ├─ timestamp + normalized text match -> click
  │   ├─ empty list repeated -> result error, next item
  │   ├─ no growth / exhausted -> result error, next item
  │   └─ max scroll attempts -> result error, next item
  ├─ waitForCommentResponseShort
  │   ├─ response -> parse/store root comments
  │   └─ no response -> result error, next item
  └─ continue queue
```

---

## 6. 错误处理与边界情况

1. **抽屉不可见**：不再继续查找，避免空 DOM 滚动。
2. **连续空列表**：连续 2 轮 `loadedItems=0` 后退出。
3. **目标视频是短话题标题**：归一化后用较短前缀匹配，兼容 NBSP 和 DOM 截断。
4. **目标时间落在已加载范围内但未命中**：不立即判定滚动过头，继续按无增长/兜底条件退出。
5. **点击后没有 `commentList`**：短等待后跳过，不再阻塞约 100 秒。
6. **误点击跳转视频详情页**：保留现有返回评论管理页并有限重试机制。
7. **“雪山下的小屋”无评论视频**：仍只作为抽屉列表项出现；Phase1 不入队，Phase3 不处理。

---

## 7. 测试与验证

### 7.1 单元测试

新增 `apps/ts-api-gateway/src/crawlers/__tests__/kuaishouDrawerUtils.test.ts`：

- `normalizeKuaishouVideoText`：
  - 去除 `\n`、普通空格、` `；
  - 统一大小写；
  - 保留中文、数字、`#`。
- `isKuaishouDrawerVideoTextMatch`：
  - `#空气清新环境优美 ` 与 `#空气清新环境优美` 匹配；
  - 多行描述与 DOM 截断文本匹配；
  - 完全不同标题不匹配。
- `shouldStopKuaishouDrawerSearch`：
  - 连续空列表达到阈值时停止；
  - 只出现 `minTimestamp < target` 不停止；
  - 已滚动、无增长、且明显越过目标窗口时停止。

### 7.2 静态验证

- 确认 `openSelectVideoDrawer` 不再出现 `proceeding anyway` 后 `return true`。
- 确认 `processCommentsQueueSimple` 不再通过 `collectAllCommentResponses` 在首个响应缺失时触发 `20s * 5` 长等待。
- 确认 `findAndClickVideoInDrawer` 对 `loadedItems=0` 有快速熔断。

### 7.3 命令验证

```bash
pnpm --filter ts-api-gateway test
pnpm --filter ts-api-gateway build
```

### 7.4 运行时日志验证

修复后触发快手监控，应看到：

- 抽屉不可见时：
  - `[Drawer] Click succeeded but drawer not visible, retrying`
  - 或 `[Drawer] Failed to open kuaishou drawer after all retries`
- 空列表熔断时：
  - `[Drawer] Empty video list repeated — stopping search`
- 文本匹配成功时：
  - `[Drawer] 匹配成功`
  - `matchType: timestamp+normalized-description`
- 点击后无 `commentList` 时：
  - `[Simple] No commentList after selecting video — skipping`

不应再长时间重复：

```text
[Phase3] Kuaishou comment API response wait timed out
[Simple] No API response, incrementing counter
```

不应在 `loadedItems:0` 时滚动几十次。

---

## 8. 不在范围内

- 不修改快手 Phase1 视频采集/排序/截断策略。
- 不修改抖音、小红书、腾讯。
- 不重构为 API 驱动选择视频。
- 不采集子评论内容；Simple 模式仍只采根评论。
- 不新增数据库字段。
- 不调整全局队列调度策略。

---

## 9. 成功标准

1. 快手 `Simple` 模式中，单个无响应视频不会阻塞约 `100s`。
2. 抽屉未确认可见时，不进入视频查找循环。
3. `loadedItems=0` 连续出现时快速退出。
4. `#空气清新环境优美 ` 这类含特殊空白/短话题标题的视频能正常匹配，或至少不因“滚动过头”错误提前终止。
5. 用户观察到的“雪山下的小屋”不会被误当作 Phase3 目标；若它无评论，仍只在抽屉列表里出现，不进入评论采集。
6. 队列中某个视频失败后，后续视频继续处理。
7. 新增单测通过，`pnpm --filter ts-api-gateway test` 与 `pnpm --filter ts-api-gateway build` 通过。
