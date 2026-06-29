'use client';

import { useState, useRef, useEffect } from 'react';
import { HeaderStrip } from '@/components/ui/Bento';
import { AccentBar } from '@/components/ui/Bento';
import { StatusPill } from '@/components/ui/StatusPill';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { PanelSkeleton } from '../shared/PanelSkeleton';
import { QueryError } from '../shared/QueryError';
import { PlatformCard } from '../components/PlatformCard';
import { CronListEditor } from '../components/CronListEditor';
import { StyleListEditor, type StyleDef } from '../components/StyleListEditor';
import {
  useMaterialConfig,
  useUpdateMaterialConfig,
  useTestPlatform,
  useTriggerMaterialRun,
  useMaterialStatus,
  useMaterialCandidates,
  useMaterialDiskUsage,
} from '@/hooks/useApi';
import type { MaterialUpdateConfig, Platform } from '@/types/material';

const DEFAULT_PLATFORM: Platform = {
  id: '',
  name: '',
  enabled: true,
  request: { method: 'GET', url: '', headers: {}, params: {}, body: null, maxPages: 1, timeoutMs: 30000 },
  keyPool: { placeholder: 'API_KEY', keys: [], cooldownMs: 300000 },
  parse: {
    listPath: '',
    fieldMap: {
      videoId: '', title: '', likeCount: '', commentCount: '',
      videoUrl: '', cover: '', author: '', publishTime: '',
    },
  },
};

