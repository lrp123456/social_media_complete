'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import {
  FLOW_DEFINITIONS,
  groupSelectorsByFlow,
  classifySelector,
} from '@/lib/selectorFlows';
import type { SelectorEntry, SelectorEffectivenessStats } from '@/hooks/useApi';

// ── Types ──

type FlowViewProps = {
  platform: string;
  entries: Array<{ category: string; name: string; entry: SelectorEntry }>;
  effMap: Map<string, SelectorEffectivenessStats>;
  onEdit: (entry: { platform: string; category: string; name: string; entry: SelectorEntry }) => void;
};

// ── Constants ──

const CATEGORY_LABELS: Record<string, string> = {
  menus: '菜单', buttons: '按钮', regions: '区域', textboxes: '文本框',
};

const PHASE_ICON_MAP: Record<string, string> = {
  nav: 'navigation',
  scan: 'analytics',
  'comment-nav': 'forum',
  collect: 'inventory_2',
  reply: 'reply',
  exit: 'logout',
  upload: 'upload',
  form: 'edit_note',
  submit: 'check_circle',
  'select-work': 'inventory_2',
  'find-comment': 'search',
  execute: 'send',
};

function statusDotColor(stat: SelectorEffectivenessStats | null): string {
  if (!stat || stat.totalAttempts === 0) return 'bg-slate-400';
  if (stat.successRate >= 0.9) return 'bg-emerald-500';
  if (stat.successRate >= 0.5) return 'bg-amber-500';
  if (stat.totalAttempts >= 3) return 'bg-red-500';
  return 'bg-amber-400';
}

function getEffStat(
  effMap: Map<string, SelectorEffectivenessStats>,
  platform: string,
  category: string,
  name: string,
  strategy: string,
): SelectorEffectivenessStats | null {
  return effMap.get(`${platform}:${category}:${name}:${strategy}`) || null;
}

// ── Component ──

