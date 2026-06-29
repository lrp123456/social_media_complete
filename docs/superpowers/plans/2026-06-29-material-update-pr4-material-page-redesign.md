# 素材更新管线 PR4 — /material 页面重设计（去 MOCK）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写 `/material` 页面，移除全部 MOCK 数据，改为左侧「快速采集面板」（选平台/风格/数量 → 触发真实采集 + 实时任务状态）+ 右侧「资产库面板」（风格/平台/状态筛选 + 真实 `hot_video_candidates` 卡片网格 + 重跑 LLM），对接 PR1-3 的后端接口。

**Architecture:** 后端 `/candidates` 加 `style` 过滤 + BigInt/Date 序列化（修复 `playCount`/`likeCount`/`commentCount` 无法 JSON 序列化的潜在 bug）；新增 `POST /material-update/reprocess/:id`（重新下发单条候选，优先用归档 `local_path`）+ 服务层 `reprocessCandidate`。前端新增 `MaterialCandidate` 类型与 `useReprocessMaterial` hook，`useMaterialCandidates` 加 `style` 参数；`/material/page.tsx` 整体重写为两栏布局，复用 `BentoCard`/`StatusPill`/`MaterialIcon`/`cn` 与现有风格 token。

**Tech Stack:** TypeScript（ts-api-gateway）、Next.js 14 + React 18 + TanStack Query + Tailwind（admin-dashboard，`tsc --noEmit` + `next lint` 校验，前端无测试运行器）。

> **依赖：** 基于 PR1+PR2+PR3 分支。需要 `HotVideoCandidate` 新列（PR2）、`runMaterialUpdate({styleDir,count})`（PR1）、`useTriggerMaterialRun(opts)`（PR1）、`/status.runHealth`（PR3）。

## 关键约定

1. **BigInt 序列化**：`/candidates` 返回前用 `serializeCandidate` 把 `playCount`/`likeCount`/`commentCount`（BigInt）转 `number|null`，`publishTime`/`fetchedAt`/`acceptedAt`（Date）转 ISO 字符串。否则 Express `res.json` 对 BigInt 抛 `Do not know how to serialize a BigInt`。
2. **资产库用 `/material-update/candidates`**（候选视频），不用 `/materials`（独立素材库）。
3. **重跑 LLM**：`POST /material-update/reprocess/:id`，仅 `status=accepted|rejected` 可触发；若 `storageStatus='archived'` 且 `storagePath` 存在，传归档 `local_path`（免重下载），否则传 `video_url` + `local_path=null`。
4. **左侧数量滑块**：1-200，默认 50（与 PR1 `DEFAULT_COUNT` 一致），不依赖 `maxPages`。
5. **前端无测试运行器**：靠 `tsc --noEmit` + `next lint` + 手动验证。

## 文件结构

**修改：**
- `apps/ts-api-gateway/src/routes/material-update.ts:78-121`（`/candidates` 加 style 过滤 + 序列化）、新增 `/reprocess/:id` 端点。
- `apps/ts-api-gateway/src/services/materialUpdateService.ts`（新增 `reprocessCandidate` 导出）。
- `apps/admin-dashboard/src/types/material.ts`（新增 `MaterialCandidate` 类型）。
- `apps/admin-dashboard/src/hooks/useApi.ts`（`useMaterialCandidates` 加 style 参；新增 `useReprocessMaterial`）。
- `apps/admin-dashboard/src/app/material/page.tsx`（整体重写）。

---

## Task 1: `/candidates` 加 style 过滤 + BigInt 序列化

**Files:**
- Modify: `apps/ts-api-gateway/src/routes/material-update.ts:78-121`

- [ ] **Step 1: 加 `style` 到 query schema + 序列化函数**

