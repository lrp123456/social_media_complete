# 抖音回复流程调试日志系统设计

**日期：** 2026-06-16
**状态：** 待实现
**范围：** 抖音评论回复流程的详细调试日志和 DOM 快照保存

## 背景

抖音评论回复流程涉及多个复杂步骤（滚动查找目标评论、展开子回复、点击回复按钮、输入文字、发送），任何一个步骤出错都可能导致回复失败。当前日志只记录到 stdout 且 HTML 被截断到 5000 字符，无法用于事后分析 DOM 状态。

需要一个调试系统，在每个关键操作后保存完整的 DOM HTML 和页面截图到磁盘文件，供开发者分析问题根因。

## 架构

```
前端 ToggleSwitch ──PUT──> /system/debug-mode ──> Prisma SystemStatus.isDebugMode
                                                        │
replyToComment() ──读取 isDebugMode ─────────────────────┘
       │
       ├── saveDebugSnapshot() ──> data/reply_debug/{sessionId}/
       │     ├── 01_scroll_to_top.html + .png
       │     ├── 02_target_found.html + .png
       │     ├── ...
       │     └── manifest.json
```

## 组件设计

### 1. 后端：调试开关 API

**修改文件：** `apps/ts-api-gateway/src/routes/system.ts`

利用已有的 `SystemStatus.isDebugMode` 字段（Prisma schema 中已定义但未使用）。

**端点：**

- `GET /system/debug-mode`
  - 响应：`{ success: true, data: { enabled: boolean } }`
  - 读取 `prisma.systemStatus.findFirst()` 的 `isDebugMode` 字段

- `PUT /system/debug-mode`
  - 请求体：`{ enabled: boolean }`
  - 响应：`{ success: true, data: { enabled: boolean } }`
  - 更新 `prisma.systemStatus.update()` 的 `isDebugMode` 字段

**注意：** 数据库中只有一行 SystemStatus（id=1），使用 `findFirst` + `upsert` 模式确保记录存在。

### 2. 后端：调试快照工具模块

**新建文件：** `apps/ts-api-gateway/src/lib/replyDebugLogger.ts`

**核心导出：**

```typescript
import { Page } from 'patchright';
import { prisma } from './prisma';
import { createLogger } from './logger';
import fs from 'fs';
import path from 'path';

const logger = createLogger('reply-debug');

const DEBUG_DIR = path.resolve(process.cwd(), 'data', 'reply_debug');

/**
 * 检查调试模式是否启用
 */
export async function isDebugModeEnabled(): Promise<boolean> {
  try {
    const status = await prisma.systemStatus.findFirst();
    return status?.isDebugMode ?? false;
  } catch {
    return false;
  }
}

/**
 * 创建回复调试会话 ID
 */
export function createReplySessionId(target: { text: string; createTime: number; level: number }): string {
  const safeText = target.text.slice(0, 20).replace(/[^a-zA-Z0-9一-鿿]/g, '_');
  return `reply_${safeText}_${target.createTime}_${Date.now()}`;
}

interface DebugSnapshotOptions {
  page: Page;
  stepLabel: string;
  sessionId: string;
  stepIndex: number;
  saveScreenshot?: boolean;
  saveDomHtml?: boolean;
  extra?: Record<string, any>;
  manifest: DebugManifest;
}

interface DebugManifest {
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

/**
 * 创建初始 manifest
 */
export function createManifest(sessionId: string, target: { text: string; level: number; createTime: number; rootText?: string }): DebugManifest {
  return {
    sessionId,
    startTime: new Date().toISOString(),
    target,
    steps: [],
  };
}

/**
 * 保存调试快照（DOM HTML + 截图）
 */
export async function saveDebugSnapshot(options: DebugSnapshotOptions): Promise<void> {
  const { page, stepLabel, sessionId, stepIndex, saveScreenshot = true, saveDomHtml = true, extra, manifest } = options;

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

    // 更新 manifest
    manifest.steps.push({
      step: stepIndex,
      label: stepLabel,
      timestamp: new Date().toISOString(),
      htmlFile,
      screenshotFile,
      url: page.url(),
      extra,
    });

    // 写入 manifest.json（每次更新都写入，防止中途失败丢失信息）
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

/**
 * 完成调试会话（写入最终结果）
 */
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

### 3. 集成到 douyinCrawler.ts

**修改文件：** `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts`

**修改 `replyToComment` 方法：**

```typescript
async replyToComment(page: Page, target: ReplyTarget, replyText: string): Promise<boolean> {
  // ── 调试模式初始化 ──
  const debugEnabled = await isDebugModeEnabled();
  let manifest: DebugManifest | null = null;
  let sessionId = '';
  let stepIdx = 0;

  if (debugEnabled) {
    sessionId = createReplySessionId(target);
    manifest = createManifest(sessionId, { text: target.text, level: target.level, createTime: target.createTime, rootText: target.rootText });
    logger.info({ sessionId }, '[Reply] Debug mode enabled, snapshots will be saved');
  }

  const snap = async (label: string, extra?: Record<string, any>) => {
    if (manifest) {
      stepIdx++;
      await saveDebugSnapshot({ page, stepLabel: label, sessionId, stepIndex: stepIdx, manifest, extra });
    }
  };

  try {
    // ... 现有逻辑 ...
    await snap('reply_start');

    const foundCoords = await this.scrollExpandAndFindTarget(page, target, snap);
    // snap 已在 scrollExpandAndFindTarget 内部调用

    if (!foundCoords) {
      await snap('target_not_found');
      return false;
    }

    await snap('target_found', { x: foundCoords.x, y: foundCoords.y });

    // hover 到评论区域
    await snap('hover_target', { x: foundCoords.x, y: foundCoords.y });

    // 点击回复按钮后
    await snap('click_reply_btn', { clicked: clickedReplyBtn });

    // contenteditable 获得焦点后
    await snap('input_focused', { clicked: inputClicked });

    // 输入文字后
    await snap('text_typed', { textLength: replyText.length });

    // 点击发送后
    await snap('submit_clicked', { clicked: submitClicked });

    // 验证结果后
    await snap('verify_result', verifyResult);

    if (manifest) finishManifest(manifest, true);
    return true;
  } catch (err: any) {
    await snap('error', { message: err.message });
    if (manifest) finishManifest(manifest, false);
    return false;
  }
}
```

**修改 `scrollExpandAndFindTarget` 方法签名：**

```typescript
private async scrollExpandAndFindTarget(
  page: Page,
  target: ReplyTarget,
  snap?: (label: string, extra?: Record<string, any>) => Promise<void>,
): Promise<{ x: number; y: number } | null>
```

在方法内部的关键步骤后调用 `snap`：
- 滚到顶部后：`await snap?.('scroll_to_top')`
- 每轮滚动后：`await snap?.('scroll_round_' + (scrollRound + 1))`
- 点击展开按钮后：`await snap?.('expand_sub_replies')`
- 找到目标后：由调用方 `replyToComment` 处理

### 4. 前端：调试开关

**修改文件：** `apps/admin-dashboard/src/hooks/useApi.ts`

添加 hooks：

```typescript
// 调试模式开关
export function useDebugMode() {
  return useQuery({
    queryKey: ['debug-mode'],
    queryFn: () => api.get('/system/debug-mode'),
    refetchInterval: 30000,
  });
}

