# 简单模式评论数更新和通知修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复简单模式下评论数显示为 0、企微通知失效、计数来源不一致、默认值不统一的 4 个 bug

**架构：** 在 monitorService.ts 的简单模式分支中添加 db.updateCommentCount() 调用；让 processCommentsQueueSimple 返回与 unifiedQueue 兼容的 commentGroups 结构；统一 matrix.ts 的计数来源和默认值

**技术栈：** TypeScript, Prisma, Playwright, 企业微信 SDK

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `apps/ts-api-gateway/src/services/monitorService.ts` | 监控服务主逻辑，简单模式分支调用 updateCommentCount + 卡片内容调整 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 抖音爬虫，processCommentsQueueSimple 返回 commentGroups |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 快手爬虫，同上 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | 小红书爬虫，同上 |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 视频号爬虫，同上 |
| `apps/ts-api-gateway/src/routes/matrix.ts` | API 端点，统一计数来源和默认值 |
| `apps/ts-api-gateway/src/routes/config-automation.ts` | 配置自动化，统一 getCrawlMode 默认值 |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 数据库服务，updateCommentCount 函数 |
| `apps/ts-api-gateway/src/services/unifiedQueue.ts` | 统一队列，commentGroups 消费方 |

---

## 任务 1：修改抖音爬虫 processCommentsQueueSimple 返回 commentGroups

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

- [ ] **步骤 1：读取 processCommentsQueueSimple 当前实现**

读取 `douyinCrawler.ts` 中 `processCommentsQueueSimple` 函数的完整实现，了解当前返回值结构。

- [ ] **步骤 2：修改返回值结构**

将 `processCommentsQueueSimple` 的返回值从 `void` 改为包含 `commentGroups` 的结构：

```typescript
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
        subReplies: [],
        newInGroup: [
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

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "douyinCrawler" | head -20
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "fix: douyin processCommentsQueueSimple returns commentGroups for simple mode"
```

---

## 任务 2：修改快手爬虫 processCommentsQueueSimple 返回 commentGroups

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`

- [ ] **步骤 1：读取 processCommentsQueueSimple 当前实现**

读取 `kuaishouCrawler.ts` 中 `processCommentsQueueSimple` 函数的完整实现。

- [ ] **步骤 2：修改返回值结构**

与任务 1 相同的 commentGroups 结构，注意快手使用 `q.awemeId`。

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "kuaishouCrawler" | head -20
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "fix: kuaishou processCommentsQueueSimple returns commentGroups for simple mode"
```

---

## 任务 3：修改小红书爬虫 processCommentsQueueSimple 返回 commentGroups

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`

- [ ] **步骤 1：读取 processCommentsQueueSimple 当前实现**

读取 `xiaohongshuCrawler.ts` 中 `processCommentsQueueSimple` 函数的完整实现。

- [ ] **步骤 2：修改返回值结构**

与任务 1 相同的 commentGroups 结构，注意小红书使用 `q.exportId`（非 awemeId）。

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "xiaohongshuCrawler" | head -20
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "fix: xiaohongshu processCommentsQueueSimple returns commentGroups for simple mode"
```

---

## 任务 4：修改视频号爬虫 processCommentsQueueSimple 返回 commentGroups

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`

- [ ] **步骤 1：读取 processCommentsQueueSimple 当前实现**

读取 `tencentCrawler.ts` 中 `processCommentsQueueSimple` 函数的完整实现。

- [ ] **步骤 2：修改返回值结构**

与任务 1 相同的 commentGroups 结构，注意视频号使用 `q.exportId`（非 awemeId）。

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "tencentCrawler" | head -20
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "fix: tencent processCommentsQueueSimple returns commentGroups for simple mode"
```

---

## 任务 5：修改 monitorService.ts 简单模式分支添加 updateCommentCount

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：读取 runDouyinCheck 简单模式分支**

读取 `monitorService.ts` 中 `runDouyinCheck` 函数的简单模式分支（约第 1079-1087 行）。

- [ ] **步骤 2：添加 updateCommentCount 调用**

```typescript
// 抖音简单模式分支
if (isSimpleMode) {
  logger.info({ userId: task.userId, maxRootComments }, '抖音 Simple 模式 — 仅采集根评论');
  await dy.processCommentsQueueSimple(page, queue, maxRootComments);
  // 新增：Phase3 结束后更新 Video.commentCount
  for (const q of queue) {
    await db.updateCommentCount(q.awemeId, q.newCount);
  }
  phase3Result = { results: queue.map(q => ({ awemeId: q.awemeId, success: true })) };
}
```

