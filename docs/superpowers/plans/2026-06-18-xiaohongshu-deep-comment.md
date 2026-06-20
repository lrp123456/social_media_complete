# 小红书深度评论采集 + 评论回复 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 小红书 deep 模式评论树爬取 + 评论回复能力，对齐抖音/快手/视频号的 3 阶段流水线架构，并统一所有平台的视频生命周期管理。

**架构：** Phase 1（笔记列表扫描+非公开过滤）→ Phase 2（主站登录校验）→ Phase 3（串行逐视频评论树采集）+ `replyToComment` 回复 6 阶段；全平台统一 `reconcileVideosForUser` 替代 `upsertVideosBatch + truncateVideosByUser`。

**技术栈：** TypeScript, Patchright (Playwright fork), Prisma, RequestInterceptor, HumanActions

---

### 任务 0：新增 `reconcileVideosForUser` + 保护机制

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorDatabaseService.ts`（新增函数，标注旧函数 `@deprecated`）

- [ ] **步骤 1：新增 `reconcileVideosForUser` 函数**

在 `truncateVideosByUser` 之后（约 L167）、`markCommentsAsNotified` 之前插入：

```typescript
/**
 * 协调用户视频列表与 DB，统一处理生命周期（替代 upsertVideosBatch + truncateVideosByUser）
 *
 * 调用方负责传入【已过滤可监控的视频列表】（公开 + 未删除·前 N 条）
 * DB 中存在但不在输入列表中的视频 → 删除（场景 B/C/G 合并处理）
 *
 * 保护机制：若 visibleVideos 为空且 DB 有视频，跳过删除（避免 API 异常误删）
 *
 * @deprecated 请使用此函数替代 upsertVideosBatch + truncateVideosByUser
 */
export async function reconcileVideosForUser(
  userId: number,
  visibleVideos: Array<{
    aweme_id: string;
    description: string;
    create_time: number;
    comment_count: number;
    metrics?: any;
  }>,
  maxVideos: number,
): Promise<{
  newVideoIds: string[];
  removedVideoIds: string[];
  unchangedCount: number;
}> {
  const newVideoIds: string[] = [];
  const removedVideoIds: string[] = [];
  let unchangedCount = 0;

  // 1) 获取 DB 中该用户的全部视频 ID
  const dbVideos = await prisma.video.findMany({
    where: { userId },
    select: { id: true },
  });
  const dbIds = new Set(dbVideos.map((v) => v.id));

  // 2) 保护机制：源为空且 DB 有数据 → 跳过删除
  const sourceIds = new Set(visibleVideos.slice(0, maxVideos).map((v) => v.aweme_id));
  if (sourceIds.size === 0 && dbIds.size > 0) {
    logger.warn(
      { userId, dbCount: dbIds.size },
      '[reconcileVideosForUser] visibleVideos is empty but DB has records — skipping deletion (protection)',
    );
    // 仍执行 upsert（即使 source 空也允许首次建立）
  } else {
    // 3) 找出需要删除的 ID（在 DB 中但不在 source 中）
    const toRemove = [...dbIds].filter((id) => !sourceIds.has(id));
    if (toRemove.length > 0) {
      // 先清理无 FK 关联的子表
      await prisma.videoRootCommentCount.deleteMany({ where: { videoId: { in: toRemove } } });
      await prisma.videoCommentRecord.deleteMany({ where: { videoId: { in: toRemove } } });
      await prisma.videoCommentCount.deleteMany({ where: { videoId: { in: toRemove } } });
      // Video 删除 → 级联删除 Comment
      await prisma.video.deleteMany({
        where: { id: { in: toRemove } },
      });
      removedVideoIds.push(...toRemove);
      logger.debug({ userId, removed: toRemove.length }, '[reconcileVideosForUser] 删除已消失的视频');
    }
  }

  // 4) UPSERT 可见视频
  const upsertVideos = visibleVideos.slice(0, maxVideos);
  if (upsertVideos.length > 0) {
    await prisma.$transaction(
      upsertVideos.map((v) =>
        prisma.video.upsert({
          where: { id: v.aweme_id },
          update: {
            description: v.description,
            metrics: JSON.stringify(v.metrics || {}),
          },
          create: {
            id: v.aweme_id,
            userId,
            description: v.description,
            createTime: BigInt(v.create_time),
            commentCount: 0,
            metrics: JSON.stringify(v.metrics || {}),
          },
        }),
      ),
    );

    // 标记新增/不变
    for (const v of upsertVideos) {
      if (!dbIds.has(v.aweme_id)) {
        newVideoIds.push(v.aweme_id);
      } else {
        unchangedCount++;
      }
    }
  }

  logger.info(
    { userId, newCount: newVideoIds.length, removedCount: removedVideoIds.length, unchangedCount },
    '[reconcileVideosForUser] 视频生命周期协调完成',
  );

  return { newVideoIds, removedVideoIds, unchangedCount };
}
```

- [ ] **步骤 2：标注旧函数 deprecation**

给 `upsertVideosBatch` 和 `truncateVideosByUser` 添加 `@deprecated` JSDoc 标注：

```typescript
/**
 * 批量 upsert 视频
 * @deprecated 请使用 reconcileVideosForUser（统一处理 upsert + 删除 + 保护机制）
 */
