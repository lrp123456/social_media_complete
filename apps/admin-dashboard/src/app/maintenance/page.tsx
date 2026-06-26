'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import ExecutionHealthTab from './ExecutionHealthTab';
import SelectorHealthTab from './SelectorHealthTab';
import ConfigSnapshotTab from './ConfigSnapshotTab';

type TabKey = 'execution-health' | 'selector-health' | 'config-snapshots';

const TABS: { key: TabKey; icon: string; label: string }[] = [
  { key: 'execution-health', icon: 'monitoring', label: '执行健康' },
  { key: 'selector-health', icon: 'bug_report', label: '选择器健康' },
  { key: 'config-snapshots', icon: 'history', label: '配置管理' },
];

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-5 py-2 rounded-lg text-label-md font-medium transition-all ${
        active
          ? 'bg-primary/10 text-primary shadow-sm'
          : 'text-on-surface-variant hover:bg-surface-container-high'
      }`}
    >
      <span className="material-symbols-rounded text-icon-sm">{icon}</span>
      {label}
    </button>
  );
}

export default function MaintenancePage() {
  const [activeTab, setActiveTab] = useState<TabKey>('execution-health');

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-outline-variant px-6 pt-4 pb-2">
        <div className="flex items-center gap-2 mb-3">
          <MaterialIcon icon="construction" size="xl" className="text-on-surface-variant" />
          <h1 className="text-headline-sm font-bold">维护调试</h1>
        </div>
        <div className="inline-flex gap-1 p-1 rounded-xl bg-surface-container">
          {TABS.map((tab) => (
            <TabButton
              key={tab.key}
              active={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
              icon={tab.icon}
              label={tab.label}
            />
          ))}
        </div>
      </div>

      {/* Tab content — CSS display switching to preserve state */}
      <div className="flex-1 overflow-y-auto">
        <div style={{ display: activeTab === 'execution-health' ? 'block' : 'none' }}>
          <ExecutionHealthTab />
        </div>
        <div style={{ display: activeTab === 'selector-health' ? 'block' : 'none' }}>
          <SelectorHealthTab />
        </div>
        <div style={{ display: activeTab === 'config-snapshots' ? 'block' : 'none' }}>
          <ConfigSnapshotTab />
        </div>
      </div>
    </div>
  );
}
