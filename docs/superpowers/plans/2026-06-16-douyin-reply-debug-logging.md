# 抖音回复流程调试日志系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在抖音评论回复流程的每个关键操作后保存完整的 DOM HTML 和页面截图到磁盘文件，通过前端开关控制，并提供 manifest.json 索引文件供事后分析。

**Architecture:** 独立的 `replyDebugLogger.ts` 工具模块提供快照保存能力，通过 Prisma `SystemStatus.isDebugMode` 字段控制开关，前端 ToggleSwitch 控制开关状态。`replyToComment` 在关键步骤后调用 `saveDebugSnapshot` 保存 DOM + 截图。

**Tech Stack:** TypeScript, Prisma, Express, React Query, pino logger, patchright (Playwright fork)

---

## File Map

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `apps/ts-api-gateway/src/lib/replyDebugLogger.ts` | 调试快照工具模块：isDebugModeEnabled, saveDebugSnapshot, createManifest, finishManifest |
| 修改 | `apps/ts-api-gateway/src/routes/system.ts` | 添加 GET/PUT /system/debug-mode 端点 |
| 修改 | `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` | 在 replyToComment 和 scrollExpandAndFindTarget 中集成快照调用 |
| 修改 | `apps/admin-dashboard/src/hooks/useApi.ts` | 添加 useDebugMode / useUpdateDebugMode hooks |
| 修改 | `apps/admin-dashboard/src/app/matrix/page.tsx` | 在 MonitorTab 操作区添加调试开关 ToggleSwitch |

---

### Task 1: 后端调试快照工具模块

**Files:**
- Create: `apps/ts-api-gateway/src/lib/replyDebugLogger.ts`

- [ ] **Step 1: 创建 replyDebugLogger.ts**

