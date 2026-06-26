'use client';

import { cn } from '@/lib/utils';
import { StatusPill } from '@/components/ui/StatusPill';
import type { MaintenanceHealth } from '@/hooks/useApi';

/** 执行健康徽章 */
export function HealthBadge({ health }: { health: MaintenanceHealth }) {
  const map: Record<MaintenanceHealth, { tone: 'success' | 'warning' | 'error'; label: string }> = {
    healthy: { tone: 'success', label: '健康' },
    degraded: { tone: 'warning', label: '降级' },
    failed: { tone: 'error', label: '失败' },
  };
  const c = map[health];
  return <StatusPill tone={c.tone} dot>{c.label}</StatusPill>;
}

/** 选择器/URL 结果徽章 */
export function SelectorResultBadge({ passed, total, label }: { passed: number; total: number; label?: string }) {
  if (total === 0) return <StatusPill tone="neutral">无记录</StatusPill>;
  const rate = passed / total;
  const text = label ? `${label} (${passed}/${total})` : `${passed}/${total}`;
  if (rate >= 0.95) return <StatusPill tone="success">{text}</StatusPill>;
  if (rate >= 0.8) return <StatusPill tone="warning">{text}</StatusPill>;
  return <StatusPill tone="error">{text}</StatusPill>;
}

/** 流程类型标签 */
export function FlowLabel({ flowType }: { flowType: string }) {
  const colorMap: Record<string, string> = {
    login: 'bg-blue-50 text-blue-700',
    publish: 'bg-emerald-50 text-emerald-700',
    monitor: 'bg-amber-50 text-amber-700',
    collect: 'bg-purple-50 text-purple-700',
    maintenance: 'bg-rose-50 text-rose-700',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-label-md text-label-sm font-semibold',
        colorMap[flowType] || 'bg-surface-container text-on-surface-variant',
      )}
    >
      {flowType}
    </span>
  );
}

/** 步骤健康徽章 */
export function StepHealthBadge({ status }: { status: string }) {
  const map: Record<string, { tone: 'success' | 'warning' | 'error' | 'pending' | 'info'; label: string }> = {
    passed: { tone: 'success', label: '通过' },
    skipped: { tone: 'info', label: '跳过' },
    degraded: { tone: 'warning', label: '降级' },
    failed: { tone: 'error', label: '失败' },
    running: { tone: 'pending', label: '运行中' },
  };
  const c = map[status] || { tone: 'neutral' as const, label: status };
  return <StatusPill tone={c.tone as any} dot>{c.label}</StatusPill>;
}

/** 格式化相对时间 */
export function relativeTime(ts: string | number | null | undefined): string {
  if (!ts) return '-';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  return `${days} 天前`;
}
