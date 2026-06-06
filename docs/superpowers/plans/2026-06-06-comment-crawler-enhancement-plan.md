# 评论爬虫增强 + 企业微信通知/回复 — 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 增强抖音 Phase 3 评论管道，支持 DOM 展开子回复、完整评论树存储、企业微信模板卡片通知、按钮触发一键回复、修复退出策略侧边栏滚动。

**架构：** 在现有 `douyinCrawler.ts` Phase 3 中插入 DOM 展开层（`expandAllReplies`），增强 Comment 模型支持层级字段，复用现有 HumanActions CDP、selectorStore 热更新、BullMQ 调度管道。企微通知从纯 markdown 升级为 `text_notice` 模板卡片 + `button_interaction` 回复交互。

**技术栈：** TypeScript (Node.js), Prisma ORM, BullMQ, @wecom/aibot-node-sdk, Patchright/CDP, selectors.json 外部化配置

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `prisma/schema.prisma` | Comment 新增层级字段 + VideoRootCommentCount 新模型 |
| `apps/ts-api-gateway/data/selectors.json` | 评论展开/回复相关选择器（热更新） |
| `apps/ts-api-gateway/src/crawlers/menuSelectors.ts` | 新选择器 key → SelectorReader 桥接映射 |
| `apps/ts-api-gateway/src/crawlers/menuNavigator.ts` | scrollIntoView 扩展至 douyin |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | Phase 3 增强：expandAllReplies + parseCommentTree |
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 评论树 upsert、VideoRootCommentCount CRUD、回复执行 |
| `apps/ts-api-gateway/src/services/monitorService.ts` | sendMonitorNotification 改用模板卡片 |
| `apps/ts-api-gateway/src/services/wechatBotService.ts` | 待回复上下文管理 + 回复流程消息处理器 |

---

### 任务 1：数据库迁移

**文件：**
- 修改：`prisma/schema.prisma:52-70`
- 创建：Prisma migration 文件（自动生成）

- [ ] **步骤 1：修改 Comment 模型，新增层级字段**

在 Comment 模型中添加 rootId / parentId / level / replyToName 字段：

```prisma
model Comment {
  id           Int      @id @default(autoincrement())
  videoId      String   @map("video_id")
  cid          String   @unique
  text         String   @default("")
  userNickname String   @default("") @map("user_nickname")
  userUid      String   @default("") @map("user_uid")
  diggCount    Int      @default(0) @map("digg_count")
  createTime   BigInt   @map("create_time")
  replyId      String   @default("0") @map("reply_id")
  isNew        Int      @default(1) @map("is_new")
  rootId       String?  @map("root_id")       // 新增：根评论 cid
  parentId     String?  @map("parent_id")     // 新增：直接父评论 cid
  level        Int      @default(1) @map("level")  // 新增：1=根, 2=子回复
  replyToName  String?  @map("reply_to_name") // 新增：被回复用户昵称
  createdAt    DateTime @default(now()) @map("created_at")

  video Video @relation(fields: [videoId], references: [id], onDelete: Cascade)

  @@index([videoId], name: "idx_comments_video_id")
  @@index([cid], name: "idx_comments_cid")
  @@index([videoId, rootId], name: "idx_comments_video_root")  // 新增：按视频+根评论查询
  @@map("comments")
}
```

- [ ] **步骤 2：新增 VideoRootCommentCount 模型**

在 schema.prisma 的 Comment 模型之后添加：

```prisma
model VideoRootCommentCount {
  id         String   @id @default(uuid())
  videoId    String   @map("video_id")
  cid        String
  replyCount Int      @default(0) @map("reply_count")
  updatedAt  DateTime @updatedAt @map("updated_at")

  @@unique([videoId, cid])
  @@index([videoId])
  @@map("video_root_comment_counts")
}
```

- [ ] **步骤 3：生成并运行 Prisma migration**

```bash
cd /home/lrp/social_media_complete && npx prisma migrate dev --name add_comment_hierarchy
```

预期输出：migration 文件创建成功，数据库迁移成功。

- [ ] **步骤 4：Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add comment hierarchy fields and VideoRootCommentCount model"
```

---

### 任务 2：选择器配置（selectors.json + 桥接）

**文件：**
- 修改：`apps/ts-api-gateway/data/selectors.json`
- 修改：`apps/ts-api-gateway/src/crawlers/menuSelectors.ts`

- [ ] **步骤 1：在 selectors.json 中添加评论相关选择器**

在 `douyin.buttons` 中添加 `btn_expand_replies`、`btn_reply_comment`、`btn_reply_submit`；在 `douyin.regions` 中添加 `region_reply_list`、`region_comment_container`、`region_reply_input`、`region_sidebar_scroll`。

首先读取当前 selectors.json 末尾的 douyin 段以确定插入位置：

```bash
cd /home/lrp/social_media_complete && python3 -c "
import json
with open('apps/ts-api-gateway/data/selectors.json') as f:
    cfg = json.load(f)