export default function FlowView({ platform, entries, effMap, onEdit }: FlowViewProps) {
  const [activeFlow, setActiveFlow] = useState<string>('monitor');
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(new Set());

  // Group entries by flow → phase
  const grouped = useMemo(() => groupSelectorsByFlow(platform, entries), [platform, entries]);

  // Determine which flows have entries
  const availableFlows = useMemo(() => {
    return Object.keys(FLOW_DEFINITIONS).filter((f) => grouped[f] && Object.keys(grouped[f]).length > 0);
  }, [grouped]);

  // Collect uncategorized entries (those not classified into any flow)
  const uncategorized = useMemo(() => {
    const classified = new Set<string>();
    for (const flowPhases of Object.values(grouped)) {
      for (const phaseEntries of Object.values(flowPhases)) {
        for (const item of phaseEntries) {
          classified.add(`${item.category}:${item.name}`);
        }
      }
    }
    return entries.filter((e) => !classified.has(`${e.category}:${e.name}`));
  }, [entries, grouped]);

  const togglePhase = (phaseId: string) => {
    setCollapsedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phaseId)) next.delete(phaseId);
      else next.add(phaseId);
      return next;
    });
  };

  const flowDef = FLOW_DEFINITIONS[activeFlow];
  const flowGrouped = grouped[activeFlow] || {};

  // Count selectors per phase
  const phaseCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [phaseId, phaseEntries] of Object.entries(flowGrouped)) {
      counts[phaseId] = phaseEntries.length;
    }
    return counts;
  }, [flowGrouped]);

  if (availableFlows.length === 0) {
    return (
      <div className="text-center py-16 text-on-surface-variant">
        <MaterialIcon icon="visibility_off" size="2xl" className="text-outline mb-3 opacity-40" />
        <p className="text-title-md">暂无业务流程选择器</p>
        <p className="text-body-sm mt-1">当前平台没有已分类的选择器</p>
      </div>
    );
  }

  return (
    <div>
      {/* Flow tabs */}
      <div className="flex gap-2 mb-5">
        {availableFlows.map((flowId) => {
          const def = FLOW_DEFINITIONS[flowId];
          const total = Object.values(grouped[flowId] || {}).reduce((s, arr) => s + arr.length, 0);
          return (
            <button
              key={flowId}
              onClick={() => setActiveFlow(flowId)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 rounded-xl text-label-md font-medium transition-all',
                activeFlow === flowId
                  ? 'bg-primary text-on-primary shadow-sm'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high',
              )}
            >
              <MaterialIcon icon={def.icon as any} size="sm" />
              {def.label}
              <span className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full font-bold',
                activeFlow === flowId ? 'bg-white/20' : 'bg-outline-variant/40',
              )}>
                {total}
              </span>
            </button>
          );
        })}
      </div>

      {/* Pipeline */}
      <div className="relative space-y-0">
        {flowDef.phases.map((phase, idx) => {
          const phaseEntries = flowGrouped[phase.id] || [];
          const count = phaseCounts[phase.id] || 0;
          const isCollapsed = collapsedPhases.has(phase.id);
          const isLast = idx === flowDef.phases.length - 1;
          const icon = PHASE_ICON_MAP[phase.id] || phase.icon || 'circle';

          // Compute phase health
          let failCount = 0;
          for (const item of phaseEntries) {
            const primaryStat = getEffStat(effMap, platform, item.category, item.name, 'primary');
            if (primaryStat && primaryStat.totalAttempts >= 3 && primaryStat.successRate < 0.5) failCount++;
          }

          return (
            <div key={phase.id} className="relative">
              {/* Connector line */}
              {!isLast && (
                <div className="absolute left-6 top-12 bottom-0 w-0.5 bg-outline-variant/40 z-0" />
              )}

              {/* Phase card */}
              <div className={cn(
                'relative z-10 bg-surface border rounded-2xl overflow-hidden transition-all',
                count > 0 ? 'border-outline-variant' : 'border-outline-variant/40 opacity-60',
                failCount > 0 && 'border-red-200',
              )}>
                {/* Phase header */}
                <button
                  onClick={() => togglePhase(phase.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-container-lowest transition-colors"
                >
                  {/* Phase icon with connector dot */}
                  <div className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
                    count > 0 ? 'bg-primary/10' : 'bg-surface-container',
                  )}>
                    <MaterialIcon icon={icon as any} size="sm" className={count > 0 ? 'text-primary' : 'text-on-surface-variant'} />
                  </div>

                  <div className="flex-1 text-left min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-label-md font-bold text-on-surface">{phase.label}</span>
                      {count > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-bold">
                          {count}
                        </span>
                      )}
                      {failCount > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">
                          {failCount} 失效
                        </span>
                      )}
                    </div>
                    <p className="text-body-xs text-on-surface-variant mt-0.5">{phase.description}</p>
                  </div>

                  <MaterialIcon
                    icon={isCollapsed ? 'expand_more' : 'expand_less'}
                    size="sm"
                    className="text-on-surface-variant flex-shrink-0"
                  />
                </button>

                {/* Phase entries */}
                {!isCollapsed && phaseEntries.length > 0 && (
                  <div className="border-t border-outline-variant/40 px-4 py-2 space-y-1">
                    {phaseEntries.map((item) => {
                      const primaryStat = getEffStat(effMap, platform, item.category, item.name, 'primary');
                      const dotColor = statusDotColor(primaryStat);
                      const allGood = !primaryStat || primaryStat.successRate >= 0.9 || primaryStat.totalAttempts < 3;

                      return (
                        <button
                          key={`${item.category}:${item.name}`}
                          onClick={() => onEdit({ platform, category: item.category, name: item.name, entry: { ...item.entry } })}
                          className={cn(
                            'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-colors',
                            'hover:bg-surface-container-lowest',
                            !allGood && 'bg-red-50/50',
                          )}
                        >
                          {/* Effectiveness dot */}
                          <span className={cn('w-2 h-2 rounded-full flex-shrink-0', dotColor)} />

                          {/* Category badge */}
                          <span className={cn(
                            'text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0',
                            item.category === 'menus' ? 'bg-blue-100 text-blue-700' :
                            item.category === 'buttons' ? 'bg-purple-100 text-purple-700' :
                            item.category === 'regions' ? 'bg-teal-100 text-teal-700' :
                            'bg-orange-100 text-orange-700',
                          )}>
                            {CATEGORY_LABELS[item.category]}
                          </span>

                          {/* Name */}
                          <span className="text-label-sm font-mono text-on-surface flex-1 truncate">{item.name}</span>

                          {/* Purposes */}
                          {item.entry.purposes.map((p) => (
                            <span key={p} className={cn(
                              'text-[8px] px-1 py-px rounded-full font-medium flex-shrink-0',
                              p === 'publish' ? 'bg-sky-100 text-sky-600' : 'bg-violet-100 text-violet-600',
                            )}>
                              {p === 'publish' ? '发布' : '监控'}
                            </span>
                          ))}

                          {/* Effectiveness stat badge */}
                          {primaryStat && primaryStat.totalAttempts > 0 && (
                            <span className={cn(
                              'text-[9px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0',
                              primaryStat.successRate >= 0.9 ? 'bg-emerald-100 text-emerald-600' :
                              primaryStat.successRate >= 0.5 ? 'bg-amber-100 text-amber-600' :
                              'bg-red-100 text-red-600',
                            )}>
                              {(primaryStat.successRate * 100).toFixed(0)}%
                            </span>
                          )}

                          <MaterialIcon icon="edit" size="xs" className="text-on-surface-variant/50 flex-shrink-0" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Uncategorized */}
      {uncategorized.length > 0 && (
        <div className="mt-5 bg-surface border border-outline-variant/60 rounded-2xl overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-outline-variant/40">
            <MaterialIcon icon="apps" size="sm" className="text-on-surface-variant" />
            <span className="text-label-md font-bold text-on-surface">未分类</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-outline-variant/40 text-on-surface-variant font-bold">
              {uncategorized.length}
            </span>
          </div>
          <div className="px-4 py-2 space-y-1">
            {uncategorized.map((item) => (
              <button
                key={`${item.category}:${item.name}`}
                onClick={() => onEdit({ platform, category: item.category, name: item.name, entry: { ...item.entry } })}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left hover:bg-surface-container-lowest transition-colors"
              >
                <span className={cn(
                  'text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0',
                  item.category === 'menus' ? 'bg-blue-100 text-blue-700' :
                  item.category === 'buttons' ? 'bg-purple-100 text-purple-700' :
                  item.category === 'regions' ? 'bg-teal-100 text-teal-700' :
                  'bg-orange-100 text-orange-700',
                )}>
                  {CATEGORY_LABELS[item.category]}
                </span>
                <span className="text-label-sm font-mono text-on-surface flex-1 truncate">{item.name}</span>
                <MaterialIcon icon="edit" size="xs" className="text-on-surface-variant/50 flex-shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
