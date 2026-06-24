# 视频采集截断与抽屉滚动加载修复设计规格

**日期**: 2026-06-24
**状态**: 待用户复审
**范围**: 修复抖音 Phase1 超额采集未截断、Phase3 选择作品抽屉滚动加载过早门控两个 bug；并把"截断前显式按时间倒序"统一到快手、小红书、腾讯

---

## 1. 背景

监控第二次执行（评论数无变化）时仍进入评论管理页面，并在选择作品抽屉中反复点击“呜呜呜”等视频，最终 Phase3 报 `Failed to click video`。日志分析发现两个根因：

1. **Phase1 超额采集未截断**：抖音 `checkForUpdates` 遍历完整的、超额采集到的 `videos` 数组（实测 24 条），而 `reconcileVideosForUser` 只持久化最新 20 条。位置 21–24 的视频更旧、从未入库，于是每个周期都被判定为 `new_video_with_comments` 入队，Phase3 又试图在抽屉里点击它们。
2. **抽屉滚动加载过早门控**：抖音 `findAndClickVideoInDrawer` 进入时检查 Semi-UI 的 `没有更多视频` 哨兵。该哨兵从抽屉首屏渲染起就存在，导致 `maxScrolls = 0`，滚动加载循环根本不执行。目标视频位于第二页 cursor 批次，永远进不了 DOM。

目标是：
- Phase1 固定只监控最新 20 条（含置顶），新视频自然排到最前，旧视频超出 20 条不再每周期重复入队。
- Phase3 抽屉在首屏未命中目标时，滚动加载触发 cursor 翻页，直到找到目标或真正耗尽。

---

## 2. 设计决策

### 2.1 Bug 1：固定取最新 20 条（含置顶）

**决策**：抓取后立即按 `create_time` 倒序排序，再 `slice(0, maxMonitorVideos)`。截断后的列表同时用于入队判断循环和 `reconcileVideosForUser`。

| 项 | 取值 |
|---|---|
| 监控上限 | `maxMonitorVideos`（默认 20） |
| 排序键 | `create_time` 倒序（最新在前） |
| 置顶视频 | 含置顶取最新 20 条；`skipPinnedVideos` 时仅不爬置顶项，不补位 |
| 截断位置 | Phase1 抓取返回后、入队循环之前 |

**理由**：
- 用户要求“只对比时间最新的 20 个视频，有新增视频时间和排序都应在旧视频前”。
- 平台 API 通常已按新→旧返回，但显式排序保证确定性，避免拦截器突发顺序错乱。
- 截断同时喂给入队循环和 reconcile，保证两者口径一致，消除“DB 只存 20、队列却看 24”的错配。

### 2.2 Bug 2：移除过早门控，滚动到找到/真正耗尽

**决策**：删除 `noMoreVideo → maxScrolls = 0` 短路。改为循环“查 DOM → 命中即点击 → 否则滚动加载 → 重复”。真正耗尽判定放在**滚动之后**：连续两次滚动后容器数量无增长，且哨兵仍显示“没有更多视频”，才退出。

| 停止条件 | 触发动作 |
|---|---|
| 命中目标并点击成功 | 返回 true |
| 连续两次滚动无新容器 + 哨兵确认耗尽 | 退出循环，返回 false |
| 达到 `MAX_SCROLL_ATTEMPTS_DRAWER`（25） | 兜底退出，返回 false |

**理由**：
- `没有更多视频` 哨兵首屏即存在，不能作为“未滚动前”的耗尽信号。
- 真正耗尽应在滚动后通过“无新数据 + 哨兵”双重确认。
- 滚动原语 `scrollDrawerForMore` 已实现鼠标移入 `.douyin-creator-interactive-sidesheet-body` + 分段 wheel 派发，能触发 `cursor=` 翻页 API，无需新增。

### 2.3 其他平台审查

**决策**：快手、小红书、腾讯经审查均不存在这两个 bug，但截断前未显式排序。本次一并补上显式倒序排序，保持四家“最新 N 条”语义一致。

| 平台 | Bug 1（超额未截断） | Bug 2（抽屉过早门控） | 本次改动 |
|---|---|---|---|
| 抖音 | 存在 | 存在 | 截断 + 抽屉门控修复 |
| 快手 | 不存在（已 slice） | 不存在（时间戳容差 + 完整滚动循环） | 仅补显式倒序排序 |
| 小红书 | 不存在（已 slice） | 不适用（Phase3 不走选择作品抽屉） | 仅补显式倒序排序 |
| 腾讯 | 不存在（已 slice） | 不适用（瀑布流滚动列表 + findVideo 定位） | 仅补显式倒序排序 |