# 在现有 douyin.buttons 中找到最后一个按钮
existing_btns = list(cfg['platforms']['douyin']['buttons'].keys())
existing_regions = list(cfg['platforms']['douyin']['regions'].keys())
print('Last buttons:', existing_btns[-3:] if len(existing_btns) > 3 else existing_btns)
print('Last regions:', existing_regions[-3:] if len(existing_regions) > 3 else existing_regions)
print('Total buttons:', len(existing_btns))
print('Total regions:', len(existing_regions))
"
```

然后手动在 `douyin.buttons` 末尾添加：

```json
"btn_expand_replies": {
  "purposes": ["monitor"],
  "primary": "text=/查看\\d+条回复/",
  "fallbacks": ["text=/展开/", "[class*='expand-reply']"],
  "selectorType": "text",
  "description": "抖音评论区--展开子回复按钮"
},
"btn_reply_comment": {
  "purposes": ["monitor"],
  "primary": "text=回复",
  "fallbacks": ["[class*='reply-btn']"],
  "selectorType": "text",
  "description": "抖音评论区--回复按钮"
},
"btn_reply_submit": {
  "purposes": ["monitor"],
  "primary": "[class*='submit-btn']",
  "fallbacks": ["button[class*='submit']", "div[class*='submit']"],
  "selectorType": "css",
  "description": "抖音评论区--回复发送按钮"
}
```

在 `douyin.regions` 末尾添加：

```json
"region_reply_list": {
  "purposes": ["monitor"],
  "primary": "[class*='reply-list']",
  "selectorType": "css",
  "description": "抖音评论区--子回复列表容器"
},
"region_comment_container": {
  "purposes": ["monitor"],
  "primary": "[class*='container-sXKyMs']",
  "selectorType": "css",
  "description": "抖音评论区--评论容器"
},
"region_reply_input": {
  "purposes": ["monitor"],
  "primary": "div[contenteditable=\"true\"]",
  "selectorType": "css",
  "description": "抖音评论区--回复输入框"
},
"region_sidebar_scroll": {
  "purposes": ["monitor", "publish"],
  "primary": ".douyin-creator-master-navigation-list",
  "fallbacks": ["[class*='navigation-list']"],
  "selectorType": "css",
  "description": "抖音侧边栏滚动容器"
}
```

- [ ] **步骤 2：更新 selectors.json 的 updatedAt 时间戳**

```bash
cd /home/lrp/social_media_complete && node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('apps/ts-api-gateway/data/selectors.json','utf8'));
cfg.updatedAt = new Date().toISOString();
fs.writeFileSync('apps/ts-api-gateway/data/selectors.json', JSON.stringify(cfg, null, 2));
console.log('updatedAt:', cfg.updatedAt);
"
```

- [ ] **步骤 3：在 menuSelectors.ts 中添加新选择器桥接映射**

在 `douyin` 对象的 `CRAWLER_KEY_MAP` 末尾（`'region.sidebar': ...` 之后）添加：

```typescript
// 评论展开/回复选择器
'comment.expand-replies': { category: 'buttons', name: 'btn_expand_replies' },
'comment.reply-btn': { category: 'buttons', name: 'btn_reply_comment' },
'comment.reply-submit': { category: 'buttons', name: 'btn_reply_submit' },
'comment.reply-list': { category: 'regions', name: 'region_reply_list' },
'comment.container': { category: 'regions', name: 'region_comment_container' },
'comment.reply-input': { category: 'regions', name: 'region_reply_input' },
'comment.sidebar-scroll': { category: 'regions', name: 'region_sidebar_scroll' },
```

- [ ] **步骤 4：Verify — 确认热更新生效**

```bash
cd /home/lrp/social_media_complete && node -e "
const { getSelectorReader } = require('./apps/ts-api-gateway/src/lib/selectorStore');
const reader = getSelectorReader();
const btn = reader.get('douyin', 'buttons', 'btn_expand_replies');
console.log('Expand button:', btn?.primary);
const region = reader.get('douyin', 'regions', 'region_sidebar_scroll');
console.log('Sidebar scroll:', region?.primary);
"
```

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/data/selectors.json apps/ts-api-gateway/src/crawlers/menuSelectors.ts
git commit -m "feat(selectors): add comment expand/reply and sidebar scroll selectors for douyin"
```

---

### 任务 3：退出策略侧边栏滚动修复

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/menuNavigator.ts:122-191`

- [ ] **步骤 1：修改 tryClickBySelector，将 scrollIntoView 逻辑从仅快手扩展至 douyin**

当前第 164-175 行的 scrollIntoView 块仅在 `scrollIntoView` 为 true 时触发（当前仅快手传 true）。修改为：对 douyin 平台始终启用滚动检测，同时保留显式 `scrollIntoView` flag 逻辑。

替换第 162-176 行区域：

```typescript
  // --- Strategy 3: CSS selector click (fallback — less specific, may hit wrong element) ---
  if (def.css) {
    // 对 douyin/kuaishou 或显式 scrollIntoView，先滚动元素到视口
    const needsScroll = scrollIntoView || platform === 'douyin';
    if (needsScroll) {
      logger.debug({ css: def.css, platform }, 'Scrolling element into view via CDP');
      try {
        const elements = await HumanActions.queryElementsWithInfo(page, def.css);
        if (elements.length > 0) {
          await HumanActions.cdpScrollNodeIntoView(page, elements[0].nodeId);
          await HumanActions.wait(page, 200, 400);
        }
      } catch {
        // Non-critical — cdpClick will handle scrolling if possible
      }
    }

    const cssStart = Date.now();
    const clicked = await HumanActions.cdpClick(page, def.css, { timeout });
    if (clicked) {
      logger.debug({ css: def.css }, 'Clicked via CSS selector');
      reportClickResult(platform, category, name, 'fallback-css', def.css, true, Date.now() - cssStart);
      return true;
    }
    logger.warn({ css: def.css }, 'CSS click failed');
    reportClickResult(platform, category, name, 'fallback-css', def.css, false, Date.now() - cssStart);
  }
```

- [ ] **步骤 2：在 resolveAndClick 中传递 platform 参数**

在 `resolveAndClick` 函数中（第 21 行附近），`tryClickBySelector` 调用时传入 `platform` 参数。当前 `tryClickBySelector` 的调用已经传了 timeout，检查是否需要额外传递 platform。查看现有调用：

```typescript
// 在 resolveAndClick 中的 tryClickBySelector 调用（第 74 行附近）
const expanded = await tryClickBySelector(page, parentDef, {
  timeout: options?.timeout ?? 8000,
});
```

需加上 platform：

```typescript
const expanded = await tryClickBySelector(page, parentDef, {
  timeout: options?.timeout ?? 8000,
  platform,
});
```

同样修改第 88 行和第 101 行的 `tryClickBySelector` 调用，都加上 `platform`。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/menuNavigator.ts
git commit -m "fix(menu): enable scrollIntoView for douyin sidebar menu clicks"
```

---

