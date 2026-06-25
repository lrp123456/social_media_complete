# 简单模式评论数更新和通知修复设计规格

**日期**: 2026-06-23  
**状态**: 已批准（Oracle 审查通过）  
**作者**: AI Assistant

---

## 1. 问题概述

简单模式下存在 4 个 bug：

| Bug | 严重程度 | 描述 |
|-----|----------|------|
| #1 | **关键** | `Video.commentCount` 从未更新，前端显示 0 |
| #2 | 次要 | `notifyNewComments` 函数不存在，企微通知失效 |
| #3 | 次要 | 不同 API 端点使用不同计数来源 |
| #4 | 极小 | `getCrawlMode` 与 `getCrawlConfig` 默认值不一致 |

---

## 2. 设计决策

### 2.1 Bug #1 修复方案

**决策**：在 `monitorService.ts` 的简单模式分支中，Phase3 结束后调用 `db.updateCommentCount()`。

**理由**：
- `newCount` 来自 Phase1 API 的 `comment_count`，是平台返回的实时总评论数
- 即使 Phase3 采集失败，`newCount` 仍然有效
- 保持爬虫层职责单一（只负责采集，不负责更新状态）

### 2.2 Bug #2 修复方案

**决策**：让 `processCommentsQueueSimple` 返回 `commentGroups` 结构，复用现有通知流程。

**理由**：
- 保持通知格式一致
- 自动触发 AI 回复建议生成
- 快速回复功能自动可用

### 2.3 卡片更新限制

**约束**：企业微信 `update_template_card` API 必须在 5 秒内调用，LLM 生成通常需要 10-30+ 秒。

**决策**：保持现有架构——AI 回复通过新卡片展示，而非更新原卡片。

**理由**：
- 5 秒超时限制，无法直接更新
- 新卡片可以包含更丰富的信息（模型、耗时等）
- 用户操作流程更清晰

---

## 3. 详细设计

### 3.1 Bug #1：更新 `Video.commentCount`

**修改文件**：`apps/ts-api-gateway/src/services/monitorService.ts`

**修改位置**：4 个平台的简单模式分支（`runDouyinCheck`、`runKuaishouCheck`、`runXiaohongshuCheck`、`runTencentCheck`）

**修改内容**：

```typescript
// 抖音 (runDouyinCheck) - 第 1079-1087 行
if (isSimpleMode) {
  logger.info({ userId: task.userId, maxRootComments }, '抖音 Simple 模式 — 仅采集根评论');
  await dy.processCommentsQueueSimple(page, queue, maxRootComments);
  // 新增：Phase3 结束后更新 Video.commentCount
  for (const q of queue) {
    await db.updateCommentCount(q.awemeId, q.newCount);
  }
  phase3Result = { results: queue.map(q => ({ awemeId: q.awemeId, success: true })) };
}

// 快手 (runKuaishouCheck) - 类似修改，使用 q.awemeId
// 小红书 (runXiaohongshuCheck) - 类似修改，使用 q.exportId（非 awemeId）
// 视频号 (runTencentCheck) - 类似修改，使用 q.exportId（非 awemeId）
```

**⚠️ 字段名注意事项**：
- 抖音/快手：使用 `q.awemeId`
- 小红书/视频号：使用 `q.exportId`

**数据流**：
```
Phase1: checkForUpdates()
  └─ API 响应: video.comment_count (实时总评论数)
  └─ 输出: CommentQueueItem.newCount = API 的 comment_count

Phase3: processCommentsQueueSimple()
  └─ 仅采集根评论内容
  └─ 返回 commentGroups 结构

Phase3 后: monitorService.ts
  └─ db.updateCommentCount(awemeId, newCount) ✅ 新增
```

### 3.2 Bug #2：简单模式通知

**修改文件**：
- `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`
- `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`
- `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`
- `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`
- `apps/ts-api-gateway/src/services/monitorService.ts`

**修改内容**：

#### 3.2.1 修改 `processCommentsQueueSimple` 返回值

**⚠️ 关键：`commentGroups` 格式必须与 unifiedQueue 兼容**

unifiedQueue.ts:329-364 期望的格式：
```typescript
{
  rootComment: CommentNode,     // 完整 CommentNode 对象
  subReplies: CommentNode[],    // 子回复列表
  newInGroup: CommentNode[],    // 新增评论（CommentNode 数组）
}
```

