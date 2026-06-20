# XHS Phase 3 评论采集重写 + 企微卡片 F5 刷新 QR 码 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 XHS Phase 3 评论采集（选择器缺失导致全部失败），将登录检测内联到 Phase 3 缩略图点击流程中，增加首次初始化逻辑，并为所有平台企微登录告警卡片增加 F5 刷新 QR 码按钮。

**架构：** 删除独立的 `checkMainsiteLogin` 方法。Phase 3 中点击缩略图打开主站新标签页后，内联检测 `#login-btn` / `.login-modal` 判断登录态。登录失效 → 截 QR 发企微 → 设 `login_required` + Redis 标记 → 终止队列。恢复后靠 Phase 1 DB 对比自然跳过已处理笔记。首次爬取（无 `VideoRootCommentCount` 记录）标记 `isFirstCrawl`，全部评论存基线。

**技术栈：** TypeScript, Playwright, Prisma, ioredis, 企业微信机器人 API

---

## 文件结构

| 文件 | 职责 | 改动类型 |
|------|------|----------|
| `data/selectors.json` (2862行) | CSS 选择器值 | 新增 `region_note_card_by_id`、`region_note_card_cover` |
| `apps/ts-api-gateway/src/crawlers/menuSelectors.ts` (480行) | 选择器 key 映射 | **无需改动** — line 118-119 已有映射 |
| `apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts` (1219行) | XHS 爬虫核心 | 修复选择器；内联登录检测；删除 `checkMainsiteLogin`；`isFirstCrawl` 逻辑 |
| `apps/ts-api-gateway/src/services/monitorService.ts` (2076行) | 监控调度 | 重构 `runXiaohongshuCheck`；删除 Phase 0/2；新增 `refreshQR` |
| `apps/ts-api-gateway/src/services/wechatBotService.ts` (867行) | 企微机器人 | 卡片加第三个按钮；消息处理加 `F5刷新` 命令 |

---

### 任务 1：selectors.json 补全笔记卡片选择器

**文件：**
- 修改：`data/selectors.json:2847`（XHS `regions` 区域末尾，在 `region_mainsite_qr_code` 之后）

**背景：** `menuSelectors.ts:118-119` 已有 key 映射 `region.note-card-by-id` → `region_note_card_by_id` 和 `region.note-card-cover` → `region_note_card_cover`，但 `selectors.json` 中没有对应的值。`getSelector` 查不到值返回空 → `clickThumbnailAndWaitNewTab` 抛出 "No card selector"。

CDP 探测确认的 DOM：`.note-card[data-impression*="{noteId}"]` 匹配 21 个卡片，`data-impression` JSON 含 `noteTarget.value.noteId`。缩略图可点击区域为 `.note-card__cover .note-card__media`。

- [ ] **步骤 1：在 selectors.json XHS regions 末尾添加两个选择器**

在 `region_mainsite_qr_code` 条目之后（约 line 2862）插入：

```json
"region_note_card_by_id": {
  "purposes": ["monitor"],
  "primary": ".note-card[data-impression*=\"{noteId}\"]",
  "fallbacks": [".note-card[data-impression*=\"{noteId}\"] .note-card__cover"],
  "description": "笔记管理页面笔记卡片，通过 data-impression 属性中的 noteId 子串匹配"
},
"region_note_card_cover": {
  "purposes": ["monitor"],
  "primary": ".note-card__cover .note-card__media",
  "fallbacks": [".note-card__cover"],
  "description": "笔记卡片缩略图可点击区域"
}
```

- [ ] **步骤 2：验证选择器 key 映射已存在**

确认 `apps/ts-api-gateway/src/crawlers/menuSelectors.ts:118-119` 已有：
```typescript
'region.note-card-by-id': { category: 'regions', name: 'region_note_card_by_id' },
'region.note-card-cover': { category: 'regions', name: 'region_note_card_cover' },
```
无需改动。

- [ ] **步骤 3：验证**

```bash
python3 -c "
import json
with open('data/selectors.json') as f:
    data = json.load(f)
r = data['platforms']['xiaohongshu']['regions']
print('note-card-by-id:', r.get('region_note_card_by_id', 'MISSING'))
print('note-card-cover:', r.get('region_note_card_cover', 'MISSING'))
"
```

- [ ] **步骤 4：Commit**

```bash
git add data/selectors.json
git commit -m "feat(xhs): add note card selectors for Phase 3 thumbnail click"
```

---