### 任务 4：数据库服务层新增操作

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorDatabaseService.ts`

- [ ] **步骤 1：新增 `upsertCommentTree` 函数（替代旧 `upsertComment`）**

在现有 `upsertComment` 函数后方添加：

```typescript
import type { CommentNode } from '../crawlers/douyinCrawler';

/**
 * Upsert 评论（含层级字段）— 替代旧的 upsertComment
 */
export async function upsertCommentWithHierarchy(
  videoId: string,
  comment: {
    cid: string;
    text: string;
    user_nickname: string;
    user_uid: string;
    digg_count: number;
    create_time: number;
    reply_id: string;
    rootId?: string;
    parentId?: string;
    level: number;
    replyToName?: string;
  },
): Promise<void> {
  await prisma.comment.upsert({
    where: { cid: comment.cid },
    update: {
      text: comment.text,
      diggCount: comment.digg_count,
      rootId: comment.rootId ?? null,
      parentId: comment.parentId ?? null,
      level: comment.level,
      replyToName: comment.replyToName ?? null,
    },
    create: {
      videoId,
      cid: comment.cid,
      text: comment.text,
      userNickname: comment.user_nickname,
      userUid: comment.user_uid,
      diggCount: comment.digg_count,
      createTime: BigInt(comment.create_time),
      replyId: comment.reply_id,
      rootId: comment.rootId ?? null,
      parentId: comment.parentId ?? null,
      level: comment.level,
      replyToName: comment.replyToName ?? null,
      isNew: 1,
    },
  });
}

/**
 * 批量 upsert 评论树（一个视频的所有评论）
 */
export async function upsertCommentTree(
  videoId: string,
  comments: Array<{
    cid: string;
    text: string;
    user_nickname: string;
    user_uid: string;
    digg_count: number;
    create_time: number;
    reply_id: string;
    rootId?: string;
    parentId?: string;
    level: number;
    replyToName?: string;
  }>,
): Promise<void> {
  if (comments.length === 0) return;
  await prisma.$transaction(
    comments.map((c) => upsertCommentWithHierarchy(videoId, c)),
  );
}
```

- [ ] **步骤 2：新增 VideoRootCommentCount 操作函数**

```typescript
/**
 * 获取视频下所有根评论的回复计数
 */
export async function getRootCommentCounts(
  videoId: string,
): Promise<Map<string, number>> {
  const rows = await prisma.videoRootCommentCount.findMany({
    where: { videoId },
    select: { cid: true, replyCount: true },
  });
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.cid, row.replyCount);
  }
  return map;
}

/**
 * Upsert 单个根评论的回复计数
 */
export async function upsertRootCommentCount(
  videoId: string,
  cid: string,
  replyCount: number,
): Promise<void> {
  await prisma.videoRootCommentCount.upsert({
    where: { videoId_cid: { videoId, cid } },
    update: { replyCount },
    create: { videoId, cid, replyCount },
  });
}

/**
 * 批量更新根评论回复计数
 */
export async function upsertRootCommentCounts(
  videoId: string,
  counts: Array<{ cid: string; replyCount: number }>,
): Promise<void> {
  if (counts.length === 0) return;
  await prisma.$transaction(
    counts.map((c) =>
      prisma.videoRootCommentCount.upsert({
        where: { videoId_cid: { videoId, cid: c.cid } },
        update: { replyCount: c.replyCount },
        create: { videoId, cid: c.cid, replyCount: c.replyCount },
      }),
    ),
  );
}

/**
 * 获取视频所有已有评论的 cid 集合（用于差集增量检测）
 */
export async function getExistingCids(videoId: string): Promise<Set<string>> {
  const rows = await prisma.comment.findMany({
    where: { videoId },
    select: { cid: true },
  });
  return new Set(rows.map((r) => r.cid));
}
```

- [ ] **步骤 3：TypeScript 编译验证**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | head -20
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorDatabaseService.ts
git commit -m "feat(db): add comment hierarchy upsert and VideoRootCommentCount operations"
```

---

### 任务 5：Phase 3 爬虫增强（expandAllReplies + parseCommentTree）

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

这是最大的变更。在当前 `processCommentsQueue` 中，在视频被选中、reactionDelay 之后、`waitForCommentResponse` 之前，插入 DOM 展开步骤。

- [ ] **步骤 1：在 class 顶部定义 CommentNode 接口和新的 import**

在 douyinCrawler.ts 文件开头（约第 6 行 import 区域后），添加：

```typescript
import { getSelector } from './menuSelectors';
```

在 `CommentInfo` 接口（第 24 行）后添加：

```typescript
export interface CommentNode {
  cid: string;
  text: string;
  userNickname: string;
  userUid: string;
  createTime: number;
  diggCount: number;
  level: 1 | 2;
  rootId?: string;
  parentId?: string;
  replyToName?: string;
  replyId: string;
  subComments?: CommentNode[];
}
```

- [ ] **步骤 2：添加 `expandAllReplies` 方法**

在 class 中（约 `detectRiskControlAsync` 之后，约第 700 行）添加：