```typescript
// douyinCrawler.ts - processCommentsQueueSimple
async processCommentsQueueSimple(
  page: Page,
  queue: CommentQueueItem[],
  maxRootComments: number
): Promise<{ results: Array<{ awemeId: string; success: boolean; commentGroups?: any[]; error?: string }> }> {
  const results = [];
  
  for (const item of queue) {
    try {
      // ... 现有采集逻辑 ...
      
      // 构建 commentGroups 结构（与 unifiedQueue 兼容）
      const commentGroups = newComments.map(comment => ({
        rootComment: {
          cid: comment.cid,
          text: comment.text || '',
          userNickname: comment.userNickname || '',
          userUid: comment.userUid || '',
          createTime: comment.createTime || 0,
          diggCount: comment.diggCount || 0,
          level: 1 as const,
          replyId: '0',
          isAuthor: false,
          subComments: [],
          imageUrls: comment.imageUrls,
        },
        subReplies: [], // 简单模式无子回复
        newInGroup: [   // 注意：字段名为 newInGroup，不是 newCids
          {
            cid: comment.cid,
            text: comment.text || '',
            userNickname: comment.userNickname || '',
            userUid: comment.userUid || '',
            createTime: comment.createTime || 0,
            diggCount: comment.diggCount || 0,
            level: 1 as const,
            replyId: '0',
            isAuthor: false,
            subComments: [],
            imageUrls: comment.imageUrls,
          }
        ],
      }));
      
      results.push({ awemeId: item.awemeId, success: true, commentGroups });
    } catch (err) {
      results.push({ awemeId: item.awemeId, success: false, error: (err as Error).message });
    }
  }
  
  return { results };
}
```

#### 3.2.2 调整卡片内容

**修改位置**：`monitorService.ts` 的 `sendMonitorNotification` 函数

```typescript
// 根据模式调整卡片内容
const isSimpleMode = crawlConfig.mode === 'simple';

// 主标题
main_title: {
  title: `「${videoDescription}」`,
  desc: `${platformInfo.label} · ${newCount} 条新评论${isSimpleMode ? '（简单模式）' : ''}`,
},

// 重点内容
emphasis_content: {
  title: `${newCount}`,
  desc: '条新评论',
},

// 副标题（简单模式无子回复）
sub_title_text: isSimpleMode
  ? `${commentGroups.map(g => g.rootComment.userNickname).join('、')} 发表了新评论`
  : `${newCommentNames.join('、')} 等发表了新评论（⭐=新增）`,

// 评论树（简单模式仅根评论）
quote_area: {
  type: 0,
  title: isSimpleMode ? '💬 新评论' : '💬 评论树（⭐=新增）',
  quote_text: formatCommentTree(commentGroups, isSimpleMode),
},
```

#### 3.2.3 评论树格式化调整

```typescript
function formatCommentTree(commentGroups: any[], isSimpleMode: boolean): string {
  return commentGroups.map(group => {
    const root = group.rootComment;
    const prefix = root.isNew === 1 ? '⭐ ' : '';
    const timeAgo = formatTimeAgo(root.createTime);
    const images = root.imageUrls ? ' 📷' : '';
    
    if (isSimpleMode) {
      // 简单模式：仅根评论，无子回复
      return `${prefix}${root.userNickname}: ${root.text}${images} (${timeAgo})`;
    }
    
    // 深度模式：包含子回复
    let tree = `${prefix}${root.userNickname}: ${root.text}${images} (${timeAgo})`;
    for (const reply of group.subReplies) {
      const replyPrefix = reply.isNew === 1 ? '  ⭐ ' : '  └ ';
      const replyImages = reply.imageUrls ? ' 📷' : '';
      tree += `\n${replyPrefix}${reply.userNickname}: 回复 ${reply.replyToName}: ${reply.text}${replyImages}`;
    }
    return tree;
  }).join('\n');
}
```

### 3.3 Bug #3：统一计数来源

**修改文件**：`apps/ts-api-gateway/src/routes/matrix.ts`

**修改内容**：统一使用 `Comment` 表聚合计数，而非 `Video.commentCount` 字段。

**需要修改的端点**：

