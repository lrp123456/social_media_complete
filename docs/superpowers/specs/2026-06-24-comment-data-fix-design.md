# 评论数据修复设计规格

**日期**: 2026-06-24
**状态**: 已批准
**范围**: 修复 XHS 字段不匹配 BUG + 清理死代码 + 验证快手/抖音新代码

## 背景

全面审计 4 个平台（抖音、快手、小红书、腾讯）的评论数据流后发现以下问题：

| # | 问题 | 严重度 | 平台 |
|---|------|--------|------|
| 1 | XHS 简单模式 `exportId` vs `awemeId` 字段不匹配 → `noteId=undefined` | 🔴 BUG | 小红书 |
| 2 | `crawlMode === 'light'` 是死代码（DB 只存 simple/deep） | 🟡 | 所有 |
| 3 | 快手 photoList API 拦截已实现但未验证 | 🟢 | 快手 |
| 4 | 抖音抽屉 DOM 评论数提取已实现但未验证 | 🟢 | 抖音 |
| 5 | 快手 `work_list` API 实际上返回 `commentCount`（驼峰格式） | 🟢 | 快手 |

## 设计决策

### 决策 1：子评论采集策略
- **选择**：保持简单模式不变，不采集子回复
- **理由**：用户明确选择"保持简单模式不变"

### 决策 2：修复范围
- **选择**：修复所有 + 验证（方案 A）
- **理由**：用户选择"修复所有 + 验证"

### 决策 3：验证方式
- **选择**：手动触发验证
- **理由**：用户选择"手动触发验证"

## 修复方案

### 修复 1：XHS 字段不匹配

**问题**：
- `checkForUpdates`（line 755-771）构建队列时用 `exportId`
- `processCommentsQueueSimple` 期望 `XhsCommentQueueItem` 的 `awemeId`
- `monitorService.ts:1454` 用 `as any` 绕过类型检查

**修复位置**：`monitorService.ts:1451-1454`

**修复方式**：在调用处映射队列项：

```typescript
// 修复前：
await xhs.processCommentsQueueSimple(page, filteredQueue as any, maxRootComments);

// 修复后：
const xhsQueue = filteredQueue.map(q => ({
  awemeId: q.exportId,
  description: q.description,
  createTime: 0,                    // simple mode 不使用此字段
  oldCount: q.oldCount,
  newCount: q.newCount,
  isFirstCrawl: q.isFirstCrawl,
  _userId: task.userId,            // 从 task 上下文获取
  isPinned: q.isPinned,            // 保留置顶标记
}));
await xhs.processCommentsQueueSimple(page, xhsQueue, maxRootComments);
```

**注意**：源队列（`checkForUpdates` line 755-771）不包含 `createTime` 和 `_userId`，需要从 `task` 上下文补充。

### 修复 2：清理死代码

**问题**：`crawlMode === 'light'` 分支永远不会执行（DB 只存 `'simple'` 或 `'deep'`）。

**修复位置**：`monitorService.ts` 4 处（line 1070, 1247, 1414, 1624）

**修复方式**：删除 `if (crawlMode === 'light') { ... }` 分支及其日志。

**注意**：`monitorService.ts:1414` 的条件是 `crawlMode === 'light' || filteredQueue.length === 0`，删除 `'light'` 检查后需保留 `filteredQueue.length === 0` 分支（处理无更新的情况）。

**额外修复**：`getCrawlMode`（`monitorDatabaseService.ts:502-508`）需添加 legacy 值归一化：
```typescript
const mode = setting?.mode;
if (mode === 'light') return 'simple'; // normalize legacy mode
return mode || 'simple';
```

### 验证项

#### 验证 1：快手 photoList API 拦截

**代码位置**：`kuaishouCrawler.ts:2196-2249`（`updateCommentCountsFromPhotoList` 方法）

**验证方式**：
1. Docker 重建
2. 手动触发快手监控任务
3. 检查日志：`[Kuaishou-PhotoList]` 前缀
4. 检查数据库：快手视频 commentCount 是否更新

**注意**：快手 `work_list` API 实际上已返回 `commentCount`（驼峰格式），`parseVideoItem()` 的 `||` 链会正确提取。photoList 拦截是额外的回退机制。

**已知问题**：`updateCommentCountsFromPhotoList` 等待时间仅 500-1000ms（line 2201），可能不够。建议改为轮询：
```typescript
for (let w = 0; w < 6; w++) {
  const responses = this.interceptor.getResponses(PHOTO_LIST_PATTERN);
  if (responses.length > 0) break;
  await HumanActions.wait(page, 500, 500);
}
```

#### 验证 2：抖音抽屉 DOM 评论数提取

**代码位置**：`douyinCrawler.ts:2971-3042`（`updateCommentCountsFromDrawer` 方法）

**验证方式**：
1. Docker 重建
2. 手动触发抖音监控任务
3. 检查日志：`[Douyin-Drawer]` 前缀
4. 检查数据库：抖音视频 commentCount 是否与抽屉显示一致

**已知风险**：DOM 选择器（`[class*="douyin-creator-interactive-list-items"]`）依赖 CSS 类名，可能随抖音前端更新而失效。当前错误路径仅在 debug 级别记录日志，建议在 `videoItems.length === 0` 时添加 warn 级别日志。

#### 验证 3：快手 commentCount 来源确认

**发现**：从用户提供的 curl 响应确认，快手 `work_list` API 返回 `commentCount` 字段（驼峰格式）。

**验证方式**：
1. 检查 `parseVideoItem()` 的 `||` 链是否正确提取 `item.commentCount`
2. 检查数据库中快手视频的 commentCount 值

## 不在范围内

- 子评论采集（保持简单模式不变）
- 统一队列接口（YAGNI）
- 腾讯 create_time 归一化（已是秒级，无需处理）

## 文件变更

| 文件 | 变更类型 | 描述 |
|------|---------|------|
| `monitorService.ts` | 修改 | 修复 XHS 字段映射 + 删除 light 模式死代码 |
| `monitorDatabaseService.ts` | 修改 | `getCrawlMode` 添加 legacy 'light' 归一化 |

## 成功标准

1. XHS 简单模式能正确采集评论（noteId 不再是 undefined）
2. 快手 photoList API 拦截日志正常输出
3. 抖音抽屉 DOM 评论数提取日志正常输出
4. 所有平台 commentCount 值正确存储
5. `crawlMode === 'light'` 死代码已清理
6. legacy 'light' 模式 DB 值能正确归一化为 'simple'