### 任务 2：xiaohongshuCrawler — 内联登录检测 + loginRequired 处理

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts`

**子任务 2a：`processOneNoteComments` (line 1014-1062) — 内联登录检测**

在新标签页打开后、评论采集前插入登录检测。如果检测到未登录，截 QR 发企微，返回 `loginRequired: true`。

- [ ] **步骤 1：修改返回类型签名（line 1018）**

```typescript
// 修改前
): Promise<{ success: boolean; awemeId: string; error?: string }> {
// 修改后
): Promise<{ success: boolean; awemeId: string; error?: string; loginRequired?: boolean }> {
```

- [ ] **步骤 2：在 line 1027 之后、line 1028 之前插入登录检测**

在 `if (!newPage) { return ... }` 块之后，`try {` 之前插入：

```typescript
      // ── 内联登录检测：点击缩略图跳到主站后检测是否弹出登录框 ──
      let loggedOut = false;
      try {
        const loginBtn = await newPage.$('#login-btn');
        if (loginBtn) {
          loggedOut = true;
          logger.info({ exportId }, '[XHS-Phase3] 检测到 #login-btn — 主站未登录');
        }
      } catch { /* 忽略查询异常 */ }

      if (!loggedOut) {
        try {
          const loginModal = await newPage.$('.login-modal');
          if (loginModal) {
            loggedOut = true;
            logger.info({ exportId }, '[XHS-Phase3] 检测到 .login-modal — 主站未登录');
          }
        } catch { /* 忽略查询异常 */ }
      }

      if (loggedOut) {
        logger.info({ exportId }, '[XHS-Phase3] 主站未登录，截取 QR 码发送企微');
        try {
          const qrEl = await newPage.waitForSelector('.login-container .qrcode-img, .qrcode-img', { timeout: 15000 });
          const qrBuffer = await qrEl.screenshot({ type: 'png' });
          const { botManager } = await import('../services/wechatBotService');
          const { prisma: prismaLogin } = await import('../lib/prisma');
          const loginUser = await prismaLogin.user.findUnique({ where: { id: userId }, select: { wechatUserid: true } });
          if (loginUser?.wechatUserid) {
            await botManager.sendLoginAlert(loginUser.wechatUserid, 'xiaohongshu', userId, qrBuffer);
            logger.info({ exportId }, '[XHS-Phase3] QR 码已发送到企微');
          }
        } catch (qrErr: any) {
          logger.warn({ exportId, error: qrErr.message }, '[XHS-Phase3] QR 码截图发送失败');
        }
        await newPage.close().catch(() => {});
        await page.bringToFront();
        return { success: false, awemeId: exportId, loginRequired: true };
      }
```

**子任务 2b：`processCommentsQueue` (line 1064-1093) — 处理 loginRequired 终止队列**

- [ ] **步骤 3：修改 `processCommentsQueue` 循环逻辑**

在 line 1077 的风控检测 `break` 之后，增加 loginRequired 检测：

```typescript
      // 替换 line 1073-1080 的循环体
      for (const item of queue) {
        const result = await this.processOneNoteComments(page, item, userId);
        results.push(result);

        // 登录失效 → 终止队列
        if (result.loginRequired) {
          logger.warn({ userId, awemeId: item.exportId }, '[XHS-Phase3] Login required — aborting queue');
          break;
        }

        // 风控检测
        if (result.error?.includes('captcha') || result.error?.includes('Risk control')) {
          logger.warn({ userId, awemeId: item.exportId }, '[XHS-Phase3] Risk detected, aborting queue');
          break;
        }
      }
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "feat(xhs): inline login detection in Phase 3 thumbnail click"
```

---

### 任务 3：xiaohongshuCrawler — 首次初始化逻辑 (isFirstCrawl)

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:40-56`（`XiaohongshuCheckResult` 接口）
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:776-781`（commentsQueue 构建）

- [ ] **步骤 1：更新 `XiaohongshuCheckResult` 接口（line 48-53）**

```typescript
// 修改前
commentsQueue: Array<{
  exportId: string;
  description: string;
  oldCount: number;
  newCount: number;
}>;
// 修改后
commentsQueue: Array<{
  exportId: string;
  description: string;
  oldCount: number;
  newCount: number;
  isFirstCrawl: boolean;
}>;
```

- [ ] **步骤 2：修改 commentsQueue 构建逻辑（line 776-781）**

替换现有的 `commentsQueue` 映射：

```typescript
// 修改前 (line 776-781)
const commentsQueue = updatedVideos.map((v) => ({
  exportId: v.awemeId,
  description: v.description,
  oldCount: v.oldCount,
  newCount: v.newCount,
}));

// 修改后
const commentsQueue: Array<{ exportId: string; description: string; oldCount: number; newCount: number; isFirstCrawl: boolean }> = [];
for (const v of updatedVideos) {
  // 检查该笔记是否已有评论快照记录（VideoRootCommentCount）
  // 无记录 = 首次爬取（isFirstCrawl），有记录 = 增量更新
  const existingSnapshot = await prisma.videoRootCommentCount.findFirst({
    where: { videoId: v.awemeId },
    select: { cid: true },
  });
  commentsQueue.push({
    exportId: v.awemeId,
    description: v.description,
    oldCount: v.oldCount,
    newCount: v.newCount,
    isFirstCrawl: !existingSnapshot,
  });
  logger.info({ awemeId: v.awemeId, isFirstCrawl: !existingSnapshot }, '[XHS-Light] Queue item crawl mode');
}
```

- [ ] **步骤 3：更新 `processCommentsQueue` 签名（line 1066）**

```typescript
// 修改前
queue: Array<{ exportId: string; description: string; oldCount: number; newCount: number }>,
// 修改后
queue: Array<{ exportId: string; description: string; oldCount: number; newCount: number; isFirstCrawl?: boolean }>,
```

- [ ] **步骤 4：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "feat(xhs): add isFirstCrawl flag to commentsQueue"
```

---

### 任务 4：xiaohongshuCrawler — 删除 checkMainsiteLogin

**文件：**
- 修改：`apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts:540-626`

- [ ] **步骤 1：删除 `checkMainsiteLogin` 方法（line 540-626）**

删除从 `/**` 注释（line 540）到方法结束 `}`（line 626）的整个方法。包括 JSDoc 注释、方法签名和方法体。

- [ ] **步骤 2：Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
git commit -m "refactor(xhs): remove checkMainsiteLogin — login detection now inline in Phase 3"
```

---

### 任务 5：monitorService — 重构 runXiaohongshuCheck

**文件：**
- 修改：`apps/ts-api-gateway/src/services/monitorService.ts:1045-1191`

**背景：** 删除 Phase 0（Redis recheck 独立登录检查）和 Phase 2（独立 `checkMainsiteLogin`）。Phase 1 后直接进 Phase 3。Phase 3 返回 loginRequired 时设 `login_required` + Redis 标记。保留 Redis recheck 恢复逻辑（有标记时仍正常跑 Phase 1，靠 Phase 3 内联检测验证）。

- [ ] **步骤 1：替换整个 `runXiaohongshuCheck` 函数**

将 `monitorService.ts:1045-1191` 替换为：

```typescript
async function runXiaohongshuCheck(page: any, task: MonitorTask, onProgress?: (p: { phase: string; step: string; percent: number; detail?: string }) => void): Promise<MonitorResult> {
  const xhs = getXiaohongshuCrawler(task.windowId);
  const crawlMode = await db.getCrawlMode('xiaohongshu');
  const redis = getRedis();

  logger.info({ userId: task.userId, crawlMode }, '[XHS-monitor] Starting xiaohongshu check');

  // 登录态恢复标记检测（仅日志，实际验证在 Phase 3 内联完成）
  const loginRecheckKey = `xhs:login_recheck:${task.userId}`;
  const needsLoginRecheck = await redis.get(loginRecheckKey);
  if (needsLoginRecheck) {
    logger.info({ userId: task.userId }, '[XHS-monitor] 检测到登录态恢复标记，将在 Phase 3 内联验证');
  }

  await xhs.registerListener(page, ['/api/galaxy/v2/creator/note/user/posted']);

  const currentUrl = page.url();
  if (!currentUrl.includes('creator.xiaohongshu.com')) {
    await xhs.navigateToCreatorHome(page);
  }

  // Phase 1: 笔记列表扫描 + 非公开过滤
  onProgress?.({ phase: 'Phase1', step: '扫描笔记列表', percent: 20, detail: '正在获取笔记列表并对比评论数' });
  const phase1Result = await xhs.checkForUpdates(page, task.userId);
  xhs.unregisterListener();

  if (phase1Result.riskControlDetected) {
    logger.error({ userId: task.userId, platform: 'xiaohongshu', riskType: phase1Result.riskControlInfo?.type }, '小红书风控触发');
    await db.logRiskScene(task.userId, 'xiaohongshu', phase1Result.riskControlInfo?.type || 'unknown', phase1Result.riskControlInfo?.evidence || '');
    await db.setUserCooldown(task.userId, Date.now() + 30 * 60 * 1000);
    return { hasUpdate: false, newComments: 0, updatedVideos: [], phase: 'Phase1', riskDetected: true };
  }

  const queue = phase1Result.commentsQueue || [];

  // 无新评论或 Light 模式 → 正常退出
  if (crawlMode === 'light' || queue.length === 0) {
    // recheck 标记清理：无新评论说明登录态不影响，清除标记
    if (needsLoginRecheck && queue.length === 0) {
      await redis.del(loginRecheckKey);
      logger.info({ userId: task.userId }, '[XHS-monitor] 无评论变化，清除登录态恢复标记');
    }
    await xhs.executeExitStrategy(page);
    const updates = (phase1Result.updatedVideos || []).map((v: any) => ({
      awemeId: v.awemeId,
      description: v.description,
      oldCount: v.oldCount,
      newCount: v.newCount,
    }));
    return { hasUpdate: phase1Result.hasUpdate, newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0), updatedVideos: updates, phase: 'Phase1', riskDetected: false };
  }

  // Phase 3: 评论树采集（有新评论 + Deep 模式）
  // 登录检测已内联到 processOneNoteComments（点击缩略图时）
  onProgress?.({ phase: 'Phase3', step: '采集评论详情', percent: 60, detail: `正在处理 ${queue.length} 个视频的评论` });
  logger.info({ userId: task.userId, queueLength: queue.length }, '[XHS-Phase3] Processing comments queue');

  const phase3Result = await xhs.processCommentsQueue(page, queue, task.userId);

  // 退出策略
  await xhs.executeExitStrategy(page);

  // 处理登录失效（Phase 3 内联检测到的）
  const hasLoginRequired = phase3Result.some((r: any) => r.loginRequired);
  if (hasLoginRequired) {
    logger.info({ userId: task.userId }, '[XHS-monitor] 主站未登录 — 暂停监控，等待扫码恢复');
    await db.updateUserStatus(task.userId, 'login_required');
    await redis.set(loginRecheckKey, '1', 'EX', 86400); // 24h TTL

    // Light 模式合成 Comment
    const updates = (phase1Result.updatedVideos || []).map((v: any) => ({
      awemeId: v.awemeId,
      description: v.description,
      oldCount: v.oldCount,
      newCount: v.newCount,
    }));
    for (const u of updates) {
      const diff = u.newCount - u.oldCount;
      if (diff > 0) {
        await db.upsertLightModeComment(u.awemeId, {
          text: `[轻量模式] ${diff} 条新评论（主站未登录）`,
          create_time: Math.floor(Date.now() / 1000),
        });
      }
    }
    return { hasUpdate: updates.length > 0, newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0), updatedVideos: updates, phase: 'Phase3', riskDetected: false };
  }

  // 登录正常 → 清除 recheck 标记
  if (needsLoginRecheck) {
    await redis.del(loginRecheckKey);
    logger.info({ userId: task.userId }, '[XHS-monitor] 主站登录已恢复 — 清除恢复标记');
  }

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

  releaseCrawler('xiaohongshu', task.windowId);

  return {
    hasUpdate: updates.length > 0,
    newComments: updates.reduce((s, u) => s + u.newCount - u.oldCount, 0),
    updatedVideos: updates,
    phase: 'Phase3',
    riskDetected: false,
  };
}
```

- [ ] **步骤 2：验证编译**

```bash
docker cp apps/ts-api-gateway/src/services/monitorService.ts sm-ts-api:/app/apps/ts-api-gateway/src/services/monitorService.ts
docker restart sm-ts-api
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/monitorService.ts
git commit -m "refactor(xhs): remove Phase 0/2 login check, Phase 1→3 direct flow"
```

---

### 任务 6：企微卡片加 F5 刷新 QR 码按钮

**文件：**
- 修改：`apps/ts-api-gateway/src/services/wechatBotService.ts:458-461`（jump_list）
- 修改：`apps/ts-api-gateway/src/services/wechatBotService.ts:613-615`（插入 F5 handler）

- [ ] **步骤 1：在 jump_list 添加第三个按钮（line 458-461）**

```typescript
// 修改前
jump_list: [
  { type: 3, title: '✅ 已登录，继续监控', question: `继续监控 ${userId} ${platform}` },
  { type: 3, title: '🔄 强制刷新登录页', question: `强制刷新 ${userId} ${platform}` },
],
// 修改后
jump_list: [
  { type: 3, title: '✅ 已登录，继续监控', question: `继续监控 ${userId} ${platform}` },
  { type: 3, title: '🔄 强制刷新登录页', question: `强制刷新 ${userId} ${platform}` },
  { type: 3, title: '♻️ F5刷新QR码', question: `F5刷新 ${userId} ${platform}` },
],
```

- [ ] **步骤 2：在 line 613 之后插入 F5 刷新 handler**

在 `强制刷新` handler 结束（line 613 的 `}`）之后、`// 匹配 AI 生成回复`（line 615）之前插入：

