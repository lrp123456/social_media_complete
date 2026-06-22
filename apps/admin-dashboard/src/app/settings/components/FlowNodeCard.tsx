// apps/admin-dashboard/src/app/settings/components/FlowNodeCard.tsx
import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowNode, FlowSubStep } from '@/hooks/useApi';

const ACTION_COLORS: Record<string, string> = {
  check_url: '#3b82f6',
  click_menu: '#22c55e',
  click_button: '#22c55e',
  enable_interceptor: '#f59e0b',
  scroll_load: '#8b5cf6',
  check_quantity: '#06b6d4',
  done: '#64748b',
  navigate: '#ef4444',
  refresh_page: '#6366f1',
  wait_for_response: '#a855f7',
};

type FlowNodeCardData = {
  node: FlowNode;
  expanded?: boolean;
  onToggleExpand?: (id: string) => void;
  lastRun?: { status: string; durationMs?: number };
};

function FlowNodeCard({ data, selected }: NodeProps & { data: FlowNodeCardData }) {
  const { node, expanded, onToggleExpand, lastRun } = data;
  const color = ACTION_COLORS[node.action] || '#64748b';
  const hasSubSteps = node.steps && node.steps.length > 0;
  const branchCount = node.branches?.length || 0;

  return (
    <div
      style={{
        background: '#1e293b',
        border: `2px solid ${selected ? '#818cf8' : color}`,
        borderRadius: 12,
        padding: '10px 16px',
        minWidth: 180,
        maxWidth: 280,
        cursor: 'pointer',
      }}
      onClick={() => hasSubSteps && onToggleExpand?.(node.id)}
    >
      <Handle type="target" position={Position.Top} style={{ background: color }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ color, fontSize: 11, fontWeight: 600 }}>{node.action}</span>
        {hasSubSteps && (
          <span style={{ color: '#475569', fontSize: 10 }}>
            {expanded ? '▼' : '▶'} {node.steps!.length} 步
          </span>
        )}
        {branchCount > 0 && (
          <span style={{ color: '#f59e0b', fontSize: 10 }}>⟳ {branchCount} 分支</span>
        )}
        {lastRun && (
          <span
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: lastRun.status === 'success' ? '#22c55e' : lastRun.status === 'failed' ? '#ef4444' : '#64748b',
            }}
          />
        )}
      </div>

      <div style={{ color: '#e2e8f0', fontSize: 13 }}>{node.description}</div>

      {node.selector && (
        <div style={{ color: '#475569', fontSize: 11, marginTop: 4, fontFamily: 'monospace' }}>
          {(node.selector as any).primary?.value?.substring(0, 40) || (node.selector as any).key || ''}
        </div>
      )}

      {/* 展开时显示子步骤列表 */}
      {expanded && hasSubSteps && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #334155' }}>
          {node.steps!.map((sub: FlowSubStep, i: number) => (
            <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
              <span style={{ color: '#475569', fontSize: 10 }}>{i + 1}.</span>
              <span style={{ color: '#94a3b8', fontSize: 11 }}>{sub.action}</span>
              <span style={{ color: '#64748b', fontSize: 10 }}>{sub.description}</span>
            </div>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  );
}

export default memo(FlowNodeCard);