把 `routes/material-update.ts` 的 `candidatesQuerySchema` 与 `/candidates` handler：
```ts
const candidatesQuerySchema = z.object({
  page: z.string().optional().default('1'),
  pageSize: z.string().optional().default('20'),
  platformId: z.string().optional(),
  status: z.string().optional(),
});

materialUpdateRouter.get('/candidates', async (req: Request, res: Response) => {
  const parsed = candidatesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.flatten() });
    return;
  }

  const { page, pageSize, platformId, status } = parsed.data;
  const pageNum = parseInt(page, 10);
  const size = parseInt(pageSize, 10);

  const where: Record<string, unknown> = {};
  if (platformId) where.platform = platformId;
  if (status) where.status = status;

  try {
    const [items, total] = await Promise.all([
      prisma.hotVideoCandidate.findMany({
        where,
        orderBy: { fetchedAt: 'desc' },
        skip: (pageNum - 1) * size,
        take: size,
      }),
      prisma.hotVideoCandidate.count({ where }),
    ]);

    res.json({
      success: true,
      data: { items, total, page: pageNum, pageSize: size },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});
```
替换为：
```ts
const candidatesQuerySchema = z.object({
  page: z.string().optional().default('1'),
  pageSize: z.string().optional().default('20'),
  platformId: z.string().optional(),
  status: z.string().optional(),
  style: z.string().optional(),
});

/** 把 Prisma 候选对象序列化为 JSON 安全结构（BigInt→number，Date→ISO）。 */
function serializeCandidate(c: any) {
  return {
    id: c.id,
    platform: c.platform,
    videoId: c.videoId,
    title: c.title,
    author: c.author,
    cover: c.cover,
    videoUrl: c.videoUrl,
    playCount: c.playCount != null ? Number(c.playCount) : null,
    likeCount: c.likeCount != null ? Number(c.likeCount) : null,
    commentCount: c.commentCount != null ? Number(c.commentCount) : null,
    publishTime: c.publishTime ? new Date(c.publishTime).toISOString() : null,
    fetchedAt: c.fetchedAt ? new Date(c.fetchedAt).toISOString() : null,
    acceptedAt: c.acceptedAt ? new Date(c.acceptedAt).toISOString() : null,
    status: c.status,
    style: c.style,
    rating: c.rating ?? null,
    storagePath: c.storagePath,
    storageStatus: c.storageStatus,
    failReason: c.failReason,
  };
}

materialUpdateRouter.get('/candidates', async (req: Request, res: Response) => {
  const parsed = candidatesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.flatten() });
    return;
  }

  const { page, pageSize, platformId, status, style } = parsed.data;
  const pageNum = parseInt(page, 10);
  const size = parseInt(pageSize, 10);

  const where: Record<string, unknown> = {};
  if (platformId) where.platform = platformId;
  if (status) where.status = status;
  if (style) where.style = style;

  try {
    const [rows, total] = await Promise.all([
      prisma.hotVideoCandidate.findMany({
        where,
        orderBy: { fetchedAt: 'desc' },
        skip: (pageNum - 1) * size,
        take: size,
      }),
      prisma.hotVideoCandidate.count({ where }),
    ]);

    res.json({
      success: true,
      data: { items: rows.map(serializeCandidate), total, page: pageNum, pageSize: size },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/ts-api-gateway && npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 3: Commit**

```bash
git add apps/ts-api-gateway/src/routes/material-update.ts
git commit -m "fix(material-update): /candidates style filter + BigInt/Date serialization

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: `reprocessCandidate` 服务函数 + `/reprocess/:id` 端点

**Files:**
- Modify: `apps/ts-api-gateway/src/services/materialUpdateService.ts`（新增导出）
- Modify: `apps/ts-api-gateway/src/routes/material-update.ts`（新增端点）

- [ ] **Step 1: 新增 `reprocessCandidate`**

在 `materialUpdateService.ts` 的 `testPlatform` 函数之后追加：
```ts
/**
 * 重新下发单条候选到 Python Worker（重跑 LLM 评估）。
 * 仅 status=accepted|rejected 可触发。归档文件存在则传 local_path 免重下载。
 */
export async function reprocessCandidate(candidateId: string): Promise<void> {
  const config = getMaterialUpdateConfig();
  const candidate = await prisma.hotVideoCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) {
    throw new Error(`候选不存在: ${candidateId}`);
  }
  if (candidate.status !== 'accepted' && candidate.status !== 'rejected') {
    throw new Error(`仅 accepted/rejected 候选可重跑，当前状态: ${candidate.status}`);
  }

  let localPath: string | null = null;
  if (config.storage.enabled && candidate.storageStatus === 'archived' && candidate.storagePath) {
    localPath = path.resolve(config.storage.rootPath, candidate.storagePath);
  }

  await prisma.hotVideoCandidate.update({
    where: { id: candidateId },
    data: { status: 'processing', style: null, rating: null, failReason: null },
  });

  await dispatchToPython(candidate.id, candidate.videoUrl || '', candidate.platform, config, localPath);
  logger.info(`[materialUpdate] 候选 ${candidateId} 已重新下发 Python（local_path=${localPath ? '有' : '无'}）`);
}
```
（`path` 已在 PR2 导入；`prisma`/`getMaterialUpdateConfig`/`dispatchToPython`/`logger` 均已在文件内可用。）

