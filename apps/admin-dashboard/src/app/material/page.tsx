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
  useReprocessCandidate,
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
  const reprocess = useReprocessCandidate();

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
            <label className="text-xs text-on-surface-variant mb-1 block">采集数量（<code className="font-mono">{'{{COUNT}}'}</code>）: {count}</label>
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
                          <MaterialIcon icon="link" size="sm" />
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