| 端点 | 行号 | 当前来源 | 修改为 |
|------|------|----------|--------|
| `GET /monitor/accounts` | 664 | `prisma.video.aggregate({ _sum: { commentCount: true } })` | `prisma.comment.count()` |
| `GET /monitor/accounts/:userId` | 1119 | `v.commentCount` | `v._count.comments`（已有查询，零额外开销） |
| `GET /monitor/videos` | 802 | `v.commentCount` | `prisma.comment.count()` |

```typescript
// matrix.ts - accounts/:userId 端点 (line 1119)
// 原代码：commentCount: v.commentCount
// 修改为：commentCount: v._count?.comments ?? 0

// matrix.ts - accounts 端点 (line 664)
// 原代码：prisma.video.aggregate({ _sum: { commentCount: true } })
// 修改为：prisma.comment.count()

// matrix.ts - videos 端点 (line 802)
// 原代码：commentCount: v.commentCount
// 修改为：commentCount: await prisma.comment.count({ where: { videoId: v.id } })
```

### 3.4 Bug #4：统一默认值

**修改文件**：
- `apps/ts-api-gateway/src/routes/config-automation.ts`
- `apps/ts-api-gateway/src/routes/matrix.ts`

**修改内容**：
1. 将 `getCrawlMode` 的默认值从 `'deep'` 改为 `'simple'`，与 `getCrawlConfig` 一致。
2. matrix.ts 第 1707 行 `GET /monitor/crawl-settings` 端点也硬编码了 `'deep'`，需同步修改为 `'simple'`。

```typescript
// config-automation.ts - getCrawlMode (line 503)
// 原代码：return 'deep'
// 修改为：return 'simple'

// matrix.ts - GET /monitor/crawl-settings (line 1707)
// 原代码：mode: s.mode || 'deep'
// 修改为：mode: s.mode || 'simple'
```

---

## 4. 测试验证

### 4.1 单元测试

- [ ] `db.updateCommentCount()` 被调用，`Video.commentCount` 正确更新
- [ ] `processCommentsQueueSimple` 返回 `commentGroups` 结构
- [ ] 卡片内容根据 `isSimpleMode` 正确调整
- [ ] 评论树格式化正确（简单模式无子回复）

### 4.2 集成测试

- [ ] 简单模式采集后，前端显示正确的评论数
- [ ] 企业微信通知正常发送，包含评论内容
- [ ] AI 回复建议自动生成
- [ ] 快速回复功能正常工作

### 4.3 端到端测试

- [ ] 简单模式完整流程：采集 → 更新计数 → 发送通知 → AI 回复 → 快速回复
- [ ] 深度模式不受影响
- [ ] 4 个平台（抖音、快手、小红书、视频号）都正常工作

---

## 5. 文件清单

| 文件 | 修改类型 | 说明 |
|------|----------|------|
| `apps/ts-api-gateway/src/services/monitorService.ts` | 修改 | 添加 `db.updateCommentCount()` 调用 + 卡片内容调整 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 修改 | `processCommentsQueueSimple` 返回 `commentGroups` |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 修改 | 同上 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | 修改 | 同上 |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 修改 | 同上 |
| `apps/ts-api-gateway/src/routes/matrix.ts` | 修改 | 统一计数来源 + 统一默认值 |
| `apps/ts-api-gateway/src/routes/config-automation.ts` | 修改 | 统一默认值 |

---

## 6. 风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Phase3 采集失败 | `newCount` 可能不准确 | `newCount` 来自 Phase1 API，与 Phase3 无关 |
| 卡片更新 5 秒超时 | 无法更新原卡片 | 保持现有架构，使用新卡片展示 AI 回复 |
| 4 个平台修改重复 | 代码冗余 | 抽取公共函数（可选优化） |
| `commentGroups` 格式不兼容 | unifiedQueue 崩溃 | 使用 `newInGroup` (CommentNode[]) 替代 `newCids` (Set) |
| 字段名不一致 | 小红书/视频号报错 | 抖音/快手用 `awemeId`，小红书/视频号用 `exportId` |

---

## 7. 已知问题（不在本次范围内）

- [ ] 视频号深度模式也缺失 `updateCommentCount` 调用（与简单模式相同的 bug，需单独修复）
