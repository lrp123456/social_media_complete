'use client';

import { useState, useMemo, useRef, type KeyboardEvent } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { BentoCard } from '@/components/ui/Bento';
import { StatusPill } from '@/components/ui/StatusPill';
import { cn } from '@/lib/utils';

// =========================================================================
// Types
// =========================================================================

type Platform = 'pinterest' | 'douyin' | 'xiaohongshu' | 'bilibili';

interface PlatformOption {
  key: Platform;
  label: string;
  icon: 'music_note' | 'play_arrow' | 'book' | 'movie_creation';
}

interface MaterialItem {
  id: string;
  thumbnail: string;
  title: string;
  style: string;
  room: string;
  quality: 'S' | 'A' | 'B' | 'C';
  source: Platform;
  sourceLabel: string;
  date: string;
  likes: number;
  saves: number;
}

interface TaskStatusData {
  taskId: string;
  status: 'running' | 'completed' | 'failed';
  progress: number;
  elapsedSeconds: number;
  itemsScraped: number;
  totalItems: number;
}

// =========================================================================
// Constants
// =========================================================================

const PLATFORM_OPTIONS: PlatformOption[] = [
  { key: 'pinterest', label: 'Pinterest', icon: 'music_note' },
  { key: 'douyin', label: '抖音', icon: 'play_arrow' },
  { key: 'xiaohongshu', label: '小红书', icon: 'book' },
  { key: 'bilibili', label: 'Bilibili', icon: 'movie_creation' },
];

const STYLE_OPTIONS = ['奶油风', '侘寂风', '现代简约', '国潮混搭'];
const ROOM_OPTIONS = ['客厅', '卧室', '厨房', '卫浴'];
const QUALITY_OPTIONS: ('S' | 'A' | 'B' | 'C')[] = ['S', 'A', 'B', 'C'];

const QUALITY_COLORS: Record<'S' | 'A' | 'B' | 'C', string> = {
  S: 'bg-amber-400 text-amber-900',
  A: 'bg-emerald-400 text-emerald-900',
  B: 'bg-blue-400 text-blue-900',
  C: 'bg-surface-container text-on-surface-variant',
};

const SOURCE_LABELS: Record<Platform, string> = {
  pinterest: 'Pinterest',
  douyin: '抖音',
  xiaohongshu: '小红书',
  bilibili: 'Bilibili',
};

// =========================================================================
// Mock data
// =========================================================================

const MOCK_MATERIALS: MaterialItem[] = Array.from({ length: 16 }, (_, i) => {
  const platforms: Platform[] = ['pinterest', 'douyin', 'xiaohongshu', 'bilibili'];
  const styles = STYLE_OPTIONS;
  const rooms = ROOM_OPTIONS;
  const qualities: ('S' | 'A' | 'B' | 'C')[] = ['S', 'A', 'B', 'C'];
  const source = platforms[i % platforms.length];
  return {
    id: `mat-${i + 1}`,
    thumbnail: '',
    title: `家居设计参考素材 #${i + 1}`,
    style: styles[i % styles.length],
    room: rooms[i % rooms.length],
    quality: qualities[i % qualities.length],
    source,
    sourceLabel: SOURCE_LABELS[source],
    date: `2025-0${(i % 9) + 1}-${String((i % 28) + 1).padStart(2, '0')}`,
    likes: Math.floor(Math.random() * 5000),
    saves: Math.floor(Math.random() * 1200),
  };
});

const MOCK_TASK_STATUS: TaskStatusData = {
  taskId: 'TASK-PIN-20250603-001',
  status: 'running',
  progress: 62,
  elapsedSeconds: 345,
  itemsScraped: 124,
  totalItems: 200,
};