- [ ] **Step 2: 新增 `/reprocess/:id` 端点**

在 `routes/material-update.ts` 的 `/disk-usage` 端点之后、`/webhook` 之前插入：
```ts
// ============================================================
// POST /api/v1/material-update/reprocess/:id — 重跑单条候选 LLM 评估
// ============================================================
materialUpdateRouter.post('/reprocess/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await reprocessCandidate(id);
    res.status(202).json({ success: true, message: '已触发重跑' });
  } catch (err) {
    const msg = String(err);
    const status = msg.includes('不存在') ? 404 : msg.includes('仅 accepted') ? 409 : 500;
    res.status(status).json({ success: false, error: msg });
  }
});
```

- [ ] **Step 3: import `reprocessCandidate`**

在 `routes/material-update.ts` 顶部从 service 的 import 中加入 `reprocessCandidate`：
```ts
import { runMaterialUpdate, isRunning, getRunState, reprocessCandidate } from '../services/materialUpdateService';
```
（原行 `import { runMaterialUpdate, isRunning, getRunState } from '../services/materialUpdateService';` 替换为上述。）

- [ ] **Step 4: 类型检查**

Run: `cd apps/ts-api-gateway && npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 5: Commit**

```bash
git add apps/ts-api-gateway/src/services/materialUpdateService.ts apps/ts-api-gateway/src/routes/material-update.ts
git commit -m "feat(material-update): POST /reprocess/:id re-run single candidate LLM eval

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 前端 `MaterialCandidate` 类型 + hooks

**Files:**
- Modify: `apps/admin-dashboard/src/types/material.ts`（追加 `MaterialCandidate`）
- Modify: `apps/admin-dashboard/src/hooks/useApi.ts`（`useMaterialCandidates` 加 style；新增 `useReprocessMaterial`）

- [ ] **Step 1: 追加 `MaterialCandidate` 类型**

在 `apps/admin-dashboard/src/types/material.ts` 末尾追加：
```ts
export interface MaterialCandidate {
  id: string;
  platform: string;
  videoId: string;
  title: string | null;
  author: string | null;
  cover: string | null;
  videoUrl: string | null;
  playCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  publishTime: string | null;
  fetchedAt: string;
  acceptedAt: string | null;
  status: 'pending' | 'processing' | 'accepted' | 'rejected' | 'no_url';
  style: string | null;
  rating: number | null;
  storagePath: string | null;
  storageStatus: 'none' | 'pending_downloaded' | 'archived' | 'failed';
  failReason: string | null;
}
```

- [ ] **Step 2: `useMaterialCandidates` 加 `style` 参数**

在 `apps/admin-dashboard/src/hooks/useApi.ts` 中把 `useMaterialCandidates`：
```ts
export function useMaterialCandidates(page = 1, pageSize = 20, platformId?: string, status?: string) {
  const params: Record<string, string> = { page: String(page), pageSize: String(pageSize) };
  if (platformId) params.platformId = platformId;
  if (status) params.status = status;
  return useQuery({
    queryKey: ['material-candidates', page, pageSize, platformId, status],
    queryFn: () => api.get('/material-update/candidates', { params }).then((r) => r.data),
  });
}
```
替换为：
```ts
export function useMaterialCandidates(
  page = 1,
  pageSize = 20,
  platformId?: string,
  status?: string,
  style?: string,
) {
  const params: Record<string, string> = { page: String(page), pageSize: String(pageSize) };
  if (platformId) params.platformId = platformId;
  if (status) params.status = status;
  if (style) params.style = style;
  return useQuery({
    queryKey: ['material-candidates', page, pageSize, platformId, status, style],
    queryFn: () => api.get('/material-update/candidates', { params }).then((r) => r.data),
  });
}
```

- [ ] **Step 3: 新增 `useReprocessMaterial` hook**

在 `useApi.ts` 的 `useMaterialDiskUsage` 之后（或 `useMaterialCandidates` 之后）追加：
```ts
export function useReprocessMaterial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/material-update/reprocess/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['material-candidates'] }),
  });
}
```

- [ ] **Step 4: 类型检查**

Run: `cd apps/admin-dashboard && npx tsc --noEmit`
Expected: 报错仅可能来自待重写的 `material/page.tsx`（若其引用旧类型）。`types/material.ts` 与 `useApi.ts` 本身无报错。

- [ ] **Step 5: Commit**

