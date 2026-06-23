# 评论采集修复设计

## 背景

Per-window 队列重构完成后，部署验证发现评论采集存在以下问题：

1. **小红书所有笔记 Phase 3 失败** — `clickThumbnailAndWaitNewTab` 对所有笔记返回 null
2. **腾讯根评论分页不完整** — "生活life"视频 API 返回 `commentCount: 24`、`downContinueFlag: 1`，但 DB 只存了 10 条根评论
3. **commentCount 存储不准确** — 部分平台存储的是采集到的评论数而非 API 真实总数；Phase 1 创建时 commentCount=0，Phase 3 失败则永远为 0
4. **选择器 Docker volume 同步问题** — Docker volume 覆盖镜像中的 `selectors.json`，首次部署或版本更新后运行时只有最小 FALLBACK_CONFIG

## 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| commentCount 存储时机 | Phase 1 存储 API 值，Phase 3 不更新 | Phase 1 的 API 值是真实总数；Phase 3 只负责采集评论内容，与总数无关 |
| XHS Phase 3 入口方式 | 修复 click 方式 | 保持人类行为模拟 |
| 腾讯分页方式 | 修复 scroll 目标 | 保持人类行为模拟 |
| 选择器同步策略 | 方案 B — 自动 merge + 前端可配置 | 防止 Docker volume 过期问题重现 |

## 改动清单

### 1. 选择器自动同步（`selectorStore.ts`）

**问题：** Docker volume `ts_api_data` 挂载在 `/app/apps/ts-api-gateway/data`，覆盖镜像中打包的 `selectors.json`。首次部署或版本更新后，`loadFromDisk()` 找不到文件，回退到最小 `FALLBACK_CONFIG`（仅含 douyin 基础选择器），导致所有非 douyin 平台的选择器缺失。

**方案：** 在 `SelectorReader` 初始化时执行 deep-merge：

```
loadFromDisk():
  1. 读取 runtime selectors.json (DATA_DIR/selectors.json)
  2. 读取 bundled selectors.json (通过 __dirname 或 import.meta.url 定位打包版本)
  3. 如果 runtime 不存在 → 直接使用 bundled，保存到 runtime
  4. 如果两者都存在 → deep-merge:
     - 遍历 bundled 的每个 platform → category → selector key
     - key 仅在 bundled 存在 → 添加到 runtime（新选择器随代码更新出现）
     - key 仅在 runtime 存在 → 保留（用户自定义）
     - key 在两者都存在 → 保留 runtime 版本（用户覆盖优先）
  5. 如果 merge 产生了新增 key → 保存合并结果到 runtime 文件
  6. 记录日志：新增 N 个选择器，跳过 M 个用户自定义
```

**bundled 路径定位（关键）：** Docker volume 挂载在 `/app/apps/ts-api-gateway/data`，会覆盖镜像中同路径的文件。因此需要在 Dockerfile 中将打包的 `selectors.json` 复制到一个**不被 volume 覆盖**的路径：

```dockerfile
# Dockerfile — 在 COPY 之后新增
COPY apps/ts-api-gateway/data/selectors.json /app/bundled-selectors.json
```

`selectorStore.ts` 中新增常量：
```typescript
const BUNDLED_SELECTOR_FILE = '/app/bundled-selectors.json';
```

在非 Docker 环境（本地开发），该文件可能不存在，此时跳过 merge，直接使用 runtime 文件或 FALLBACK_CONFIG。

**影响范围：**
- `apps/ts-api-gateway/Dockerfile` — 新增 `COPY` 指令
- `apps/ts-api-gateway/src/lib/selectorStore.ts` — `loadFromDisk()` 函数
- 所有平台的选择器在运行时可通过前端 `/api/v1/config-automation/selectors` API 查看和管理

### 2. commentCount 存储策略（`monitorDatabaseService.ts` + 4 个 crawler）

**问题：** `commentCount` 在 Phase 1 创建时为 0，仅在 Phase 3 成功后更新，且部分平台存储的是采集到的评论数而非 API 真实总数。

**方案：** Phase 1 存储平台 API 返回的真实评论总数。Phase 3 不再更新 `commentCount`。

#### 2.1 `reconcileVideosForUser` 改动

当前代码（`monitorDatabaseService.ts:251`）：
```typescript
create: { commentCount: 0, ... }
update: { /* 不更新 commentCount */ }
```

改为：
```typescript
create: { commentCount: v.comment_count ?? 0, ... }
update: { commentCount: v.comment_count ?? undefined, ... }
```

`update` 路径中，如果 API 未返回 `comment_count`（`undefined`），Prisma 会跳过该字段不更新。如果 API 返回了新值，则更新。

#### 2.2 Phase 3 commentCount 调用处理