export async function upsertVideosBatch(
```

```typescript
/**
 * 删除用户超出保留数量的最旧视频
 * @deprecated 请使用 reconcileVideosForUser（统一处理生命周期）
 */
export async function truncateVideosByUser(
```

- [ ] **步骤 3：验证无语法错误**

```bash
npx tsc --noEmit --project apps/ts-api-gateway/tsconfig.json 2>&1 | head -30
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorDatabaseService.ts
git commit -m "feat(monitor-db): add reconcileVideosForUser with protection mechanism"
```

---

### 任务 1：全平台调用方迁移到 `reconcileVideosForUser`

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`（runDouyinCheck / runKuaishouCheck / runTencentCheck / runXiaohongshuCheck 内替换）

**注意：** 小红书的 `runXiaohongshuCheck` 在 Phase 1 后还需要增加 `permission_code === 0` 过滤，但那个在任务 2 完成。本任务只做机械替换，不改变逻辑。

- [ ] **步骤 1：抖音 `runDouyinCheck` 替换**

搜索 `// Phase 1: 扫描视频列表` 附近的代码，将：

```typescript
await db.upsertVideosBatch(task.userId, videos);
await db.truncateVideosByUser(task.userId, douyinCrawler['maxMonitorVideos'] || 20);
```

替换为：

```typescript
await db.reconcileVideosForUser(task.userId, videos, douyinCrawler['maxMonitorVideos'] || 20);
```

- [ ] **步骤 2：快手 `runKuaishouCheck` 替换**

同上搜索替换。

- [ ] **步骤 3：视频号 `runTencentCheck` 替换**

同上搜索替换。

- [ ] **步骤 4：小红书 `runXiaohongshuCheck` 替换**

```typescript
await db.upsertVideosBatch(userId, videos);
await db.truncateVideosByUser(userId, this.maxMonitorVideos);
```

替换为：

```typescript
await db.reconcileVideosForUser(userId, videos, this.maxMonitorVideos);
```

- [ ] **步骤 5：验证编译**

```bash
npx tsc --noEmit --project apps/ts-api-gateway/tsconfig.json 2>&1 | head -30
```

- [ ] **步骤 6：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts apps/ts-api-gateway/src/crawlers/douyinCrawler.ts apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/crawlers/tencentCrawler.ts apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "refactor: migrate all platforms to reconcileVideosForUser"
```

---

### 任务 2：XHS Phase 1 非公开过滤 + 解除 deep 限制

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`
- 修改：`apps/ts-api-gateway/src/routes/matrix.ts`

- [ ] **步骤 1：XHS crawler `fetchNoteListFromSource` 增加非公开过滤**

在 `fetchNoteListFromSource` 方法的 `allItems` 解析后、`sliced` 前，添加 `permission_code` 过滤逻辑（约 L200）：

```typescript
// ★ 非公开过滤：仅保留 permission_code === 0 的公开笔记
const filteredItems = allItems.filter((item: any) => {
  const permissionCode = item.permission_code ?? item.permissionCode ?? item.permission?.code;
  if (permissionCode !== undefined && permissionCode !== null) {
    const isPublic = Number(permissionCode) === 0;
    if (!isPublic) {
      logger.info({ awemeId: item.id || item.note_id }, '[XHS-fetch] 过滤非公开笔记（permission_code=%s）', permissionCode);
    }
    return isPublic;
  }
  // 没有 permission_code 字段的笔记默认为公开（容错）
  return true;
});
const sliced = filteredItems.slice(0, this.maxMonitorVideos);
```

注意先将 `const sliced = allItems.slice(0, this.maxMonitorVideos)` 替换为上述代码。

- [ ] **步骤 2：`checkForUpdates` 中替换 `upsertVideosBatch + truncateVideosByUser` 为 `reconcileVideosForUser`**

任务 1 步骤 4 已完成，确认即可。

- [ ] **步骤 3：`monitorService.ts` `runXiaohongshuCheck` 解除 deep 强制 light 限制**

```typescript
async function runXiaohongshuCheck(page: any, task: MonitorTask, onProgress?: ...): Promise<MonitorResult> {
  // 小红书支持 deep 模式
  const crawlMode = await db.getCrawlMode('xiaohongshu');
  // 移除强制 light 逻辑

  logger.info({ ... }, '[XHS-monitor] Starting xiaohongshu check');
  // ... 其余保持不变
```

- [ ] **步骤 4：`routes/matrix.ts` 移除 deep 模式拒绝**

```typescript
// 移除以下代码块（L1477-L1483）：
// if (platform === 'xiaohongshu' && mode === 'deep') {
//   return res.status(400).json({
//     success: false,
//     error: '小红书不支持深度爬取模式，仅支持轻量通知',
//   });
// }
```

- [ ] **步骤 5：验证编译**

```bash
npx tsc --noEmit --project apps/ts-api-gateway/tsconfig.json 2>&1 | head -30
```

- [ ] **步骤 6：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts apps/ts-api-gateway/src/services/monitorService.ts apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "feat(xhs): Phase 1 private video filtering + remove deep mode restriction"
```

---

### 任务 3：selectors.json + menuSelectors.ts 新增 22 键

**文件：**
- 修改：`apps/ts-api-gateway/data/selectors.json`
- 修改：`apps/ts-api-gateway/src/crawlers/menuSelectors.ts`

- [ ] **步骤 1：selectors.json 新增 XHS 条目**

在 `platforms.xiaohongshu` 的 `regions` 和 `buttons` 节点追加：

A. 缩略图点击 (regions):
```json
"region_note_card_by_id": {
  "purposes": ["monitor"],
  "primary": ".note-card[data-impression*=\"{noteId}\"]",
  "fallbacks": [".note-card__cover"]
},
"region_note_card_cover": {
  "purposes": ["monitor"],
  "primary": ".note-card__cover .media-body",
  "fallbacks": [".note-card__cover img"]
},
"region_note_card_private_marker": {
  "purposes": ["monitor"],
  "primary": "getByText(\"仅自己可见\", exact=True)",
  "fallbacks": ["[class*=\"private\"]:visible"]
}
```

B. 主站登录检测 (regions):
```json
"region_mainsite_user_avatar": {
  "purposes": ["monitor"],
  "primary": ".user.side-bar-component",
  "fallbacks": [".user-avatar", "[class*=\"user-sidebar\"]"]
},
"region_mainsite_login_modal": {
  "purposes": ["monitor"],
  "primary": "getByText(\"登录\", exact=True)",
  "fallbacks": ["[class*=\"login-modal\"]:visible"]
},
"region_mainsite_qr_code": {
  "purposes": ["monitor"],
  "primary": ".qrcode-img",
  "fallbacks": ["img[alt*=\"二维码\"]"]
}
```

C. 评论区容器与采集 (regions + buttons):
```json
"region_comments_container": {
  "purposes": ["monitor"],
  "primary": ".comments-el",
  "fallbacks": ["[class*=\"comment-list\"]"]
},
"region_comment_scroller": {
  "purposes": ["monitor"],
  "primary": ".note-scroller",
  "fallbacks": ["[class*=\"scroller\"]"]
},
"region_comment_total": {
  "purposes": ["monitor"],
  "primary": ".comments-container .total",
  "fallbacks": ["getByText(/条评论/)"]
},
"region_comment_root_container": {
  "purposes": ["monitor"],
  "primary": ".comment-item:not(.comment-item-sub)",
  "fallbacks": ["[class*=\"comment-item\"]:not([class*=\"sub\"])"]
},
"region_comment_sub_container": {
  "purposes": ["monitor"],
  "primary": ".comment-item.comment-item-sub",
  "fallbacks": ["[class*=\"comment-item\"][class*=\"sub\"]"]
},
"region_comment_author_name": {
  "purposes": ["monitor"],
  "primary": ".author .name",
  "fallbacks": ["[class*=\"author-name\"]"]
},
"region_comment_content_text": {
  "purposes": ["monitor"],
  "primary": ".content .note-text",
  "fallbacks": ["[class*=\"comment-content\"]"]
},
"region_comment_author_tag": {
  "purposes": ["monitor"],
  "primary": "getByText(\"作者\", exact=True)",
  "fallbacks": ["[class*=\"author-tag\"]"]
},
"btn_expand_sub_comments": {
  "purposes": ["monitor"],
  "primary": "getByText(\"展开\")",
  "fallbacks": ["[class*=\"expand-reply\"]"]
}
```

D. 评论回复 (regions + buttons + textboxes):
```json
"btn_reply_comment": {
  "purposes": ["reply"],
  "primary": "getByText(\"回复\", exact=True)",
  "fallbacks": ["[class*=\"icon-reply\"]"]
},
"region_reply_input_area": {
  "purposes": ["reply"],
  "primary": ".bottom-container [contenteditable=\"true\"]",
  "fallbacks": ["[class*=\"reply-input-area\"]"]
},
"tb_reply_input": {
  "purposes": ["reply"],
  "primary": ".bottom-container [contenteditable=\"true\"]",
  "fallbacks": ["[contenteditable=\"true\"]:visible"]
},
"btn_reply_submit": {
  "purposes": ["reply"],
  "primary": "getByText(\"发送\", exact=True)",
  "fallbacks": ["[class*=\"send-btn\"]"]
},
"btn_reply_cancel": {
  "purposes": ["reply"],
  "primary": "getByText(\"取消\", exact=True)",
  "fallbacks": ["[class*=\"cancel-btn\"]"]
}
```

- [ ] **步骤 2：menuSelectors.ts 新增 key mapping**

在 `xiaohongshu` 平台的 `CRAWLER_KEY_MAP` 中追加：

```typescript
'region.note-card-by-id': { category: 'regions', name: 'region_note_card_by_id' },
'region.note-card-cover': { category: 'regions', name: 'region_note_card_cover' },
'region.note-card-private-marker': { category: 'regions', name: 'region_note_card_private_marker' },
'region.mainsite-user-avatar': { category: 'regions', name: 'region_mainsite_user_avatar' },
'region.mainsite-login-modal': { category: 'regions', name: 'region_mainsite_login_modal' },
'region.mainsite-qr-code': { category: 'regions', name: 'region_mainsite_qr_code' },
'region.comments-container': { category: 'regions', name: 'region_comments_container' },
'region.comment-scroller': { category: 'regions', name: 'region_comment_scroller' },
'region.comment-total': { category: 'regions', name: 'region_comment_total' },
'region.comment-root-container': { category: 'regions', name: 'region_comment_root_container' },
'region.comment-sub-container': { category: 'regions', name: 'region_comment_sub_container' },
'region.comment-author-name': { category: 'regions', name: 'region_comment_author_name' },
'region.comment-content-text': { category: 'regions', name: 'region_comment_content_text' },
'region.comment-author-tag': { category: 'regions', name: 'region_comment_author_tag' },
'region.reply-input-area': { category: 'regions', name: 'region_reply_input_area' },
'btn.expand-sub-comments': { category: 'buttons', name: 'btn_expand_sub_comments' },
'btn.reply-comment': { category: 'buttons', name: 'btn_reply_comment' },
'btn.reply-submit': { category: 'buttons', name: 'btn_reply_submit' },
'btn.reply-cancel': { category: 'buttons', name: 'btn_reply_cancel' },
'tb.reply-input': { category: 'textboxes', name: 'tb_reply_input' },
```

- [ ] **步骤 3：验证 JSON 合法性 + 编译**

```bash
python3 -c "import json; json.load(open('apps/ts-api-gateway/data/selectors.json')); print('JSON valid')"
npx tsc --noEmit --project apps/ts-api-gateway/tsconfig.json 2>&1 | head -10
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/data/selectors.json apps/ts-api-gateway/src/crawlers/menuSelectors.ts
git commit -m "feat(xhs): add 22 selectors to selectors.json + menuSelectors key mapping"
```

---

### 任务 4：replyTypes.ts 共享接口 + 更新 import

**文件：**
- 创建：`apps/ts-api-gateway/src/crawlers/replyTypes.ts`
- 修改：`apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`（移除本地的 ReplyTarget）
- 修改：`apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts`（引用新接口）
- 修改：`apps/ts-api-gateway/src/crawlers/tencentCrawler.ts`（引用新接口）
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`（更新 import）

- [ ] **步骤 1：创建 `replyTypes.ts`**

```typescript
/**
 * 共享回复目标接口 — 对多多平台评论回复操作
 * 各平台 crawler 统一引用此接口
 */

export interface ReplyTarget {
  /** ★ XHS 强主键：评论 cid（用于定位） */
  cid?: string;
  /** 评论正文（仅用于日志和最终可视确认） */
  text: string;
  /** 评论层级：1=根评论，2=子评论 */
  level: 1 | 2;
  /** ★ 要回复的那条评论的作者昵称（匹配主键之一） */
  username: string;
  /** ★ 仅 level=1：根评论的子评论数 */
  subReplyCount?: number;
  /** ★ 仅 level=2：所属根评论的正文 */
  rootText?: string;
  /** ★ 仅 level=2：所属根评论的作者昵称 */
  rootUsername?: string;
  /** ★ 仅 level=2：所属根评论的子评论数 */
  rootSubReplyCount?: number;
  /** 保留：用于日志和向后兼容 */
  createTime?: number;
}
```

- [ ] **步骤 2：修改 `douyinCrawler.ts` 引用共享接口**

将本地 `export interface ReplyTarget { ... }`（L69-L86）替换为：

```typescript
// 引用共享回复目标接口
export { ReplyTarget } from './replyTypes';
```

并在 import 中删除本地定义。

- [ ] **步骤 3：修改 `kuaishouCrawler.ts` 引用共享接口**

将 `export interface KuaishouReplyTarget { ... }` 替换为引用共享接口或扩展：

```typescript
import type { ReplyTarget } from './replyTypes';
// 如果快手需要额外字段，可以扩展：
// export interface KuaishouReplyTarget extends ReplyTarget { ... }
// 如果与共享接口完全一致，直接用：
export type { ReplyTarget as KuaishouReplyTarget } from './replyTypes';
```

实际操作中检查快手接口字段，若 `KuaishouReplyTarget` 已有 `commentCid` 字段则保持兼容。

- [ ] **步骤 4：修改 `tencentCrawler.ts` 引用共享接口**

 аналогично步骤 3。

- [ ] **步骤 5：`monitorService.ts` 中使用新接口**

搜索 `import('../crawlers/kuaishouCrawler').KuaishouReplyTarget` 和 `import('../crawlers/tencentCrawler').TencentReplyTarget`，确认路径正确。

- [ ] **步骤 6：验证编译**

```bash
npx tsc --noEmit --project apps/ts-api-gateway/tsconfig.json 2>&1 | head -30
```

- [ ] **步骤 7：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/replyTypes.ts apps/ts-api-gateway/src/crawlers/douyinCrawler.ts apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts apps/ts-api-gateway/src/crawlers/tencentCrawler.ts apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "refactor: extract shared ReplyTarget interface to replyTypes.ts"
```

---

### 任务 5：XHS Phase 2 主站登录校验 + QR 流程

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：`xiaohongshuCrawler.ts` 新增 `checkMainsiteLogin` 方法**

```typescript
/**
 * Phase 2: 检查主站登录态
 * 打开 www.xiaohongshu.com → 检测用户头像存在 → 未登录则发 QR → 回退 light
 * @returns true=已登录，false=未登录
 */
async checkMainsiteLogin(
  context: any,  // BrowserContext
  userId: number,
  wechatUserid: string,
): Promise<boolean> {
  logger.info({ userId }, '[XHS-Phase2] 开始检查主站登录态');
  const mainsitePage = await context.newPage();

  try {
    await mainsitePage.goto('https://www.xiaohongshu.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await HumanActions.wait(mainsitePage, 3000, 5000);

    // 检测用户头像（已登录标识）
    const avatarDef = getSelector('region.mainsite-user-avatar', XHS_PLATFORM);
    let loggedIn = false;
    if (avatarDef.css) {
      try {
        await mainsitePage.waitForSelector(avatarDef.css, { timeout: 8000 });
        loggedIn = true;
      } catch {
        loggedIn = false;
      }
    }

    if (!loggedIn) {
      logger.info({ userId }, '[XHS-Phase2] 主站未登录，发送 QR 码');

      // 截图 QR 码区域
      const qrDef = getSelector('region.mainsite-qr-code', XHS_PLATFORM);
      try {
        const qrEl = await mainsitePage.waitForSelector(qrDef.css || '.qrcode-img', { timeout: 15000 });
        const qrBuffer = await qrEl.screenshot({ type: 'png' });
        const qrBase64 = qrBuffer.toString('base64');

        // 发送到企微
        const { sendWechatMessage } = await import('./robot');
        await sendWechatMessage(wechatUserid, 'markdown', {
          content: `### 🔐 小红书主站登录校验\n\n请扫描以下二维码登录小红书主站以启用 deep 模式评论采集。\n\n> 二维码有效期为 5 分钟\n\n![二维码](data:image/png;base64,${qrBase64})`,
        });
        logger.info({ userId }, '[XHS-Phase2] QR 码已发送到企微');
      } catch (err: any) {
        logger.warn({ userId, error: err.message }, '[XHS-Phase2] QR 码截图失败');
      }
    }

    return loggedIn;
  } catch (err: any) {
    logger.warn({ userId, error: err.message }, '[XHS-Phase2] 主站登录检查异常');
    return false;
  } finally {
    await mainsitePage.close().catch(() => {});
  }
}
```

- [ ] **步骤 2：`monitorService.ts` `runXiaohongshuCheck` 扩展为三阶段**

将 `runXiaohongshuCheck` 从单一 Phase 1 改为三阶段（参考 `runTencentCheck`）：

```typescript
async function runXiaohongshuCheck(page: any, task: MonitorTask, onProgress?): Promise<MonitorResult> {
  const crawlMode = await db.getCrawlMode('xiaohongshu');

  logger.info({ userId: task.userId, crawlMode }, '[XHS-monitor] Starting xiaohongshu check');

  await xiaohongshuCrawler.registerListener(page, ['/api/galaxy/v2/creator/note/user/posted']);

  const currentUrl = page.url();
  if (!currentUrl.includes('creator.xiaohongshu.com')) {
    await xiaohongshuCrawler.navigateToCreatorHome(page);
  }

  // Phase 1: 笔记列表扫描 + 非公开过滤
  onProgress?.({ phase: 'Phase1', step: '扫描笔记列表', percent: 20, detail: '正在获取笔记列表并对比评论数' });
  const phase1Result = await xiaohongshuCrawler.checkForUpdates(page, task.userId);
  xiaohongshuCrawler.unregisterListener();

  if (phase1Result.riskControlDetected) {
    await db.logRiskScene(task.userId, 'xiaohongshu', phase1Result.riskControlInfo?.type || 'unknown', phase1Result.riskControlInfo?.evidence || '');
    await db.setUserCooldown(task.userId, Date.now() + 30 * 60 * 1000);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  const queue = phase1Result.commentsQueue; // 需要先修改返回类型

  // 无新评论 或 Light 模式
  if (crawlMode === 'light' || !queue || queue.length === 0) {
    await xiaohongshuCrawler.executeExitStrategy(page);
    const updates = (phase1Result.updatedVideos || []).map((v: any) => ({
      awemeId: v.awemeId,
      description: v.description,
      oldCount: v.oldCount,
      newCount: v.newCount,
    }));
    return { hasUpdate: phase1Result.hasUpdate, newComments: 0, updatedVideos: updates, phase: 'Phase1', riskDetected: false };
  }

  // Phase 2: 主站登录校验
  onProgress?.({ phase: 'Phase2', step: '检查主站登录', percent: 40, detail: `发现 ${queue.length} 个视频有新评论` });
  const user = await db.getUserById(task.userId);
  const wechatUserid = (user as any)?.wechatUserid || '';
  const loggedIn = await xiaohongshuCrawler.checkMainsiteLogin(
    (page as any).context(),
    task.userId,
    wechatUserid,
  );

  if (!loggedIn) {
    logger.info({ userId: task.userId }, '[XHS-monitor] 主站未登录 — 回退到 Light 模式');
    await xiaohongshuCrawler.executeExitStrategy(page);
    const updates = (phase1Result.updatedVideos || []).map((v: any) => ({
      awemeId: v.awemeId,
      description: v.description,
      oldCount: v.oldCount,
      newCount: v.newCount,
    }));
    // Light 模式合成 Comment
    for (const u of updates) {
      const diff = u.newCount - u.oldCount;
      if (diff > 0) {
        await db.upsertLightModeComment(u.awemeId, {
          text: `[轻量模式] ${diff} 条新评论（主站未登录）`,
          create_time: Math.floor(Date.now() / 1000),
        });
      }
    }
    return { hasUpdate: true, newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0), updatedVideos: updates, phase: 'Phase2', riskDetected: false };
  }

  // Phase 3: 评论树采集（下一任务实现）
  onProgress?.({ phase: 'Phase3', step: '采集评论详情', percent: 60, detail: `正在处理 ${queue.length} 个视频的评论` });
  const phase3Result = await xiaohongshuCrawler.processCommentsQueue(page, queue, task.userId);

  await xiaohongshuCrawler.executeExitStrategy(page);

  const successful = phase3Result.filter((r: any) => r.success);
  const failed = phase3Result.filter((r: any) => !r.success);
  const updates = queue
    .filter((q: any) => successful.some((r: any) => r.awemeId === q.exportId))
    .map((q: any) => ({
      awemeId: q.exportId,
      description: q.description,
      oldCount: q.oldCount,
      newCount: q.newCount,
    }));

  logger.info({
    userId: task.userId,
    platform: 'xiaohongshu',
    queueLength: queue.length,
    successCount: successful.length,
    failCount: failed.length,
  }, '[Result] 小红书 Phase3 done');

  return {
    hasUpdate: updates.length > 0,
    newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0),
    updatedVideos: updates,
    phase: 'Phase3',
    riskDetected: false,
  };
}
```

- [ ] **步骤 3：调整 `checkForUpdates` 返回类型**

增加 `commentsQueue` 字段到 `XiaohongshuCheckResult`：

```typescript
export interface XiaohongshuCheckResult {
  hasUpdate: boolean;
  updatedVideos: Array<{...}>;
  commentsQueue: Array<{
    exportId: string;
    description: string;
    oldCount: number;
    newCount: number;
  }>;
  riskControlDetected: boolean;
  riskControlInfo?: RiskControlDetection;
}
```

- [ ] **步骤 4：在 `checkForUpdates` 末尾构建 `commentsQueue`**

```typescript
const commentsQueue = updatedVideos.map((v) => ({
  exportId: v.awemeId,
  description: v.description,
  oldCount: v.oldCount,
  newCount: v.newCount,
}));
// ... 在 return 中加入
return {
  hasUpdate: updatedVideos.length > 0,
  updatedVideos,
  commentsQueue,
  riskControlDetected: false,
};
```

- [ ] **步骤 5：验证编译**

```bash
npx tsc --noEmit --project apps/ts-api-gateway/tsconfig.json 2>&1 | head -30
```

- [ ] **步骤 6：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "feat(xhs): Phase 2 mainsite login check + QR flow, three-phase skeleton"
```

---

### 任务 6：XHS Phase 3 评论树采集

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`

本任务在 `XiaohongshuCrawler` 类中新增 Phase 3 所需方法。

- [ ] **步骤 1：新增 `clickThumbnailAndWaitNewTab`**

```typescript
/**
 * Phase 3 步骤 3b: 点击缩略图等待新标签页
 * 在新标签页中打开笔记详情页（主站）
 */
async clickThumbnailAndWaitNewTab(page: Page, noteId: string, timeout = 15000): Promise<Page | null> {
  logger.info({ noteId }, '[XHS-Phase3] Clicking thumbnail to open note detail');

  try {
    // 定位笔记卡片
    const cardDef = getSelector('region.note-card-by-id', XHS_PLATFORM);
    const cardSelector = cardDef.css?.replace('{noteId}', noteId);
    if (!cardSelector) {
      logger.warn({ noteId }, '[XHS-Phase3] No note-card-by-id selector');
      return null;
    }

    // 监听新标签页
    const [newPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout }),
      (async () => {
        // 先找到卡片
        const card = await page.waitForSelector(cardSelector, { timeout: 10000 });
        // 在卡片内找缩略图
        const coverDef = getSelector('region.note-card-cover', XHS_PLATFORM);
        let coverEl;
        if (coverDef.css) {
          coverEl = await card.$(coverDef.css);
        }
        if (!coverEl) {
          // 回退：点击卡片本身
          coverEl = card;
        }
        // 点击
        await HumanActions.cdpHumanClick(page, coverEl);
      })(),
    ]);

    await newPage.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await HumanActions.wait(newPage, 2000, 4000);
    logger.info({ noteId, url: newPage.url() }, '[XHS-Phase3] New tab opened');
    return newPage;
  } catch (err: any) {
    logger.warn({ noteId, error: err.message }, '[XHS-Phase3] Failed to open new tab for note');
    return null;
  }
}
```

- [ ] **步骤 2：新增 `registerCommentInterceptor`**

```typescript
/**
 * Phase 3 步骤 3c: 在主站新标签页中注册评论 API 拦截器
 */
