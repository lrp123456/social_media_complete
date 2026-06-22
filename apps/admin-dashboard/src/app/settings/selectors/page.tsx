'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import type { MaterialIconName } from '@/components/ui/MaterialIcon';
import {
  useSelectorConfig,
  useSelectorEffectiveness,
  useUpsertSelector,
  useDeleteSelector,
} from '@/hooks/useApi';
import type { SelectorEntry, SelectorEffectivenessStats } from '@/hooks/useApi';
import { FlowGraphView } from '../components/FlowGraphView';

// ─── 常量 ───

const PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'tencent'] as const;
const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', tencent: '视频号',
};

const FLOW_TABS = [
  { id: 'monitor', label: '监控流程', icon: 'visibility' },
  { id: 'publish', label: '发布流程', icon: 'send' },
  { id: 'reply', label: '评论回复', icon: 'reply' },
];

export default function SelectorConfigPage() {
  const [activePlatform, setActivePlatform] = useState('douyin');
  const [activeFlow, setActiveFlow] = useState('monitor');

  const { data: configData } = useSelectorConfig();
  const { data: effectiveness } = useSelectorEffectiveness();
  const upsert = useUpsertSelector();
  const remove = useDeleteSelector();

  // 计算选择器总数（用于平台标签 badge）
  const selectorCounts = useMemo(() => {
    if (!configData?.platforms) return {} as Record<string, number>;
    const counts: Record<string, number> = {};
    for (const [plat, data] of Object.entries(configData.platforms)) {
      const p = data as any;
      counts[plat] = Object.values(p || {}).reduce((acc: number, cat: any) => {
        if (cat && typeof cat === 'object' && !Array.isArray(cat)) {
          return acc + Object.keys(cat).length;
        }
        return acc;
      }, 0);
    }
    return counts;
  }, [configData]);

  return (
    <div className="h-full flex flex-col">
      {/* 平台标签栏 */}
      <div className="flex items-center gap-1 px-4 pt-4 pb-2 border-b">
        {PLATFORMS.map((p) => (
          <button
            key={p}
            onClick={() => setActivePlatform(p)}
            className={cn(
              'px-3 py-1.5 text-sm rounded-t transition-colors',
              activePlatform === p
                ? 'bg-white border border-b-white text-blue-600 font-medium -mb-px'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50',
            )}
          >
            {PLATFORM_LABELS[p]}
            {selectorCounts[p] > 0 && (
              <span className="ml-1 text-xs text-gray-400">({selectorCounts[p]})</span>
            )}
          </button>
        ))}
      </div>

      {/* 工作流标签栏 */}
      <div className="flex items-center gap-1 px-4 py-2 border-b bg-gray-50">
        {FLOW_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveFlow(tab.id)}
            className={cn(
              'flex items-center gap-1 px-3 py-1 text-sm rounded transition-colors',
              activeFlow === tab.id
                ? 'bg-blue-100 text-blue-700 font-medium'
                : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100',
            )}
          >
            <MaterialIcon icon={tab.icon as MaterialIconName} className="text-sm" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* 流程图主视图 */}
      <div className="flex-1 overflow-hidden">
        <FlowGraphView platform={activePlatform} flowName={activeFlow} />
      </div>
    </div>
  );
}