**策略：保留所有 Phase 3 中的 `updateCommentCount` / `updateVideoCommentCount` 调用，不做移除。**

理由：Phase 1 的 `reconcileVideosForUser` 改动已经确保 `commentCount` 在 Phase 1 就存入 API 真实值。Phase 3 中这些调用要么写入相同的 API 值（douyin/kuaishou 用 `item.newCount`），要么写入采集数（XHS/tencent）——但由于 Phase 1 已经先写入了 API 值，Phase 3 的写入如果用不同的值会覆盖正确值。

因此，需要将 XHS 和腾讯 Phase 3 中的 commentCount 写入值也改为 API 值（与 Phase 1 一致），而非移除调用：

| 文件 | 行号 | 当前写入值 | 改为 |
|------|------|-----------|------|
| `xiaohongshuCrawler.ts` | ~1152 | `comments.length`（采集数） | `item.newCount`（API 值，从 commentsQueue 传入） |
| `tencentCrawler.ts` | ~1475 | `dbCommentsArray.length`（采集数） | `item.newCount`（API 值，从 commentsQueue 传入） |
| `douyinCrawler.ts` | ~2000, ~2283 | `item.newCount`（已是 API 值） | 不变 |
| `kuaishouCrawler.ts` | ~1794 | `item.newCount`（已是 API 值） | 不变 |
| `monitorService.ts` | 所有 simple/light 模式调用 | `q.newCount` / `u.newCount`（已是 API 值） | 不变 |

这样所有 Phase 3 调用统一写入 API 值，与 Phase 1 一致。即使 Phase 3 先于 Phase 1 写入（理论上不会），值也是相同的。

#### 2.3 腾讯 commentCount 来源

腾讯视频列表 API (`post_list`) 的返回结构中已包含 `commentCount` 字段（`TencentVideoInfo.commentCount`），Phase 1 的 `parseVideoItem` 已提取此字段。Phase 1 直接存入 DB，Phase 3 不再更新。

`comment_list` API 响应中的 `data.commentCount` 不参与 DB 写入或二次验证。Phase 1 的 `post_list` 值即为最终值。

### 3. XHS clickThumbnailAndWaitNewTab 修复（`xiaohongshuCrawler.ts`）

**问题：** 对所有笔记返回 null。

**根因：**
1. Docker volume 中 `selectors.json` 缺少 `region_note_card_by_id`（Section 1 的自动同步将解决）
2. `data-impression` 属性是 HTML 转义的 JSON，CSS `*=` 子串匹配可能因转义字符失败
3. 点击后新标签页未打开时直接返回 null，无降级方案

**方案：**

```
clickThumbnailAndWaitNewTab(page, noteId, timeout):
  1. 获取选择器并记录日志（cardDef.css, coverDef.css）
  2. 选择器降级：如果 getSelector 返回空，使用硬编码：
     - card: `.note-card[data-impression*="${noteId}"]`
     - cover: `.note-card__cover .note-card__media`
  3. 等待卡片元素（waitForSelector 10s）
     - 如果失败 → 用 page.evaluate 遍历所有 .note-card，
       检查 data-impression 属性是否包含 noteId（JS 字符串匹配，不受 HTML 转义影响）
   4. 在卡片内查找 cover 元素，找到则点击 cover，否则点击卡片
   5. **顺序式**监听新标签页（非 Promise.all）：
      - 先注册 `page.context().waitForEvent('page', { timeout })` 
      - 然后执行点击
      - 如果 `waitForEvent` 在 timeout 内 resolve → 返回新标签页
      - 如果 `waitForEvent` reject（超时）→ 进入步骤 6 降级
      - 注意：避免 Promise.all 嵌套，防止点击失败和标签页打开的竞态条件
   6. 如果新标签页未在 timeout 内打开：
      - 降级：page.context().newPage() 直接导航到
        https://www.xiaohongshu.com/explore/{noteId}
      - 记录 warn 日志
   7. 新标签页 waitForLoadState('domcontentloaded')
   8. 返回 Page（成功）或 null（完全失败）
```

**关键改进：**
- 每步记录诊断日志
- `page.evaluate` JS 匹配作为 CSS 选择器的降级
- URL 直接导航作为点击失败的降级
- **顺序式**点击→等标签页，避免 Promise.all 竞态（Oracle Finding 6）
- 硬编码降级选择器需与 `selectors.json` 保持同步，添加注释提醒

### 4. 腾讯根评论分页修复（`tencentCrawler.ts`）

**问题：** API 返回 `downContinueFlag: 1`（有更多页），但滚动未触发下一页加载。

**根因：** 无限滚动实际容器是 `.scroll-list__wrp .scroll-list`（带 `infinite-scroll-distance="20"`），但代码滚动的是外层 `.feed-comment__wrp`。外层容器滚动不一定触发内层 `infinite-scroll` 的滚动事件。

