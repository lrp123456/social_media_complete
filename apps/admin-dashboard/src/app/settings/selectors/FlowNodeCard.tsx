'use client';

import { cn } from '@/lib/utils';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import type { FlowNode, LastRunStep } from '@/hooks/useApi';

// ── Types ──

type FlowNodeCardProps = {
  node: FlowNode;
  lastRun?: LastRunStep;
  selected: boolean;
  onClick: () => void;
};

// ── Action Config ──

type ActionConfig = {
  label: string;
  icon: string;
  color: string;
};

const ACTION_CONFIG: Record<string, ActionConfig> = {
  check_url:            { label: '检查 URL',          icon: 'link',            color: 'border-l-sky-500' },
  check_menu_state:     { label: '检查菜单状态',      icon: 'menu',            color: 'border-l-violet-500' },
  click_menu:           { label: '点击菜单',          icon: 'ads_click',       color: 'border-l-blue-500' },
  click_tab:            { label: '点击标签',          icon: 'tab',             color: 'border-l-indigo-500' },
  click_button:         { label: '点击按钮',          icon: 'touch_app',       color: 'border-l-purple-500' },
  enable_interceptor:   { label: '启用拦截器',        icon: 'shield',          color: 'border-l-teal-500' },
  disable_interceptor:  { label: '禁用拦截器',        icon: 'shield_off',      color: 'border-l-orange-500' },
  refresh_page:         { label: '刷新页面',          icon: 'refresh',         color: 'border-l-amber-500' },
  wait_for_response:    { label: '等待响应',          icon: 'hourglass_empty', color: 'border-l-cyan-500' },
  check_quantity:       { label: '检查数量',          icon: 'pin',             color: 'border-l-emerald-500' },
  scroll_load:          { label: '滚动加载',          icon: 'swipe_vertical',  color: 'border-l-lime-500' },
  page_turn:            { label: '翻页',              icon: 'chevron_right',   color: 'border-l-rose-500' },
  close_menu:           { label: '关闭菜单',          icon: 'close',           color: 'border-l-pink-500' },
  done:                 { label: '完成',              icon: 'check_circle',    color: 'border-l-green-600' },
};

// ── Helpers ──

function formatDuration(ms?: number): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusDotColor(status?: string): string {
  switch (status) {
    case 'success':
      return 'bg-emerald-500';
    case 'fallback':
      return 'bg-amber-400';
    case 'failed':
      return 'bg-red-500';
    default:
      return 'bg-slate-400';
  }
}

function selectorTryStatus(tries: any): string {
  if (!tries) return '';
  if (typeof tries === 'object') {
    return Object.entries(tries)
      .map(([sel, ok]) => `${sel}:${ok ? '✓' : '✗'}`)
      .join(' ');
  }
  return '';
}

// ── Component ──

export default function FlowNodeCard({ node, lastRun, selected, onClick }: FlowNodeCardProps) {
  const config = ACTION_CONFIG[node.action] || { label: node.action, icon: 'help', color: 'border-l-slate-400' };

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative w-full border-l-4 rounded-lg p-3 cursor-pointer transition-all hover:shadow-md text-left',
        config.color,
        selected && 'ring-2 ring-blue-500 shadow-md',
        !selected && 'bg-surface border-outline-variant',
      )}
    >
      {/* Top row: icon + action label + status dot */}
      <div className="flex items-center gap-2">
        <MaterialIcon icon={config.icon as any} size="sm" className="text-on-surface-variant shrink-0" />
        <span className="text-label-sm font-semibold text-on-surface flex-1 truncate">{config.label}</span>
        {lastRun && (
          <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', statusDotColor(lastRun.status))} />
        )}
      </div>

      {/* Step ID */}
      <p className="text-[10px] font-mono text-on-surface-variant/60 mt-0.5">#{node.id}</p>

      {/* Description */}
      {node.description && (
        <p className="text-body-xs text-on-surface-variant mt-1 line-clamp-2">{node.description}</p>
      )}

      {/* Selector summary */}
      {node.selector?.primary?.value && (
        <p className="text-[11px] font-mono text-on-surface-variant/80 mt-1.5 truncate" title={node.selector.primary.value}>
          {node.selector.primary.value.length > 50
            ? node.selector.primary.value.slice(0, 50) + '…'
            : node.selector.primary.value}
        </p>
      )}

      {/* API Pattern reference */}
      {node.apiPatternKey && (
        <div className="flex items-center gap-1 mt-1.5">
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-700 font-medium">API</span>
          <span className="text-[10px] font-mono text-on-surface-variant/70 truncate">{node.apiPatternKey}</span>
        </div>
      )}

      {/* Execution status line */}
      {lastRun && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-outline-variant/30 text-[10px] text-on-surface-variant/70">
          <span>{formatDuration(lastRun.durationMs)}</span>
          {lastRun.selectorTries && (
            <span className="truncate">{selectorTryStatus(lastRun.selectorTries)}</span>
          )}
        </div>
      )}
    </button>
  );
}