**理由**：
- 快手 `findAndClickVideoInDrawer` 用 `.video-item` + 时间戳容差匹配，有完整滚动加载循环（`MAX_SCROLL_ATTEMPTS=100`），用“已加载视频时间是否早于目标”判断滚动过头，逻辑合理。
- 小红书、腾讯 Phase3 不走“选择作品抽屉”，无此门控问题。
- 截断前显式排序是确定性保障，统一到四家避免后续平台间口径漂移。

### 2.4 Bug 1 与 Bug 2 的关联

截断（Bug 1）让入队队列只含最新 20 条；这 20 条正是抽屉首屏默认渲染的视频，绝大多数可在不滚动时直接点中。抽屉滚动加载（Bug 2）是兜底：当目标视频因排序、置顶、新发布落到首屏之外时仍能找到。两者互补——截断减少需要滚动的概率，滚动兜底保证截断后仍能点到。

---

## 3. 详细设计

### 3.1 截断排序纯函数

**文件**：`apps/ts-api-gateway/src/services/commentCrawlRules.ts`

新增纯函数，便于单测：

```ts
export function truncateToNewest<T extends { create_time?: number }>(
  items: T[],
  limit: number,
): T[] {
  return [...items]
    .sort((a, b) => (b.create_time ?? 0) - (a.create_time ?? 0))
    .slice(0, limit);
}
```

### 3.2 抖音 Phase1 截断

**文件**：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`（`checkForUpdates`，约 1437 行）

在 `const videos = await this.fetchVideoListFromSource(page, source);` 之后、DB 对比/入队循环之前插入：

```ts
const fetchedCount = videos.length;
const videos = truncateToNewest(videos, this.maxMonitorVideos);
logger.info({ userId, fetched: fetchedCount, monitored: videos.length, cap: this.maxMonitorVideos }, '[Phase1] Truncated to newest N videos');
```

入队循环（1487 行）和 `reconcileVideosForUser`（1573 行）都基于截断后的 `videos`，其余不变。

### 3.3 抖音抽屉滚动加载

**文件**：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`（`findAndClickVideoInDrawer`，约 2816 行）

**改动 1**：删除过早门控（2825–2838 行）：

```ts
const maxScrolls = MAX_SCROLL_ATTEMPTS_DRAWER;
```

**改动 2**：替换滚动循环（2840–2879 行）为“滚动后真正耗尽判定”：

```ts
let lastContainerCount = -1;
let noGrowthRounds = 0;

for (let scrollAttempt = 0; scrollAttempt <= maxScrolls; scrollAttempt++) {
  await HumanActions.wait(page, 400, 700);

  const containerSelector = getSelector('drawer.video-item').css
    || '[class*="douyin-creator-interactive-list-items"] > div';
  const containerElements = await HumanActions.queryElementsWithInfo(page, containerSelector);
  const count = containerElements?.length ?? 0;

  if (containerElements && containerElements.length > 0) {
    logger.info({ count, scrollAttempt }, '[Drawer] Found video containers');
    for (const container of containerElements) {
      if (!isDescriptionMatch(container.text || '', description)) continue;
      const clicked = await HumanActions.cdpClickNode(page, container.nodeId);
      if (clicked) {
        logger.info({ awemeId, matchType: 'description' }, '[Drawer] 匹配成功（描述前缀）');
        return true;
      }
      const reClicked = await this.tryClickMatchedContainer(
        page, description.toLowerCase(), description.toLowerCase().substring(0, 25),
      );
      if (reClicked) return true;
      logger.warn({ awemeId }, '[Drawer] Match found but click failed — giving up');
      return false;
    }
  }

  if (scrollAttempt < maxScrolls) {
    logger.info({ scrollAttempt, containerCount: count }, '[Drawer] 未匹配，滚动加载更多');
    await this.scrollDrawerForMore(page, scrollAttempt);

    if (count === lastContainerCount) {
      noGrowthRounds++;
      const exhausted = await page.evaluate(() => {
        const els = document.querySelectorAll('[class*="loading"]');
        for (const el of els) {
          if (el.textContent?.includes('没有更多视频')) return true;
        }
        return false;
      }).catch(() => false);
      if (noGrowthRounds >= 2 && exhausted) {
        logger.info({ scrollAttempt, count }, '[Drawer] 滚动后无新视频且哨兵确认耗尽 — 停止');
        break;
      }
    } else {
      noGrowthRounds = 0;
    }
    lastContainerCount = count;
  }
}

logger.warn({ awemeId, maxScrolls }, '[Drawer] 滚动穷尽仍未匹配');
return false;
```

`scrollDrawerForMore` 保持不变。

### 3.4 其他平台补显式倒序排序

**快手** `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`（约 689 行）：

```ts
const sliced = truncateToNewest(filtered, this.maxMonitorVideos);
```

**小红书** `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`（约 261 行）：

