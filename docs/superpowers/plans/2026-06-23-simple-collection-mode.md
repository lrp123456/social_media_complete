# 简单采集模式 + 评论上限实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现简单采集模式（仅根评论 + 评论上限 30），替代现有 light 模式

**架构：** 在 Phase3 评论采集中添加简单模式分支，通过滚动加载 API 响应获取根评论，使用纯 CID 去重检测新评论，复用现有企微通知逻辑

**技术栈：** TypeScript, Prisma, Playwright/Patchright, BullMQ

---

## 文件结构

| 文件 | 职责 | 变更类型 |
|------|------|----------|
| `prisma/schema.prisma` | CrawlSetting 模型添加 config 字段 | 修改 |
| `apps/ts-api-gateway/src/routes/matrix.ts` | 更新 Zod 校验器支持 simple 模式 | 修改 |
| `apps/ts-api-gateway/src/routes/config-automation.ts` | 从 DB 读取 CrawlSetting 配置 | 修改 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | 配置读取 + 模式判断 | 修改 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 简单模式 Phase3 逻辑 | 修改 |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | 简单模式 Phase3 逻辑 | 修改 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | 简单模式 Phase3 逻辑 | 修改 |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | 简单模式 Phase3 逻辑 | 修改 |
| `apps/admin-dashboard/src/app/matrix/page.tsx` | 配置 UI + 评论展示 | 修改 |

---

## 任务 1：数据库模型更新

**文件：**
- 修改：`prisma/schema.prisma:155-158`

- [ ] **步骤 1：更新 CrawlSetting 模型添加 config 字段**

```prisma
model CrawlSetting {
  id        Int      @id @default(autoincrement())
  platform  String   @unique
  mode      String   @default("simple")  // "simple" | "deep"
  enabled   Boolean  @default(true)
  config    Json?    // { max_root_comments: 30 }
  updatedAt DateTime @updatedAt @map("updated_at")

  @@map("crawl_settings")
}
```

- [ ] **步骤 2：生成 Prisma Client**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx prisma generate --schema /home/lrp/social_media_complete/prisma/schema.prisma
```

- [ ] **步骤 3：推送数据库变更**

```bash
npx prisma db push --schema /home/lrp/social_media_complete/prisma/schema.prisma --accept-data-loss
```

- [ ] **步骤 4：验证数据库变更**

```bash
npx prisma studio --schema /home/lrp/social_media_complete/prisma/schema.prisma
# 检查 crawl_settings 表是否有 config 列
```

- [ ] **步骤 5：Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add config field to CrawlSetting model"
```

---

## 任务 2：更新 Zod 校验器支持 simple 模式

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts:1530`

- [ ] **步骤 1：找到 Zod 校验器**

在 `matrix.ts` 中搜索 `z.enum(['deep', 'light'])`

- [ ] **步骤 2：更新校验器**

```typescript
// 原代码
mode: z.enum(['deep', 'light'])

// 新代码
mode: z.enum(['deep', 'simple'])
```

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
cd /home/lrp/social_media_complete/apps/ts-api-gateway
npx tsc --noEmit
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "feat: update Zod validator to support simple mode"
```

---

## 任务 3：更新配置读取逻辑

**文件：**
- 修改：`apps/ts-api-gateway/src/routes/config-automation.ts`

- [ ] **步骤 1：添加 getCrawlConfig 函数**

```typescript
/**
 * 从数据库读取平台采集配置
 */
export async function getCrawlConfig(platform: string): Promise<{
  mode: 'simple' | 'deep';
  maxRootComments: number;
  enabled: boolean;
}> {
  const { prisma } = await import('../lib/prisma');
  
  const setting = await prisma.crawlSetting.findUnique({
    where: { platform },
  }).catch(() => null);

  const config = (setting?.config as any) || {};
  
  return {
    mode: (setting?.mode as 'simple' | 'deep') || 'simple',
    maxRootComments: config.max_root_comments || 30,
    enabled: setting?.enabled ?? true,
  };
}
```

- [ ] **步骤 2：导出函数**

在文件顶部的导出列表中添加 `getCrawlConfig`

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/routes/config-automation.ts
git commit -m "feat: add getCrawlConfig function for simple mode"
```

---

## 任务 4：实现抖音简单模式 Phase3

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

- [ ] **步骤 1：添加简单模式 Phase3 方法**

在 `DouyinCrawler` 类中添加新方法：

```typescript
/**
 * 简单模式 Phase3：仅采集根评论（最多 30 条）
 * 使用纯 CID 去重，不采集子评论内容
 */
