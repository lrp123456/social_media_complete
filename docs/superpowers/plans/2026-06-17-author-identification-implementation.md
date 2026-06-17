# 作者识别与评论通知优化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 全平台统一作者身份识别机制，通知只针对非作者评论触发，作者评论仅更新评论树

**架构：** Phase1 视频列表 API 提取 authorUid → 写入/校验 `User.platformAuthorId`（自愈）→ 评论入库时计算 `isAuthor`（抖音优先 `label_type`，其他用 ID 比对）→ 通知层依赖 `isAuthor` 字段过滤而非 UID 比对

**技术栈：** TypeScript, Prisma, BullMQ, patchright

---

## 文件清单

| 文件 | 改动职责 |
|------|---------|
| `apps/ts-api-gateway/src/services/monitorDatabaseService.ts` | 新增 `syncPlatformAuthorId` 自愈函数；修复视频号 `userUid` 存储 |
| `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | `parseCommentList` 保留 `label_type`；首爬路径补全 `is_author`；改用 `syncPlatformAuthorId` |
| `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts` | `is_author` 改为 ID 比对；改用 `syncPlatformAuthorId` |
| `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts` | Phase1 提取 `finder_id`；`is_author` 改为 ID 比对；评论 `user_uid` 改存 `username` |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` | Phase1 提取笔记作者 ID（仅绑定，不改评论） |
| `apps/ts-api-gateway/src/services/unifiedQueue.ts` | 通知过滤改用 `!isAuthor` 字段判断 |
| `apps/ts-api-gateway/src/routes/matrix.ts` | 手动触发端点补全去重 |

---

## 通用编译验证命令

每个任务完成后运行（grep 出现 `_phase3Result`、`innerText`、`withCDPContext`、`Symbol.iterator`、`click.*does not exist`、`IRedisClient` 等都是预存错误，可忽略）：

```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep -E "<目标文件>"
```

预期：无新增错误。
</content>
</invoke>
---

## 任务 1：新增 syncPlatformAuthorId 自愈函数

**文件：** 修改 `apps/ts-api-gateway/src/services/monitorDatabaseService.ts`（在文件末尾追加）

**目的：** 提供统一的作者 ID 绑定与自愈接口，所有平台的 Phase1 都调用它。

- [ ] **步骤 1：在文件末尾追加函数**

```typescript
/**
 * 同步平台作者 ID（首次绑定 + 自愈检测）
 * - 数据库中无 platformAuthorId → 写入新值
 * - 数据库中已有但与新值不一致 → 更新并记录告警
 * - 已一致 → 跳过（零开销）
 */
export async function syncPlatformAuthorId(
  userId: number,
  newAuthorId: string | number | undefined | null,
  newAuthorName?: string | null,
): Promise<void> {
  if (newAuthorId === undefined || newAuthorId === null || newAuthorId === '') {
    return;
  }

  const newAuthorIdStr = String(newAuthorId);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformAuthorId: true, platform: true },
  });
  if (!user) return;

  const currentId = user.platformAuthorId ?? null;

  if (currentId === null) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        platformAuthorId: newAuthorIdStr,
        platformAuthorName: newAuthorName || '',
      },
    });
    logger.info(
      { userId, platform: user.platform, authorId: newAuthorIdStr },
      '[AuthorSync] 首次绑定平台作者 ID',
    );
    return;
  }

  if (currentId !== newAuthorIdStr) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        platformAuthorId: newAuthorIdStr,
        platformAuthorName: newAuthorName || '',
      },
    });
    logger.warn(
      { userId, platform: user.platform, oldAuthorId: currentId, newAuthorId: newAuthorIdStr },
      '[AuthorSync] 平台作者 ID 变更，已更新',
    );
  }
}
```

- [ ] **步骤 2：编译验证**

`cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep monitorDatabaseService.ts | grep -v "_phase3Result\|innerText"`

预期：无新增错误。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorDatabaseService.ts
git commit -m "feat(author-sync): add syncPlatformAuthorId for binding + self-heal"
```

---

## 任务 2：修复视频号 userUid 存储错误

**文件：** 修改 `apps/ts-api-gateway/src/services/monitorDatabaseService.ts:551`

**目的：** 视频号评论 userUid 当前存的是头像 URL，改为优先使用调用方传入的真实用户 ID。

- [ ] **步骤 1：修改第 551 行**

将：
```typescript
          userUid: c.head_img_url,
```

替换为：
```typescript
          userUid: c.user_uid || c.head_img_url || '',