```typescript
        // 匹配"F5刷新"意图: 格式 "F5刷新 <userId> <platform>"（来自登录告警 jump_list）
        const f5RefreshSetup = content.match(/^F5刷新\s+(\d+)\s+(\S+)$/);
        if (f5RefreshSetup) {
          const targetUserId = parseInt(f5RefreshSetup[1], 10);
          const targetPlatform = f5RefreshSetup[2];

          const { prisma: prismaF5 } = await import('../lib/prisma');
          const userF5 = await prismaF5.user.findUnique({
            where: { id: targetUserId },
            select: { fingerprintWindowId: true, wechatUserid: true },
          }).catch(() => null);

          if (!userF5) {
            await botManager.sendTextMessage([userid], '❌ 未找到用户');
            return;
          }

          const { getBrowserManager: getBMF5 } = await import('../lib/browserManager');
          const bmF5 = getBMF5();
          const windowIdF5 = String(userF5.fingerprintWindowId);

          try {
            const { page: pageF5 } = await bmF5.connect(windowIdF5, '', targetPlatform);
            // F5 刷新：不重新导航，只刷新当前页面（适用于 QR 码过期但页面还在）
            await pageF5.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            await pageF5.waitForTimeout(3000);

            const { captureAndSendQR: captureQR } = await import('./monitorService');
            await captureQR(pageF5, targetUserId, targetPlatform, userF5.wechatUserid || userid);

            await botManager.sendTextMessage([userid], `♻️ 已F5刷新 ${targetPlatform} 页面，新二维码已发送`);
          } catch (err: any) {
            logger.error({ targetUserId, targetPlatform, err }, 'F5刷新页面失败');
            await botManager.sendTextMessage([userid], `❌ F5刷新失败: ${err.message || '未知错误'}`);
          } finally {
            await bmF5.disconnectSession(windowIdF5, targetPlatform as any).catch(() => {});
          }
          return;
        }
```