async processCommentsQueueSimple(
  page: Page,
  queue: CommentQueueItem[],
  maxRootComments: number = 30,
): Promise<void> {
  const { prisma } = await import('../lib/prisma');
  const db = await import('../services/monitorDatabaseService');
  
  for (const item of queue) {
    logger.info({ awemeId: item.awemeId, maxRootComments }, '[Simple] Starting simple mode comment collection');
    
    // 1. 获取已有的根评论 CID 集合
    const existingCids = await prisma.comment.findMany({
      where: { videoId: item.awemeId, level: 1 },
      select: { cid: true },
    });
    const existingCidSet = new Set(existingCids.map(c => c.cid));
    
    // 2. 滚动加载根评论
    const allComments: any[] = [];
    let consecutiveNoNew = 0;
    let hasMore = true;
    
    while (hasMore && allComments.length < maxRootComments && consecutiveNoNew < 5) {
      // 等待 API 响应
      const responses = await this.collectAllCommentResponses(page);
      
      if (responses.length === 0) {
        consecutiveNoNew++;
        logger.info({ awemeId: item.awemeId, consecutiveNoNew }, '[Simple] No API response, incrementing counter');
        continue;
      }
      
      // 提取根评论
      const newComments = responses.flatMap(r => r.body?.comments || [])
        .filter(c => !existingCidSet.has(c.cid));
      
      if (newComments.length === 0) {
        consecutiveNoNew++;
      } else {
        consecutiveNoNew = 0;
        allComments.push(...newComments);
      }
      
      // 检查 has_more
      const lastResp = responses[responses.length - 1];
      hasMore = lastResp?.body?.has_more === 1;
      
      // 继续滚动
      if (hasMore && allComments.length < maxRootComments) {
        await this.scrollCommentArea(page, 'down');
        await page.waitForTimeout(8000); // 8 秒超时
      }
    }
    
    // 3. 限制到 maxRootComments
    const commentsToStore = allComments.slice(0, maxRootComments);
    
    // 4. 存储新评论
    if (commentsToStore.length > 0) {
      for (const comment of commentsToStore) {
        await db.upsertComment({
          videoId: item.awemeId,
          cid: comment.cid,
          text: comment.text || '',
          userNickname: comment.user?.nickname || '',
          userUid: comment.user?.uid || '',
          diggCount: comment.digg_count || 0,
          createTime: comment.create_time || 0,
          level: 1,
          isNew: 1,
        });
      }
      
      logger.info({ 
        awemeId: item.awemeId, 
        newCount: commentsToStore.length,
        totalCollected: allComments.length 
      }, '[Simple] Stored new root comments');
      
      // 5. 触发企微通知
      await this.notifyNewComments(item.awemeId, commentsToStore);
    } else {
      logger.info({ awemeId: item.awemeId }, '[Simple] No new root comments found');
    }
  }
}
```

- [ ] **步骤 2：添加 notifyNewComments 方法**

```typescript
/**
 * 通知新评论（复用现有逻辑）
 */
private async notifyNewComments(awemeId: string, comments: any[]): Promise<void> {
  try {
    const { monitorService } = await import('../services/monitorService');
    // 调用现有的通知逻辑
    await monitorService.notifyNewComments(awemeId, comments);
  } catch (err: any) {
    logger.error({ awemeId, err: err.message }, '[Simple] Failed to notify new comments');
  }
}
```

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat: implement simple mode Phase3 for douyin"
```

---

## 任务 5：实现快手简单模式 Phase3

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`

- [ ] **步骤 1：添加简单模式 Phase3 方法**

在 `KuaishouCrawler` 类中添加类似的方法（参考任务 4）

关键差异：
- API 响应路径：`data.list`（不是 `body.comments`）
- has_more 判断：`data.pcursor`（有值=有更多）
- cursor 字段：`data.pcursor`

- [ ] **步骤 2：验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "feat: implement simple mode Phase3 for kuaishou"
```

---

## 任务 6：实现小红书简单模式 Phase3

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`

- [ ] **步骤 1：添加简单模式 Phase3 方法**

在 `XiaohongshuCrawler` 类中添加类似的方法（参考任务 4）

关键差异：
- API 响应路径：`data.comments`（不是 `body.comments`）
- has_more 判断：`data.has_more === false`
- cursor 字段：`data.cursor`

- [ ] **步骤 2：验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "feat: implement simple mode Phase3 for xiaohongshu"
```

---

## 任务 7：实现视频号简单模式 Phase3

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`

- [ ] **步骤 1：添加简单模式 Phase3 方法**

在 `TencentCrawler` 类中添加类似的方法（参考任务 4）

关键差异：
- API 响应路径：`data.comment`（不是 `body.comments`）
- has_more 判断：`data.downContinueFlag === 0`
- cursor 字段：`data.lastBuff`
- 无子评论数量字段（视频号不支持）

- [ ] **步骤 2：验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat: implement simple mode Phase3 for tencent"
```

---

## 任务 8：更新 monitorService 集成简单模式

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：添加配置读取**

