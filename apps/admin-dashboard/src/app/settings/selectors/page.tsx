'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import api from '@/lib/api';
import {
  useSelectorConfig,
  useSelectorEffectiveness,
  useUpsertSelector,
  useDeleteSelector,
} from '@/hooks/useApi';
import type { SelectorEntry, SelectorEffectivenessStats } from '@/hooks/useApi';

// ─── 常量 ───

const PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'tencent'] as const;
const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', tencent: '视频号',
};
const CATEGORIES = ['menus', 'buttons', 'regions', 'textboxes'] as const;
const CATEGORY_LABELS: Record<string, string> = {
  menus: '菜单', buttons: '按钮', regions: '区域', textboxes: '文本框',
};
const SELECTOR_TYPE_LABELS: Record<string, string> = {
  css: 'CSS', role: 'Role', text: '文本', placeholder: '占位符', label: 'Label',
};

// ─── 辅助函数 ───

function strategyLabel(strategy: string): string {
  if (strategy === 'primary') return 'Primary';
  if (strategy.startsWith('fallback-')) return strategy.replace('fallback-', '').toUpperCase();
  return strategy;
}

function statusColor(stat: SelectorEffectivenessStats | null): { dot: string; text: string; bg: string } {
  if (!stat || stat.totalAttempts === 0) return { dot: 'bg-slate-400', text: 'text-slate-400', bg: 'bg-slate-50' };
  if (stat.successRate >= 0.9) return { dot: 'bg-emerald-500', text: 'text-emerald-600', bg: 'bg-emerald-50' };
  if (stat.successRate >= 0.5) return { dot: 'bg-amber-500', text: 'text-amber-600', bg: 'bg-amber-50' };
  if (stat.totalAttempts >= 3) return { dot: 'bg-red-500', text: 'text-red-600', bg: 'bg-red-50' };
  return { dot: 'bg-amber-400', text: 'text-amber-600', bg: 'bg-amber-50' };
}

// ─── 组件 ───