```ts
const sliced = truncateToNewest(filteredItems, this.maxMonitorVideos);
```

**腾讯** `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`（约 953 行）：

```ts
}).slice(0, this.maxMonitorVideos);
// 改为
const filteredVideos = truncateToNewest(
  enriched.filter(video => { /* 过滤非公开和评论关闭 */ }),
  this.maxMonitorVideos,
);
```

---

## 4. 数据流

```text
Phase1 fetchVideoListFromSource 返回全部公开视频（可能 > 20）
  └─ truncateToNewest(videos, maxMonitorVideos)
      └─ 最新 20 条（含置顶，按 create_time 倒序）
          ├─ 入队判断循环：仅这 20 条参与 new/changed 判定
          └─ reconcileVideosForUser：仅持久化这 20 条
```

```text
Phase3 findAndClickVideoInDrawer
  └─ 首屏默认渲染前 20 条 → 命中即点击
      └─ 未命中 → scrollDrawerForMore 触发 cursor 翻页
          ├─ 新容器出现 → 继续查 DOM
          └─ 连续两次无增长 + 哨兵确认 → 真正耗尽，退出
```

---

## 5. 错误处理与边界情况

1. **超额采集但不足 20 条** —— `slice(0, maxMonitorVideos)` 对短数组安全。
2. **`create_time` 缺失** —— `(b.create_time ?? 0) - (a.create_time ?? 0)`，缺字段按 0 排到末尾，不抛异常。
3. **置顶视频** —— 含置顶取最新 20 条；`skipPinnedVideos` 时仅不爬置顶项，不补位，与 `monitorService` 现有 skipPinned 过滤一致。
4. **抽屉连续滚动无新数据但哨兵未显示** —— `noGrowthRounds` 仅在 `exhausted` 同时为真时才退出；否则继续直到 `MAX_SCROLL_ATTEMPTS_DRAWER` 兜底。
5. **截断后某旧视频之前已入库但本轮掉出前 20** —— `reconcileVideosForUser` 视为“已消失”删除（非保护模式），保持 DB 与监控范围一致。这是预期行为（只监控最新 20 条）。
6. **cursor 翻页鉴权** —— 现有页面会话已带 cookie/token，`scrollDrawerForMore` 模拟真实滚动即可复用。

---

## 6. 测试与验证

### 6.1 单元测试

`apps/ts-api-gateway/src/services/__tests__/commentCrawlRules.test.ts` 新增 `truncateToNewest` 用例：
- 25 条乱序视频 → 返回最新 20 条，且按时间倒序；
- 不足 20 条 → 原样返回（倒序）；
- `create_time` 缺失项按 0 排到末尾，不抛异常；
- 空数组 → 返回空数组。

### 6.2 静态验证

- 确认抖音 `findAndClickVideoInDrawer` 不再有 `maxScrolls = 0` 短路；`noMoreVideo` 已删除或仅在滚动后检查。
- `pnpm --filter ts-api-gateway build` 通过。
- `pnpm --filter ts-api-gateway test` 通过。

### 6.3 手动运行时验证（抖音账号）

1. 选取之前失败的抖音账号（userId 21，27 条视频、超额采集到 24）。
2. 触发监控，观察日志：
   - `[Phase1] Truncated to newest N videos`：fetched 24、monitored 20；
   - 入队队列只含最新 20 条内视频，溢出旧视频不再作为“新增”入队；
   - 抽屉日志出现 `未匹配，滚动加载更多`，最终 `匹配成功` 而非 `Failed to click video`；
   - Phase3 成功率从 0/3 提升。
3. 新发布一条视频再触发：新视频排到最新 20 条最前，正常入队首爬；最旧 1 条掉出 20 被删除。
4. 第二次触发（无新增）：`commentsQueue` 为空，不进入 Phase3。

---

## 7. 不在范围内

- 调整 `MAX_MONITOR_VIDEOS`（=20）默认值。
- 修改快手/小红书/腾讯的抽屉与瀑布流点击逻辑（审查后判定合理）。
- 改变 `skipPinnedVideos` 语义。
- 新增 cursor API 直接拦截方案。
- 修改抖音 `scrollDrawerForMore` 本身。

---

## 8. 成功标准

1. 抖音 Phase1 固定只入队最新 20 条视频，溢出旧视频不再重复入队。
2. 第二次执行（评论数无变化）不进入 Phase3。
3. 抖音 Phase3 抽屉能通过滚动加载找到首屏之外的目标视频，`Failed to click video` 不再因门控短路出现。
4. 真正耗尽时（连续两次无增长 + 哨兵确认）及时退出，不死循环。
5. 快手、小红书、腾讯截断前显式按 `create_time` 倒序，四家“最新 N 条”语义一致。
6. `truncateToNewest` 单测通过；`build` 与 `test` 通过。