export default function MaterialTab() {
  const configQuery = useMaterialConfig();
  const updateConfig = useUpdateMaterialConfig();
  const testPlatform = useTestPlatform();
  const triggerRun = useTriggerMaterialRun();
  const statusQuery = useMaterialStatus();
  const candidatesQuery = useMaterialCandidates(1, 12);

  const [form, setForm] = useState<MaterialUpdateConfig | null>(null);
  const initRef = useRef(false);
  const [savedPill, setSavedPill] = useState(false);
  const [testingPlatformId, setTestingPlatformId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { videoCount: number; videos: any[] }>>({});

  useEffect(() => {
    if (configQuery.data && !initRef.current) {
      setForm(configQuery.data);
      initRef.current = true;
    }
  }, [configQuery.data]);

  const handleSave = () => {
    if (!form) return;
    updateConfig.mutate(form, {
      onSuccess: () => { setSavedPill(true); setTimeout(() => setSavedPill(false), 3000); },
    });
  };

  const addPlatform = () => {
    if (!form) return;
    const newPlatform: Platform = { ...DEFAULT_PLATFORM, id: `platform_${Date.now()}`, name: '新平台' };
    setForm({ ...form, platforms: [...form.platforms, newPlatform] });
  };

  const updatePlatform = (idx: number, p: Platform) => {
    if (!form) return;
    const platforms = [...form.platforms];
    platforms[idx] = p;
    setForm({ ...form, platforms });
  };

  const removePlatform = (idx: number) => {
    if (!form) return;
    const removedId = form.platforms[idx]?.id;
    const nextPlatforms = form.platforms.filter((_, i) => i !== idx);
    const nextStyles = removedId
      ? form.processing.styles.map((s) => {
          if (!s.platformOverrides?.[removedId]) return s;
          const { [removedId]: _, ...rest } = s.platformOverrides;
          return { ...s, platformOverrides: rest };
        })
      : form.processing.styles;
    setForm({
      ...form,
      platforms: nextPlatforms,
      processing: { ...form.processing, styles: nextStyles },
    });
  };

  const scrollToPlatform = (platformId: string) => {
    const el = document.querySelector(`[data-platform-id="${platformId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleTest = (platform: Platform) => {
    setTestingPlatformId(platform.id);
    testPlatform.mutate(platform, {
      onSuccess: (data) => { setTestResults({ ...testResults, [platform.id]: data }); setTestingPlatformId(null); },
      onError: () => setTestingPlatformId(null),
    });
  };

  if (configQuery.isLoading) return <PanelSkeleton rows={8} />;
  if (configQuery.isError) return <QueryError />;
  if (!form) return null;

  const diskUsageQuery = useMaterialDiskUsage();

  const getKeyChips = (platformId: string) => {
    const platformStatus = statusQuery.data?.platforms?.find((p: any) => p.platformId === platformId);
    return platformStatus?.keys?.map((k: any) => ({ key: '', masked: k.masked, cooledDown: k.cooledDown, cooldownRemaining: k.cooldownRemaining }));
  };

  return (
    <div className="space-y-6 p-6">
      {/* 顶部 Header */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="primary" />
        <HeaderStrip>
          <div className="flex items-center justify-between w-full">
            <div>
              <h2 className="text-headline-sm font-bold">素材更新 · 每周热门采集</h2>
              <p className="text-sm text-on-surface-variant mt-1">配置 RapidAPI 平台 → 定时采集热门视频 → LLM 评估 → 按风格落盘素材库</p>
            </div>
            <div className="flex items-center gap-2">
              {savedPill && <StatusPill tone="success" icon="check_circle">已保存 · 下次抓取生效</StatusPill>}
              {statusQuery.data?.running && <StatusPill tone="info" icon="sync" dot>采集中...</StatusPill>}
            </div>
          </div>
        </HeaderStrip>
      </section>

      {/* 面板 1: 平台采集源 */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="tertiary" />
        <HeaderStrip>
          <h3 className="text-lg font-semibold">平台采集源</h3>
          <button onClick={addPlatform} className="btn-primary text-sm"><MaterialIcon icon="add" size="sm" />新增平台</button>
        </HeaderStrip>
        <div className="p-4 space-y-3">
          {form.platforms.length === 0 && <p className="text-sm text-on-surface-variant italic text-center py-4">尚未配置采集平台，点击「新增平台」开始</p>}
          {form.platforms.map((p, i) => (
            <PlatformCard key={p.id} platform={p} onChange={(np) => updatePlatform(i, np)} onRemove={() => removePlatform(i)} onTest={() => handleTest(p)} testing={testingPlatformId === p.id} testResult={testResults[p.id] || null} keyChips={getKeyChips(p.id)} />
          ))}
        </div>
      </section>

      {/* 面板 2: 调度设置 */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="success" />
        <HeaderStrip>
          <h3 className="text-lg font-semibold">调度设置</h3>
          <button type="button" onClick={() => setForm({ ...form, schedule: { ...form.schedule, enabled: !form.schedule.enabled } })} className={`toggle-track ${form.schedule.enabled ? 'bg-primary' : 'bg-surface-container-high'}`}>
            <span className={`toggle-thumb ${form.schedule.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </HeaderStrip>
        <div className="p-4">
          <CronListEditor crons={form.schedule.cron} onChange={(crons) => setForm({ ...form, schedule: { ...form.schedule, cron: crons } })} />
        </div>
      </section>

      {/* 面板 3: 视频存储设置 (PR2 新增) */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="primary" />
        <HeaderStrip>
          <h3 className="text-lg font-semibold">视频存储设置</h3>
          <button type="button" onClick={() => setForm({ ...form, storage: { ...form.storage, enabled: !form.storage.enabled } })} className={`toggle-track ${form.storage.enabled ? 'bg-primary' : 'bg-surface-container-high'}`}>
            <span className={`toggle-thumb ${form.storage.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </HeaderStrip>
        <div className="p-4 space-y-4">
          <div>
            <label className="text-xs text-on-surface-variant mb-1 block">存储根路径</label>
            <input type="text" className="form-input text-sm w-full font-mono" value={form.storage.rootPath} onChange={(e) => setForm({ ...form, storage: { ...form.storage, rootPath: e.target.value } })} placeholder="/data/videos" disabled={!form.storage.enabled} />
            <p className="text-xs text-on-surface-variant mt-1">视频文件存储根目录，需与 Python Worker 共享磁盘卷</p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-on-surface-variant">磁盘使用量：</span>
            {diskUsageQuery.isLoading ? <span className="text-on-surface-variant text-xs">计算中...</span> : diskUsageQuery.data?.data?.enabled ? (
              <span className="font-mono text-sm">{diskUsageQuery.data.data.usedHuman}</span>
            ) : (
              <span className="text-on-surface-variant text-xs">存储未启用</span>
            )}
          </div>
        </div>
      </section>

      {/* 面板 4: 处理与评估 */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="tertiary" />
        <HeaderStrip><h3 className="text-lg font-semibold">处理与评估</h3></HeaderStrip>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-on-surface-variant mb-1 block">抽帧间隔 (ms)</label>
              <input type="number" className="form-input text-sm" value={form.processing.frameIntervalMs} onChange={(e) => setForm({ ...form, processing: { ...form.processing, frameIntervalMs: parseInt(e.target.value) || 1000 } })} step={500} min={100} />
            </div>
            <div>
              <label className="text-xs text-on-surface-variant mb-1 block">达标评级阈值 (1-5)</label>
              <input type="number" className="form-input text-sm" value={form.processing.minRating} onChange={(e) => setForm({ ...form, processing: { ...form.processing, minRating: parseInt(e.target.value) || 4 } })} min={1} max={5} />
            </div>
          </div>
          <div>
            <label className="text-xs text-on-surface-variant mb-1 block">评估提示词</label>
            <textarea className="form-input text-sm font-mono w-full min-h-32" value={form.processing.evaluatePrompt} onChange={(e) => setForm({ ...form, processing: { ...form.processing, evaluatePrompt: e.target.value } })} rows={6} />
          </div>
          <div>
            <label className="text-sm font-semibold mb-2 block">风格列表</label>
            <StyleListEditor
              styles={form.processing.styles}
              platforms={form.platforms}
              onChange={(styles: StyleDef[]) => setForm({ ...form, processing: { ...form.processing, styles } })}
            />
          </div>
        </div>
      </section>

      {/* 面板 4: 运行状态 */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="error" />
        <HeaderStrip>
          <h3 className="text-lg font-semibold">运行状态</h3>
          <div className="flex items-center gap-2">
            {(() => {
              const health = statusQuery.data?.runHealth;
              if (health === 'no_keys') return <StatusPill tone="error" dot>存在未配置 Key 的平台</StatusPill>;
              if (health === 'all_keys_cooldown') return <StatusPill tone="warning" dot>所有 Key 均冷却中</StatusPill>;
              if (health === 'parse_mismatch') return <StatusPill tone="warning" dot>存在解析异常的平台</StatusPill>;
              if (health === 'ok') return <StatusPill tone="success" dot>运行正常</StatusPill>;
              return null;
            })()}
            <button onClick={() => triggerRun.mutate(undefined)} disabled={statusQuery.data?.running} className="btn-primary text-sm">
              <MaterialIcon icon="play_arrow" size="sm" />
              立即执行
            </button>
          </div>
        </HeaderStrip>
        <div className="p-4">
          {statusQuery.isLoading ? <PanelSkeleton rows={3} /> : statusQuery.data ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {Object.entries(statusQuery.data.candidateCounts || {}).map(([status, count]) => (
                  <StatusPill key={status} tone={
                    status === 'accepted' ? 'success' : status === 'rejected' ? 'error' : status === 'processing' ? 'info' : 'neutral'
                  }>
                    {status}: {count as number}
                  </StatusPill>
                ))}
              </div>
              {statusQuery.data.platforms?.map((p: any) => {
                const warning = statusQuery.data?.warnings?.find((w: any) => w.platformId === p.platformId);
                const healthTone = !warning ? 'success' : warning.kind === 'no_keys' ? 'error' : 'warning';
                const healthLabel = !warning ? '正常' : warning.kind === 'no_keys' ? '未配置 Key' : warning.kind === 'all_keys_cooldown' ? 'Key 冷却中' : '解析异常';
                return (
                  <div key={p.platformId} data-platform-id={p.platformId} className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{p.platformName}</span>
                    <span className="text-on-surface-variant">{p.keys.filter((k: any) => !k.cooledDown).length}/{p.keys.length} key 可用</span>
                    {p.keys.some((k: any) => k.cooledDown) && <span className="text-xs text-error">{p.keys.filter((k: any) => k.cooledDown).length} 个冷却中</span>}
                    <span className="ml-auto flex items-center gap-2">
                      <StatusPill tone={healthTone as any}>{healthLabel}</StatusPill>
                      {warning && (
                        <button
                          type="button"
                          onClick={() => scrollToPlatform(p.platformId)}
                          className="text-xs text-primary hover:underline whitespace-nowrap"
                        >
                          前往设置
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : <QueryError />}
        </div>
      </section>

      {/* 面板 5: 候选视频预览 */}
      <section className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
        <AccentBar color="primary" />
        <HeaderStrip>
          <h3 className="text-lg font-semibold">候选视频预览</h3>
          <span className="text-sm text-on-surface-variant">共 {candidatesQuery.data?.total || 0} 条</span>
        </HeaderStrip>
        <div className="p-4">
          {candidatesQuery.isLoading ? <PanelSkeleton rows={4} /> : candidatesQuery.data?.items?.length ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {candidatesQuery.data.items.map((c: any) => (
                <div key={c.id} className="rounded-lg border border-outline-variant overflow-hidden bg-surface-container-lowest">
                  {c.cover && <img src={c.cover} alt={c.title || ''} className="w-full aspect-video object-cover" />}
                  <div className="p-2">
                    <p className="text-sm font-medium truncate">{c.title || '(无标题)'}</p>
                    <p className="text-xs text-on-surface-variant">{c.author || '未知'}</p>
                    <div className="flex items-center gap-1 mt-1">
                      <StatusPill tone={c.status === 'accepted' ? 'success' : c.status === 'rejected' ? 'error' : c.status === 'processing' ? 'info' : 'neutral'}>
                        {c.status}
                      </StatusPill>
                      {c.style && <span className="text-xs text-on-surface-variant">{c.style}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-on-surface-variant italic text-center py-4">暂无候选视频</p>}
        </div>
      </section>

      {/* 底部保存 */}
      <div className="sticky bottom-0 bg-surface-container-lowest/90 backdrop-blur border-t border-outline-variant p-4 -mx-6 -mb-6">
        <button onClick={handleSave} className="btn-primary w-full" disabled={updateConfig.isPending}>
          <MaterialIcon icon="save" size="sm" />
          {updateConfig.isPending ? '保存中...' : '保存配置'}
        </button>
      </div>
    </div>
  );
}
