'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { FlowNodeCard } from './FlowNodeCard';
import { NodeDrawer } from './NodeDrawer';
import FrameworkManager from './FrameworkManager';
import { ApiPatternManager } from './ApiPatternManager';
import DataSourceManager from './DataSourceManager';
import { useNavigationFlows, useFlowLastRun } from '@/hooks/useApi';
import type { FlowNode, LastRunStep } from '@/hooks/useApi';

export function FlowGraphView({
  platform,
  flowName,
}: {
  platform: string;
  flowName: string;
}) {
  const { data: flowData, isLoading } = useNavigationFlows(platform);
  const { data: lastRunData } = useFlowLastRun(platform, flowName);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showFrameworks, setShowFrameworks] = useState(false);
  const [showApiPatterns, setShowApiPatterns] = useState(false);
  const [showDataSources, setShowDataSources] = useState(false);

  const flows = flowData?.navigationFlows || {};
  const flow = flows[flowName];
  const steps: FlowNode[] = flow?.steps || [];
  const lastRunSteps: LastRunStep[] = lastRunData?.steps || [];

  const selectedNode = steps.find((s) => s.id === selectedNodeId) || null;

  const getLastRun = (nodeId: string): LastRunStep | undefined => {
    return lastRunSteps.find((s) => s.label === nodeId);
  };

  if (isLoading) {
    return <div className="flex items-center justify-center h-64 text-gray-400">加载中...</div>;
  }

  if (!flow) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-gray-400">
        <MaterialIcon icon="account_tree" className="text-4xl mb-2" />
        <div>暂无 "{flowName}" 流程配置</div>
        <div className="text-sm mt-1">请先在 selectors.json 中定义 navigationFlows</div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* 左侧：流程图 */}
      <div className="flex-1 overflow-auto p-6">
        {/* 工具栏 */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm font-medium text-gray-700">{flow.label || flowName}</span>
          <span className="text-xs text-gray-400">({steps.length} 步骤)</span>
          <div className="ml-auto flex gap-2">
            <button onClick={() => setShowFrameworks(true)} className="px-3 py-1 border rounded text-xs hover:bg-gray-50">
              <MaterialIcon icon="select_all" className="text-xs inline" /> 框架管理
            </button>
            <button onClick={() => setShowApiPatterns(true)} className="px-3 py-1 border rounded text-xs hover:bg-gray-50">
              <MaterialIcon icon="api" className="text-xs inline" /> API Pattern
            </button>
            <button onClick={() => setShowDataSources(true)} className="px-3 py-1 border rounded text-xs hover:bg-gray-50">
              <MaterialIcon icon="storage" className="text-xs inline" /> DataSource
            </button>
          </div>
        </div>

        {/* 节点列表 + 连线 */}
        <div className="space-y-0">
          {steps.map((node, index) => (
            <div key={node.id}>
              {/* 连线 */}
              {index > 0 && (
                <div className="flex items-center justify-start ml-6 h-6">
                  <div className="w-0.5 h-full bg-gray-300" />
                </div>
              )}

              {/* 节点卡片 */}
              <div className="max-w-md">
                <FlowNodeCard
                  node={node}
                  lastRun={getLastRun(node.id)}
                  selected={selectedNodeId === node.id}
                  onClick={() => setSelectedNodeId(selectedNodeId === node.id ? null : node.id)}
                />
              </div>

              {/* 分支连线 */}
              {node.branches && (
                <div className="ml-8 mt-1 space-y-1">
                  {Object.entries(node.branches).map(([condition, target]) => (
                    <div key={condition} className="flex items-center gap-2">
                      <div className="w-4 h-0.5 bg-gray-300" />
                      <span className="text-xs text-gray-400 px-2 py-0.5 bg-gray-100 rounded">
                        {condition}
                      </span>
                      <span className="text-xs text-blue-500 font-mono">→ {target.goto}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 右侧：抽屉 */}
      {selectedNode && (
        <NodeDrawer
          node={selectedNode}
          platform={platform}
          flowName={flowName}
          onClose={() => setSelectedNodeId(null)}
        />
      )}

      {/* 弹窗 */}
      {showFrameworks && <FrameworkManager platform={platform} onClose={() => setShowFrameworks(false)} />}
      {showApiPatterns && <ApiPatternManager platform={platform} onClose={() => setShowApiPatterns(false)} />}
      {showDataSources && <DataSourceManager platform={platform} onClose={() => setShowDataSources(false)} />}
    </div>
  );
}