```typescript
// @ts-api-gateway/lib/replyDebugLogger.ts - 回复流程调试快照工具

import { Page } from 'patchright';
import { prisma } from './prisma';
import { createLogger } from './logger';
import fs from 'fs';
import path from 'path';

const logger = createLogger('reply-debug');

const DEBUG_DIR = path.resolve(process.cwd(), 'data', 'reply_debug');

/** 调试快照 manifest 结构 */
export interface DebugManifest {
  sessionId: string;
  startTime: string;
  target: { text: string; level: number; createTime: number; rootText?: string };
  steps: Array<{
    step: number;
    label: string;
    timestamp: string;
    htmlFile?: string;
    screenshotFile?: string;
    url: string;
    extra?: Record<string, any>;
  }>;
  result?: { success: boolean; totalSteps: number; elapsedMs: number };
}

/** 检查调试模式是否启用（读取 SystemStatus.isDebugMode） */
export async function isDebugModeEnabled(): Promise<boolean> {
  try {
    const status = await prisma.systemStatus.findFirst();
    return status?.isDebugMode ?? false;
  } catch {
    return false;
  }
}

/** 创建回复调试会话 ID */
export function createReplySessionId(target: { text: string; createTime: number; level: number }): string {
  const safeText = target.text.slice(0, 20).replace(/[^a-zA-Z0-9一-鿿]/g, '_');
  return `reply_${safeText}_${target.createTime}_${Date.now()}`;
}

/** 创建初始 manifest */
export function createManifest(
  sessionId: string,
  target: { text: string; level: number; createTime: number; rootText?: string },
): DebugManifest {
  return {
    sessionId,
    startTime: new Date().toISOString(),
    target,
    steps: [],
  };
}

/** 保存调试快照（DOM HTML + 截图） */
export async function saveDebugSnapshot(options: {
  page: Page;
  stepLabel: string;
  sessionId: string;
  stepIndex: number;
  manifest: DebugManifest;
  saveScreenshot?: boolean;
  saveDomHtml?: boolean;
  extra?: Record<string, any>;
}): Promise<void> {
  const { page, stepLabel, sessionId, stepIndex, manifest, saveScreenshot = true, saveDomHtml = true, extra } = options;

  try {
    const sessionDir = path.join(DEBUG_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const timestamp = Date.now();
    const prefix = `${String(stepIndex).padStart(2, '0')}_${stepLabel}_${timestamp}`;
    let htmlFile: string | undefined;
    let screenshotFile: string | undefined;

    if (saveDomHtml) {
      try {
        const html = await page.content();
        htmlFile = `${prefix}.html`;
        fs.writeFileSync(path.join(sessionDir, htmlFile), html, 'utf-8');
      } catch (err: any) {
        logger.warn({ stepLabel, error: err.message }, 'Failed to save DOM HTML');
      }
    }

    if (saveScreenshot) {
      try {
        const screenshotBuffer = await page.screenshot({ fullPage: false, type: 'png' });
        screenshotFile = `${prefix}.png`;
        fs.writeFileSync(path.join(sessionDir, screenshotFile), screenshotBuffer);
      } catch (err: any) {
        logger.warn({ stepLabel, error: err.message }, 'Failed to save screenshot');
      }
    }

    manifest.steps.push({
      step: stepIndex,
      label: stepLabel,
      timestamp: new Date().toISOString(),
      htmlFile,
      screenshotFile,
      url: page.url(),
      extra,
    });

    // 每次更新都写入 manifest.json，防止中途失败丢失信息
    fs.writeFileSync(
      path.join(sessionDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    logger.info({ stepLabel, stepIndex, sessionId, htmlFile, screenshotFile }, 'Debug snapshot saved');
  } catch (err: any) {
    logger.warn({ stepLabel, error: err.message }, 'Failed to save debug snapshot');
  }
}

/** 完成调试会话（写入最终结果） */
export function finishManifest(manifest: DebugManifest, success: boolean): void {
  manifest.result = {
    success,
    totalSteps: manifest.steps.length,
    elapsedMs: Date.now() - new Date(manifest.startTime).getTime(),
  };

  try {
    const sessionDir = path.join(DEBUG_DIR, manifest.sessionId);
    fs.writeFileSync(
      path.join(sessionDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  } catch {}
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `cd /home/lrp/social_media_complete && npx tsc --noEmit apps/ts-api-gateway/src/lib/replyDebugLogger.ts --esModuleInterop --moduleResolution node --target es2020 --module commonjs --skipLibCheck`
Expected: No errors (may have import resolution warnings for prisma, but types should be correct)

- [ ] **Step 3: Commit**

```bash
git add apps/ts-api-gateway/src/lib/replyDebugLogger.ts
git commit -m "feat: add replyDebugLogger utility module for DOM snapshot saving"
```

---

### Task 2: 后端调试开关 API

**Files:**
- Modify: `apps/ts-api-gateway/src/routes/system.ts`

- [ ] **Step 1: 添加 debug-mode 端点到 system.ts**

在 `system.ts` 文件末尾的 `export default router;` 之前添加：

```typescript
/** GET /api/v1/system/debug-mode - 获取调试模式状态 */
router.get('/debug-mode', async (_req: Request, res: Response) => {
  try {
    const status = await prisma.systemStatus.findFirst();
    res.json({ success: true, data: { enabled: status?.isDebugMode ?? false } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '获取调试模式状态失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/** PUT /api/v1/system/debug-mode - 设置调试模式 */
router.put('/debug-mode', async (req: Request, res: Response) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
    }

    const status = await prisma.systemStatus.findFirst();
    if (status) {
      await prisma.systemStatus.update({ where: { id: status.id }, data: { isDebugMode: enabled } });
    } else {
      await prisma.systemStatus.create({ data: { id: 1, isDebugMode: enabled } });
    }

    logger.info({ enabled }, '调试模式已切换');
    res.json({ success: true, data: { enabled } });
  } catch (err) {
    logger.error({ err: (err as Error).message }, '设置调试模式失败');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `cd /home/lrp/social_media_complete && npx tsc --noEmit apps/ts-api-gateway/src/routes/system.ts --esModuleInterop --moduleResolution node --target es2020 --module commonjs --skipLibCheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/ts-api-gateway/src/routes/system.ts
git commit -m "feat: add GET/PUT /system/debug-mode API endpoints"
```

---

### Task 3: 集成快照到 douyinCrawler.ts — replyToComment 方法

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

- [ ] **Step 1: 添加 import 语句**

在 douyinCrawler.ts 文件顶部的 import 区域，在 `import { createLogger } from '../lib/logger';` 之后添加：

```typescript
import { isDebugModeEnabled, createReplySessionId, createManifest, saveDebugSnapshot, finishManifest, DebugManifest } from '../lib/replyDebugLogger';
```

- [ ] **Step 2: 修改 replyToComment 方法 — 添加调试初始化**

在 `replyToComment` 方法中，`logger.info` 之后、`try` 块之前，添加调试模式初始化代码。找到以下代码：

```typescript
    logger.info({
      text: target.text.slice(0, 30),
      level: target.level,
      createTime: target.createTime,
      rootText: target.rootText?.slice(0, 30),
    }, '[Reply] Starting douyin reply (dual-criteria)');

    try {
      await HumanActions.thinkingPause(page, 800, 2000);
```

替换为：

```typescript
    logger.info({
      text: target.text.slice(0, 30),
      level: target.level,
      createTime: target.createTime,
      rootText: target.rootText?.slice(0, 30),
    }, '[Reply] Starting douyin reply (dual-criteria)');

    // ── 调试模式初始化 ──
    const debugEnabled = await isDebugModeEnabled();
    let manifest: DebugManifest | null = null;
    let sessionId = '';
    let stepIdx = 0;

    if (debugEnabled) {
      sessionId = createReplySessionId(target);
      manifest = createManifest(sessionId, {
        text: target.text,
        level: target.level,
        createTime: target.createTime,
        rootText: target.rootText,
      });
      logger.info({ sessionId }, '[Reply] Debug mode enabled, snapshots will be saved');
    }

    const snap = async (label: string, extra?: Record<string, any>) => {
      if (manifest) {
        stepIdx++;
        await saveDebugSnapshot({ page, stepLabel: label, sessionId, stepIndex: stepIdx, manifest, extra });
      }
    };

    try {
      await HumanActions.thinkingPause(page, 800, 2000);
      await snap('reply_start');
```

- [ ] **Step 3: 修改 scrollExpandAndFindTarget 调用 — 传入 snap**

找到：

```typescript
      const foundCoords = await this.scrollExpandAndFindTarget(page, target);
```

替换为：

```typescript
      const foundCoords = await this.scrollExpandAndFindTarget(page, target, snap);
```

- [ ] **Step 4: 在 target_not_found 处添加快照**

找到：

```typescript
      if (!foundCoords) {
        logger.warn({ text: target.text.slice(0, 40), level: target.level }, '[Reply] Target not found');
        return false;
      }
```

替换为：

```typescript
      if (!foundCoords) {
        await snap('target_not_found');
        logger.warn({ text: target.text.slice(0, 40), level: target.level }, '[Reply] Target not found');
        if (manifest) finishManifest(manifest, false);
        return false;
      }
```

- [ ] **Step 5: 在 target_found 处添加快照**

找到：

```typescript
      logger.info({ x: Math.round(foundCoords.x), y: Math.round(foundCoords.y) }, '[Reply] Target located, clicking reply');
```

在它之前添加：

```typescript
      await snap('target_found', { x: Math.round(foundCoords.x), y: Math.round(foundCoords.y) });
```

- [ ] **Step 6: 在 hover_target 处添加快照**

找到：

```typescript
        // 先 hover 到评论区域，触发回复按钮显示
        await HumanActions.withCDPContext(page, async (ctx) => {
          await ctx.mouse.moveTo({ x: foundCoords.x, y: foundCoords.y });
          await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
        });
        await HumanActions.wait(page, 500, 1000);
```

在 `await HumanActions.wait(page, 500, 1000);` 之后添加：

```typescript
        await snap('hover_target', { x: Math.round(foundCoords.x), y: Math.round(foundCoords.y) });
```

- [ ] **Step 7: 在 click_reply_btn 处添加快照**

找到：

```typescript
          logger.info({ clicked: clickedReplyBtn }, '[Reply] 点击了回复按钮');
```

在它之后添加：

```typescript
          await snap('click_reply_btn', { clicked: clickedReplyBtn });
```

- [ ] **Step 8: 在 input_focused 处添加快照**

找到：

```typescript
          if (inputClicked) {
            logger.info('[Reply] 立即点击了 contenteditable');
            await HumanActions.wait(page, 300, 600);
          }
```

在 `await HumanActions.wait(page, 300, 600);` 之后添加：

```typescript
          await snap('input_focused', { immediate: true });
```

- [ ] **Step 9: 在 text_typed 处添加快照**

找到：

```typescript
      // ── 拟人化输入 ──
      await HumanActions.safeCDPType(page, replyText);
      await HumanActions.wait(page, 500, 1200);
```

在 `await HumanActions.wait(page, 500, 1200);` 之后添加：

```typescript
      await snap('text_typed', { textLength: replyText.length });
```

- [ ] **Step 10: 在 submit_clicked 处添加快照**

找到：

```typescript
      if (!submitClicked) logger.warn('[Reply] Submit not found, but text was typed');

      await HumanActions.wait(page, 2000, 4000);
```

在 `await HumanActions.wait(page, 2000, 4000);` 之后添加：

```typescript
      await snap('submit_clicked', { clicked: submitClicked });
```

- [ ] **Step 11: 在 verify_result 处添加快照**

找到：

```typescript
      logger.info({ verifyResult }, '[Reply] 提交后验证');

      await HumanActions.betweenActionsPause(page);
```

在 `logger.info` 之后、`await HumanActions.betweenActionsPause` 之前添加：

```typescript
      await snap('verify_result', verifyResult);
```

- [ ] **Step 12: 在成功返回处完成 manifest**

找到：

```typescript
      logger.info({ text: target.text.slice(0, 30), level: target.level }, '[Reply] Douyin reply completed');
      return true;
```

替换为：

```typescript
      logger.info({ text: target.text.slice(0, 30), level: target.level }, '[Reply] Douyin reply completed');
      if (manifest) finishManifest(manifest, true);
      return true;
```

- [ ] **Step 13: 在 catch 块中完成 manifest**

找到：

```typescript
    } catch (err: any) {
      logger.error({ error: err.message, text: target.text.slice(0, 30) }, '[Reply] Douyin reply failed');
      return false;
    }
```

替换为：

```typescript
    } catch (err: any) {
      await snap('error', { message: err.message });
      logger.error({ error: err.message, text: target.text.slice(0, 30) }, '[Reply] Douyin reply failed');
      if (manifest) finishManifest(manifest, false);
      return false;
    }
```

- [ ] **Step 14: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): integrate debug snapshots into replyToComment flow"
```

---

### Task 4: 集成快照到 douyinCrawler.ts — scrollExpandAndFindTarget 方法

**Files:**
- Modify: `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

- [ ] **Step 1: 修改 scrollExpandAndFindTarget 方法签名**

找到：

```typescript
  private async scrollExpandAndFindTarget(
    page: Page,
    target: ReplyTarget,
  ): Promise<{ x: number; y: number } | null> {
```

替换为：

```typescript
  private async scrollExpandAndFindTarget(
    page: Page,
    target: ReplyTarget,
    snap?: (label: string, extra?: Record<string, any>) => Promise<void>,
  ): Promise<{ x: number; y: number } | null> {
```

- [ ] **Step 2: 在 scroll_to_top 处添加快照**

找到：

```typescript
    await this.scrollCommentArea(page, 'top');
    await HumanActions.wait(page, 500, 800);

    logger.info({ text: target.text.slice(0, 30), time: target.createTime, isSub }, '[Reply::Find] Start (root-first expand)');
```

在 `logger.info` 之后添加：

```typescript
    await snap?.('scroll_to_top');
```

- [ ] **Step 3: 在每轮滚动后添加快照**

找到：

```typescript
    for (let scrollRound = 0; scrollRound < MAX_SCROLL; scrollRound++) {
      logger.info({ scrollRound: scrollRound + 1 }, '[Reply::Find] Scroll round');
```

在 `logger.info` 之后添加：

```typescript
      await snap?.('scroll_round_' + (scrollRound + 1));
```

- [ ] **Step 4: 在展开子回复后添加快照**

找到：

```typescript
        // 点击根评论容器内的"查看N条回复"按钮
        let expanded = false;
        // 用 CDP 在容器坐标附近点击展开按钮
        const btnText = await this.clickExpandButton(page);
```

在 `const btnText = await this.clickExpandButton(page);` 之后添加：

```typescript
        await snap?.('expand_sub_replies', { btnText });
```

- [ ] **Step 5: 验证 TypeScript 编译**

Run: `cd /home/lrp/social_media_complete && npx tsc --noEmit apps/ts-api-gateway/src/crawlers/douyinCrawler.ts --esModuleInterop --moduleResolution node --target es2020 --module commonjs --skipLibCheck 2>&1 | head -20`
Expected: No errors related to our changes

- [ ] **Step 6: Commit**

```bash
git add apps/ts-api-gateway/src/crawlers/douyinCrawler.ts
git commit -m "feat(douyin): add debug snapshots to scrollExpandAndFindTarget"
```

---

### Task 5: 前端 Hooks — useDebugMode

**Files:**
- Modify: `apps/admin-dashboard/src/hooks/useApi.ts`

- [ ] **Step 1: 添加 useDebugMode 和 useUpdateDebugMode hooks**

在 `useApi.ts` 文件末尾（最后一个 `export function` 之后）添加：

```typescript
// ============================================================
// 调试模式开关
// ============================================================

export function useDebugMode() {
  return useQuery({
    queryKey: ['debug-mode'],
    queryFn: () => api.get('/system/debug-mode').then((r) => r.data),
    refetchInterval: 30000,
  });
}

export function useUpdateDebugMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.put('/system/debug-mode', { enabled }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['debug-mode'] }),
  });
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `cd /home/lrp/social_media_complete && npx tsc --noEmit apps/admin-dashboard/src/hooks/useApi.ts --esModuleInterop --moduleResolution node --target es2020 --module esnext --jsx react-jsx --skipLibCheck 2>&1 | head -10`
Expected: No errors related to our changes

- [ ] **Step 3: Commit**

```bash
git add apps/admin-dashboard/src/hooks/useApi.ts
git commit -m "feat(dashboard): add useDebugMode and useUpdateDebugMode hooks"
```

---

### Task 6: 前端 UI — MonitorTab 调试开关

**Files:**
- Modify: `apps/admin-dashboard/src/app/matrix/page.tsx`

- [ ] **Step 1: 添加 hooks 调用到 MonitorTab 组件**

在 `MonitorTab` 组件内，找到现有的 hooks 调用区域（约 line 792-808），在 `const clearUserData = useClearUserData();` 之后添加：

```typescript
  const { data: debugModeData } = useDebugMode();
  const updateDebugMode = useUpdateDebugMode();
  const isDebugMode = debugModeData?.enabled ?? false;
```

- [ ] **Step 2: 在操作按钮区添加调试开关 UI**

找到清空数据库按钮之后的 `</div>` 闭合标签（约 line 1050），在它之前添加：

```tsx
              {/* 回复调试开关 */}
              <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-surface border border-outline-variant flex-shrink-0">
                <MaterialIcon icon="bug_report" size="sm" className="text-amber-500" />
                <span className="text-label-md text-on-surface-variant">回复调试</span>
                <ToggleSwitch
                  id="debug-mode-toggle"
                  checked={isDebugMode}
                  onChange={(v) => updateDebugMode.mutate(v)}
                  disabled={updateDebugMode.isPending}
                />
              </div>
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `cd /home/lrp/social_media_complete && npx tsc --noEmit apps/admin-dashboard/src/app/matrix/page.tsx --esModuleInterop --moduleResolution node --target es2020 --module esnext --jsx react-jsx --skipLibCheck 2>&1 | head -20`
Expected: No errors related to our changes

- [ ] **Step 4: Commit**

```bash
git add apps/admin-dashboard/src/app/matrix/page.tsx
git commit -m "feat(dashboard): add debug mode toggle to MonitorTab"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 验证后端编译**

Run: `cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/ts-api-gateway/tsconfig.json 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 2: 验证前端编译**

Run: `cd /home/lrp/social_media_complete && npx tsc --noEmit -p apps/admin-dashboard/tsconfig.json 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: 验证 data/reply_debug 目录可写**

Run: `mkdir -p /home/lrp/social_media_complete/data/reply_debug && ls -la /home/lrp/social_media_complete/data/reply_debug`
Expected: Directory exists and is writable

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete douyin reply debug logging system"
```