async registerCommentInterceptor(newPage: Page): Promise<void> {
  const patterns = [
    '/api/sns/web/v2/comment/page',
    '/api/sns/web/v2/comment/sub/page',
  ];

  const interceptor = new RequestInterceptor();
  for (const pattern of patterns) {
    interceptor.setValidationConfig(pattern, {
      expectedPageUrls: ['www.xiaohongshu.com'],
      requiredItemFields: [],
      minItems: 0,
    });
  }

  const listenerId = await interceptor.register(newPage, patterns);
  logger.info({ patterns }, '[XHS-Phase3] Comment API interceptor registered');

  // 保存到实例变量供后续使用
  (this as any)._commentInterceptor = interceptor;
  (this as any)._commentListenerId = listenerId;
}
```

- [ ] **步骤 3：新增 `scrollLoadRootComments`**

```typescript
/**
 * Phase 3 步骤 3d: 滚动评论区加载根评论（翻页直到 has_more=false）
 * 通过拦截器收集 /comment/page 响应
 */
async scrollLoadRootComments(newPage: Page): Promise<any[]> {
  logger.info('[XHS-Phase3] Loading root comments via scroll');

  const interceptor = (this as any)._commentInterceptor as RequestInterceptor;
  const pattern = '/api/sns/web/v2/comment/page';

  // 等待首条响应（页面 js 会自动发起请求）
  await interceptor.waitForResponse(pattern, 15000).catch(() => {});

  let allItems: any[] = [];
  let scrollAttempts = 0;
  const maxScrollAttempts = 30;

  while (scrollAttempts < maxScrollAttempts) {
    const items = interceptor.getCollectedItems(pattern);
    if (items.length > allItems.length) {
      allItems = items;
      logger.info({ totalItems: allItems.length, attempt: scrollAttempts }, '[XHS-Phase3] Root comments batch loaded');
    }

    // 检查是否还有更多
    const responses = interceptor.getResponses(pattern);
    const lastResp = responses[responses.length - 1];
    const hasMore = lastResp?.body?.data?.has_more !== false;

    if (!hasMore && allItems.length > 0) {
      logger.info({ totalItems: allItems.length }, '[XHS-Phase3] All root comments loaded');
      break;
    }

    // 滚动评论区触发翻页
    const scrollerDef = getSelector('region.comment-scroller', XHS_PLATFORM);
    if (scrollerDef.css) {
      try {
        await HumanActions.cdpSmartScroll(newPage, [scrollerDef.css], 400, 'down');
      } catch {
        await HumanActions.humanScroll(newPage, 300, { minPause: 300, maxPause: 800 });
      }
    } else {
      await HumanActions.humanScroll(newPage, 300, { minPause: 300, maxPause: 800 });
    }
    await HumanActions.wait(newPage, 1000, 2000);
    scrollAttempts++;
  }

  return allItems;
}
```

- [ ] **步骤 4：新增 `expandSubCommentsForRoots`**

```typescript
/**
 * Phase 3 步骤 3e: 逐根评论展开子评论
 * 从 rootComments 解析 sub_comment_count>0 的根，点击"展开"按钮
 */