```bash
git add apps/admin-dashboard/src/types/material.ts apps/admin-dashboard/src/hooks/useApi.ts
git commit -m "feat(material-update): MaterialCandidate type, useMaterialCandidates style filter, useReprocessMaterial

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 重写 `/material` 页面

**Files:**
- Modify: `apps/admin-dashboard/src/app/material/page.tsx`（整体重写）

- [ ] **Step 1: 读取旧文件确认要替换**

Run: `wc -l apps/admin-dashboard/src/app/material/page.tsx`
Expected: 约 664 行（确认是旧 MOCK 版本）。
（用 Read 工具读取该文件以满足 Write 前置条件——仅用于覆盖许可，不需逐行分析。）

- [ ] **Step 2: 整体重写 `page.tsx`**

用 Write 工具把 `apps/admin-dashboard/src/app/material/page.tsx` 整体替换为：
```tsx
'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { BentoCard } from '@/components/ui/Bento';
import { StatusPill } from '@/components/ui/StatusPill';
import { cn } from '@/lib/utils';
import {
  useMaterialConfig,
  useMaterialStatus,
  useMaterialCandidates,
  useTriggerMaterialRun,
  useReprocessMaterial,
} from '@/hooks/useApi';
import type { MaterialCandidate, MaterialUpdateConfig } from '@/types/material';

const STATUS_TONE: Record<MaterialCandidate['status'], 'success' | 'error' | 'info' | 'neutral' | 'pending'> = {
  accepted: 'success',
  rejected: 'error',
  processing: 'info',
  pending: 'pending',
  no_url: 'neutral',
};