```

向后兼容：调用方传 `user_uid` 时优先使用，否则保持旧行为。

- [ ] **步骤 2：编译验证**

`cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep monitorDatabaseService.ts | grep -v "_phase3Result\|innerText"`

预期：无新增错误。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorDatabaseService.ts
git commit -m "fix(tencent): prefer user_uid over avatar URL for comment userUid"
```

---

## 任务 3：抖音 parseCommentList 保留 label_type

**文件：** 修改 `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:734-742` 和 `:757-764`

**目的：** 解析评论时保留服务端权威作者标记 `label_type === 1`。

- [ ] **步骤 1：修改 parseCommentList 的 return 块（约 line 734-742）**

将：
```typescript
    return rootComments.map((c: any) => ({
      cid: c.cid,
      text: c.text || '',
      user_nickname: c.user?.nickname || '',
      user_uid: c.user?.uid || '',
      digg_count: c.digg_count || 0,
      create_time: c.create_time,
      reply_id: String(c.reply_id ?? c.replyId ?? '0'),
    }));
```

替换为：
```typescript
    return rootComments.map((c: any) => ({
      cid: c.cid,
      text: c.text || '',
      user_nickname: c.user?.nickname || '',
      user_uid: c.user?.uid || '',
      digg_count: c.digg_count || 0,
      create_time: c.create_time,
      reply_id: String(c.reply_id ?? c.replyId ?? '0'),
      label_type: c.label_type ?? 0,
      label_text: c.label_text || '',
    }));
```

- [ ] **步骤 2：修改 parseRootCommentSnapshots 的 return 块（约 line 757-764）**

将：
```typescript
      .map((c: any) => ({
        cid: c.cid,
        text: c.text || '',
        replyCount: c.reply_comment_total ?? 0,
        createTime: c.create_time,
        userUid: c.user?.uid || '',
        userNickname: c.user?.nickname || '',
      }));
```

替换为：
```typescript
      .map((c: any) => ({
        cid: c.cid,
        text: c.text || '',
        replyCount: c.reply_comment_total ?? 0,
        createTime: c.create_time,
        userUid: c.user?.uid || '',
        userNickname: c.user?.nickname || '',
        labelType: c.label_type ?? 0,
      }));
```

- [ ] **步骤 3：扩展 CommentInfo 和 RootCommentSnapshot 类型（如有显式定义）**

```bash
grep -n "interface CommentInfo\|interface RootCommentSnapshot\|type CommentInfo\|type RootCommentSnapshot" apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
```

如有显式 interface，分别添加可选字段：

CommentInfo 添加：`label_type?: number; label_text?: string;`
RootCommentSnapshot 添加：`labelType?: number;`

如果 grep 无结果（inline 推断），跳过此步。

- [ ] **步骤 4：编译验证**

`cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep douyinCrawler.ts | grep -v "withCDPContext\|innerText\|click.*does not exist\|Symbol.iterator"`