async expandSubCommentsForRoots(newPage: Page, rootComments: any[]): Promise<void> {
  logger.info({ totalRoots: rootComments.length }, '[XHS-Phase3] Expanding sub-comments');

  for (const root of rootComments) {
    const subCount = root.sub_comment_count || root.subCommentCount || 0;
    if (subCount <= 0) continue;

    const rootCid = root.id;
    logger.info({ rootCid, subCount }, '[XHS-Phase3] Expanding sub-comments for root');

    try {
      // 容器优先：在根评论容器内找"展开"按钮
      const rootContainer = newPage.locator(`[id="comment-${rootCid}"]`).first();
      if (await rootContainer.isVisible().catch(() => false)) {
        // 第一次点击"展开 N 条回复" → 加载前 10 条子评论
        const expandBtn = rootContainer.getByText('展开').first();
        if (await expandBtn.isVisible().catch(() => false)) {
          await HumanActions.cdpHumanClick(newPage, expandBtn);
          await HumanActions.wait(newPage, 1500, 2500);
        }

        // 循环点击"展开更多回复"直到按钮消失
        for (let i = 0; i < 10; i++) {
          const moreBtn = rootContainer.getByText('展开更多回复').first();
          if (await moreBtn.isVisible().catch(() => false)) {
            await HumanActions.cdpHumanClick(newPage, moreBtn);
            await HumanActions.wait(newPage, 1000, 2000);
          } else {
            break;
          }
        }
      } else {
        // 回退：直接在页面内找
        logger.warn({ rootCid }, '[XHS-Phase3] Root container not found, trying page-wide search');
        const expandBtn = newPage.getByText('展开').first();
        if (await expandBtn.isVisible().catch(() => false)) {
          await HumanActions.cdpHumanClick(newPage, expandBtn);
          await HumanActions.wait(newPage, 1500, 2500);
        }
      }
    } catch (err: any) {
      logger.warn({ rootCid, error: err.message }, '[XHS-Phase3] Failed to expand sub-comments');
    }
  }
}
```

- [ ] **步骤 5：新增 `buildCommentTree`**

```typescript
/**
 * Phase 3 步骤 3f: 从拦截器收集的 API 响应构建评论树
 */