- [ ] **步骤 3：Commit**

```bash
git add apps/ts-api-gateway/src/services/wechatBotService.ts
git commit -m "feat(bot): add F5 refresh QR button to all platform login cards"
```

---

### 任务 7：集成验证

**文件：** 无代码改动，纯验证

- [ ] **步骤 1：部署所有改动到容器**

```bash
docker cp data/selectors.json sm-ts-api:/app/data/selectors.json
docker cp apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts sm-ts-api:/app/apps/ts-api-gateway/src/crawlers/xiaohongshuCrawler.ts
docker cp apps/ts-api-gateway/src/services/monitorService.ts sm-ts-api:/app/apps/ts-api-gateway/src/services/monitorService.ts
docker cp apps/ts-api-gateway/src/services/wechatBotService.ts sm-ts-api:/app/apps/ts-api-gateway/src/services/wechatBotService.ts
docker restart sm-ts-api
sleep 15
```

- [ ] **步骤 2：触发 XHS 监控**

```bash
curl -s -X POST http://localhost:3001/api/v1/matrix/monitor/accounts/5/trigger
```

- [ ] **步骤 3：检查日志确认选择器修复**

等待 60 秒后：
```bash
docker logs --since 90s sm-ts-api 2>&1 | grep -E 'XHS-Phase3|card selector|isFirstCrawl|loginRequired|登录' | tail -20
```

预期：
- 不再出现 "No card selector"
- 出现 `[XHS-Phase3] Clicking thumbnail to open note detail`
- 出现 `isFirstCrawl` 日志
- 如果已登录：出现 `Comments collected`
- 如果未登录：出现 `检测到 #login-btn` + QR 发送

- [ ] **步骤 4：确认其他平台无回归**

```bash
docker logs --since 5m sm-ts-api 2>&1 | grep -E '监控:.*douyin|监控:.*kuaishou' | tail -5
```