**DOM 结构：**
```
.feed-comment__wrp                    ← 当前滚动目标（外层）
  └─ .scroll-list__wrp.scroll-list-wrap
       └─ .scroll-list (infinite-scroll-distance=20)  ← 实际无限滚动容器
            └─ .comment-item × 10
```

**方案：**

修改 `collectVideoComments` 及相关方法中的滚动调用。

**关键约束：** 腾讯页面使用 wujie 微前端，`.scroll-list__wrp .scroll-list` 在 shadow DOM 内。`page.locator()` 无法穿透 shadow DOM，必须用 `page.evaluate` + `shadowRoot.querySelector` 检测容器是否存在。

**实现方式：** 将滚动目标优先级逻辑直接集成到 `scrollShadowContainer` 方法内部，而非新增 `getScrollTarget`。修改 `scrollShadowContainer` 接受 `null` 作为 `containerSelector`，当为 `null` 时按优先级链查找：

```typescript
// scrollShadowContainer 内部修改：
// 如果 containerSelector 为 null，按优先级查找
const SCROLL_PRIORITY = [
  '.scroll-list__wrp .scroll-list',
  '.scroll-list__wrp',
  '.feed-comment__wrp',
];

if (!containerSelector) {
  const found = await page.evaluate((selectors: string[]) => {
    const wujieApps = document.querySelectorAll('wujie-app');
    for (const app of Array.from(wujieApps)) {
      const sr = (app as HTMLElement).shadowRoot;
      if (!sr) continue;
      for (const sel of selectors) {
        if (sr.querySelector(sel)) return sel;
      }
    }
    // 主文档降级
    for (const sel of selectors) {
      if (document.querySelector(sel)) return sel;
    }
    return selectors[selectors.length - 1]; // 兜底
  }, SCROLL_PRIORITY);
  containerSelector = found;
}
```

**影响范围（所有 `.feed-comment__wrp` 滚动调用点）：**

| 方法 | 行号 | 当前选择器 | 改为 |
|------|------|-----------|------|
| `collectVideoComments` | 1297 | `'.feed-comment__wrp'` | `null`（优先级查找） |
| `collectVideoComments` | 1323 | `'.feed-comment__wrp'` | `null` |
| `collectVideoComments` | 1332 | `'.feed-comment__wrp'` | `null` |
| `scrollCommentArea` | 1719, 1723 | `'.feed-comment__wrp'` | `null` |
| `scrollRootCommentIntoView` | 2426 | `'.feed-comment__wrp'` | `null` |
| `expandSubRepliesForReply` | 2449, 2459 | `'.feed-comment__wrp'` | `null` |

`scrollShadowContainer` 内部缓存本次调用的查找结果（实例变量），避免每次滚动都重新 evaluate。

**退出逻辑改进：**
- `downContinueFlag === 0` 且有评论 → 退出
- 连续 3 次滚动无新评论 → 退出
- `downContinueFlag === 1` 但连续 2 次无新数据 → 加大滚动幅度（600px），再 1 次仍无效 → 退出
- **修复 `dataExhausted` 提前退出竞态：** `dataExhausted` 仅在当前迭代没有新 API 响应时才触发退出。如果本次滚动产生了新响应（即使之前的响应 `downContinueFlag=0`），不退出，继续处理新数据。

**新增日志：** 每次滚动后记录 `scrollTarget`、`downContinueFlag`、`rootCount`。

## 不做的事

- **不修改** Simple 模式的 commentCount 逻辑（Phase 1 已存储真实值，Simple 模式无需关心）
- **不新增** `apiCommentCount` / `collectedCommentCount` 双字段（YAGNI）
- **不修改** `updateCommentCount` / `updateVideoCommentCount` 函数签名（保留供其他调用方使用）
- **不修改** Phase 2（轻通知）逻辑
- **不做** 选择器前端 UI 改造（现有 `DynamicSelectorPanel` 已支持完整 CRUD，自动同步后所有选择器自动出现在前端）

## 验证方式

1. `docker compose up -d --build --force-recreate` 后检查日志：`Selector sync: added N new selectors`
2. 调用 `GET /api/v1/config-automation/selectors?platform=xiaohongshu` 确认 `region_note_card_by_id` 存在
3. 运行监控任务，检查 XHS 笔记 Phase 3 日志：`[XHS-Phase3] New tab opened`
4. 运行腾讯监控任务，检查评论日志：`rootCount: 24`（而非 10）
5. 查询 DB：`SELECT id, commentCount FROM Video WHERE commentCount > 0` — 确认所有平台视频的 commentCount 均为 API 真实值