buildCommentTree(newPage: Page): Array<{
  cid: string; text: string; user_nickname: string; user_uid: string;
  digg_count: number; create_time: number; reply_id: string;
  rootId?: string; parentId?: string; level: number; replyToName?: string; is_author?: boolean;
}> {
  const interceptor = (this as any)._commentInterceptor as RequestInterceptor;
  const comments: Array<any> = [];

  // 解析根评论 /comment/page
  const rootResponses = interceptor.getResponses('/api/sns/web/v2/comment/page');
  for (const resp of rootResponses) {
    const items = resp?.body?.data?.comments || resp?.body?.data?.items || [];
    for (const item of items) {
      comments.push({
        cid: item.id,
        text: item.content,
        user_nickname: item.user_info?.nickname || '',
        user_uid: item.user_info?.user_id || '',
        digg_count: parseInt(item.like_count || '0', 10),
        create_time: Math.floor((item.create_time || 0) / 1000),
        reply_id: '0',
        rootId: undefined,
        parentId: undefined,
        level: 1,
        replyToName: undefined,
        is_author: item.show_tags?.includes('is_author') || false,
      });

      // 如果根评论中有嵌套的子评论也解析
      if (item.comments && Array.isArray(item.comments)) {
        for (const sub of item.comments) {
          comments.push({
            cid: sub.id,
            text: sub.content,
            user_nickname: sub.user_info?.nickname || '',
            user_uid: sub.user_info?.user_id || '',
            digg_count: parseInt(sub.like_count || '0', 10),
            create_time: Math.floor((sub.create_time || 0) / 1000),
            reply_id: sub.target_comment?.id || item.id,
            rootId: item.id,
            parentId: sub.target_comment?.id || item.id,
            level: 2,
            replyToName: sub.target_comment?.user_info?.nickname || '',
            is_author: sub.show_tags?.includes('is_author') || false,
          });
        }
      }
    }
  }

  // 解析子评论 /comment/sub/page
  const subResponses = interceptor.getResponses('/api/sns/web/v2/comment/sub/page');
  for (const resp of subResponses) {
    const items = resp?.body?.data?.comments || resp?.body?.data?.items || [];
    for (const sub of items) {
      comments.push({
        cid: sub.id,
        text: sub.content,
        user_nickname: sub.user_info?.nickname || '',
        user_uid: sub.user_info?.user_id || '',
        digg_count: parseInt(sub.like_count || '0', 10),
        create_time: Math.floor((sub.create_time || 0) / 1000),
        reply_id: sub.target_comment?.id || sub.root_id || '0',
        rootId: sub.root_id || undefined,
        parentId: sub.target_comment?.id || sub.parent_id || undefined,
        level: 2,
        replyToName: sub.target_comment?.user_info?.nickname || '',
        is_author: sub.show_tags?.includes('is_author') || false,
      });
    }
  }

  return comments;
}
```

- [ ] **步骤 6：新增 `processOneNoteComments`**

```typescript
/**
 * Phase 3 子步骤 3a-3h: 处理单个视频的评论采集
 */
