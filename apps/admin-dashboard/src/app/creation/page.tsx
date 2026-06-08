'use client';

import { useState, useMemo } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { BentoCard } from '@/components/ui/Bento';
import { StatusPill } from '@/components/ui/StatusPill';
import { useCreationTasks, useComposeVideo } from '@/hooks/useApi';
import { cn } from '@/lib/utils';

// ============================================================
// Helpers
// ============================================================

function formatEta(seconds: number | undefined): string {
  if (!seconds) return '--';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs} 秒`;
  return `${mins} 分${secs > 0 ? ` ${secs} 秒` : ''}`;
}

// ============================================================
// Fallback / mock data
// ============================================================

const MOCK_TASKS = [
  { taskId: 'TSK-202311-001', taskType: 'video_compose', status: 'rendering', progress: 78, etaSeconds: 150, createdAt: '2024-03-15T10:00:00Z', updatedAt: '2024-03-15T10:45:00Z' },
  { taskId: 'TSK-202310-092', taskType: 'video_compose', status: 'completed', progress: 100, etaSeconds: 0, createdAt: '2024-03-14T08:00:00Z', updatedAt: '2024-03-14T08:45:00Z' },
  { taskId: 'TSK-202311-005', taskType: 'video_compose', status: 'script_generating', etaSeconds: undefined, createdAt: '2024-03-15T11:00:00Z', updatedAt: '2024-03-15T11:10:00Z' },
  { taskId: 'TSK-202311-008', taskType: 'video_compose', status: 'pending', etaSeconds: undefined, createdAt: '2024-03-15T11:30:00Z', updatedAt: '2024-03-15T11:30:00Z' },
  { taskId: 'TSK-202312-001', taskType: 'video_compose', status: 'failed', etaSeconds: 0, createdAt: '2024-03-13T09:00:00Z', updatedAt: '2024-03-13T09:20:00Z' },
];

const TASK_NAMES: Record<string, string> = {
  'TSK-202311-001': '秋季上新宣传A组',
  'TSK-202310-092': '国庆促销混剪_版B',
  'TSK-202311-005': '双十一爆款预热',
  'TSK-202311-008': '日常引流短视频_30s',
  'TSK-202312-001': '跨年倒计时特辑',
};

const STYLE_OPTIONS = [
  { key: 'cream', label: '奶油风' },
  { key: 'wabi', label: '侘寂风' },
  { key: 'modern', label: '现代简约' },
  { key: 'guochao', label: '国潮混搭' },
];

const MODE_OPTIONS = [
  { key: 'random', label: '随机风格' },
  { key: 'fixed', label: '固定风格' },
  { key: 'user_uploaded', label: '固定素材' },
];

// ============================================================
// Page
// ============================================================

export default function CreationPage() {
  // Data
  const { data: tasksData, isLoading: tasksLoading } = useCreationTasks();
  const composeVideo = useComposeVideo();

  // Config state
  const [mode, setMode] = useState('random');
  const [selectedStyles, setSelectedStyles] = useState<string[]>(['cream', 'modern']);
  const [duration, setDuration] = useState(45);
  const [publishDate, setPublishDate] = useState('2024-03-15');
  const [publishTime, setPublishTime] = useState('18:30');
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  // Tasks
  const tasks = useMemo(() => {
    if (tasksData && Array.isArray(tasksData) && tasksData.length > 0) return tasksData;
    return MOCK_TASKS;
  }, [tasksData]);

  const toggleStyle = (key: string) => {
    setSelectedStyles((prev) =>
      prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key],
    );
  };

  const toggleExpand = (taskId: string) => {
    setExpandedRowId((prev) => (prev === taskId ? null : taskId));
  };

  return (
    <div>
      {/* ============================================
          Page Header
          ============================================ */}
      <div className="mb-section-margin flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-headline-lg text-headline-lg-mobile md:text-headline-lg text-on-surface">智能创作工作台</h1>
          <p className="font-body text-body-md text-on-surface-variant mt-2 max-w-2xl">配置视频合成参数并实时监控渲染管线状态。</p>
        </div>
        <button className="hidden md:flex items-center gap-2 bg-primary-container text-on-primary px-4 py-2 rounded-lg text-label-md text-label-md hover:bg-surface-tint transition-colors shadow-sm shrink-0">
          <MaterialIcon icon="play_arrow" size="md" fill /> 开始批量生成
        </button>
      </div>

      {/* ============================================
          Bento Grid Layout
          ============================================ */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-bento h-[calc(100vh-200px)] min-h-[600px]">

        {/* ============================================
            Left: 合成配置 (4 cols)
            ============================================ */}
        <div className="xl:col-span-4 bg-surface-container-lowest rounded-xl border border-outline-variant p-inner-component-padding flex flex-col h-full overflow-y-auto shadow-sm">
          {/* Header */}
          <div className="flex items-center gap-2 mb-6 border-b border-outline-variant pb-4">
            <MaterialIcon icon="tune" size="md" className="text-primary" fill />
            <h2 className="text-headline-md text-headline-md text-on-surface">合成配置</h2>
          </div>

          <form className="space-y-6 flex-1" onSubmit={(e) => e.preventDefault()}>
            {/* 合成模式 */}
            <div>
              <label className="block text-label-md text-label-md text-on-surface-variant mb-3">合成模式</label>
              <div className="flex flex-wrap gap-2">
                {MODE_OPTIONS.map((opt) => (
                  <label key={opt.key} className="cursor-pointer">
                    <input
                      className="peer sr-only"
                      name="mode"
                      type="radio"
                      checked={mode === opt.key}
                      onChange={() => setMode(opt.key)}
                    />
                    <div className="px-4 py-2 rounded-full border border-outline-variant bg-surface text-on-surface-variant font-body text-body-sm peer-checked:bg-primary-container peer-checked:text-on-primary peer-checked:border-primary-container transition-all hover:border-primary">
                      {opt.label}
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* 风格预设 */}
            <div>
              <label className="block text-label-md text-label-md text-on-surface-variant mb-3">风格预设 (多选)</label>
              <div className="grid grid-cols-2 gap-2">
                {STYLE_OPTIONS.map((style) => (
                  <label key={style.key} className="flex items-center gap-3 p-3 rounded-lg border border-outline-variant bg-surface hover:border-primary transition-colors cursor-pointer group">
                    <input
                      className="w-4 h-4 text-primary bg-surface-container-low border-outline-variant rounded focus:ring-primary focus:ring-2 focus:ring-opacity-20"
                      type="checkbox"
                      checked={selectedStyles.includes(style.key)}
                      onChange={() => toggleStyle(style.key)}
                    />
                    <span className="font-body text-body-sm text-on-surface group-hover:text-primary">{style.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* 输出时长 */}
            <div>
              <div className="flex justify-between items-center mb-3">
                <label className="text-label-md text-label-md text-on-surface-variant">输出时长估算</label>
                <span className="text-label-md text-label-md text-primary">30s - {duration}s</span>
              </div>
              <input
                className="w-full h-1 bg-surface-container-highest rounded-lg appearance-none cursor-pointer accent-primary"
                max="120"
                min="15"
                type="range"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
              <div className="flex justify-between text-[10px] text-outline mt-1 px-1">
                <span>15s</span>
                <span>60s</span>
                <span>120s</span>
              </div>
            </div>

            {/* 定时发布 */}
            <div>
              <label className="block text-label-md text-label-md text-on-surface-variant mb-3">定时发布配置</label>
              <div className="flex flex-col gap-2">
                <div className="flex items-center border border-outline-variant rounded-lg bg-surface-container-low px-3 py-2 focus-within:border-primary focus-within:ring-2 ring-primary/20 transition-all">
                  <MaterialIcon icon="calendar_today" size="md" className="text-outline mr-2" />
                  <input
                    className="bg-transparent border-none focus:ring-0 text-body font-body w-full outline-none text-on-surface"
                    type="date"
                    value={publishDate}
                    onChange={(e) => setPublishDate(e.target.value)}
                  />
                </div>
                <div className="flex items-center border border-outline-variant rounded-lg bg-surface-container-low px-3 py-2 focus-within:border-primary focus-within:ring-2 ring-primary/20 transition-all">
                  <MaterialIcon icon="schedule" size="md" className="text-outline mr-2" />
                  <input
                    className="bg-transparent border-none focus:ring-0 text-body font-body w-full outline-none text-on-surface"
                    type="time"
                    value={publishTime}
                    onChange={(e) => setPublishTime(e.target.value)}
                  />
                </div>
              </div>
            </div>
          </form>

          {/* Mobile generate button */}
          <button className="md:hidden mt-6 w-full flex items-center justify-center gap-2 bg-primary-container text-on-primary px-4 py-3 rounded-lg text-label-md text-label-md hover:bg-surface-tint transition-colors shadow-sm">
            <MaterialIcon icon="play_arrow" size="md" fill /> 开始生成
          </button>
        </div>

        {/* ============================================
            Right: 生产管线状态 (8 cols)
            ============================================ */}
        <div className="xl:col-span-8 bg-surface-container-lowest rounded-xl border border-outline-variant flex flex-col h-full overflow-hidden shadow-sm relative">
          {/* Decorative blurred background */}
          <div className="absolute top-0 right-0 w-64 h-32 bg-primary/5 rounded-bl-[100px] blur-3xl pointer-events-none" />

          {/* Header */}
          <div className="p-inner-component-padding border-b border-outline-variant flex justify-between items-center bg-surface/50 backdrop-blur-sm relative z-10">
            <div className="flex items-center gap-2">
              <MaterialIcon icon="monitoring" size="md" className="text-primary" fill />
              <h2 className="text-headline-md text-headline-md text-on-surface">生产管线状态</h2>
            </div>
            <div className="flex gap-2">
              <button className="p-2 rounded-lg border border-outline-variant hover:bg-surface-container transition-colors text-on-surface-variant flex items-center justify-center">
                <MaterialIcon icon="filter_list" size="lg" />
              </button>
              <button className="p-2 rounded-lg border border-outline-variant hover:bg-surface-container transition-colors text-on-surface-variant flex items-center justify-center">
                <MaterialIcon icon="refresh" size="lg" />
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-auto relative z-10">
            {tasksLoading ? (
              <div className="p-6 space-y-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-6 animate-pulse py-4 px-6">
                    <div className="flex-1 space-y-2">
                      <div className="h-3 bg-surface-container rounded w-32" />
                      <div className="h-2 bg-surface-container rounded w-20" />
                    </div>
                    <div className="h-3 bg-surface-container rounded w-24" />
                    <div className="h-6 bg-surface-container rounded w-20" />
                  </div>
                ))}
              </div>
            ) : tasks.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-on-surface-variant py-16">
                <MaterialIcon icon="construction" size="3xl" className="text-outline mb-3 opacity-40" />
                <p className="text-body-sm">暂无创作任务</p>
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-surface-container-low/90 backdrop-blur-md z-20">
                  <tr>
                    <th className="py-3 px-6 text-label-md text-label-md text-on-surface-variant font-semibold border-b border-outline-variant w-1/4">任务名称 / ID</th>
                    <th className="py-3 px-6 text-label-md text-label-md text-on-surface-variant font-semibold border-b border-outline-variant w-1/4">预估时长</th>
                    <th className="py-3 px-6 text-label-md text-label-md text-on-surface-variant font-semibold border-b border-outline-variant w-1/4">当前状态</th>
                    <th className="py-3 px-6 text-label-md text-label-md text-on-surface-variant font-semibold border-b border-outline-variant w-1/4 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-container-high bg-transparent">
                  {tasks.map((task: any) => (
                    <TaskRow
                      key={task.taskId}
                      task={task}
                      isExpanded={expandedRowId === task.taskId}
                      onToggle={() => toggleExpand(task.taskId)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Table Footer Pagination */}
          <div className="p-4 border-t border-outline-variant bg-surface-container-lowest flex justify-between items-center text-xs text-on-surface-variant relative z-10">
            <span>显示 1-{tasks.length} 共 {tasks.length} 条记录</span>
            <div className="flex gap-1">
              <button className="p-1 rounded border border-outline-variant hover:bg-surface-container disabled:opacity-50" disabled>
                <MaterialIcon icon="chevron_left" size="sm" />
              </button>
              <button className="p-1 rounded border border-outline-variant hover:bg-surface-container">
                <MaterialIcon icon="chevron_right" size="sm" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Task Row Component
// ============================================================

function TaskRow({ task, isExpanded, onToggle }: { task: any; isExpanded: boolean; onToggle: () => void }) {
  const name = TASK_NAMES[task.taskId] || task.taskId;

  return (
    <>
      {/* Main Row */}
      <tr className="hover:bg-surface-container-low transition-colors group cursor-pointer" onClick={onToggle}>
        <td className="py-4 px-6">
          <div className="font-body text-body-sm font-medium text-on-surface">{name}</div>
          <div className="text-label-md text-[10px] text-outline mt-1">#{task.taskId}</div>
        </td>
        <td className="py-4 px-6 font-body text-body-sm text-on-surface-variant">
          {task.status === 'rendering' ? (
            <div className="flex items-center gap-2">
              <MaterialIcon icon="sync" size="sm" className="text-primary animate-spin-slow" />
              约 {formatEta(task.etaSeconds)}
            </div>
          ) : task.status === 'script_generating' ? (
            '计算中...'
          ) : task.status === 'pending' ? (
            '排队中 (2)'
          ) : (
            '--'
          )}
        </td>
        <td className="py-4 px-6">
          {task.status === 'rendering' && (
            <span className="inline-flex items-center gap-1 text-label-md text-label-md text-primary bg-primary/10 px-2 py-1 rounded-md">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-dot" />
              渲染中 {task.progress || 0}%
            </span>
          )}
          {task.status === 'completed' && (
            <span className="inline-flex items-center gap-1 text-label-md text-label-md text-status-success bg-status-success/10 px-2 py-1 rounded-md">
              <MaterialIcon icon="check_circle" size="sm" />
              合成完成
            </span>
          )}
          {task.status === 'script_generating' && (
            <span className="inline-flex items-center gap-1 text-label-md text-label-md text-status-warning bg-status-warning/10 px-2 py-1 rounded-md">
              <MaterialIcon icon="auto_awesome" size="sm" className="animate-pulse-dot" />
              脚本生成中
            </span>
          )}
          {task.status === 'pending' && (
            <span className="inline-flex items-center gap-1 text-label-md text-label-md text-secondary bg-secondary/10 px-2 py-1 rounded-md">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
              等处理
            </span>
          )}
          {task.status === 'failed' && (
            <span className="inline-flex items-center gap-1 text-label-md text-label-md text-error bg-error/10 px-2 py-1 rounded-md">
              <MaterialIcon icon="error" size="sm" />
              合成失败
            </span>
          )}
        </td>
        <td className="py-4 px-6 text-right">
          {task.status === 'failed' ? (
            <button className="text-error text-label-md text-[12px] hover:underline">查看日志</button>
          ) : (
            <MaterialIcon
              icon={isExpanded ? 'expand_less' : 'expand_more'}
              size="md"
              className="text-outline group-hover:text-primary transition-colors"
            />
          )}
        </td>
      </tr>

      {/* Expanded Content */}
      {isExpanded && (
        <tr className="bg-surface/30">
          <td className="p-0 border-b border-outline-variant" colSpan={4}>
            <div className="p-6">
              {task.status === 'rendering' && <PipelineProgress progress={task.progress || 75} />}
              {task.status === 'completed' && <OutputFile taskId={task.taskId} />}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ============================================================
// Pipeline Progress (for rendering tasks)
// ============================================================

function PipelineProgress({ progress }: { progress: number }) {
  const steps = [
    { label: '选取素材', completed: true, icon: 'check' as const },
    { label: '脚本生成', completed: true, icon: 'check' as const },
    { label: '渲染管线', active: true, icon: 'movie' as const },
    { label: '合成输出', completed: false, icon: 'done_all' as const },
  ];

  return (
    <div className="flex items-center justify-between relative">
      {/* Pipeline background line */}
      <div className="absolute left-6 right-6 top-1/2 -translate-y-1/2 h-0.5 bg-surface-container-highest z-0" />
      {/* Active progress line */}
      <div
        className="absolute left-6 top-1/2 -translate-y-1/2 h-0.5 bg-primary z-0 transition-all duration-1000"
        style={{ width: `${Math.min(progress, 100)}%` }}
      />

      {steps.map((step, idx) => (
        <div key={idx} className="relative z-10 flex flex-col items-center gap-2">
          {step.completed ? (
            <div className="w-8 h-8 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-sm">
              <MaterialIcon icon={step.icon} size="sm" fill />
            </div>
          ) : step.active ? (
            <div className="w-8 h-8 rounded-full bg-surface border-2 border-primary text-primary flex items-center justify-center shadow-sm">
              <MaterialIcon icon={step.icon} size="sm" spin />
            </div>
          ) : (
            <div className="w-8 h-8 rounded-full bg-surface-container-high text-outline flex items-center justify-center border border-outline-variant">
              <MaterialIcon icon={step.icon} size="sm" />
            </div>
          )}
          <span className={cn(
            'text-label-md text-[10px]',
            step.active ? 'text-primary font-bold' : step.completed ? 'text-on-surface-variant' : 'text-outline',
          )}>
            {step.label}
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Output File Card (for completed tasks)
// ============================================================

function OutputFile({ taskId }: { taskId: string }) {
  return (
    <div className="flex justify-between items-center">
      <div className="flex items-center gap-4">
        <div className="w-24 h-16 bg-surface-container-high rounded-md border border-outline-variant flex items-center justify-center relative overflow-hidden group/thumb cursor-pointer">
          <MaterialIcon icon="play_circle" size="2xl" className="text-outline group-hover/thumb:scale-110 transition-transform" />
          <div className="absolute inset-0 bg-black/20 opacity-0 group-hover/thumb:opacity-100 transition-opacity" />
        </div>
        <div>
          <div className="font-body text-body-sm text-on-surface">输出文件: {TASK_NAMES[taskId] || taskId}_final.mp4</div>
          <div className="text-label-md text-[10px] text-outline mt-1">时长: 00:45 | 大小: 12.4 MB</div>
        </div>
      </div>
      <button className="bg-surface-container-low border border-outline-variant hover:border-primary text-on-surface-variant hover:text-primary px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1">
        <MaterialIcon icon="download" size="sm" /> 下载
      </button>
    </div>
  );
}