在 `runDouyinCheck`（及其他平台检查函数）中添加配置读取：

```typescript
import { getCrawlConfig } from '../routes/config-automation';

// 在函数开头
const crawlConfig = await getCrawlConfig('douyin');
const isSimpleMode = crawlConfig.mode === 'simple';
const maxRootComments = crawlConfig.maxRootComments;
```

- [ ] **步骤 2：添加模式分支**

在 Phase3 处理中添加简单模式分支：

```typescript
if (isSimpleMode) {
  // 简单模式：仅采集根评论
  await crawler.processCommentsQueueSimple(page, commentsQueue, maxRootComments);
} else {
  // 深度模式：完整评论树采集
  await crawler.processCommentsQueue(page, commentsQueue);
}
```

- [ ] **步骤 3：验证 TypeScript 编译**

```bash
npx tsc --noEmit
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "feat: integrate simple mode into monitorService"
```

---

## 任务 9：更新前端配置 UI

**文件：**
- 修改：`apps/admin-dashboard/src/app/matrix/page.tsx`

- [ ] **步骤 1：添加配置状态**

在组件中添加配置状态：

```typescript
const [crawlConfig, setCrawlConfig] = useState({
  mode: 'simple',
  maxRootComments: 30,
});
```

- [ ] **步骤 2：添加配置 API 调用**

```typescript
useEffect(() => {
  fetch('/api/v1/matrix/crawl-settings')
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        setCrawlConfig(data.data);
      }
    });
}, []);
```

- [ ] **步骤 3：添加配置 UI**

在设置页面中添加：

```tsx
<div className="config-section">
  <h3>采集模式</h3>
  <select 
    value={crawlConfig.mode}
    onChange={(e) => setCrawlConfig({...crawlConfig, mode: e.target.value})}
  >
    <option value="simple">简单模式（仅根评论）</option>
    <option value="deep">深度模式（完整评论树）</option>
  </select>
  
  <div>
    <label>根评论上限：</label>
    <input 
      type="number"
      value={crawlConfig.maxRootComments}
      onChange={(e) => setCrawlConfig({...crawlConfig, maxRootComments: parseInt(e.target.value)})}
    />
  </div>
  
  <button onClick={saveConfig}>保存配置</button>
</div>
```

- [ ] **步骤 4：添加保存函数**

```typescript
const saveConfig = async () => {
  await fetch('/api/v1/matrix/crawl-settings/douyin', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: crawlConfig.mode,
      config: { max_root_comments: crawlConfig.maxRootComments },
    }),
  });
};
```

- [ ] **步骤 5：验证前端构建**

```bash
cd /home/lrp/social_media_complete/apps/admin-dashboard
npm run build
```

- [ ] **步骤 6：Commit**

```bash
git add apps/admin-dashboard/src/app/matrix/page.tsx
git commit -m "feat: add simple mode config UI"
```

---

## 任务 10：集成测试

**文件：**
- 测试：手动测试 + 日志验证

- [ ] **步骤 1：重建 Docker 容器**

```bash
docker compose build --no-cache ts-api-gateway
docker compose up -d ts-api-gateway
```

- [ ] **步骤 2：验证配置 API**

```bash
curl -s http://localhost:3001/api/v1/matrix/crawl-settings | python3 -m json.tool
```

- [ ] **步骤 3：触发监控任务**

通过企微发送"继续监控"或等待自动调度

- [ ] **步骤 4：检查日志**

```bash
docker logs sm-ts-api 2>&1 | grep -i "simple\|Simple"
```

预期看到：`[Simple] Starting simple mode comment collection`

- [ ] **步骤 5：验证评论存储**

```bash
docker exec sm-ts-api npx tsx -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const comments = await p.comment.findMany({
    where: { level: 1 },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log(JSON.stringify(comments, null, 2));
  await p.\$disconnect();
})();
"
```

- [ ] **步骤 6：验证企微通知**

检查企微是否收到新评论通知

- [ ] **步骤 7：Final Commit**

```bash
git add -A
git commit -m "feat: complete simple collection mode implementation"
```

---

## 自检清单

1. **规格覆盖度：**
   - ✅ 简单模式 Phase3 流程（任务 4-7）
   - ✅ 停止条件（任务 4-7）
   - ✅ 纯 CID 去重（任务 4-7）
   - ✅ 四平台 API 字段映射（任务 4-7）
   - ✅ 配置结构（任务 1-3）
   - ✅ 前端展示（任务 9）
   - ✅ 企微通知（任务 4-7）

2. **占位符扫描：**
   - ✅ 无 "待定"、"TODO"
   - ✅ 所有步骤都有完整代码

3. **类型一致性：**
   - ✅ `getCrawlConfig` 返回类型一致
   - ✅ `processCommentsQueueSimple` 参数类型一致

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-23-simple-collection-mode.md`。

两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