- [ ] **步骤 3：读取 runKuaishouCheck 简单模式分支**

读取 `monitorService.ts` 中 `runKuaishouCheck` 函数的简单模式分支。

- [ ] **步骤 4：添加 updateCommentCount 调用（快手）**

```typescript
// 快手简单模式分支
if (isSimpleMode) {
  logger.info({ userId: task.userId, maxRootComments }, '快手 Simple 模式 — 仅采集根评论');
  await ks.processCommentsQueueSimple(page, queue, maxRootComments);
  for (const q of queue) {
    await db.updateCommentCount(q.awemeId, q.newCount);
  }
  phase3Result = { results: queue.map(q => ({ awemeId: q.awemeId, success: true })) };
}
```

- [ ] **步骤 5：读取 runXiaohongshuCheck 简单模式分支**

读取 `monitorService.ts` 中 `runXiaohongshuCheck` 函数的简单模式分支。

- [ ] **步骤 6：添加 updateCommentCount 调用（小红书）**

```typescript
// 小红书简单模式分支（注意使用 exportId）
if (isSimpleMode) {
  logger.info({ userId: task.userId, maxRootComments }, '小红书 Simple 模式 — 仅采集根评论');
  await xhs.processCommentsQueueSimple(page, queue, maxRootComments);
  for (const q of queue) {
    await db.updateCommentCount(q.exportId, q.newCount);
  }
  phase3Result = { results: queue.map(q => ({ awemeId: q.exportId, success: true })) };
}
```

- [ ] **步骤 7：读取 runTencentCheck 简单模式分支**

读取 `monitorService.ts` 中 `runTencentCheck` 函数的简单模式分支。

- [ ] **步骤 8：添加 updateCommentCount 调用（视频号）**

```typescript
// 视频号简单模式分支（注意使用 exportId）
if (isSimpleMode) {
  logger.info({ userId: task.userId, maxRootComments }, '视频号 Simple 模式 — 仅采集根评论');
  await tx.processCommentsQueueSimple(page, queue, maxRootComments);
  for (const q of queue) {
    await db.updateCommentCount(q.exportId, q.newCount);
  }
  phase3Result = { results: queue.map(q => ({ awemeId: q.exportId, success: true })) };
}
```

- [ ] **步骤 9：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "monitorService" | head -20
```

- [ ] **步骤 10：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "fix: add updateCommentCount for simple mode in all platforms"
```

---

## 任务 6：修改 monitorService.ts 卡片内容调整

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：读取 sendMonitorNotification 函数**

读取 `monitorService.ts` 中 `sendMonitorNotification` 函数，找到卡片构建逻辑。

- [ ] **步骤 2：添加 isSimpleMode 判断**

在卡片构建逻辑中添加简单模式判断：

```typescript
const isSimpleMode = crawlConfig.mode === 'simple';
```

- [ ] **步骤 3：调整卡片内容**

```typescript
// 主标题
main_title: {
  title: `「${videoDescription}」`,
  desc: `${platformInfo.label} · ${newCount} 条新评论${isSimpleMode ? '（简单模式）' : ''}`,
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

- [ ] **步骤 4：修改 formatCommentTree 函数**

```typescript
function formatCommentTree(commentGroups: any[], isSimpleMode: boolean): string {
  return commentGroups.map(group => {
    const root = group.rootComment;
    const prefix = root.level === 1 ? '⭐ ' : '';
    const timeAgo = formatTimeAgo(root.createTime);
    const images = root.imageUrls ? ' 📷' : '';
    
    if (isSimpleMode) {
      return `${prefix}${root.userNickname}: ${root.text}${images} (${timeAgo})`;
    }
    
    let tree = `${prefix}${root.userNickname}: ${root.text}${images} (${timeAgo})`;
    for (const reply of group.subReplies) {
      const replyPrefix = reply.level === 1 ? '  ⭐ ' : '  └ ';
      const replyImages = reply.imageUrls ? ' 📷' : '';
      tree += `\n${replyPrefix}${reply.userNickname}: 回复 ${reply.replyToName}: ${reply.text}${replyImages}`;
    }
    return tree;
  }).join('\n');
}
```

- [ ] **步骤 5：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "monitorService" | head -20
```