// =========================================================================
// Helpers
// =========================================================================

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}秒`;
  return `${m}分${s > 0 ? ` ${s}秒` : ''}`;
}

function formatNumber(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return n.toLocaleString('zh-CN');
}

// =========================================================================
// Page
// =========================================================================

export default function MaterialPage() {
  // ── Collection config state ──────────────────────────────────────
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>('pinterest');
  const [keyword, setKeyword] = useState('');
  const [maxPins, setMaxPins] = useState(50);
  const [likeThreshold, setLikeThreshold] = useState(100);
  const [saveThreshold, setSaveThreshold] = useState(20);
  const [categoryTag, setCategoryTag] = useState('all');

  // ── Gallery filter state ─────────────────────────────────────────
  const [filterStyle, setFilterStyle] = useState<string | null>(null);
  const [filterRoom, setFilterRoom] = useState<string | null>(null);
  const [filterQuality, setFilterQuality] = useState<'S' | 'A' | 'B' | 'C' | null>(null);

  // ── Task polling state ───────────────────────────────────────────
  const [taskId] = useState(MOCK_TASK_STATUS.taskId);
  const [taskStatus, setTaskStatus] = useState<TaskStatusData>(MOCK_TASK_STATUS);

  // ── Mock mutation ────────────────────────────────────────────────
  const [collecting, setCollecting] = useState(false);

  const handleTriggerCollection = () => {
    if (!keyword.trim()) return;
    setCollecting(true);
    setTaskStatus((prev) => ({ ...prev, status: 'running', progress: 0, itemsScraped: 0 }));
    // Simulate progress
    const interval = setInterval(() => {
      setTaskStatus((prev) => {
        const nextProgress = Math.min(prev.progress + Math.floor(Math.random() * 6) + 2, 100);
        const nextItems = Math.min(prev.itemsScraped + Math.floor(Math.random() * 8) + 3, prev.totalItems);
        if (nextProgress >= 100) {
          clearInterval(interval);
          setCollecting(false);
          return { ...prev, status: 'completed', progress: 100, itemsScraped: nextItems, elapsedSeconds: prev.elapsedSeconds + 5 };
        }
        return { ...prev, progress: nextProgress, itemsScraped: nextItems, elapsedSeconds: prev.elapsedSeconds + 5 };
      });
    }, 3000);
  };

  // ── Derived ──────────────────────────────────────────────────────
  const filteredMaterials = useMemo(() => {
    return MOCK_MATERIALS.filter((m) => {
      if (filterStyle && m.style !== filterStyle) return false;
      if (filterRoom && m.room !== filterRoom) return false;
      if (filterQuality && m.quality !== filterQuality) return false;
      return true;
    });
  }, [filterStyle, filterRoom, filterQuality]);

  const categoryTags = [
    { value: 'all', label: '全部分类' },
    { value: 'sofa', label: '沙发' },
    { value: 'table', label: '桌几' },
    { value: 'lighting', label: '灯具' },
    { value: 'storage', label: '收纳' },
    { value: 'decor', label: '装饰' },
  ];

  return (
    <div>
      {/* ================================================================= */}
      {/* Page Header                                                       */}
      {/* ================================================================= */}
      <div className="mb-section-margin flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-headline-lg text-headline-lg text-on-surface">素材更新中心</h1>
          <p className="font-body text-body-md text-on-surface-variant mt-2 max-w-2xl">
            跨平台采集家居设计素材，智能归档与品质标注，支撑视频合成管线。
          </p>
        </div>
        <button
          onClick={handleTriggerCollection}
          disabled={collecting || !keyword.trim()}
          className="flex items-center gap-2 bg-primary-container text-on-primary px-5 py-2.5 rounded-lg text-label-md hover:bg-surface-tint transition-colors shadow-sm shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <MaterialIcon
            icon={collecting ? 'sync' : 'cloud_download'}
            size="md"
            fill
            className={collecting ? 'animate-spin-slow' : ''}
          />
          {collecting ? '采集中…' : '开始采集'}
        </button>
      </div>

      {/* ================================================================= */}
      {/* Bento Grid Layout                                                 */}
      {/* ================================================================= */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-bento mb-section-margin">

        {/* ============================================================= */}
        {/* Left: Collection Configuration Panel (4 cols)                 */}
        {/* ============================================================= */}
        <div className="xl:col-span-4 space-y-bento">
          <BentoCard>
            {/* Header */}
            <div className="flex items-center gap-2 mb-5 border-b border-outline-variant pb-4">
              <MaterialIcon icon="tune" size="md" className="text-primary" fill />
              <h2 className="text-headline-md text-headline-md text-on-surface">采集配置</h2>
            </div>

            {/* Platform Selection */}
            <div className="mb-5">
              <label className="block text-label-md text-label-md text-on-surface-variant mb-3">
                选择平台
              </label>
              <div className="grid grid-cols-2 gap-2">
                {PLATFORM_OPTIONS.map((p) => (
                  <label key={p.key} className="cursor-pointer">
                    <input
                      type="radio"
                      name="platform"
                      className="peer sr-only"
                      checked={selectedPlatform === p.key}
                      onChange={() => setSelectedPlatform(p.key)}
                    />
                    <div
                      className={cn(
                        'flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-all',
                        'border-outline-variant bg-surface text-on-surface-variant',
                        'peer-checked:bg-primary-container peer-checked:text-on-primary peer-checked:border-primary-container',
                        'hover:border-primary',
                      )}
                    >
                      <MaterialIcon icon={p.icon} size="md" />
                      <span className="font-body text-body-sm">{p.label}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Keyword Input */}
            <div className="mb-5">
              <label className="block text-label-md text-label-md text-on-surface-variant mb-2">
                关键词
              </label>
              <div className="flex items-center border border-outline-variant rounded-lg bg-surface-container-low px-3 py-2 focus-within:border-primary focus-within:ring-2 ring-primary/20 transition-all">
                <MaterialIcon icon="search" size="md" className="text-outline mr-2 shrink-0" />
                <input
                  className="bg-transparent border-none focus:ring-0 text-body font-body w-full outline-none text-on-surface placeholder:text-outline"
                  type="text"
                  placeholder="输入搜索关键词，如「奶油风客厅」"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') handleTriggerCollection();
                  }}
                />
              </div>
            </div>

            {/* Max Count Slider */}
            <div className="mb-5">
              <div className="flex justify-between items-center mb-2">
                <label className="text-label-md text-label-md text-on-surface-variant">
                  最大采集数量
                </label>
                <span className="text-label-md text-label-md text-primary font-semibold">{maxPins}</span>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                value={maxPins}
                onChange={(e) => setMaxPins(Number(e.target.value))}
                className="w-full h-1 bg-surface-container-highest rounded-lg appearance-none cursor-pointer accent-primary"
              />
              <div className="flex justify-between text-[10px] text-outline mt-1 px-1">
                <span>1</span>
                <span>50</span>
                <span>100</span>
              </div>
            </div>

            {/* Filter Config */}
            <div className="mb-5 space-y-4">
              <label className="block text-label-md text-label-md text-on-surface-variant">
                过滤条件
              </label>

              {/* Like Threshold */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="font-body text-body-sm text-on-surface-variant">点赞数 ≥</span>
                  <span className="font-mono text-xs text-on-surface">{likeThreshold}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={5000}
                  step={50}
                  value={likeThreshold}
                  onChange={(e) => setLikeThreshold(Number(e.target.value))}
                  className="w-full h-1 bg-surface-container-highest rounded-lg appearance-none cursor-pointer accent-primary"
                />
              </div>

              {/* Save Threshold */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="font-body text-body-sm text-on-surface-variant">收藏数 ≥</span>
                  <span className="font-mono text-xs text-on-surface">{saveThreshold}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={2000}
                  step={20}
                  value={saveThreshold}
                  onChange={(e) => setSaveThreshold(Number(e.target.value))}
                  className="w-full h-1 bg-surface-container-highest rounded-lg appearance-none cursor-pointer accent-primary"
                />
              </div>

              {/* Category Tag Select */}
              <div>
                <label className="font-body text-body-sm text-on-surface-variant block mb-1">
                  分类标签
                </label>
                <select
                  value={categoryTag}
                  onChange={(e) => setCategoryTag(e.target.value)}
                  className="form-input font-body text-body-sm"
                >
                  {categoryTags.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Trigger Button */}
            <button
              onClick={handleTriggerCollection}
              disabled={collecting || !keyword.trim()}
              className="w-full flex items-center justify-center gap-2 bg-primary text-on-primary py-3 rounded-lg text-label-md font-semibold hover:opacity-90 transition-opacity shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <MaterialIcon
                icon={collecting ? 'sync' : 'rocket_launch'}
                size="md"
                fill
                className={collecting ? 'animate-spin-slow' : ''}
              />
              {collecting ? '采集中…' : '启动采集任务'}
            </button>
          </BentoCard>
        </div>

        {/* ============================================================= */}
        {/* Right: Material Gallery (8 cols)                              */}
        {/* ============================================================= */}
        <div className="xl:col-span-8 space-y-bento">
          {/* Gallery Section */}
          <BentoCard hover={false}>
            {/* Header */}
            <div className="flex items-center gap-2 mb-4 border-b border-outline-variant pb-4">
              <MaterialIcon icon="wall_art" size="md" className="text-primary" fill />
              <h2 className="text-headline-md text-headline-md text-on-surface">素材归档视窗</h2>
              <span className="ml-auto text-body-sm text-on-surface-variant">
                共 {filteredMaterials.length} 条素材
              </span>
            </div>

            {/* Filter Bar */}
            <div className="flex flex-wrap items-center gap-2 mb-5">
              {/* Style Filter */}
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-label-md text-[11px] text-on-surface-variant mr-1">风格</span>
                <button
                  onClick={() => setFilterStyle(null)}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors',
                    filterStyle === null
                      ? 'bg-primary-container text-on-primary border-primary-container'
                      : 'bg-surface text-on-surface-variant border-outline-variant hover:border-primary',
                  )}
                >
                  全部
                </button>
                {STYLE_OPTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setFilterStyle(filterStyle === s ? null : s)}
                    className={cn(
                      'px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors',
                      filterStyle === s
                        ? 'bg-primary-container text-on-primary border-primary-container'
                        : 'bg-surface text-on-surface-variant border-outline-variant hover:border-primary',
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>

              <span className="w-px h-5 bg-outline-variant mx-1 hidden md:block" />

              {/* Room Filter */}
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-label-md text-[11px] text-on-surface-variant mr-1">空间</span>
                <button
                  onClick={() => setFilterRoom(null)}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors',
                    filterRoom === null
                      ? 'bg-primary-container text-on-primary border-primary-container'
                      : 'bg-surface text-on-surface-variant border-outline-variant hover:border-primary',
                  )}
                >
                  全部
                </button>
                {ROOM_OPTIONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => setFilterRoom(filterRoom === r ? null : r)}
                    className={cn(
                      'px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors',
                      filterRoom === r
                        ? 'bg-primary-container text-on-primary border-primary-container'
                        : 'bg-surface text-on-surface-variant border-outline-variant hover:border-primary',
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>

              <span className="w-px h-5 bg-outline-variant mx-1 hidden md:block" />

              {/* Quality Filter */}
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-label-md text-[11px] text-on-surface-variant mr-1">品质</span>
                {QUALITY_OPTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => setFilterQuality(filterQuality === q ? null : q)}
                    className={cn(
                      'px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors',
                      filterQuality === q
                        ? 'bg-primary-container text-on-primary border-primary-container'
                        : 'bg-surface text-on-surface-variant border-outline-variant hover:border-primary',
                    )}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>

            {/* Grid */}
            {filteredMaterials.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant">
                <MaterialIcon icon="inventory_2" size="3xl" className="opacity-30 mb-2" />
                <p className="font-body text-body-sm">暂无匹配素材</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredMaterials.map((item) => (
                  <MaterialCard key={item.id} item={item} />
                ))}
              </div>
            )}
          </BentoCard>

          {/* ============================================================= */}
          {/* Collection Task Status                                         */}
          {/* ============================================================= */}
          <BentoCard hover={false}>
            <div className="flex items-center gap-2 mb-4 border-b border-outline-variant pb-4">
              <MaterialIcon icon="monitoring" size="md" className="text-primary" fill />
              <h2 className="text-headline-md text-headline-md text-on-surface">采集任务状态</h2>
            </div>

            <div className="flex flex-col md:flex-row gap-6">
              {/* Task Info */}
              <div className="flex-1 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-label-md text-label-md text-on-surface-variant">任务 ID</span>
                  <span className="font-mono text-body-sm text-on-surface">{taskStatus.taskId}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-label-md text-label-md text-on-surface-variant">状态</span>
                  <span>
                    {taskStatus.status === 'running' && (
                      <span className="inline-flex items-center gap-1 text-label-md text-label-md text-primary bg-primary/10 px-2.5 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-dot" />
                        运行中
                      </span>
                    )}
                    {taskStatus.status === 'completed' && (
                      <StatusPill tone="success" icon="check_circle">
                        已完成
                      </StatusPill>
                    )}
                    {taskStatus.status === 'failed' && (
                      <StatusPill tone="error" icon="error">
                        采集失败
                      </StatusPill>
                    )}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-label-md text-label-md text-on-surface-variant">已用时间</span>
                  <span className="font-mono text-body-sm text-on-surface">
                    {formatElapsed(taskStatus.elapsedSeconds)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-label-md text-label-md text-on-surface-variant">已采集</span>
                  <span className="font-mono text-body-sm text-on-surface">
                    {taskStatus.itemsScraped} / {taskStatus.totalItems}
                  </span>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="flex-1 flex flex-col justify-center">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-label-md text-label-md text-on-surface-variant">采集进度</span>
                  <span className="text-label-md text-label-md text-primary font-semibold">
                    {taskStatus.progress}%
                  </span>
                </div>
                <div className="w-full h-2 bg-surface-container-highest rounded-full overflow-hidden">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-700',
                      taskStatus.status === 'completed'
                        ? 'bg-emerald-500'
                        : taskStatus.status === 'failed'
                          ? 'bg-error'
                          : 'bg-primary',
                    )}
                    style={{ width: `${taskStatus.progress}%` }}
                  />
                </div>
                {taskStatus.status === 'running' && (
                  <p className="text-body-sm text-on-surface-variant mt-2">
                    正在采集第 {taskStatus.itemsScraped} / {taskStatus.totalItems} 条素材…
                  </p>
                )}
                {taskStatus.status === 'completed' && (
                  <p className="text-body-sm text-emerald-600 mt-2 flex items-center gap-1">
                    <MaterialIcon icon="check_circle" size="sm" />
                    采集完成，共获取 {taskStatus.itemsScraped} 条素材
                  </p>
                )}
                {taskStatus.status === 'failed' && (
                  <p className="text-body-sm text-error mt-2 flex items-center gap-1">
                    <MaterialIcon icon="error" size="sm" />
                    采集异常，请检查网络或平台限制后重试
                  </p>
                )}
              </div>
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}

// =========================================================================
// Material Card Component
// =========================================================================

function MaterialCard({ item }: { item: MaterialItem }) {
  const [imgError, setImgError] = useState(false);

  return (
    <div className="group rounded-lg border border-outline-variant bg-surface-container-lowest overflow-hidden transition-all duration-200 hover:border-primary/50 hover:shadow-md hover:-translate-y-0.5 cursor-pointer">
      {/* Thumbnail */}
      <div className="relative aspect-[4/3] bg-surface-container-high overflow-hidden">
        {!imgError && item.thumbnail ? (
          <img
            src={item.thumbnail}
            alt={item.title}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-outline">
            <MaterialIcon icon="image" size="3xl" className="opacity-30" />
          </div>
        )}

        {/* Overlay badges */}
        <div className="absolute top-2 left-2 flex flex-wrap gap-1">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/50 text-white backdrop-blur-sm">
            {item.style}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/50 text-white backdrop-blur-sm">
            {item.room}
          </span>
        </div>

        {/* Quality badge */}
        <div
          className={cn(
            'absolute top-2 right-2 w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold shadow-sm',
            QUALITY_COLORS[item.quality],
          )}
        >
          {item.quality}
        </div>
      </div>

      {/* Info */}
      <div className="p-3 space-y-2">
        <p className="text-body-sm font-medium text-on-surface truncate group-hover:text-primary transition-colors">
          {item.title}
        </p>
        <div className="flex items-center justify-between text-[11px] text-on-surface-variant">
          <div className="flex items-center gap-1.5">
            <MaterialIcon icon="music_note" size="xs" className="opacity-60" />
            <span>{item.sourceLabel}</span>
          </div>
          <span>{item.date}</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-on-surface-variant">
          <span className="flex items-center gap-0.5">
            <MaterialIcon icon="thumb_up" size="xs" className="opacity-60" />
            {formatNumber(item.likes)}
          </span>
          <span className="flex items-center gap-0.5">
            <MaterialIcon icon="bookmark" size="xs" className="opacity-60" />
            {formatNumber(item.saves)}
          </span>
        </div>
      </div>
    </div>
  );
}