预期：无新增错误。

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): preserve label_type in parseCommentList"
```

---

## 任务 4：抖音首爬路径补全 isAuthor + commentGroups 过滤

**文件：** 修改 `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:1643-1750`

**目的：** 首次爬取也要正确计算 `isAuthor` 并在构建 `commentGroups` 时过滤作者评论。

- [ ] **步骤 1：在首爬路径开头查询 platformAuthorId**

在 line 1643 `if (isFirstCrawl) {` 之后、line 1648 `logger.info(...)` 之前插入：

```typescript
          // 查询作者 ID 用于 isAuthor 判断
          const firstCrawlUser = await db.getUserById(item._userId!);
          const firstCrawlAuthorId = firstCrawlUser?.platformAuthorId;

```

- [ ] **步骤 2：扩展 allFlat 类型并添加 is_author 字段**

将 line 1664-1668 的 `allFlat` 类型定义：

```typescript
          const allFlat: Array<{
            cid: string; text: string; user_nickname: string; user_uid: string;
            digg_count: number; create_time: number; reply_id: string;
            rootId?: string; parentId?: string; level: number; replyToName?: string;
          }> = [];
```

替换为：

```typescript
          const allFlat: Array<{
            cid: string; text: string; user_nickname: string; user_uid: string;
            digg_count: number; create_time: number; reply_id: string;
            rootId?: string; parentId?: string; level: number; replyToName?: string;
            is_author?: boolean;
          }> = [];
```

- [ ] **步骤 3：在 root 推入逻辑中加 is_author**

将 line 1670-1677 的：
```typescript
          for (const root of rootComments) {
            allFlat.push({
              cid: root.cid, text: root.text || '',
              user_nickname: root.user?.nickname || '', user_uid: root.user?.uid || '',
              digg_count: root.digg_count || 0, create_time: root.create_time,
              reply_id: '0', level: 1,
            });
          }
```

替换为：
```typescript
          for (const root of rootComments) {
            const rootUid = root.user?.uid || '';
            const rootIsAuthor = (root.label_type === 1)
              || (firstCrawlAuthorId ? String(rootUid) === String(firstCrawlAuthorId) : false);
            allFlat.push({
              cid: root.cid, text: root.text || '',
              user_nickname: root.user?.nickname || '', user_uid: rootUid,
              digg_count: root.digg_count || 0, create_time: root.create_time,
              reply_id: '0', level: 1,
              is_author: rootIsAuthor,
            });
          }
```

- [ ] **步骤 4：在 sub 推入逻辑中加 is_author**

将 line 1678-1687 的：
```typescript
          for (const sub of subReplies) {
            const replyId = String(sub.reply_id ?? '0');
            allFlat.push({
              cid: sub.cid, text: sub.text || '',
              user_nickname: sub.user?.nickname || '', user_uid: sub.user?.uid || '',
              digg_count: sub.digg_count || 0, create_time: sub.create_time,
              reply_id: replyId, rootId: replyId, parentId: replyId,
              level: 2, replyToName: sub.reply_to_username || '',
            });
          }
```

替换为：
```typescript
          for (const sub of subReplies) {
            const replyId = String(sub.reply_id ?? '0');
            const subUid = sub.user?.uid || '';
            const subIsAuthor = (sub.label_type === 1)
              || (firstCrawlAuthorId ? String(subUid) === String(firstCrawlAuthorId) : false);
            allFlat.push({
              cid: sub.cid, text: sub.text || '',
              user_nickname: sub.user?.nickname || '', user_uid: subUid,
              digg_count: sub.digg_count || 0, create_time: sub.create_time,
              reply_id: replyId, rootId: replyId, parentId: replyId,
              level: 2, replyToName: sub.reply_to_username || '',
              is_author: subIsAuthor,
            });
          }
```

- [ ] **步骤 5：在首爬 commentGroups 构建处过滤作者评论**

修改 line 1697-1746 的首爬 `commentGroups` 构建逻辑。在 `firstCrawlGroups.push(...)` 之前过滤掉作者评论。

将 line 1736-1745：
```typescript
            const groupNew: CommentNode[] = [
              rootNode,
              ...groupSubs,
            ];

            firstCrawlGroups.push({
              rootComment: rootNode,
              subReplies: groupSubs,
              newInGroup: groupNew,
            });
```

替换为：
```typescript
            // 过滤作者评论（label_type 优先，UID 兜底）
            const isRootAuthor = (root.label_type === 1)
              || (firstCrawlAuthorId ? String(rootNode.userUid) === String(firstCrawlAuthorId) : false);
            const nonAuthorSubs = groupSubs.filter(s => {
              const subUid = s.userUid;
              const subLabelType = (subReplies.find((r: any) => String(r.cid) === s.cid)?.label_type) ?? 0;
              const subIsAuthor = (subLabelType === 1)
                || (firstCrawlAuthorId ? String(subUid) === String(firstCrawlAuthorId) : false);
              return !subIsAuthor;
            });

            const groupNew: CommentNode[] = [
              ...(isRootAuthor ? [] : [rootNode]),
              ...nonAuthorSubs,
            ];

            // 如果整个 group 全是作者评论，跳过该 group
            if (groupNew.length === 0) continue;

            firstCrawlGroups.push({
              rootComment: rootNode,
              subReplies: nonAuthorSubs,
              newInGroup: groupNew,
            });
```

- [ ] **步骤 6：编译验证**

`cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep douyinCrawler.ts | grep -v "withCDPContext\|innerText\|click.*does not exist\|Symbol.iterator"`

预期：无新增错误。

- [ ] **步骤 7：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): compute isAuthor in first-crawl path + filter from commentGroups"
```

---

## 任务 5：抖音 Phase1 改用 syncPlatformAuthorId

**文件：** 修改 `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts:1148-1225`

**目的：** Phase1 视频列表中提取的 `authorUid` 不仅在首次绑定时写入，而且要做自愈检测。

- [ ] **步骤 1：删除 needAuthorId 标志**

将 line 1148-1150：
```typescript
    // 查询当前用户，判断是否需要提取平台作者 ID
    const user = await db.getUserById(userId);
    let needAuthorId = !user?.platformAuthorId; // 如果还没存过 authorId 就标记需要提取
```

替换为：
```typescript
    // syncPlatformAuthorId 会处理首次绑定 + 自愈检测，不需要 needAuthorId 标志
```

- [ ] **步骤 2：替换 line 1211-1225 的提取作者 ID 逻辑**

将：
```typescript
        // 提取作者 ID
        if (needAuthorId && video.authorUid) {
          const userForUpdate = await db.getUserById(userId);
          if (userForUpdate && !userForUpdate.platformAuthorId) {
            await prisma.user.update({
              where: { id: userId },
              data: {
                platformAuthorId: video.authorUid,
                platformAuthorName: video.authorNickname || '',
              },
            });
            needAuthorId = false;
            logger.info({ userId, authorUid: video.authorUid }, '[Phase1] Extracted platform author ID');
          }
        }
```

替换为：
```typescript
        // 同步作者 ID（首次绑定 + 自愈）
        if (video.authorUid) {
          await db.syncPlatformAuthorId(userId, video.authorUid, video.authorNickname);
        }
```

- [ ] **步骤 3：在 Path B（兜底路径）也调用 syncPlatformAuthorId**

搜索 `douyinCrawler.ts` 中 Path B 的兜底逻辑（在 video loop 之后，遍历 videos 检查 `authorUid` 的代码）：

```bash
grep -n "video.authorUid" apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
```

找到 Path B（在 `for (const video of videos)` 主循环之外的回退兜底），将其中的 `prisma.user.update(...)` 调用替换为 `await db.syncPlatformAuthorId(userId, video.authorUid, video.authorNickname);`。

如果搜索结果显示只有 Path A（已在步骤 2 替换），则跳过此步。

- [ ] **步骤 4：编译验证**

`cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep douyinCrawler.ts | grep -v "withCDPContext\|innerText\|click.*does not exist\|Symbol.iterator"`

预期：无新增错误。

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "refactor(douyin): use syncPlatformAuthorId for self-heal binding"
```

---

## 任务 6：快手 isAuthor 改为 ID 比对 + 改用 syncPlatformAuthorId

**文件：** 修改 `apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts:1073-1141, :1547-1568`

**目的：** 快手当前评论入库 `is_author: false` 硬编码，改为 `String(authorId) === String(platformAuthorId)`；Phase1 改用 syncPlatformAuthorId。

- [ ] **步骤 1：替换 Phase1 的作者 ID 提取（line 1073-1141）**

将 line 1073-1075：
```typescript
    // 查询当前用户，判断是否需要提取平台作者 ID
    const user = await db.getUserById(userId);
    let needAuthorId = !user?.platformAuthorId;
```

替换为：
```typescript
    // syncPlatformAuthorId 会处理首次绑定 + 自愈检测
```

将 line 1132-1141 的：
```typescript
        // 提取作者 ID
        if (needAuthorId && video.authorUid) {
          const currentUser = await db.getUserById(userId);
          if (currentUser && !currentUser.platformAuthorId) {
            await prisma.user.update({
              where: { id: userId },
              data: { platformAuthorId: video.authorUid, platformAuthorName: video.authorNickname || '' },
            });
```

替换为（保留闭合括号）：
```typescript
        // 同步作者 ID（首次绑定 + 自愈）
        if (video.authorUid) {
          await db.syncPlatformAuthorId(userId, video.authorUid, video.authorNickname);
```

注意：检查上下文，删掉随后的 `needAuthorId = false;` 和闭合的 `if (currentUser && !currentUser.platformAuthorId)` 块。最终结构应为：

```typescript
        // 同步作者 ID（首次绑定 + 自愈）
        if (video.authorUid) {
          await db.syncPlatformAuthorId(userId, video.authorUid, video.authorNickname);
          logger.info({ userId, authorUid: video.authorUid }, '[Kuaishou Phase1] Synced platform author ID');
        }
```

- [ ] **步骤 2：在评论入库前查询 platformAuthorId**

在 line 1547 `const dbComments = allCollectedComments.map(...)` 之前插入：

```typescript
        // 查询作者 ID 用于 isAuthor 判断
        const ksUser = await db.getUserById(item._userId);
        const ksAuthorId = ksUser?.platformAuthorId;

```

- [ ] **步骤 3：修改 line 1562 的 is_author 硬编码**

将：
```typescript
            is_author: false,
```

替换为：
```typescript
            is_author: ksAuthorId ? String(c.authorId) === String(ksAuthorId) : false,
```

- [ ] **步骤 4：编译验证**

`cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep kuaishouCrawler.ts | grep -v "withCDPContext\|click.*does not exist\|Symbol.iterator"`

预期：无新增错误。

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/kuaishouCrawler.ts
git commit -m "feat(kuaishou): compute isAuthor by authorId comparison + use syncPlatformAuthorId"
```

---

## 任务 7：视频号 Phase1 提取 finder_id + 评论 isAuthor

**文件：** 修改 `apps/ts-api-gateway/src/crawlers/tencentCrawler.ts:573-649, :1115-1156`

**目的：** 视频号当前完全没有 platformAuthorId 绑定，且评论 is_author 永远 false、userUid 存的是头像 URL。

- [ ] **步骤 1：探索 RequestInterceptor 是否保存请求 body**

```bash
grep -n "requestBody\|postData()\|request\.postData" packages/browser-core/src/ apps/ts-api-gateway/src/lib/requestInterceptor.ts 2>/dev/null
```

如有 requestBody 字段，使用步骤 2A；否则使用步骤 2B（page.on('request') 直接监听）。

- [ ] **步骤 2A：interceptor 已支持 requestBody**

在 `tencentCrawler.ts:606-609` 之后（`const videos: TencentVideoInfo[] = ...` 之前）插入：

```typescript
    // 从拦截到的请求 payload 中提取 _log_finder_id（视频号作者标识）
    let finderId: string | undefined;
    try {
      const reqBody = (intercepted as any)?.requestBody;
      if (reqBody) {
        const parsed = typeof reqBody === 'string' ? JSON.parse(reqBody) : reqBody;
        finderId = parsed?._log_finder_id || undefined;
      }
    } catch (parseErr: any) {
      logger.warn({ err: parseErr.message }, '[Phase1] Failed to parse post_list request body');
    }

    if (finderId) {
      await db.syncPlatformAuthorId(userId, finderId);
      logger.info({ userId, finderId }, '[Phase1] Synced tencent finder_id');
    }

```

- [ ] **步骤 2B：interceptor 不支持时（兜底方案）**

如果步骤 1 显示 interceptor 不保存 requestBody：

在 `tencentCrawler.ts` 类顶部添加私有字段：
```typescript
  private capturedFinderId: string | null = null;
```

在 `registerListener` 函数中（搜索 `registerListener`）添加 patchright 请求监听：
```typescript
  page.on('request', (req) => {
    if (req.url().includes('/post_list')) {
      try {
        const body = req.postData();
        if (body) {
          const parsed = JSON.parse(body);
          if (parsed?._log_finder_id) {
            this.capturedFinderId = parsed._log_finder_id;
          }
        }
      } catch {}
    }
  });
```

然后在 `checkForUpdates` 的 line 606-609 之后插入：
```typescript
    if (this.capturedFinderId) {
      await db.syncPlatformAuthorId(userId, this.capturedFinderId);
      logger.info({ userId, finderId: this.capturedFinderId }, '[Phase1] Synced tencent finder_id');
    }
```

二选一执行。如果两个方案都不可行，记录 SKIP 标记并继续后续任务。

- [ ] **步骤 3：在 collectVideoComments 内部查询 platformAuthorId**

`collectVideoComments(page, exportId, videoTitle, userId)` 已有 userId 参数（line 906）。在 line 1115 之前插入：

```typescript
    // 查询作者 ID 用于 isAuthor 判断
    const tencentUser = await db.getUserById(userId);
    const tencentAuthorId = tencentUser?.platformAuthorId;

```

- [ ] **步骤 4：修改 root 评论入库（line 1120-1134）**

将 line 1122-1133 的 root 入库块替换为：

```typescript
        dbComments.set(cid, {
          comment_id: apiRoot.commentId || cid,
          content: apiRoot.commentContent,
          nickname: apiRoot.commentNickname,
          head_img_url: apiRoot.commentHeadurl || '',
          user_uid: apiRoot.username || '',
          create_time: parseInt(apiRoot.commentCreatetime) || 0,
          like_count: apiRoot.commentLikeCount || 0,
          reply_count: (apiRoot.levelTwoComment || []).length,
          export_id: exportId,
          is_author: tencentAuthorId ? String(apiRoot.username) === String(tencentAuthorId) : false,
          level: 1 as const,
        });
```

- [ ] **步骤 5：修改 sub 评论入库（line 1135-1156）**

将 line 1138-1153 的 sub 入库块替换为：

```typescript
          dbComments.set(subCid, {
            comment_id: sub.commentId || subCid,
            content: sub.commentContent,
            nickname: sub.commentNickname,
            head_img_url: sub.commentHeadurl || '',
            user_uid: sub.username || '',
            create_time: parseInt(sub.commentCreatetime) || 0,
            like_count: sub.commentLikeCount || 0,
            reply_count: 0,
            export_id: exportId,
            is_author: tencentAuthorId ? String(sub.username) === String(tencentAuthorId) : false,
            level: 2 as const,
            root_id: cid,
            parent_id: sub.replyCommentId || cid,
            reply_to_name: sub.replyNickname || '',
          });
```

- [ ] **步骤 6：编译验证**

`cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep tencentCrawler.ts | grep -v "Symbol.iterator"`

预期：无新增错误。

- [ ] **步骤 7：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/tencentCrawler.ts
git commit -m "feat(tencent): bind finder_id + compute isAuthor + fix userUid"
```

---

## 任务 8：小红书 Phase1 提取作者 ID（仅绑定，不改评论）

**文件：** 修改 `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:496-535`

**目的：** Phase1 笔记列表中提取作者 ID 并绑定。本任务仅绑定，不实现评论级 isAuthor 判断。

- [ ] **步骤 1：探索小红书笔记 API 响应中的作者 ID 字段**

启动 docker 容器或通过现有日志查看小红书笔记 API 的响应结构：

```bash
docker logs sm-ts-api 2>&1 | grep -A 20 "XHS.*INITIAL_ITEMS" | head -50
```

或检查 `parseVideoItem`（`packages/browser-core/src/interceptor.ts:103-145`）中已知字段。

如果当前日志不足以确定字段名，**降级处理**：本任务标记为 SKIP，等下次小红书任务运行后抓包确认字段，再补充实现。

如果能确认字段（候选：`user.userId`、`user.user_id`、`user_id`、`userId`、`author.userId`），继续步骤 2。

- [ ] **步骤 2：在 fetchNoteListFromSource 中带出作者 ID**

修改 `xiaohongshuCrawler.ts:200-211`，将：

```typescript
    const allItems = this.interceptor.getCollectedItems(pattern);
    const sliced = allItems.slice(0, this.maxMonitorVideos);
```

替换为：

```typescript
    const allItems = this.interceptor.getCollectedItems(pattern);
    const sliced = allItems.slice(0, this.maxMonitorVideos);

    // 提取作者 ID（小红书笔记 API 字段，根据步骤 1 探索结果调整）
    let xhsAuthorId: string | undefined;
    let xhsAuthorName: string | undefined;
    for (const item of allItems as any[]) {
      const uid = item.user?.userId || item.user?.user_id || item.user_id || item.userId || item.author?.userId;
      if (uid) {
        xhsAuthorId = String(uid);
        xhsAuthorName = item.user?.nickname || item.user?.name || item.author?.nickname || '';
        break;
      }
    }
    (sliced as any)._xhsAuthorId = xhsAuthorId;
    (sliced as any)._xhsAuthorName = xhsAuthorName;
```

注意：`getCollectedItems` 返回的是 `parseVideoItem` 已处理过的精简对象。如果作者字段被剥离，需要改用未处理的 raw 数据。检查 interceptor 实现：

```bash
grep -n "getCollectedItems\|parseVideoItem" packages/browser-core/src/interceptor.ts | head -10
```

如果 `getCollectedItems` 返回精简对象，将上述逻辑改为：

```typescript
    const rawResponses = this.interceptor.getResponses(pattern) || [];
    let xhsAuthorId: string | undefined;
    let xhsAuthorName: string | undefined;
    for (const resp of rawResponses) {
      const items = resp?.body?.data?.data?.items || resp?.body?.data?.items || resp?.data?.data?.items || [];
      for (const item of items) {
        const uid = item.user?.userId || item.user?.user_id || item.user_id || item.userId || item.author?.userId;
        if (uid) {
          xhsAuthorId = String(uid);
          xhsAuthorName = item.user?.nickname || item.user?.name || item.author?.nickname || '';
          break;
        }
      }
      if (xhsAuthorId) break;
    }
    (sliced as any)._xhsAuthorId = xhsAuthorId;
    (sliced as any)._xhsAuthorName = xhsAuthorName;
```

- [ ] **步骤 3：在 checkForUpdates 中调用 syncPlatformAuthorId**

在 `xiaohongshuCrawler.ts:519` `const videos = await this.fetchNoteListFromSource(page);` 之后插入：

```typescript
    // 同步作者 ID
    const xhsAuthorId = (videos as any)._xhsAuthorId;
    const xhsAuthorName = (videos as any)._xhsAuthorName;
    if (xhsAuthorId) {
      await db.syncPlatformAuthorId(userId, xhsAuthorId, xhsAuthorName);
      logger.info({ userId, xhsAuthorId }, '[XHS-Light] Synced platform author ID');
    }
```

- [ ] **步骤 4：编译验证**

`cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep xiaohongshuCrawler.ts`

预期：无新增错误。

- [ ] **步骤 5：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "feat(xiaohongshu): bind platform author ID from note list API"
```

---

## 任务 9：通知过滤改用 isAuthor 字段

**文件：** 修改 `apps/ts-api-gateway/src/services/unifiedQueue.ts:287-328`

**目的：** 通知过滤从 UID 比对改为依赖 Comment 对象的 isAuthor 字段，level 1 和 level 2 统一过滤。

- [ ] **步骤 1：替换通知过滤逻辑**

将 line 287-328 整段（包含 `const user = await prisma.user.findUnique...` 到 `.filter((g: any) => g.newCids.size > 0)`）替换。

替换内容（原 UID 比对 → !isAuthor 判断）：

```typescript
            const commentGroups = phase3Result?.results
              ?.filter((r: any) => r.success && r.commentGroups)
              ?.flatMap((r: any) =>
                r.commentGroups
                  .map((g: any) => {
                    // 通知过滤：依赖 isAuthor 字段，level 1 和 level 2 都过滤
                    const newSubReplies = g.newInGroup
                      .filter((n: any) => n.level === 2 && !n.isAuthor)
                      .map((n: any) => ({
                        cid: n.cid,
                        text: n.text,
                        userNickname: n.userNickname,
                        replyToName: n.replyToName,
                        createTime: n.createTime,
                      }));
                    const allSubReplies = [
                      ...g.subReplies.filter((s: any) => !s.isAuthor),
                      ...newSubReplies,
                    ];
                    const seenCids = new Set<string>();
                    const dedupedSubReplies = allSubReplies.filter((s: any) => {
                      if (seenCids.has(s.cid)) return false;
                      seenCids.add(s.cid);
                      return true;
                    });

                    return {
                      awemeId: r.awemeId,
                      description: queue.find((q: any) => q.awemeId === r.awemeId)?.description || '',
                      rootComment: g.rootComment,
                      subReplies: dedupedSubReplies,
                      newCids: new Set(
                        g.newInGroup
                          .filter((n: any) => !n.isAuthor)
                          .map((n: any) => n.cid)
                      ),
                    };
                  })
                  .filter((g: any) => g.newCids.size > 0)
              ) || [];
```

注意：原代码中的 `prisma.user.findUnique` 和 `platformAuthorId` 变量已删除。如果 `unifiedQueue.ts` 中其他地方还在用 `user` 或 `platformAuthorId`，保留必要的查询。

- [ ] **步骤 2：检查 CommentNode 是否有 isAuthor 字段**

```bash
grep -rn "interface CommentNode\|type CommentNode" apps/ts-api-gateway/src/ packages/browser-core/src/ 2>/dev/null
```

如果定义中没有 `isAuthor`，添加：
```typescript
  isAuthor?: boolean;
```

- [ ] **步骤 3：编译验证**

`cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep unifiedQueue.ts`

预期：无新增错误。

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/services/unifiedQueue.ts
git commit -m "refactor(notify): filter author comments by isAuthor field"
```

---

## 任务 10：手动触发端点补全去重

**文件：** 修改 `apps/ts-api-gateway/src/routes/matrix.ts:1191-1192`

**目的：** 手动触发端点直接入队不去重，频繁点击会产生并发 job 抢同一窗口锁。

- [ ] **步骤 1：在入队前补全去重检查**

在 line 1191-1192 `// Add to BullMQ queue` 之前插入：

```typescript
    // 去重：检查是否已有同用户的 active/waiting 任务
    const existingJobs = await monitorQueue.getJobs(['active', 'waiting']);
    const hasExisting = existingJobs.some((j: any) => (j.data as any)?.userId === user.id);
    if (hasExisting) {
      return res.json({
        success: true,
        message: '该用户已有任务在队列中，无需重复触发',
        deduplicated: true,
      });
    }

```

- [ ] **步骤 2：编译验证**

`cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep matrix.ts | grep -v "IRedisClient\|string | undefined\|Property 'catch'"`

预期：无新增错误。

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/routes/matrix.ts
git commit -m "fix(trigger): dedupe manual trigger to prevent duplicate jobs"
```

---

## 任务 11：构建 + 测试 + Docker 部署验证

- [ ] **步骤 1：完整编译**

```bash
cd apps/ts-api-gateway && npx tsc --noEmit 2>&1 | grep -v "_phase3Result\|innerText\|withCDPContext\|click.*does not exist\|Symbol.iterator\|IRedisClient\|string | undefined\|Property 'catch'" | head -30
```

预期：无新增错误。

- [ ] **步骤 2：运行测试**

```bash
cd apps/ts-api-gateway && npx jest src/lib/redlock.test.ts --verbose
```

预期：11/11 通过。

- [ ] **步骤 3：Docker 重建 + 重启**

```bash
docker compose up -d --build ts-api-gateway
```

预期：构建成功，容器启动。

- [ ] **步骤 4：观察启动日志**

```bash
sleep 10 && docker logs sm-ts-api --since 30s 2>&1 | grep -E "调度器|启动清理|AuthorSync|Phase1" | head -20
```

预期：调度器启动完成。

- [ ] **步骤 5：手动触发测试 + AuthorSync 日志**

```bash
curl -X POST http://localhost:3001/api/v1/matrix/monitor/accounts/3/trigger
sleep 30
docker logs sm-ts-api --since 1m 2>&1 | grep -E "AuthorSync|isAuthor|label_type" | head -20
```

预期：看到 `[AuthorSync]` 日志。

- [ ] **步骤 6：去重测试**

```bash
curl -X POST http://localhost:3001/api/v1/matrix/monitor/accounts/3/trigger
curl -X POST http://localhost:3001/api/v1/matrix/monitor/accounts/3/trigger
```

预期：第二次返回 `"deduplicated":true`。

- [ ] **步骤 7：Toggle 同步**

```bash
curl -X PUT http://localhost:3001/api/v1/matrix/monitor/accounts/3/toggle \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
sleep 3
curl -s http://localhost:3001/api/v1/matrix/monitor/scheduler-status
curl -X PUT http://localhost:3001/api/v1/matrix/monitor/accounts/3/toggle \
  -H 'Content-Type: application/json' -d '{"enabled":true}'
```

预期：toggle 即时同步调度器。

- [ ] **步骤 8：数据库验证**

```bash
docker exec sm-postgres psql -U sm_admin -d social_media -c "SELECT id, platform, platform_author_id, platform_author_name FROM users ORDER BY id"
```

预期：监控用户都有 `platform_author_id` 填充。

```bash
docker exec sm-postgres psql -U sm_admin -d social_media -c "SELECT v.user_id, count(*) FILTER (WHERE c.is_author=true) AS author_comments, count(*) AS total FROM video_comments c JOIN videos v ON c.video_id=v.id GROUP BY v.user_id"
```

预期：抖音/快手/视频号有 `is_author=true` 的评论记录（如果有作者发过评论）。

---

## 执行顺序与并行性

```
任务 1 (syncPlatformAuthorId 函数) ─┐
                                     ├─→ 任务 5 (douyin Phase1)
                                     ├─→ 任务 6 (kuaishou)
                                     ├─→ 任务 7 (tencent)
                                     └─→ 任务 8 (xhs)

任务 2 (userUid 修复) ──→ 任务 7

任务 3 (label_type 保留) ──→ 任务 4 (douyin 首爬)

任务 4/6/7 ──→ 任务 9 (通知过滤依赖 isAuthor 字段已正确)

任务 10 (手动触发去重) — 独立

任务 11 (验证) — 全部完成后
```

**可并行执行的批次：**
- 批次 A（独立）：任务 1、任务 2、任务 3、任务 10
- 批次 B（依赖 A）：任务 4（依赖 3）、任务 5（依赖 1）、任务 6（依赖 1）、任务 7（依赖 1+2）、任务 8（依赖 1）
- 批次 C（依赖 B）：任务 9
- 批次 D（依赖 C）：任务 11

**注意：** 批次 B 中多个任务修改不同文件，可并行；任务 4 和任务 5 都改 `douyinCrawler.ts`，必须串行。

