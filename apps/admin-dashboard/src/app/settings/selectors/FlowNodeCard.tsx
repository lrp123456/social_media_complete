'use client';

import { cn } from '@/lib/utils';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import type { MaterialIconName } from '@/components/ui/MaterialIcon';
import type { FlowNode, LastRunStep } from '@/hooks/useApi';

const ACTION_CONFIG: Record<string, { icon: MaterialIconName; color: string }> = {
  check_url: { icon: 'link', color: 'border-blue-400 bg-blue-50' },
  check_menu_state: { icon: 'folder_open' as MaterialIconName, color: 'border-purple-400 bg-purple-50' },
  click_menu: { icon: 'mouse' as MaterialIconName, color: 'border-green-400 bg-green-50' },
  click_tab: { icon: 'tab' as MaterialIconName, color: 'border-green-400 bg-green-50' },
  click_button: { icon: 'smart_button' as MaterialIconName, color: 'border-green-400 bg-green-50' },
  enable_interceptor: { icon: 'visibility', color: 'border-orange-400 bg-orange-50' },
  disable_interceptor: { icon: 'visibility_off', color: 'border-orange-400 bg-orange-50' },
  refresh_page: { icon: 'refresh', color: 'border-cyan-400 bg-cyan-50' },
  wait_for_response: { icon: 'hourglass_empty' as MaterialIconName, color: 'border-cyan-400 bg-cyan-50' },
  check_quantity: { icon: 'pin' as MaterialIconName, color: 'border-yellow-400 bg-yellow-50' },
  scroll_load: { icon: 'arrow_downward' as MaterialIconName, color: 'border-gray-400 bg-gray-50' },
  page_turn: { icon: 'arrow_forward', color: 'border-gray-400 bg-gray-50' },
  close_menu: { icon: 'folder_delete' as MaterialIconName, color: 'border-red-400 bg-red-50' },
  done: { icon: 'check_circle', color: 'border-green-500 bg-green-100' },
};

function getRunStatus(lastRun?: LastRunStep) {
  if (!lastRun) return { dot: 'bg-gray-300', label: '未执行' };
  if (lastRun.status === 'success') return { dot: 'bg-green-500', label: '成功' };
  if (lastRun.status === 'fallback') return { dot: 'bg-yellow-500', label: '回退' };
  if (lastRun.status === 'failed') return { dot: 'bg-red-500', label: '失败' };
  return { dot: 'bg-gray-300', label: lastRun.status };
}

function formatDuration(ms?: number) {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function FlowNodeCard({
  node,
  lastRun,
  selected,
  onClick,
}: {
  node: FlowNode;
  lastRun?: LastRunStep;
  selected: boolean;
  onClick: () => void;
}) {
  const cfg = ACTION_CONFIG[node.action] || { icon: 'help', color: 'border-gray-300' };
  const status = getRunStatus(lastRun);

  return (
    <div
      onClick={onClick}
      className={cn(
        'border-l-4 rounded-lg p-3 cursor-pointer transition-all hover:shadow-md',
        cfg.color,
        selected && 'ring-2 ring-blue-500 shadow-md',
      )}
    >
      {/* 顶部：图标 + 类型 + 状态色点 */}
      <div className="flex items-center gap-2">
        <MaterialIcon icon={cfg.icon} className="text-lg" />
        <span className="text-xs text-gray-500">{node.action}</span>
        <span className={cn('ml-auto w-2.5 h-2.5 rounded-full', status.dot)} title={status.label} />
      </div>

      {/* 步骤ID */}
      <div className="text-xs font-mono text-gray-400 mt-1">{node.id}</div>

      {/* 描述 */}
      <div className="text-sm text-gray-700 mt-0.5">{node.description}</div>

      {/* 选择器摘要 */}
      {node.selector?.primary?.value && (
        <div className="text-xs text-gray-400 mt-1 truncate font-mono">
          {node.selector.primary.value.substring(0, 50)}
        </div>
      )}

      {/* API Pattern 引用 */}
      {node.apiPatternKey && (
        <div className="text-xs text-orange-600 mt-1">
          <MaterialIcon icon="api" className="text-xs inline" /> {node.apiPatternKey}
        </div>
      )}

      {/* 执行状态 */}
      {lastRun && (
        <div className="text-xs text-gray-400 mt-1.5 flex items-center gap-3 flex-wrap">
          <span>{formatDuration(lastRun.durationMs)}</span>
          {lastRun.selectorTries && Array.isArray(lastRun.selectorTries) && (
            <span className="flex gap-1">
              {lastRun.selectorTries.map((t: any, i: number) => (
                <span key={i} title={t.selector}>
                  {t.result === 'found' ? '✓' : '✗'}{t.source?.replace('primary', 'P').replace('fallback', 'F') || i}
                </span>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