```typescript
private async expandAllReplies(page: Page, videoId: string, newRootCids: string[]): Promise<Map<string, number>> {
  const replyCounts = new Map<string, number>();
  logger.info({ videoId }, '[Expand] Starting reply expansion');

  const lastCounts = await db.getRootCommentCounts(videoId);

  const expandBtnDef = getSelector('comment.expand-replies');
  const expandSelectors = [
    expandBtnDef.text,
    'text=/查看\\d+条回复/',
    'text=/展开/',
  ].filter(Boolean) as string[];

  const containerDef = getSelector('comment.container');
  const containerCss = containerDef.css || '[class*="container-sXKyMs"]';

  const containers = await HumanActions.queryElementsWithInfo(page, containerCss);
  logger.info({ containerCount: containers.length }, '[Expand] Found comment containers');

  let expandedCount = 0;
  let skippedCount = 0;

  for (const container of containers) {
    const containerText = container.text || '';

    // 尝试提取根评论 cid（从 data 属性或文本内容）
    let rootCid = '';
    try {
      // 通过 CDP 获取 data-cid 属性
      const attrs = await HumanActions.cdpGetAttributes(page, container.nodeId);
      rootCid = attrs?.['data-cid'] || '';
    } catch {
      // 无 cid 则跳过
    }

    if (!rootCid) {
      // 如果没有 data-cid，尝试从 comment-content-text 的文本判定层级
      const isRootComment = !containerText.includes('回复 @');
      if (!isRootComment) continue; // 跳过子回复容器
      continue; // 跳过无法识别 cid 的容器
    }

    const lastCount = lastCounts.get(rootCid);
    const isNewRoot = newRootCids.includes(rootCid);

    // 检查回复列表是否存在
    const replyListDef = getSelector('comment.reply-list');
    const replyListCss = replyListDef.css || '[class*="reply-list"]';
    const replyListInContainer = await HumanActions.cdpFindChild(page, container.nodeId, replyListCss);

    const currentReplyCount = replyListInContainer
      ? await HumanActions.cdpCountChildren(page, replyListInContainer, '[class*="container-sXKyMs"]')
      : 0;

    replyCounts.set(rootCid, currentReplyCount);

    // 跳过逻辑：上次回复数没变 + 不是新评论 → 跳过
    if (!isNewRoot && lastCount !== undefined && currentReplyCount === lastCount) {
      skippedCount++;
      continue;
    }

    // 需要展开：在容器内查找"查看N条回复"按钮
    for (const sel of expandSelectors) {
      const btnClicked = await HumanActions.cdpClickByText(page, sel, { timeout: 3000 });
      if (btnClicked) {
        await HumanActions.wait(page, 500, 1000);
        expandedCount++;

        // 检查是否需要滚动加载更多
        if (replyListInContainer) {
          await HumanActions.cdpScrollNode(page, replyListInContainer, 200, 'down');
          await HumanActions.wait(page, 300, 600);

          // 再次检查是否还有展开按钮（如"展开更多回复"）
          const moreClicked = await HumanActions.cdpClickByText(page, 'text=/展开更多/', { timeout: 2000 });
          if (moreClicked) {
            await HumanActions.wait(page, 300, 600);
            expandedCount++;
          }
        }
        break;
      }
    }

    // 操作间随机延迟防风控
    if (expandedCount % 5 === 0) {
      await HumanActions.wait(page, 1000, 2000);
    }
  }

  logger.info({ videoId, expandedCount, skippedCount, total: containers.length }, '[Expand] Expansion complete');
  return replyCounts;
}
```

- [ ] **步骤 3：添加 `parseCommentTreeFromDOM` 方法**

```typescript
private async parseCommentTreeFromDOM(page: Page): Promise<CommentNode[]> {
  const containerDef = getSelector('comment.container');
  const containerCss = containerDef.css || '[class*="container-sXKyMs"]';

  const result = await page.evaluate((sel: string) => {
    const containers = document.querySelectorAll(sel);
    const comments: any[] = [];
    const seenCids = new Set<string>();

    containers.forEach((c: Element) => {
      const cid = (c as HTMLElement).dataset.cid || '';
      if (!cid || seenCids.has(cid)) return;
      seenCids.add(cid);

      const textEl = c.querySelector('[class*="comment-content-text"]');
      const text = textEl?.textContent?.trim() || '';

      const replyToEl = c.querySelector('[class*="reply-to"]');
      const isSub = !!replyToEl;
      const replyToName = replyToEl?.textContent?.replace(/^回复\s*@/, '').trim() || '';

      const nicknameEl = c.querySelector('[class*="user-name"], [class*="nickname"], [class*="author-name"]');
      const userNickname = nicknameEl?.textContent?.trim() || '';

      const comment: any = {
        cid,
        text,
        userNickname,
        userUid: '',
        createTime: 0,
        diggCount: 0,
        level: isSub ? 2 : 1,
        replyToName,
        replyId: '0',
        subComments: [],
      };

      if (isSub) {
        // 子回复：找到所属的根评论容器
        const replyList = c.closest('[class*="reply-list"]');
        if (replyList) {
          const rootContainer = replyList.closest(sel);
          if (rootContainer) {
            comment.rootId = (rootContainer as HTMLElement).dataset.cid || '';
          }
        }
      } else {
        // 根评论：收集其子回复
        const replyList = c.querySelector('[class*="reply-list"]');
        if (replyList) {
          const subContainers = replyList.querySelectorAll(sel);
          subContainers.forEach((sub: Element) => {
            const subCid = (sub as HTMLElement).dataset.cid || '';
            if (!subCid) return;
            const subText = sub.querySelector('[class*="comment-content-text"]')?.textContent?.trim() || '';
            const subReplyTo = sub.querySelector('[class*="reply-to"]')?.textContent?.replace(/^回复\s*@/, '').trim() || '';
            const subNick = sub.querySelector('[class*="user-name"], [class*="nickname"]')?.textContent?.trim() || '';
            comment.subComments.push({
              cid: subCid,
              text: subText,
              userNickname: subNick,
              userUid: '',
              createTime: 0,
              diggCount: 0,
              level: 2,
              rootId: cid,
              parentId: '',
              replyToName: subReplyTo,
              replyId: '0',
            });
          });
        }
      }

      comments.push(comment);
    });

    return comments;
  }, containerCss);

  return result;
}
```

- [ ] **步骤 4：修改 `processCommentsQueue` 中的单视频处理循环**

在 `processCommentsQueue` 中，找到 `findAndClickVideoInDrawer` 成功后、`waitForCommentResponse` 之前（约第 974-978 行），插入展开步骤：

替换从 reactionDelay 之后到 waitForCommentResponse 之间的代码段（约第 975-979 行）：

```typescript
        const reactionDelay = 1200 + Math.random() * 1300;
        logger.info({ awemeId: item.awemeId, reactionDelay: Math.round(reactionDelay) }, '[Phase3] Reaction pause');
        await HumanActions.wait(page, reactionDelay, reactionDelay + 100);

        // [新] DOM 展开所有子回复
        const replyCounts = await this.expandAllReplies(page, item.awemeId, [
          // 首次爬取没有 newRootCids，传入空数组
        ]);

        const response = await this.waitForCommentResponse(page);
```