export function useUpdateDebugMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.put('/system/debug-mode', { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['debug-mode'] }),
  });
}
```

**修改文件：** `apps/admin-dashboard/src/app/matrix/page.tsx`

在 `MonitorTab` 的操作按钮区域添加调试开关：

```tsx
import { useDebugMode, useUpdateDebugMode } from '@/hooks/useApi';

// 在 MonitorTab 组件内
const { data: debugModeData } = useDebugMode();
const updateDebugMode = useUpdateDebugMode();
const isDebugMode = debugModeData?.data?.enabled ?? false;

// 在 JSX 中的操作按钮区域
<div className="flex items-center gap-2">
  <span className="text-sm text-gray-500">回复调试</span>
  <ToggleSwitch
    enabled={isDebugMode}
    onChange={(enabled) => updateDebugMode.mutate(enabled)}
    loading={updateDebugMode.isPending}
  />
</div>
```

## 调试点位表

| 序号 | stepLabel | 位置 | 说明 |
|------|-----------|------|------|
| 1 | `reply_start` | replyToComment 入口 | 记录初始页面状态 |
| 2 | `scroll_to_top` | scrollExpandAndFindTarget | 滚到评论区顶部后 |
| 3 | `scroll_round_{N}` | scrollExpandAndFindTarget | 每轮滚动后 |
| 4 | `expand_sub_replies` | scrollExpandAndFindTarget | 点击"查看N条回复"后 |
| 5 | `target_found` | replyToComment | 找到目标评论坐标后 |
| 6 | `target_not_found` | replyToComment | 最终扫描后仍未找到 |
| 7 | `hover_target` | replyToComment | hover 到目标评论后 |
| 8 | `click_reply_btn` | replyToComment | 点击"回复"按钮后 |
| 9 | `input_focused` | replyToComment | contenteditable 获得焦点后 |
| 10 | `text_typed` | replyToComment | 输入回复文字后 |
| 11 | `submit_clicked` | replyToComment | 点击发送按钮后 |
| 12 | `verify_result` | replyToComment | 验证回复结果后 |
| 13 | `error` | replyToComment catch | 发生错误时 |

## 文件清单

| 操作 | 文件路径 |
|------|----------|
| 新建 | `apps/ts-api-gateway/src/lib/replyDebugLogger.ts` |
| 修改 | `apps/ts-api-gateway/src/routes/system.ts` |
| 修改 | `apps/ts-api-gateway/src/crawlers/douyinCrawler.ts` |
| 修改 | `apps/admin-dashboard/src/hooks/useApi.ts` |
| 修改 | `apps/admin-dashboard/src/app/matrix/page.tsx` |

## 非目标

- 不修改其他平台（快手、腾讯）的回复流程
- 不修改 `executeReplyAction` 的导航阶段（只覆盖 `replyToComment` 内部）
- 不在生产环境自动清理调试文件（手动清理即可）