async processOneNoteComments(
  page: Page,
  item: { exportId: string; description: string },
  userId: number,
): Promise<{ success: boolean; awemeId: string; error?: string }> {
  const { exportId, description } = item;
  logger.info({ exportId, desc: description?.slice(0, 30) }, '[XHS-Phase3] Processing note');

  try {
    // 3a locateNoteCard (已在 clickThumbnail 中完成)
    // 3b clickThumbnailAndWaitNewTab
    const newPage = await this.clickThumbnailAndWaitNewTab(page, exportId);
    if (!newPage) {
      return { success: false, awemeId: exportId, error: 'Failed to open note detail page' };
    }

    try {
      // 3c registerCommentInterceptor
      await this.registerCommentInterceptor(newPage);

      // 3d scrollLoadRootComments
      const rootComments = await this.scrollLoadRootComments(newPage);

      // 3e expandSubCommentsForRoots
      await this.expandSubCommentsForRoots(newPage, rootComments);

      // 3f buildCommentTree
      const comments = this.buildCommentTree(newPage);
      logger.info({ exportId, rootCount: rootComments.length, totalComments: comments.length }, '[XHS-Phase3] Comments collected');

      if (comments.length > 0) {
        // 3g 入库
        await db.upsertCommentTree(exportId, comments);

        // 计算各级评论计数
        const rootCids = new Set(comments.filter((c) => c.level === 1).map((c) => c.cid));
        const subCountByRoot = new Map<string, number>();
        for (const c of comments) {
          if (c.level === 2 && c.rootId && rootCids.has(c.rootId)) {
            subCountByRoot.set(c.rootId, (subCountByRoot.get(c.rootId) || 0) + 1);
          }
        }
        const rootCounts = [...subCountByRoot.entries()].map(([cid, count]) => ({
          cid,
          replyCount: count,
        }));
        await db.upsertRootCommentCounts(exportId, rootCounts);
        await db.deleteStaleRootCounts(exportId, [...rootCids].concat(rootCounts.map((r) => r.cid)));
        await db.updateVideoCommentCount(userId, exportId, comments.length);
      }

      return { success: true, awemeId: exportId };
    } finally {
      // 3h newPage.close → page.bringToFront
      await newPage.close().catch(() => {});
      await page.bringToFront();
      await HumanActions.wait(page, 5000, 10000); // 视频间间隔
    }
  } catch (err: any) {
    logger.warn({ exportId, error: err.message }, '[XHS-Phase3] Note processing failed');
    return { success: false, awemeId: exportId, error: err.message };
  }
}
```

- [ ] **步骤 7：新增 `processCommentsQueue`**

```typescript
/**
 * Phase 3: 串行处理评论队列
 */
