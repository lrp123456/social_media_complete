'use client';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import type { MaterialIconName } from '@/components/ui/MaterialIcon';
import { FlowGraphView } from '../components/FlowGraphView';
import DynamicSelectorPanel from '../components/DynamicSelectorPanel';
import FlowRulesPanel from '../components/FlowRulesPanel';
import BrowserWarmupPanel from '../components/BrowserWarmupPanel';
import CrawlModePanel from '../components/CrawlModePanel';
// import MonitorSchedulePanel from '../components/MonitorSchedulePanel';  // 任务 8 取消注释
// import AiReplyConfigPanel from '../components/AiReplyConfigPanel';      // 任务 8 取消注释

const PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'tencent'] as const;
const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', tencent: '视频号',
};
const FLOW_TABS = [
  { id: 'monitor', label: '监控流程', icon: 'visibility' as MaterialIconName },
  { id: 'publish', label: '发布流程', icon: 'send' as MaterialIconName },
  { id: 'reply', label: '评论回复', icon: 'reply' as MaterialIconName },
];

export default function MatrixTab() {
  const [activePlatform, setActivePlatform] = useState('douyin');
  const [activeFlow, setActiveFlow] = useState('monitor');

  return (
    <div className="space-y-6 p-6">
      {/* Platform + Flow tabs for FlowGraphView */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-outline-variant">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              onClick={() => setActivePlatform(p)}
              className={cn(
                'px-3 py-1.5 text-sm rounded-t transition-colors',
                activePlatform === p
                  ? 'bg-surface border border-b-surface text-primary font-medium -mb-px'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container',
              )}
            >
              {PLATFORM_LABELS[p]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 px-4 py-2 bg-surface-container/30 border-b border-outline-variant">
          {FLOW_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveFlow(tab.id)}
              className={cn(
                'flex items-center gap-1 px-3 py-1 text-sm rounded transition-colors',
                activeFlow === tab.id
                  ? 'bg-primary-container text-on-primary-container font-medium'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container',
              )}
            >
              <MaterialIcon icon={tab.icon} size="sm" />
              {tab.label}
            </button>
          ))}
        </div>
        <div className="p-4">
          <FlowGraphView platform={activePlatform} flowName={activeFlow} />
        </div>
      </div>

      <DynamicSelectorPanel />
      <FlowRulesPanel />
      <BrowserWarmupPanel />
      <CrawlModePanel />
      {/* <MonitorSchedulePanel /> */}
      {/* <AiReplyConfigPanel /> */}
    </div>
  );
}