export default function SelectorConfigPage() {
  const { data: config, isLoading } = useSelectorConfig();
  const { data: effectivenessData } = useSelectorEffectiveness();
  const effectiveness = effectivenessData?.stats || [];
  const upsertSelector = useUpsertSelector();
  const deleteSelector = useDeleteSelector();

  const [platform, setPlatform] = useState<string>('douyin');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [purposeFilter, setPurposeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{
    platform: string; category: string; name: string; entry: SelectorEntry;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  const showToast = (msg: string, type: 'success' | 'error') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // ── 构建有效性查找映射 ──
  const effMap = useMemo(() => {
    const m = new Map<string, SelectorEffectivenessStats>();
    if (!effectiveness) return m;
    for (const e of effectiveness) {
      m.set(`${e.platform}:${e.category}:${e.name}:${e.strategy}`, e);
    }
    return m;
  }, [effectiveness]);

  // ── 过滤选择器 ──
  const filteredEntries = useMemo(() => {
    if (!config?.platforms) return [];
    const plat = config.platforms[platform];
    if (!plat) return [];
    const result: Array<{
      category: string; name: string; entry: SelectorEntry;
    }> = [];
    const cats = categoryFilter === 'all' ? CATEGORIES : [categoryFilter as typeof CATEGORIES[number]];
    for (const cat of cats) {
      const catData = plat[cat] as Record<string, SelectorEntry> | undefined;
      if (!catData) continue;
      for (const [name, entry] of Object.entries(catData)) {
        if (!entry.enabled && entry.enabled !== undefined) continue;
        if (purposeFilter !== 'all' && !entry.purposes.includes(purposeFilter)) continue;
        if (search) {
          const q = search.toLowerCase();
          const haystack = `${name} ${entry.primary} ${entry.fallbacks.join(' ')} ${entry.description || ''}`.toLowerCase();
          if (!haystack.includes(q)) continue;
        }
        result.push({ category: cat, name, entry });
      }
    }
    return result;
  }, [config, platform, categoryFilter, purposeFilter, search]);

  // ── 统计 ──
  const failedCount = useMemo(() => {
    let c = 0;
    for (const { category, name } of filteredEntries) {
      const primary = effMap.get(`${platform}:${category}:${name}:primary`);
      if (primary && primary.totalAttempts >= 3 && primary.successRate < 0.3) c++;
      for (const fb of ['fallback-css', 'fallback-text', 'fallback-role', 'fallback-placeholder', 'fallback-xpath']) {
        const fbStat = effMap.get(`${platform}:${category}:${name}:${fb}`);
        if (fbStat && fbStat.totalAttempts >= 3 && fbStat.successRate < 0.3) c++;
      }
    }
    return c;
  }, [filteredEntries, effMap, platform]);

  // ── 编辑弹窗 ──
  const handleSaveEdit = async () => {
    if (!editing) return;
    try {
      await upsertSelector.mutateAsync({
        platform: editing.platform,
        category: editing.category,
        name: editing.name,
        entry: editing.entry,
      });
      showToast('选择器已保存', 'success');
      setEditing(null);
    } catch (e: any) {
      showToast(e?.response?.data?.error || '保存失败', 'error');
    }
  };

  const handleDelete = async () => {
    if (!editing || !confirm(`确认删除选择器 "${editing.name}"？`)) return;
    try {
      await deleteSelector.mutateAsync({
        platform: editing.platform,
        category: editing.category,
        name: editing.name,
      });
      showToast('选择器已删除', 'success');
      setEditing(null);
    } catch (e: any) {
      showToast(e?.response?.data?.error || '删除失败', 'error');
    }
  };

  const handleAddNew = async () => {
    if (!editing) return;
    try {
      await upsertSelector.mutateAsync({
        platform: editing.platform,
        category: editing.category,
        name: editing.name,
        entry: editing.entry,
      });
      showToast('选择器已创建', 'success');
      setEditing(null);
      setAdding(false);
    } catch (e: any) {
      showToast(e?.response?.data?.error || '创建失败', 'error');
    }
  };

  // ── 计算策略统计 ──
  const getStrategyStat = (cat: string, selName: string, strategy: string) =>
    effMap.get(`${platform}:${cat}:${selName}:${strategy}`) || null;

  // ── 策略列表 (primary + fallbacks) ──
  const getStrategyList = (entry: SelectorEntry): Array<{ label: string; selector: string; strategy: string }> => {
    const list: Array<{ label: string; selector: string; strategy: string }> = [
      { label: '主', selector: entry.primary, strategy: 'primary' },
    ];
    entry.fallbacks.forEach((fb, i) => {
      list.push({ label: `备${i + 1}`, selector: fb, strategy: `fallback-${entry.selectorType}` });
    });
    return list;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-32">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-[1400px] mx-auto">
      {toast && (
        <div className={cn(
          'fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium animate-in slide-in-from-top-2',
          toast.type === 'success'
            ? 'bg-emerald-600 text-white'
            : 'bg-red-600 text-white',
        )}>
          {toast.msg}
        </div>
      )}

      {/* ── 头部 ── */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center">
            <MaterialIcon icon="terminal" size="sm" className="text-indigo-500" />
          </div>
          <div>
            <h2 className="text-headline-md text-on-surface font-bold">选择器配置</h2>
            <p className="text-body-sm text-on-surface-variant">
              管理各平台 DOM 选择器配置与有效性追踪 · 共 {filteredEntries.length} 个选择器
              {failedCount > 0 && (
                <span className="ml-2 text-red-500 font-medium">{failedCount} 个失效</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* ── 工具栏 ── */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* 平台标签 */}
        <div className="flex bg-surface-container rounded-xl p-1 gap-0.5">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={cn(
                'px-3.5 py-2 rounded-lg text-label-md font-medium transition-all',
                platform === p
                  ? 'bg-primary text-on-primary shadow-sm'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high',
              )}
            >
              {PLATFORM_LABELS[p]}
            </button>
          ))}
        </div>
        <div className="w-px h-8 bg-outline-variant/60" />

        {/* 类别筛选 */}
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="bg-surface border border-outline-variant rounded-lg px-3 py-2 text-label-md text-on-surface outline-none focus:border-primary"
        >
          <option value="all">全部类别</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
          ))}
        </select>

        {/* 用途筛选 */}
        <select
          value={purposeFilter}
          onChange={(e) => setPurposeFilter(e.target.value)}
          className="bg-surface border border-outline-variant rounded-lg px-3 py-2 text-label-md text-on-surface outline-none focus:border-primary"
        >
          <option value="all">全部用途</option>
          <option value="publish">发布</option>
          <option value="monitor">监控</option>
        </select>

        {/* 搜索 */}
        <div className="flex-1 min-w-[200px] relative">
          <MaterialIcon icon="search" size="sm" className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索选择器名称、CSS、文本..."
            className="w-full bg-surface border border-outline-variant rounded-lg pl-9 pr-3 py-2 text-body-sm text-on-surface outline-none focus:border-primary placeholder:text-on-surface-variant/50"
          />
        </div>

        {/* 新建按钮 */}
        <button
          onClick={() => {
            setAdding(true);
            setEditing({
              platform, category: 'buttons', name: '',
              entry: {
                purposes: ['monitor'], primary: '', fallbacks: [],
                selectorType: 'css', enabled: true,
              },
            });
          }}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-primary text-on-primary text-label-md font-medium hover:shadow-md transition-all flex-shrink-0"
        >
          <MaterialIcon icon="add" size="sm" />新建
        </button>
      </div>

      {/* ── 选择器列表 ── */}
      <div className="space-y-3">
        {filteredEntries.length === 0 && (
          <div className="text-center py-16 text-on-surface-variant">
            <MaterialIcon icon="search" size="2xl" className="text-outline mb-3 opacity-40" />
            <p className="text-title-md">未找到选择器</p>
            <p className="text-body-sm mt-1">尝试更换筛选条件或平台</p>
          </div>
        )}

        {filteredEntries.map(({ category, name, entry }) => {
          const strategies = getStrategyList(entry);
          const allPassing = strategies.every((s) => {
            const stat = getStrategyStat(category, name, s.strategy);
            return !stat || stat.successRate >= 0.9 || stat.totalAttempts < 3;
          });

          return (
            <div
              key={`${category}:${name}`}
              className={cn(
                'bg-surface border rounded-2xl overflow-hidden transition-all hover:shadow-sm',
                allPassing ? 'border-outline-variant' : 'border-red-200',
              )}
            >
              {/* 主行 */}
              <div className="flex items-center gap-3 px-5 py-3.5">
                {/* 类别标签 */}
                <span className={cn(
                  'text-[10px] font-bold px-2 py-0.5 rounded-md flex-shrink-0',
                  category === 'menus' ? 'bg-blue-100 text-blue-700' :
                  category === 'buttons' ? 'bg-purple-100 text-purple-700' :
                  category === 'regions' ? 'bg-teal-100 text-teal-700' :
                  'bg-orange-100 text-orange-700',
                )}>
                  {CATEGORY_LABELS[category]}
                </span>

                {/* 名称 + 描述 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-label-md font-bold text-on-surface font-mono">{name}</span>
                    {entry.purposes.map((p) => (
                      <span key={p} className={cn(
                        'text-[9px] px-1.5 py-px rounded-full font-medium',
                        p === 'publish' ? 'bg-sky-100 text-sky-600' : 'bg-violet-100 text-violet-600',
                      )}>
                        {p === 'publish' ? '发布' : '监控'}
                      </span>
                    ))}
                    {!allPassing && (
                      <span className="text-[9px] px-1.5 py-px rounded-full bg-red-100 text-red-600 font-medium">
                        有失效
                      </span>
                    )}
                  </div>
                  {entry.description && (
                    <p className="text-body-xs text-on-surface-variant mt-0.5 truncate">{entry.description}</p>
                  )}
                </div>

                {/* 策略链 (紧凑视口) */}
                <div className="hidden lg:flex items-center gap-1.5 flex-1 min-w-0">
                  {strategies.map((s, i) => {
                    const stat = getStrategyStat(category, name, s.strategy);
                    const sc = statusColor(stat);
                    return (
                      <div key={i} className="flex items-center gap-1">
                        {i > 0 && <MaterialIcon icon="chevron_right" size="xs" className="text-outline/50" />}
                        <div
                          className={cn('flex items-center gap-1 px-2 py-1 rounded-lg', sc.bg)}
                          title={`${s.label}: ${s.selector}\n${stat ? `成功率 ${(stat.successRate * 100).toFixed(0)}% · ${stat.totalAttempts} 次` : '无数据'}`}
                        >
                          <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', sc.dot)} />
                          <span className={cn('text-[10px] font-bold', sc.text)}>{s.label}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* 编辑按钮 */}
                <button
                  onClick={() => setEditing({ platform, category, name, entry: { ...entry } })}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-label-sm text-on-surface-variant hover:bg-surface-container-high transition-colors flex-shrink-0"
                >
                  <MaterialIcon icon="edit" size="xs" />编辑
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 编辑/新建弹窗 ── */}
      {editing && (
        <div className="fixed inset-0 z-40 flex items-start justify-center pt-[10vh]">
          <div className="absolute inset-0 bg-black/40" onClick={() => { setEditing(null); setAdding(false); }} />
          <div className="relative bg-surface rounded-2xl shadow-2xl w-[720px] max-h-[80vh] overflow-y-auto border border-outline-variant">
            {/* 弹窗头 */}
            <div className="sticky top-0 bg-surface border-b border-outline-variant px-6 py-4 flex items-center justify-between z-10">
              <div>
                <h3 className="text-title-md font-bold text-on-surface">
                  {adding ? '新建选择器' : `编辑: ${editing.name}`}
                </h3>
                <p className="text-body-xs text-on-surface-variant mt-0.5">
                  {PLATFORM_LABELS[editing.platform]} · {CATEGORY_LABELS[editing.category]}
                </p>
              </div>
              <button
                onClick={() => { setEditing(null); setAdding(false); }}
                className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-surface-container transition-colors"
              >
                <MaterialIcon icon="close" size="sm" />
              </button>
            </div>

            {/* 弹窗内容 */}
            <div className="p-6 space-y-5">
              {/* 基本信息 */}
              <div className="grid grid-cols-3 gap-3">
                {adding && (
                  <div>
                    <label className="text-label-sm text-on-surface font-medium mb-1 block">名称 (key)</label>
                    <input
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      placeholder="btn_publish_submit"
                      className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm font-mono outline-none focus:border-primary"
                    />
                  </div>
                )}
                <div>
                  <label className="text-label-sm text-on-surface font-medium mb-1 block">类别</label>
                  <select
                    value={editing.category}
                    onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                    className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm outline-none focus:border-primary"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-label-sm text-on-surface font-medium mb-1 block">选择器类型</label>
                  <select
                    value={editing.entry.selectorType}
                    onChange={(e) => setEditing({
                      ...editing,
                      entry: { ...editing.entry, selectorType: e.target.value },
                    })}
                    className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm outline-none focus:border-primary"
                  >
                    {Object.entries(SELECTOR_TYPE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 用途 */}
              <div>
                <label className="text-label-sm text-on-surface font-medium mb-1 block">用途</label>
                <div className="flex gap-2">
                  {['publish', 'monitor'].map((p) => (
                    <label key={p} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editing.entry.purposes.includes(p)}
                        onChange={(e) => {
                          const purposes = e.target.checked
                            ? [...editing.entry.purposes, p]
                            : editing.entry.purposes.filter((x) => x !== p);
                          setEditing({ ...editing, entry: { ...editing.entry, purposes } });
                        }}
                        className="rounded"
                      />
                      <span className="text-body-sm">{p === 'publish' ? '发布' : '监控'}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* 主选择器 */}
              <div>
                <label className="text-label-sm text-on-surface font-medium mb-1 block">
                  主选择器 (Primary)
                  <span className={cn(
                    'ml-2 text-[10px] px-1.5 py-px rounded-full',
                    (() => {
                      const s = getStrategyStat(editing.category, editing.name, 'primary');
                      if (!s || s.totalAttempts === 0) return 'bg-slate-100 text-slate-500';
                      return s.successRate >= 0.9 ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600';
                    })(),
                  )}>
                    {(() => {
                      const s = getStrategyStat(editing.category, editing.name, 'primary');
                      if (!s || s.totalAttempts === 0) return '未测试';
                      return `${(s.successRate * 100).toFixed(0)}% · ${s.totalAttempts}次`;
                    })()}
                  </span>
                </label>
                <textarea
                  value={editing.entry.primary}
                  onChange={(e) => setEditing({
                    ...editing,
                    entry: { ...editing.entry, primary: e.target.value },
                  })}
                  rows={2}
                  className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm font-mono outline-none focus:border-primary resize-none"
                />
              </div>

              {/* 回退选择器 */}
              <div>
                <label className="text-label-sm text-on-surface font-medium mb-2 block">
                  回退选择器 (Fallbacks) — 按优先级排序
                </label>
                <div className="space-y-2">
                  {editing.entry.fallbacks.map((fb, i) => {
                    const fbStrategy = `fallback-${editing.entry.selectorType}`;
                    const s = getStrategyStat(editing.category, editing.name, fbStrategy);
                    return (
                      <div key={i} className="flex items-start gap-2">
                        <span className={cn(
                          'text-[10px] font-bold px-1.5 py-0.5 rounded mt-1.5 flex-shrink-0',
                          s && s.totalAttempts >= 3
                            ? s.successRate >= 0.9 ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'
                            : 'bg-slate-100 text-slate-500',
                        )}>
                          备{i + 1}
                        </span>
                        <textarea
                          value={fb}
                          onChange={(e) => {
                            const fallbacks = [...editing.entry.fallbacks];
                            fallbacks[i] = e.target.value;
                            setEditing({ ...editing, entry: { ...editing.entry, fallbacks } });
                          }}
                          rows={1}
                          className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-sm font-mono outline-none focus:border-primary resize-none"
                        />
                        <button
                          onClick={() => {
                            const fallbacks = editing.entry.fallbacks.filter((_, j) => j !== i);
                            setEditing({ ...editing, entry: { ...editing.entry, fallbacks } });
                          }}
                          className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors mt-0.5"
                        >
                          <MaterialIcon icon="delete" size="xs" />
                        </button>
                      </div>
                    );
                  })}
                  <button
                    onClick={() => {
                      setEditing({
                        ...editing,
                        entry: {
                          ...editing.entry,
                          fallbacks: [...editing.entry.fallbacks, ''],
                        },
                      });
                    }}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-label-sm text-primary hover:bg-primary/5 transition-colors"
                  >
                    <MaterialIcon icon="add" size="xs" />添加回退选择器
                  </button>
                </div>
              </div>

              {/* 描述 + 启用 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-label-sm text-on-surface font-medium mb-1 block">描述</label>
                  <input
                    value={editing.entry.description || ''}
                    onChange={(e) => setEditing({
                      ...editing,
                      entry: { ...editing.entry, description: e.target.value },
                    })}
                    placeholder="选择器用途说明"
                    className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-sm outline-none focus:border-primary"
                  />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editing.entry.enabled !== false}
                      onChange={(e) => setEditing({
                        ...editing,
                        entry: { ...editing.entry, enabled: e.target.checked },
                      })}
                      className="rounded"
                    />
                    <span className="text-body-sm text-on-surface">启用</span>
                  </label>
                </div>
              </div>

              {/* 高级选项 */}
              <details className="group">
                <summary className="text-label-sm text-on-surface-variant cursor-pointer hover:text-on-surface transition-colors">
                  高级选项 (scopeKey, filterTag, filterText)
                </summary>
                <div className="grid grid-cols-3 gap-3 mt-3">
                  <div>
                    <label className="text-label-xs text-on-surface-variant mb-1 block">过滤标签 (filterTag)</label>
                    <input
                      value={editing.entry.filterTag || ''}
                      onChange={(e) => setEditing({
                        ...editing,
                        entry: { ...editing.entry, filterTag: e.target.value || undefined },
                      })}
                      placeholder="BUTTON"
                      className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1.5 text-body-xs font-mono outline-none focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="text-label-xs text-on-surface-variant mb-1 block">过滤文本 (filterText)</label>
                    <input
                      value={editing.entry.filterText || ''}
                      onChange={(e) => setEditing({
                        ...editing,
                        entry: { ...editing.entry, filterText: e.target.value || undefined },
                      })}
                      placeholder="发表"
                      className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1.5 text-body-xs font-mono outline-none focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="text-label-xs text-on-surface-variant mb-1 block">作用域键 (scopeKey)</label>
                    <input
                      value={editing.entry.scopeKey || ''}
                      onChange={(e) => setEditing({
                        ...editing,
                        entry: { ...editing.entry, scopeKey: e.target.value || undefined },
                      })}
                      placeholder="region_publish_area"
                      className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1.5 text-body-xs font-mono outline-none focus:border-primary"
                    />
                  </div>
                </div>
              </details>
            </div>

            {/* 弹窗底部按钮 */}
            <div className="sticky bottom-0 bg-surface border-t border-outline-variant px-6 py-4 flex items-center justify-between">
              <div>
                {!adding && (
                  <button
                    onClick={handleDelete}
                    className="flex items-center gap-1 px-3 py-2 rounded-lg text-label-sm text-red-500 hover:bg-red-50 transition-colors"
                  >
                    <MaterialIcon icon="delete" size="xs" />删除此选择器
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setEditing(null); setAdding(false); }}
                  className="px-4 py-2 rounded-lg text-label-md text-on-surface-variant hover:bg-surface-container-high transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={adding ? handleAddNew : handleSaveEdit}
                  disabled={upsertSelector.isPending}
                  className="px-5 py-2 rounded-lg bg-primary text-on-primary text-label-md font-medium hover:shadow-md transition-all disabled:opacity-50"
                >
                  {upsertSelector.isPending ? '保存中…' : (adding ? '创建' : '保存')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