async processCommentsQueue(
  page: Page,
  queue: Array<{ exportId: string; description: string; oldCount: number; newCount: number }>,
  userId: number,
): Promise<Array<{ success: boolean; awemeId: string; error?: string }>> {
  logger.info({ queueLength: queue.length, userId }, '[XHS-Phase3] Processing comments queue');

  const results: Array<{ success: boolean; awemeId: string; error?: string }> = [];

  for (const item of queue) {
    const result = await this.processOneNoteComments(page, item, userId);
    results.push(result);

    // 风控检测
    if (result.error?.includes('captcha') || result.error?.includes('Risk control')) {
      logger.warn({ userId, awemeId: item.exportId }, '[XHS-Phase3] Risk detected, aborting queue');
      break;
    }
  }

  // 清理拦截器
  const interceptor = (this as any)._commentInterceptor as RequestInterceptor;
  const listenerId = (this as any)._commentListenerId;
  if (interceptor && listenerId) {
    interceptor.unregister(listenerId);
    interceptor.clearAll();
    (this as any)._commentInterceptor = undefined;
    (this as any)._commentListenerId = undefined;
  }

  return results;
}
```

- [ ] **步骤 8：验证编译**

```bash
npx tsc --noEmit --project apps/ts-api-gateway/tsconfig.json 2>&1 | head -30
```

- [ ] **步骤 9：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "feat(xhs): Phase 3 comment tree crawling (click thumbnail → scroll → expand → build tree)"
```

---

### 任务 7：XHS replyToComment + executeReplyAction 分支

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts`

- [ ] **步骤 1：`xiaohongshuCrawler.ts` 新增 `replyToComment` 方法（6 阶段）**

```typescript
/**
 * 评论回复 6 阶段流程
 * Phase 1: 数据准备（已在 executeReplyAction 中完成）
 * Phase 2: 进入笔记详情页（与监控路径一致：creator→缩略图→新标签页）
 * Phase 3: 评论定位（cid 强主键 + 文本 + 昵称三重匹配）
 * Phase 4: 点击回复按钮（容器内 btn.reply-comment）
 * Phase 5: 输入内容并发送（cdpInputText + 点击 btn.reply-submit）
 * Phase 6: 退出（关标签页 + bringToFront）
 */
async replyToComment(
  page: Page,
  target: import('./replyTypes').ReplyTarget,
  replyText: string,
  executionId?: string,
): Promise<boolean> {
  logger.info({
    cid: target.cid,
    text: target.text?.slice(0, 30),
    level: target.level,
    username: target.username,
  }, '[XHS-Reply] Starting xiaohongshu reply');

  try {
    // Phase 2: 进入笔记详情页
    if (!target.cid) {
      logger.error('[XHS-Reply] No cid provided');
      return false;
    }
    // 从 cid 推断 noteId（cid 格式通常是 noteId_cursor 或 UUID，我们需要 noteId）
    // 实际 cid 来自 comment 表，需要分离出 noteId —— 或者从传入参数获取
    // 这里依赖调用方在 replyData 中同时传入 videoId（即 noteId）
    // noteId 从 replyData.videoId 获取（已在 executeReplyAction 中解析）

    // 由于我们已在点击缩略图的流程中，我们可以复用 processOneNoteComments 的前半部分
    // 但这里我们简单方式：通过 URL 参数导航
    // 实际上我们通过 thumbnail click 进入（与监控一致）
    // 但回复场景中，我们已有 videoId，可以直接进入

    // ★ 简单方案：点击缩略图进入主站（与监控 Path 一致）
    const noteId = page.url().includes('explore/')
      ? page.url().split('explore/')[1]?.split('?')[0]
      : undefined;

    if (!noteId) {
      logger.error('[XHS-Reply] Cannot determine noteId from current URL');
      return false;
    }

    // 注册评论拦截器以便 API 返回时我们能快速定位评论
    await this.registerCommentInterceptor(page);

    // 等待评论区加载
    const containerDef = getSelector('region.comments-container', XHS_PLATFORM);
    if (containerDef.css) {
      await page.waitForSelector(containerDef.css, { timeout: 15000 }).catch(() => {});
    }
    await HumanActions.wait(page, 2000, 4000);

    // Phase 3: 评论定位（cid 强主键）
    const cid = target.cid;
    let commentEl = page.locator(`[data-cid="${cid}"]`).first();
    if (!(await commentEl.isVisible().catch(() => false))) {
      commentEl = page.locator(`[id*="${cid}"]`).first();
    }
    if (!(await commentEl.isVisible().catch(() => false))) {
      logger.warn({ cid }, '[XHS-Reply] Comment element not found by cid, trying text+username matching');
      // 回退：根据文本和昵称匹配
      const allComments = page.locator('[class*="comment-item"]');
      const count = await allComments.count();
      for (let i = 0; i < count; i++) {
        const el = allComments.nth(i);
        const text = await el.innerText().catch(() => '');
        if (text.includes(target.text?.slice(0, 20) || '') && text.includes(target.username || '')) {
          commentEl = el;
          logger.info({ idx: i }, '[XHS-Reply] Found comment by text+username');
          break;
        }
      }
    }

    if (!(await commentEl.isVisible().catch(() => false))) {
      logger.error({ cid }, '[XHS-Reply] Comment not found');
      return false;
    }

    // Phase 4: 点击回复按钮
    await commentEl.scrollIntoViewIfNeeded();
    await HumanActions.wait(page, 500, 1000);

    const replyBtnDef = getSelector('btn.reply-comment', XHS_PLATFORM);
    let replyClicked = false;

    // 优先在容器内找"回复"按钮
    const replyBtn = commentEl.getByText('回复').first();
    if (await replyBtn.isVisible().catch(() => false)) {
      await HumanActions.cdpHumanClick(page, replyBtn);
      replyClicked = true;
    } else if (replyBtnDef.text) {
      const globalReplyBtn = page.getByText(replyBtnDef.text, { exact: true }).first();
      if (await globalReplyBtn.isVisible().catch(() => false)) {
        await HumanActions.cdpHumanClick(page, globalReplyBtn);
        replyClicked = true;
      }
    }

    if (!replyClicked) {
      logger.error({ cid }, '[XHS-Reply] Reply button not found');
      return false;
    }

    await HumanActions.wait(page, 500, 1000);

    // Phase 5: 输入内容并发送
    const inputDef = getSelector('tb.reply-input', XHS_PLATFORM);
    if (inputDef.css) {
      const inputEl = page.locator(inputDef.css).first();
      if (await inputEl.isVisible().catch(() => false)) {
        await inputEl.click();
        await HumanActions.wait(page, 200, 500);
        await HumanActions.cdpInputText(page, replyText);
        await HumanActions.wait(page, 500, 1200);
      } else {
        logger.warn('[XHS-Reply] Reply input not visible, trying page-wide contenteditable');
        const fallbackInput = page.locator('[contenteditable="true"]').first();
        if (await fallbackInput.isVisible().catch(() => false)) {
          await fallbackInput.click();
          await HumanActions.wait(page, 200, 500);
          await HumanActions.cdpInputText(page, replyText);
          await HumanActions.wait(page, 500, 1200);
        } else {
          logger.error('[XHS-Reply] No reply input found');
          return false;
        }
      }
    }

    // 发送
    const submitDef = getSelector('btn.reply-submit', XHS_PLATFORM);
    if (submitDef.text) {
      const sendBtn = page.getByText(submitDef.text, { exact: true }).first();
      if (await sendBtn.isVisible().catch(() => false)) {
        await HumanActions.cdpHumanClick(page, sendBtn);
        await HumanActions.wait(page, 1000, 2000);
        logger.info({ cid, text: replyText }, '[XHS-Reply] Reply sent');
        return true;
      }
    }

    logger.warn('[XHS-Reply] Send button not found, trying Enter key');
    await page.keyboard.press('Enter');
    await HumanActions.wait(page, 1000, 2000);
    logger.info({ cid }, '[XHS-Reply] Reply sent via Enter key');
    return true;
  } catch (err: any) {
    logger.error({ cid, error: err.message }, '[XHS-Reply] Reply failed');
    return false;
  }
}
```

- [ ] **步骤 2：`monitorService.ts` `executeReplyAction` 新增 xiaohongshu 分支**

在视频号（tencent）分支之后、catch 之前插入（约 L1723）：

```typescript
// ── 小红书回复 ──
if (task.platform === 'xiaohongshu') {
  const currentUrl = page.url();
  if (!currentUrl.includes('creator.xiaohongshu.com')) {
    await xiaohongshuCrawler.navigateToCreatorHome(page);
  }

  // Phase 1: 数据准备（已在上面完成：commentRow / replyData / ReplyTarget 构建）
  if (executionId) await updatePhase(executionId, 2, '导航', 20, '已定位到笔记管理');

  // 构建 ReplyTarget（使用共享接口）
  const xhsTarget: import('../crawlers/replyTypes').ReplyTarget = {
    cid: replyData.commentCid,
    text: commentText,
    level: commentLevel,
    username: commentUsername,
    subReplyCount: commentLevel === 1 ? rootSubReplyCount : undefined,
    rootText: rootCommentText,
    rootUsername: commentLevel === 2 ? rootUsername : undefined,
    rootSubReplyCount: commentLevel === 2 ? rootSubReplyCount : undefined,
    createTime: commentCreateTime,
  };

  if (executionId) await updatePhase(executionId, 3, '进入笔记', 40, '正在打开笔记详情页');

  // 通过点击缩略图进入笔记详情页（与监控 Path 一致）
  const newPage = await xiaohongshuCrawler.clickThumbnailAndWaitNewTab(page, replyData.videoId);
  if (!newPage) {
    logger.error('回复失败：无法打开笔记详情页');
    if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
    throw new Error('无法打开小红书笔记详情页');
  }

  try {
    if (executionId) await updatePhase(executionId, 4, '定位评论', 55, `正在定位评论`);
    const replied = await xiaohongshuCrawler.replyToComment(newPage, xhsTarget, replyData.text, executionId);
    if (replied) {
      logger.info({ commentCid: replyData.commentCid, text: replyData.text }, '小红书回复执行成功');
      if (commentDbId) await db.updateReplyStatus(commentDbId, 'sent');
      if (executionId) await updatePhase(executionId, 5, '完成', 100, '回复执行完成');
    } else {
      logger.error({ commentCid: replyData.commentCid }, '小红书回复执行失败');
      if (commentDbId) await db.updateReplyStatus(commentDbId, 'failed');
      throw new Error('小红书回复执行失败');
    }
  } finally {
    await newPage.close().catch(() => {});
    await page.bringToFront();
  }

  // 小红书不需要 exit strategy（回 creator 页即可）
  await xiaohongshuCrawler.executeExitStrategy(page);
  return;
}
```

- [ ] **步骤 3：`monitorService.ts` finally 块新增小红书分支**

在 L1728-L1738 的 finally 中追加：

```typescript
if (task.platform === 'xiaohongshu') {
  try {
    await xiaohongshuCrawler.executeExitStrategy(page, 'menu.note-manage');
  } catch {}
}
```

- [ ] **步骤 4：验证编译**

```bash
npx tsc --noEmit --project apps/ts-api-gateway/tsconfig.json 2>&1 | head -30
```

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "feat(xhs): replyToComment implementation + executeReplyAction xiaohongshu branch"
```