- [ ] **步骤 5：修改评论解析和存储逻辑**

替换 `processCommentsQueue` 中的评论解析部分（约第 989-1005 行），从旧的 `parseCommentList` + `upsertComment` 模式改为新的评论树模式：

```typescript
          const comments = this.parseCommentList(response.body);
          logger.info({ awemeId: item.awemeId, totalComments: comments.length }, '[Phase3] Comments parsed from API response');

          const lastCommentTime = await db.getLastCommentTime(item.awemeId);
          const freshRootComments = comments.filter(
            c => c.create_time > lastCommentTime && (c.reply_id === '0' || c.reply_id === '' || c.reply_id === null)
          );

          // 先标记该视频所有旧评论为已通知
          await db.markCommentsAsNotified(item.awemeId);

          for (const comment of freshRootComments) {
            db.upsertComment(item.awemeId, comment);
          }
          db.updateCommentCount(item.awemeId, item.newCount);

          logger.info({
            awemeId: item.awemeId,
            allComments: comments.length,
            freshRootComments: freshRootComments.length,
            lastCommentTime,
          }, '[Phase3] Comments saved to database');

          results.push({ awemeId: item.awemeId, success: true, comments: freshRootComments });
```

**替换为：**

```typescript
          // [新] 从 DOM 提取完整评论树 + 从 API 获取时间等元数据
          const domComments = await this.parseCommentTreeFromDOM(page);
          const existingCids = await db.getExistingCids(item.awemeId);

          // 判断新增
          const newComments: CommentNode[] = [];
          const allFlatComments: Array<{
            cid: string; text: string; user_nickname: string; user_uid: string;
            digg_count: number; create_time: number; reply_id: string;
            rootId?: string; parentId?: string; level: number; replyToName?: string;
          }> = [];

          for (const node of domComments) {
            // 根评论
            const apiComment = comments.find(c => c.cid === node.cid);
            const createTime = apiComment?.create_time || 0;
            const isNew = !existingCids.has(node.cid);

            allFlatComments.push({
              cid: node.cid, text: node.text, user_nickname: node.userNickname,
              user_uid: apiComment?.user_uid || '', digg_count: apiComment?.digg_count || 0,
              create_time: createTime, reply_id: apiComment?.reply_id || '0',
              rootId: undefined, parentId: undefined, level: 1,
              replyToName: undefined,
            });

            if (isNew) newComments.push({ ...node, createTime, diggCount: apiComment?.digg_count || 0 });

            // 子回复
            for (const sub of (node.subComments || [])) {
              const subApi = comments.find(c => c.cid === sub.cid);
              const subTime = subApi?.create_time || 0;
              const subIsNew = !existingCids.has(sub.cid);

              allFlatComments.push({
                cid: sub.cid, text: sub.text, user_nickname: sub.userNickname,
                user_uid: subApi?.user_uid || '', digg_count: subApi?.digg_count || 0,
                create_time: subTime, reply_id: subApi?.reply_id || '0',
                rootId: node.cid, parentId: undefined, level: 2,
                replyToName: sub.replyToName,
              });

              if (subIsNew) newComments.push({ ...sub, createTime: subTime, diggCount: subApi?.digg_count || 0 });
            }
          }

          // 存储到 DB
          await db.markCommentsAsNotified(item.awemeId);
          await db.upsertCommentTree(item.awemeId, allFlatComments);
          await db.updateCommentCount(item.awemeId, item.newCount);

          // 更新 VideoRootCommentCount
          for (const [rootCid, count] of replyCounts) {
            await db.upsertRootCommentCount(item.awemeId, rootCid, count);
          }

          // 构建结果（含评论群）
          const commentGroups = domComments.map(root => ({
            rootComment: root,
            subReplies: root.subComments || [],
            newInGroup: newComments.filter(nc =>
              nc.cid === root.cid || (nc.rootId === root.cid)
            ),
          }));

          logger.info({
            awemeId: item.awemeId,
            totalComments: allFlatComments.length,
            newComments: newComments.length,
            groups: commentGroups.length,
          }, '[Phase3] Comment tree saved');

          results.push({
            awemeId: item.awemeId,
            success: true,
            comments: newComments,
            commentGroups,
          } as any);
```

- [ ] **步骤 6：更新 CommentProcessResult 接口**

在第 71 行附近，扩展 `CommentProcessResult` 接口：

```typescript
export interface CommentProcessResult {
  awemeId: string;
  success: boolean;
  comments: CommentInfo[];
  commentGroups?: Array<{
    rootComment: CommentNode;
    subReplies: CommentNode[];
    newInGroup: CommentNode[];
  }>;
  error?: string;
}
```

- [ ] **步骤 7：TypeScript 编译验证**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | head -30
```

- [ ] **步骤 8：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(crawler): add DOM-based reply expansion and comment tree parsing for Phase 3"
```

---

### 任务 6：企业微信通知增强（模板卡片）

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：导入 CommentNode 类型**

在文件顶部 import 区域添加：

```typescript
import type { CommentNode } from '../crawlers/douyinCrawler';
```

- [ ] **步骤 2：重写 `sendMonitorNotification` 函数**

替换 `sendMonitorNotification` 函数（第 24-76 行）：