export default function MaterialPage() {
  const configQuery = useMaterialConfig();
  const statusQuery = useMaterialStatus();
  const reprocess = useReprocessMaterial();

  const config = configQuery.data as (MaterialUpdateConfig & { platforms: any[] }) | undefined;

  // 左侧采集面板状态
  const enabledPlatforms = config?.platforms?.filter((p) => p.enabled) ?? [];
  const styles = config?.processing?.styles ?? [];
  const [selectedPlatform, setSelectedPlatform] = useState<string>('');
  const [selectedStyleDir, setSelectedStyleDir] = useState<string>('');
  const [count, setCount] = useState<number>(50);

  // 右侧资产库筛选
  const [filterStyle, setFilterStyle] = useState<string>('');
  const [filterPlatform, setFilterPlatform] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');

  const candidatesQuery = useMaterialCandidates(1, 48, filterPlatform || undefined, filterStatus || undefined, filterStyle || undefined);
  const triggerRun = useTriggerMaterialRun();

  const items: MaterialCandidate[] = candidatesQuery.data?.items ?? [];
  const total: number = candidatesQuery.data?.total ?? 0;

  const lastRun = statusQuery.data?.lastRunAt ? new Date(statusQuery.data.lastRunAt).toLocaleString() : '从未';
  const lastResult = statusQuery.data?.lastResult ?? {};

  const onTrigger = () => {
    triggerRun.mutate({ styleDir: selectedStyleDir || undefined, count });
  };

  const copyPath = (path: string) => {
    navigator.clipboard?.writeText(path).catch(() => {});
  };

  if (configQuery.isLoading) {
    return <div className="p-6 text-on-surface-variant">加载配置中…</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-headline-sm font-bold">素材中心</h1>
        <p className="text-sm text-on-surface-variant mt-1">快速采集热门视频 → LLM 评估 → 按风格归档</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* 左侧：快速采集面板 */}
        <BentoCard className="lg:col-span-4 p-4 space-y-4 self-start">
          <h2 className="text-lg font-semibold">采集配置</h2>

          <div>
            <label className="text-xs text-on-surface-variant mb-1 block">选择平台</label>
            <div className="flex flex-wrap gap-2">
              {enabledPlatforms.length === 0 && (
                <span className="text-sm text-on-surface-variant italic">无启用平台，前往设置配置</span>
              )}
              {enabledPlatforms.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedPlatform(p.id)}
                  className={cn(
                    'px-3 py-1.5 rounded-full text-sm border',
                    selectedPlatform === p.id
                      ? 'bg-primary text-on-primary border-primary'
                      : 'bg-surface-container-low border-outline-variant text-on-surface',
                  )}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs text-on-surface-variant mb-1 block">选择风格</label>
            <select
              className="form-input text-sm w-full"
              value={selectedStyleDir}
              onChange={(e) => setSelectedStyleDir(e.target.value)}
            >
              <option value="">全部风格（cron 模式）</option>
              {styles.map((s) => (
                <option key={s.dir} value={s.dir}>{s.name}（{s.dir}）</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-on-surface-variant mb-1 block">采集数量（{{'{COUNT}'}}）: {count}</label>
            <input
              type="range"
              min={1}
              max={200}
              value={count}
              onChange={(e) => setCount(parseInt(e.target.value, 10))}
              className="w-full"
            />
          </div>

          <button
            type="button"
            onClick={onTrigger}
            disabled={triggerRun.isPending || statusQuery.data?.running}
            className="btn-primary w-full"
          >
            <MaterialIcon icon="play_arrow" size="sm" />
            {statusQuery.data?.running ? '采集中...' : '启动采集'}
          </button>

          <div className="border-t border-outline-variant pt-3 space-y-2">
            <h3 className="text-sm font-semibold">任务状态</h3>
            <div className="flex items-center gap-2 text-sm">
              <StatusPill tone={statusQuery.data?.running ? 'info' : 'neutral'} dot>
                {statusQuery.data?.running ? '运行中' : '空闲'}
              </StatusPill>
              <span className="text-on-surface-variant text-xs">上次运行: {lastRun}</span>
            </div>
            {Object.keys(lastResult).length > 0 && (
              <div className="space-y-1">
                {Object.entries(lastResult).map(([pid, r]: [string, any]) => {
                  const p = config?.platforms?.find((x) => x.id === pid);
                  return (
                    <div key={pid} className="text-xs text-on-surface-variant">
                      {p?.name ?? pid}: 抓取 {r.fetched}，新增 {r.newCandidates}
                      {r.errors?.length > 0 && <span className="text-error"> · {r.errors.length} 错误</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </BentoCard>

        {/* 右侧：资产库面板 */}
        <BentoCard className="lg:col-span-8 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">素材归档视窗</h2>
            <span className="text-sm text-on-surface-variant">共 {total} 条素材</span>
          </div>

          <div className="flex flex-wrap gap-2">
            <select className="form-input text-sm" value={filterStyle} onChange={(e) => setFilterStyle(e.target.value)}>
              <option value="">风格: 全部</option>
              {styles.map((s) => (
                <option key={s.dir} value={s.dir}>{s.name}</option>
              ))}
            </select>
            <select className="form-input text-sm" value={filterPlatform} onChange={(e) => setFilterPlatform(e.target.value)}>
              <option value="">平台: 全部</option>
              {config?.platforms?.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select className="form-input text-sm" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">状态: 全部</option>
              <option value="pending">pending</option>
              <option value="processing">processing</option>
              <option value="accepted">accepted</option>
              <option value="rejected">rejected</option>
            </select>
          </div>

          {candidatesQuery.isLoading ? (
            <div className="text-sm text-on-surface-variant">加载中…</div>
          ) : candidatesQuery.isError ? (
            <div className="text-sm text-error">加载失败，请重试</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-on-surface-variant italic text-center py-12">
              暂无候选视频，先在左侧启动采集
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
              {items.map((c) => (
                <div key={c.id} className="rounded-lg border border-outline-variant overflow-hidden bg-surface-container-lowest flex flex-col">
                  <div className="aspect-video bg-surface-container relative">
                    {c.cover ? (
                      <img src={c.cover} alt={c.title || ''} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-on-surface-variant">
                        <MaterialIcon icon="movie" />
                      </div>
                    )}
                    {c.rating != null && (
                      <span className="absolute top-1 right-1 bg-surface-container-lowest/90 text-xs font-bold px-1.5 py-0.5 rounded">
                        评级 {c.rating}
                      </span>
                    )}
                  </div>
                  <div className="p-2 flex-1 flex flex-col gap-1">
                    <p className="text-sm font-medium truncate" title={c.title || ''}>{c.title || '(无标题)'}</p>
                    <p className="text-xs text-on-surface-variant truncate">{c.author || '未知'} · {c.platform}</p>
                    <div className="flex items-center gap-1 flex-wrap mt-1">
                      <StatusPill tone={STATUS_TONE[c.status]}>{c.status}</StatusPill>
                      {c.style && <span className="text-xs text-on-surface-variant">{c.style}</span>}
                      {c.likeCount != null && <span className="text-xs text-on-surface-variant">赞 {c.likeCount}</span>}
                    </div>
                    <div className="flex items-center gap-1 mt-1 pt-1 border-t border-outline-variant">
                      <button
                        type="button"
                        onClick={() => reprocess.mutate(c.id)}
                        disabled={reprocess.isPending || (c.status !== 'accepted' && c.status !== 'rejected')}
                        className="btn-ghost text-xs text-primary"
                        title={c.status === 'accepted' || c.status === 'rejected' ? '重跑 LLM 评估' : '仅 accepted/rejected 可重跑'}
                      >
                        <MaterialIcon icon="sync" size="sm" />
                        重跑
                      </button>
                      {c.storagePath && (
                        <button
                          type="button"
                          onClick={() => copyPath(c.storagePath!)}
                          className="btn-ghost text-xs text-on-surface-variant"
                          title={c.storagePath}
                        >
                          <MaterialIcon icon="folder" size="sm" />
                          路径
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </BentoCard>
      </div>
    </div>
  );
}
```

> 注意：`{{'{COUNT}'}}` 在 JSX 中需要渲染字面量 `{{COUNT}}`。如果上述写法在 `tsc`/构建时报错，改为：`采集数量（<code className="font-mono">{'{{COUNT}}'}</code>）: {count}`。

- [ ] **Step 3: 类型检查 + lint**

Run: `cd apps/admin-dashboard && npx tsc --noEmit && npm run lint`
Expected: 无报错。若有 `BentoCard` props 不兼容（如 `className`/`self-start`），按其类型签名调整（`BentoCard` 在旧页面已用 `className`，应兼容）。

- [ ] **Step 4: 构建烟测**

Run: `cd apps/admin-dashboard && npm run build`
Expected: 构建成功（`✓ Compiled successfully`）。若因 `next build` 较慢可跳过，但建议至少跑一次以捕获 SSR/客户端边界问题。

- [ ] **Step 5: Commit**

```bash
git add apps/admin-dashboard/src/app/material/page.tsx
git commit -m "feat(material-update): rewrite /material page — quick-collect panel + asset library, no MOCK

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 全量验证

- [ ] **Step 1: 后端类型检查**

Run: `cd apps/ts-api-gateway && npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 2: 后端单测回归（确保 PR1-3 未被破坏）**

Run: `cd apps/ts-api-gateway && npx jest materialParser materialKeyPool materialUpdateInjection materialFieldMigration videoStorageService materialUpdateValidation materialUpdateHealth`
Expected: PASS（全部）

- [ ] **Step 3: 前端类型检查 + lint**

Run: `cd apps/admin-dashboard && npx tsc --noEmit && npm run lint`
Expected: 无报错。

- [ ] **Step 4: 验收对照（手动，§11 PR4）**

- [ ] `/material` 页面无任何 MOCK 数据
- [ ] 选择平台 + 风格 + 数量后点「启动采集」触发真实采集
- [ ] 资产库面板展示真实 `hot_video_candidates` 数据
- [ ] 风格/平台/状态 filter 正常工作
- [ ] 「重跑 LLM」按钮能重新下发单条候选（仅 accepted/rejected 可点）
- [ ] 卡片显示评级、风格、点赞数、storagePath（复制）
- [ ] 空状态/加载状态/错误状态展示正常

- [ ] **Step 5: 推送分支**

```bash
git push -u origin HEAD
```

---

## 自检（Self-Review）

**Spec 覆盖（§8）：**
- `/material` 去 MOCK，左快速采集 + 右资产库 → Task 4 ✓
- `/run` 接受 `{styleDir, count}` → PR1 已完成，Task 4 调用 ✓
- `/candidates` 扩列返回新字段 + style 过滤 + BigInt 序列化 → Task 1 ✓
- `POST /reprocess/:id` → Task 2 ✓
- `MaterialItem`/类型扩展 → Task 3（`MaterialCandidate`）✓
- 移除 MOCK_MATERIALS/MOCK_TASK_STATUS/simulateProgress → Task 4 整体重写 ✓
- 端到端/空状态/加载/错误 → Task 4 Step 2 + Task 5 验收 ✓

**偏差/补充：** BigInt 序列化（约定 1）是设计文档未明说但必须的修复（否则 `/candidates` 对 BigInt 抛错）；重跑优先用归档 `local_path`（约定 3）。

**类型一致性：** `serializeCandidate` 输出字段与 `MaterialCandidate`（Task 3）一一对应；`useMaterialCandidates(page,pageSize,platformId,status,style)`（Task 3）与 `/candidates` schema（Task 1）的 `style` 一致；`reprocessCandidate`（Task 2）导出与 `/reprocess/:id`（Task 2）调用一致；`STATUS_TONE` 的键集合与 `MaterialCandidate.status` 一致。