- [ ] **步骤 6：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "fix: adjust card content for simple mode notifications"
```

---

## 任务 7：修改 matrix.ts 统一计数来源

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts`

- [ ] **步骤 1：读取 accounts 端点**

读取 `matrix.ts` 中 `GET /monitor/accounts` 端点（约第 664 行），找到计数逻辑。

- [ ] **步骤 2：修改 accounts 端点计数来源**

```typescript
// 原代码：prisma.video.aggregate({ _sum: { commentCount: true } })
// 修改为：
const totalComments = await prisma.comment.count();
```

- [ ] **步骤 3：读取 accounts/:userId 端点**

读取 `matrix.ts` 中 `GET /monitor/accounts/:userId` 端点（约第 1119 行），找到计数逻辑。

- [ ] **步骤 4：修改 accounts/:userId 端点计数来源**

```typescript
// 原代码：commentCount: v.commentCount
// 修改为：commentCount: v._count?.comments ?? 0
```

- [ ] **步骤 5：读取 videos 端点**

读取 `matrix.ts` 中 `GET /monitor/videos` 端点（约第 802 行），找到计数逻辑。

- [ ] **步骤 6：修改 videos 端点计数来源**

```typescript
// 原代码：commentCount: v.commentCount
// 修改为：
const commentCount = await prisma.comment.count({ where: { videoId: v.id } });
```

- [ ] **步骤 7：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -i "matrix" | head -20
```

- [ ] **步骤 8：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "fix: unify comment count source to use Comment table aggregation"
```

---

## 任务 8：修改 matrix.ts 和 config-automation.ts 统一默认值

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts`
- 修改：`apps/ts-api-gateway/src/routes/config-automation.ts`

- [ ] **步骤 1：读取 matrix.ts crawl-settings 端点**

读取 `matrix.ts` 中 `GET /monitor/crawl-settings` 端点（约第 1707 行），找到默认值逻辑。

- [ ] **步骤 2：修改 matrix.ts 默认值**

```typescript
// 原代码：mode: s.mode || 'deep'
// 修改为：mode: s.mode || 'simple'
```

- [ ] **步骤 3：读取 config-automation.ts getCrawlMode 函数**

读取 `config-automation.ts` 中 `getCrawlMode` 函数（约第 503 行），找到默认值逻辑。

- [ ] **步骤 4：修改 getCrawlMode 默认值**

```typescript
// 原代码：return 'deep'
// 修改为：return 'simple'
```

- [ ] **步骤 5：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit 2>&1 | grep -iE "matrix|config-automation" | head -20
```

- [ ] **步骤 6：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts apps/ts-api-gateway/src/routes/config-automation.ts
git commit -m "fix: unify default crawl mode to 'simple'"
```

---

## 任务 9：Docker 重建和集成测试

**文件：**
- 无代码修改

- [ ] **步骤 1：重建 Docker 容器**

```bash
cd /home/lrp/social_media_complete
docker compose build --no-cache ts-api-gateway
```

- [ ] **步骤 2：重启容器**

```bash
docker compose up -d ts-api-gateway
sleep 8
docker logs sm-ts-api 2>&1 | grep -iE "注册浏览器|apiPort|error" | tail -3
```

- [ ] **步骤 3：测试简单模式采集**

在监控页面将某个平台切换为简单模式，触发一次采集，验证：
1. `Video.commentCount` 是否更新
2. 企业微信是否收到通知
3. 通知内容是否包含评论

- [ ] **步骤 4：测试深度模式不受影响**

将平台切换回深度模式，触发一次采集，验证深度模式功能正常。

- [ ] **步骤 5：验证前端显示**

访问监控页面，验证评论数显示正确。

- [ ] **步骤 6：Commit 最终版本**

```bash
git add -A
git commit -m "fix: complete simple mode bugfix - updateCommentCount, notifications, count source, defaults"
```

---

## 自检清单

- [ ] 规格中的所有 4 个 bug 都有对应任务
- [ ] 所有代码步骤都包含完整代码块
- [ ] 字段名注意事项已标注（awemeId vs exportId）
- [ ] commentGroups 格式与 unifiedQueue 兼容（newInGroup 替代 newCids）
- [ ] 测试验证步骤完整