```typescript
interface CommentNotificationData {
  newComments: number;
  commentGroups: Array<{
    awemeId: string;
    description: string;
    rootComment: {
      cid: string;
      text: string;
      userNickname: string;
    };
    subReplies: Array<{
      cid: string;
      text: string;
      userNickname: string;
      replyToName?: string;
    }>;
    newCids: Set<string>;
  }>;
}

async function sendMonitorNotification(
  userId: number,
  platform: string,
  type: 'new_comments' | 'risk_detected' | 'monitor_complete',
  data?: CommentNotificationData,
): Promise<void> {
  try {
    const status = botManager.getStatus();
    if (!status.connected) {
      logger.debug('企业微信机器人未连接，跳过通知');
      return;
    }

    const user = await prisma.user.findFirst({
      where: { id: userId },
      select: { wechatUserid: true },
    }).catch(() => null);

    const targets: string[] = [];
    if (user?.wechatUserid) {
      targets.push(user.wechatUserid);
    }
    if (targets.length === 0) {
      logger.warn({ userId, platform, type }, '未找到用户的企微ID，跳过通知');
      return;
    }

    // 风险通知保持简单格式
    if (type === 'risk_detected') {
      const content = `⚠️ **风控告警**\n> 平台: ${platform}\n> 风控类型: 未知\n> 用户ID: ${userId}\n> 已自动进入冷却期`;
      await botManager.sendTextMessage(targets, content);
      return;
    }

    if (type === 'monitor_complete' || !data || data.commentGroups.length === 0) {
      if (type === 'monitor_complete') {
        const content = `✅ **监控完成**\n> 平台: ${platform}\n> 用户ID: ${userId}`;
        await botManager.sendTextMessage(targets, content);
      }
      return;
    }

    // 新评论通知：每个视频一条模板卡片
    for (const group of data.commentGroups) {
      const newCount = group.newCids.size;

      // 构建评论群文本（标记新增）
      const commentLines: string[] = [];
      const newMarker = (cid: string) => group.newCids.has(cid) ? ' 🆕' : '';

      commentLines.push(`${group.rootComment.userNickname}: ${group.rootComment.text}${newMarker(group.rootComment.cid)}`);
      for (const sub of group.subReplies) {
        const toName = sub.replyToName ? `@${sub.replyToName} ` : '';
        commentLines.push(`  └ ${sub.userNickname}: ${toName}${sub.text}${newMarker(sub.cid)}`);
      }

      const quoteText = commentLines.join('\n');
      // 截断超长文本（企微限制 4096 字节）
      const maxBytes = 3500;
      let truncated = quoteText;
      if (Buffer.byteLength(truncated, 'utf-8') > maxBytes) {
        // 按行截断
        let bytes = 0;
        const kept: string[] = [];
        for (const line of commentLines) {
          bytes += Buffer.byteLength(line + '\n', 'utf-8');
          if (bytes > maxBytes) {
            kept.push('  ...(更多内容省略)');
            break;
          }
          kept.push(line);
        }
        truncated = kept.join('\n');
      }

      // 构建模板卡片
      const card = {
        card_type: 'text_notice',
        source: {
          icon_url: '',
          desc: `📊 ${platform === 'douyin' ? '抖音' : platform}评论更新`,
          desc_color: 0,
        },
        main_title: {
          title: group.description.slice(0, 50),
          desc: `新增 ${newCount} 条评论`,
        },
        emphasis_content: {
          title: String(newCount),
          desc: '条新评论',
        },
        sub_title_text: '',
        horizontal_content_list: [
          {
            keyname: '视频',
            value: group.description.slice(0, 30),
          },
        ],
        quote_area: {
          type: 0,
          title: '评论详情',
          quote_text: truncated,
        },
        jump_list: [
          {
            type: 3,
            title: '回复此评论',
            question: `回复 ${group.awemeId} ${group.rootComment.cid}`,
          },
        ],
        card_action: {
          type: 1,
          url: 'https://creator.douyin.com/creator-micro/interactive/comment',
        },
      };

      try {
        await botManager.sendTemplateCard(targets, card);
        logger.info({ userId, platform, awemeId: group.awemeId }, '已发送企业微信模板卡片通知');
      } catch (err) {
        logger.error({ userId, err }, '发送模板卡片失败，回退到纯文本');
        // 回退：纯 markdown
        const fallback = `📊 **${platform}评论更新**\n> 视频: ${group.description}\n> 新增: ${newCount} 条\n\n${truncated}`;
        await botManager.sendTextMessage(targets, fallback);
      }
    }

    logger.info({ userId, platform, type, targets }, '已发送企业微信通知');
  } catch (err) {
    logger.error({ userId, platform, type, err }, '发送企业微信通知失败');
  }
}
```

- [ ] **步骤 3：修改 `runDouyinCheck` 中的通知调用**

在 `runDouyinCheck` 函数（约第 170 行）中，修改 `sendMonitorNotification` 调用，传入评论群数据：

找到：
```typescript
        if (result.newComments > 0) {
          await sendMonitorNotification(task.userId, task.platform, 'new_comments', {
            newComments: result.newComments,
            updatedVideos: result.updatedVideos.length,
          });
        }
```

替换为从 Phase 3 结果中收集 commentGroups 并传递：

```typescript
        if (result.newComments > 0) {
          // 从 phase3Result 中提取评论群数据
          const commentGroups = (phase3Result as any).results
            ?.filter((r: any) => r.success && r.commentGroups)
            ?.flatMap((r: any) =>
              r.commentGroups.map((g: any) => ({
                awemeId: r.awemeId,
                description: queue.find(q => q.awemeId === r.awemeId)?.description || '',
                rootComment: g.rootComment,
                subReplies: g.subReplies,
                newCids: new Set(g.newInGroup.map((n: any) => n.cid)),
              }))
            ) || [];

          if (commentGroups.length > 0) {
            await sendMonitorNotification(task.userId, task.platform, 'new_comments', {
              newComments: result.newComments,
              commentGroups,
            });
          }
        }
```

- [ ] **步骤 4：在 wechatBotService 中添加 sendTemplateCard 方法**

**文件：** `apps/ts-api-gateway/src/services/wechatBotService.ts`

在 `sendTextMessage` 方法（约第 180 行）后添加：

```typescript
  async sendTemplateCard(userids: string[], card: any): Promise<void> {
    if (!this.client) throw new Error('机器人未连接');

    for (const userid of userids) {
      await this.client.sendMessage(userid, {
        msgtype: 'template_card',
        template_card: card,
      });
    }

    logger.info(`发送模板卡片给 ${userids.join(', ')}`);
  }
```

- [ ] **步骤 5：TypeScript 编译验证**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | head -20
```

- [ ] **步骤 6：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts apps/ts-api-gateway/src/services/wechatBotService.ts
git commit -m "feat(wecom): use template card for comment notifications with comment group details"
```

