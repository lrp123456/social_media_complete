'use client';

import { useState } from 'react';
import GeneralTab from './tabs/GeneralTab';
import CreationTab from './tabs/CreationTab';
import LlmTab from './tabs/LlmTab';
import MatrixTab from './tabs/MatrixTab';
import MaterialTab from './tabs/MaterialTab';

type TabKey = 'general' | 'creation' | 'llm' | 'matrix' | 'material';

function TabButton({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: string; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-5 py-2 rounded-lg text-label-md font-medium transition-all ${
        active ? 'bg-primary/10 text-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-high'
      }`}
    >
      <span className="material-symbols-rounded text-icon-sm">{icon}</span>
      {label}
    </button>
  );
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('general');

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-outline-variant px-6 pt-4 pb-2">
        <h1 className="text-headline-sm font-bold mb-3">系统设置中心</h1>
        <div className="inline-flex gap-1 p-1 rounded-xl bg-surface-container">
          <TabButton active={activeTab === 'general'} onClick={() => setActiveTab('general')} icon="settings" label="通用设置" />
          <TabButton active={activeTab === 'creation'} onClick={() => setActiveTab('creation')} icon="movie" label="智能创作" />
          <TabButton active={activeTab === 'llm'} onClick={() => setActiveTab('llm')} icon="smart_toy" label="大模型管理" />
          <TabButton active={activeTab === 'matrix'} onClick={() => setActiveTab('matrix')} icon="smartphone" label="社媒矩阵" />
          <TabButton active={activeTab === 'material'} onClick={() => setActiveTab('material')} icon="movie" label="素材更新" />
        </div>
      </div>
      {/* CSS display 切换 — 保持所有 Tab 挂载，避免表单状态丢失 */}
      <div className="flex-1 overflow-y-auto">
        <div style={{ display: activeTab === 'general' ? 'block' : 'none' }}><GeneralTab /></div>
        <div style={{ display: activeTab === 'creation' ? 'block' : 'none' }}><CreationTab /></div>
        <div style={{ display: activeTab === 'llm' ? 'block' : 'none' }}><LlmTab /></div>
        <div style={{ display: activeTab === 'matrix' ? 'block' : 'none' }}><MatrixTab /></div>
        <div style={{ display: activeTab === 'material' ? 'block' : 'none' }}><MaterialTab /></div>
      </div>
    </div>
  );
}