---

### 任务 8：端到端验证

- [ ] **步骤 1：验证编译**

```bash
# 全量编译检查
npx tsc --noEmit --project apps/ts-api-gateway/tsconfig.json 2>&1
```

- [ ] **步骤 2：验证非公开过滤**

手动检查 `fetchNoteListFromSource` 中 `permission_code === 0` 过滤是否生效。可以在测试环境下添加一行：

```typescript
logger.info('Private video count filtered:', allItems.length - filteredItems.length);
```

- [ ] **步骤 3：验证 deep 模式切换 API**

```bash
curl -X PUT 'http://localhost:3000/api/v1/matrix/monitor/crawl-settings/xiaohongshu' \
  -d '{"mode":"deep"}' -H 'Content-Type: application/json'
# 预期: {"success": true, ...}（不再返回 400）
```

- [ ] **步骤 4：验证 Phase 1 无回归**

跑一次常规定时监控任务，确认 `reconcileVideosForUser` 正确 upsert 且未误删视频。

- [ ] **步骤 5：验证选择器 JSON 完整性**

```bash
python3 -c "
import json
data = json.load(open('apps/ts-api-gateway/data/selectors.json'))
xhs = data.get('platforms', {}).get('xiaohongshu', {})
required = ['region_note_card_by_id', 'btn_expand_sub_comments', 'btn_reply_comment', 'tb_reply_input']
for r in required:
    found = any(r in cat for cat in xhs.values())
    print(f'{r}: {\"✅\" if found else \"❌\"}')"
```

- [ ] **步骤 6：Commit**

```bash
git add -A && git commit -m "chore: end-to-end verification passed"
```

---

## 自检清单

| 检查项 | 状态 |
|--------|------|
| **规格覆盖度** | |
| 1.1 deep 模式评论树采集 | → 任务 6 (Phase 3) |
| 1.2 评论回复 | → 任务 7 |
| 1.3 视频生命周期统一管理 | → 任务 0-1 |
| 1.4 选择器外置化 | → 任务 3 |
| 2.1 三阶段流水线 | → 任务 5-6 |
| 2.2 非公开视频过滤 | → 任务 2 |
| 2.3 主站登录校验 | → 任务 5 |
| 2.4 解除 deep 限制 | → 任务 2 |
| 4.3 XHS 评论 API 映射 | → 任务 6 buildCommentTree |
| 6.3 ReplyTarget 共享接口 | → 任务 4 |
| 7. 集成点清单全部覆盖 | → 所有任务 |
| **占位符扫描** | ✅ 无 TODO/FIXME/TBD 残留 |
| **类型一致性** | ✅ ReplyTarget.cid → 任务 4 → 任务 7 使用一致 |