---

### 任务 7：一键回复流程

**文件：**
- 修改：`apps/ts-api-gateway/src/services/wechatBotService.ts`

- [ ] **步骤 1：添加待回复上下文管理**

在 `WeChatBotManager` class 顶部添加：

```typescript
  // 待回复上下文：commentCid → { videoId, userId, windowId, timeout }
  private pendingReplies = new Map<string, {
    videoId: string;
    awemeId: string;
    userId: number;
    windowId: string;
    timeout: NodeJS.Timeout;
  }>();
```

- [ ] **步骤 2：添加回复处理逻辑**

在 `WeChatBotManager` class 中添加方法：

```typescript
  setPendingReply(
    commentCid: string,
    context: { videoId: string; awemeId: string; userId: number; windowId: string },
    timeoutMs = 300_000,
  ): void {
    // 清除旧超时
    const existing = this.pendingReplies.get(commentCid);
    if (existing) clearTimeout(existing.timeout);

    const timeout = setTimeout(() => {
      this.pendingReplies.delete(commentCid);
      logger.info({ commentCid }, '待回复上下文超时，已清除');
    }, timeoutMs);

    this.pendingReplies.set(commentCid, { ...context, timeout });
    logger.info({ commentCid, ...context }, '已设置待回复上下文');
  }

  getPendingReply(commentCid: string) {
    return this.pendingReplies.get(commentCid);
  }

  clearPendingReply(commentCid: string): void {
    const existing = this.pendingReplies.get(commentCid);
    if (existing) clearTimeout(existing.timeout);
    this.pendingReplies.delete(commentCid);
  }
```

- [ ] **步骤 3：注册消息处理器解析回复指令**

在 `wechatBotService.ts` 的 `autoStartBot` export 区域（约第 220 行后），添加消息处理器注册逻辑。找到已有 `this.client.on('message', ...)` 的回调处理位置（约第 60 行），在链接请求检查之后、通用 handler 调用之前，插入回复匹配逻辑：

```typescript
        // Check if this message matches a pending reply context
        // 格式: "回复 <awemeId> <commentCid>" (由 jump_list type=3 触发)
        const replyMatch = content?.match(/^回复\s+(\S+)\s+(\S+)$/);
        if (replyMatch && this.pendingReplies.size > 0) {
          // 用户点击了 jump_list 的「回复此评论」，系统识别为设置回复上下文
          const awemeId = replyMatch[1];
          const commentCid = replyMatch[2];
          
          // 这里需要外部调用 setPendingReply 来设置上下文
          // 用户直接发送文本才会触发实际回复
          // 当前仅记录意图
          logger.info({ userid, awemeId, commentCid }, '用户触发回复意图');
        }

        // 检查是否有活跃的待回复上下文（用户直接发送文本时）
        for (const [commentCid, ctx] of this.pendingReplies) {
          if (ctx.userId === parseInt(userid) || true) {
            // 找到匹配的待回复：用户发送的文本作为回复内容
            const replyText = content || '';
            if (replyText && !replyText.startsWith('回复 ')) {
              logger.info({ userid, commentCid, replyText }, '用户发送回复文本');
              // 触发回复执行（通过回调通知外部）
              for (const handler of this.messageHandlers) {
                await handler(msg);
              }
              return; // 已被回复处理，不再走通用 handler
            }
          }
        }
```

实际上，企微回复流程的完整链路需要：
1. 用户在通知卡片中点击 `jump_list` type=3 "回复此评论"
2. 系统收到带文本的消息（如 "回复 awemeId123 commentCid456"）
3. 系统设置待回复上下文
4. 回复用户提示"请输入回复内容"
5. 用户发送回复文本
6. 系统匹配待回复上下文，执行回复

简化实现：在 bot 初始化时注册一个消息处理器，监听"回复"前缀消息并在收到后续文本时匹配。

- [ ] **步骤 4：简化实现——在 index.ts 或 init 中注册消息处理器**

在 `autoStartBot` 函数中（第 207 行后）注册回复流处理器：

```typescript
  // 注册评论回复消息处理器
  botManager.onMessage(async (msg: any) => {
    const userid = msg.body?.from?.userid;
    const content = msg.body?.text?.content?.trim();
    if (!userid || !content) return;

    // 匹配回复意图: 格式 "回复 <awemeId> <commentCid>"
    const replySetup = content.match(/^回复\s+(\S+)\s+(\S+)$/);
    if (replySetup) {
      const awemeId = replySetup[1];
      const commentCid = replySetup[2];
      
      const user = await prisma.user.findFirst({
        where: { wechatUserid: userid },
        select: { id: true },
      }).catch(() => null);

      if (!user) return;

      // 获取用户的窗口 ID
      const window = await prisma.browserWindow.findFirst({
        where: { userId: user.id, platform: 'douyin' },
        select: { fingerprintWindowId: true },
      }).catch(() => null);

      if (!window) {
        await botManager.sendTextMessage([userid], '❌ 未找到关联的浏览器窗口');
        return;
      }

      botManager.setPendingReply(commentCid, {
        videoId: awemeId, awemeId, userId: user.id, windowId: window.fingerprintWindowId,
      });

      await botManager.sendTextMessage([userid], `💬 已选择回复评论，请直接发送回复内容（5分钟内有效）`);
      return;
    }

    // 匹配实际回复文本
    for (const [commentCid, ctx] of botManager.pendingReplies) {
      // 简化：按 userid 匹配
      const user = await prisma.user.findFirst({
        where: { wechatUserid: userid },
        select: { id: true },
      }).catch(() => null);

      if (user && ctx.userId === user.id) {
        botManager.clearPendingReply(commentCid);
        
        // 执行回复（通过 BullMQ 入队或直接执行）
        await monitorQueue.add('execute_reply', {
          taskId: `reply_${Date.now()}_${commentCid}`,
          userId: ctx.userId,
          platform: 'douyin',
          windowId: ctx.windowId,
          fingerprintWindowId: ctx.windowId,
          replyData: {
            videoId: ctx.videoId,
            commentCid,
            text: content,
          },
        });

        await botManager.sendTextMessage([userid], `✅ 回复已提交: "${content.slice(0, 50)}${content.length > 50 ? '...' : ''}"`);
        return;
      }
    }
  });
```

- [ ] **步骤 5：在 monitorService.ts 中添加回复执行 Worker 逻辑**

找到 monitorWorker 定义处（约第 118 行），扩展 worker 支持 `execute_reply` 任务类型：

```typescript
// 在 Worker 的 process 函数开头添加
if (job.name === 'execute_reply') {
  const replyData = (job.data as any).replyData;
  await executeReplyAction(job.data as MonitorTask, replyData);
  return;
}
```

添加 `executeReplyAction` 函数（在文件末尾，`evaluateRules` 函数之前）：

```typescript
async function executeReplyAction(
  task: MonitorTask,
  replyData: { videoId: string; commentCid: string; text: string },
): Promise<void> {
  const bm = getBrowserManager();
  const { page } = await bm.connect(String(task.windowId), '', task.platform);

  try {
    // 导航到评论管理页面
    const currentUrl = page.url();
    if (!currentUrl.includes('creator.douyin.com')) {
      await douyinCrawler.navigateToCreatorHome(page);
    }

    const navSuccess = await douyinCrawler.navigateToCommentManage(page);
    if (!navSuccess) {
      logger.error('回复失败：无法导航到评论管理');
      return;
    }

    // 定位并展开目标视频+评论
    const drawerOpened = await (douyinCrawler as any).openSelectWorkDrawer(page);
    if (!drawerOpened) {
      logger.error('回复失败：无法打开作品选择抽屉');
      return;
    }

    // 找到并点击视频（用 awemeId 匹配）
    // 注：此处调用 findAndClickVideoInDrawer，需传入 awemeId
    await (douyinCrawler as any).findAndClickVideoInDrawer(page, replyData.videoId, '');
    await HumanActions.wait(page, 1500, 3000);

    // 找到评论容器，点击"回复"按钮
    const containerCss = '[class*="container-sXKyMs"]';
    const containers = await HumanActions.queryElementsWithInfo(page, containerCss);
    let targetNodeId: number | null = null;

    for (const c of containers) {
      try {
        const attrs = await HumanActions.cdpGetAttributes(page, c.nodeId);
        if (attrs?.['data-cid'] === replyData.commentCid) {
          targetNodeId = c.nodeId;
          break;
        }
      } catch {}
    }

    if (!targetNodeId) {
      logger.error({ commentCid: replyData.commentCid }, '回复失败：未找到目标评论');
      return;
    }

    // 在评论容器内查找"回复"按钮
    const replyBtnDef = getSelectorFromJson('douyin', 'buttons', 'btn_reply_comment');
    const replyBtnClicked = await HumanActions.cdpClickByText(page, '回复', { timeout: 5000 });
    if (!replyBtnClicked) {
      logger.error('回复失败：无法点击回复按钮');
      return;
    }
    await HumanActions.wait(page, 500, 1000);

    // 输入回复文本
    const inputCss = 'div[contenteditable="true"]';
    const inputClicked = await HumanActions.cdpClick(page, inputCss, { timeout: 5000 });
    if (!inputClicked) {
      logger.error('回复失败：无法定位输入框');
      return;
    }
    await HumanActions.wait(page, 300, 500);

    // 逐字键入
    for (const char of replyData.text) {
      await HumanActions.cdpKeyPress(page, char, char, char.charCodeAt(0));
      await HumanActions.wait(page, 50, 150);
    }

    // 点击发送
    const submitDef = getSelectorFromJson('douyin', 'buttons', 'btn_reply_submit');
    await HumanActions.cdpClick(page, submitDef.css || '[class*="submit"]', { timeout: 5000 });
    await HumanActions.wait(page, 1000, 2000);

    logger.info({ commentCid: replyData.commentCid, text: replyData.text }, '回复执行成功');
  } catch (err: any) {
    logger.error({ err: err.message }, '回复执行失败');
  } finally {
    // 执行退出策略
    try {
      await douyinCrawler.executeExitStrategy(page, 'other' as any, 'menu.interact.comment-manage');
    } catch {}
  }
}
```

需要添加 Helper 函数 `getSelectorFromJson`（如果不存在的话）：

```typescript
import { getSelector } from '../crawlers/menuSelectors';
// getSelector 已经存在，直接用
```

- [ ] **步骤 6：TypeScript 编译验证**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | head -30
```

- [ ] **步骤 7：Commit**

```bash
git add apps/ts-api-gateway/src/services/wechatBotService.ts apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "feat(wecom): add one-click reply flow via message handler and BullMQ reply worker"
```

---

### 任务 8：集成验证 + 边界处理

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：确保 Light 模式兼容**

在 Light 模式路径（约第 320 行）中，不执行 DOM 展开。确认 Light 模式代码不变。

- [ ] **步骤 2：确保错误恢复路径完整**

在 `executeMonitorCheck` 的 catch 块（约第 257 行），确认退出策略仍然正常执行。

- [ ] **步骤 3：验证编译 + 运行内置测试**

```bash
cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | tail -5
```

预期：无新增 TS 错误（预存在的 bullmq 类型警告可忽略）。

- [ ] **步骤 4：手动验证清单**

以下需在抖音创作者中心页面手工验证（无法自动化）：
1. 进入评论管理 → 展开一个有子回复的视频 → 点击"查看N条回复"→ 验证展开成功
2. 展开后运行监控 → 验证评论树正确存入 DB（`SELECT * FROM comments WHERE video_id='xxx' ORDER BY level`）
3. 第二次监控 → 验证 replyCount 不变时跳过了展开
4. 企微端收到模板卡片 → 验证格式正确、评论群显示完整
5. 点击"回复此评论" → 发送文本 → 验证 DOM 成功回复

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "feat: integration verification and edge case handling for comment pipeline"
```
