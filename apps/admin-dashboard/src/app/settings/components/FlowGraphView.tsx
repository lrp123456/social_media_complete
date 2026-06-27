import { useState, useMemo, useCallback } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap,
  type Node, type Edge, type NodeTypes, type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useNavigationFlows, useFlowLastRun } from '@/hooks/useApi';
import { createFlowMachine, flowNodesToMachineConfig } from './flowStateMachine';
import { applyDagreLayout } from './flowLayout';
import FlowNodeCard from './FlowNodeCard';
import FlowEdge from './FlowEdge';
import { NodeDrawer } from './NodeDrawer';
import FrameworkManager from './FrameworkManager';
import { ApiPatternManager } from './ApiPatternManager';
import DataSourceManager from './DataSourceManager';
import type { FlowNode } from '@/hooks/useApi';

const nodeTypes: NodeTypes = { flowNode: FlowNodeCard };
const edgeTypes: EdgeTypes = { flowEdge: FlowEdge };

interface FlowGraphViewProps {
  platform: string;
  flowName: string;
}

export function FlowGraphView({ platform, flowName }: FlowGraphViewProps) {
  const { data: flowsData, isLoading } = useNavigationFlows(platform);
  const { data: lastRunData } = useFlowLastRun(platform, flowName);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<FlowNode | null>(null);
  const [showFramework, setShowFramework] = useState(false);
  const [showApiPattern, setShowApiPattern] = useState(false);
  const [showDataSource, setShowDataSource] = useState(false);

  const flow = flowsData?.navigationFlows?.[flowName];
  const steps = flow?.steps || [];

  const handleNodeClick = useCallback((step: FlowNode) => {
    console.log('[FlowGraphView] handleNodeClick called', { stepId: step.id, action: step.action });
    setSelectedNode(step);
    console.log('[FlowGraphView] selectedNode set');
  }, []);

  // 将 FlowNode[] 转换为 React Flow nodes/edges
  const { nodes, edges } = useMemo(() => {
    const rawNodes: Node[] = [];
    const rawEdges: Edge[] = [];

    for (const step of steps) {
      rawNodes.push({
        id: step.id,
        type: 'flowNode',
        position: { x: 0, y: 0 },
        data: {
          node: step,
          expanded: expandedNodes.has(step.id),
          onToggleExpand: (id: string) => {
            setExpandedNodes((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          },
          onNodeClick: handleNodeClick,
          lastRun: lastRunData?.steps?.find((s: any) => s.label === step.id),
        },
      });

      // 分支连线
      if (step.branches) {
        for (const branch of step.branches) {
          rawEdges.push({
            id: `${step.id}-${branch.condition}-${branch.target}`,
            source: step.id,
            target: branch.target,
            type: 'flowEdge',
            data: {
              label: branch.description,
              labelStyle: branch.condition.includes('ERROR') || branch.condition.includes('FAIL') ? 'error' : 'default',
            },
            animated: true,
          });
        }
      }

      // 默认连线
      if (step.next) {
        rawEdges.push({
          id: `${step.id}-next-${step.next}`,
          source: step.id,
          target: step.next,
          type: 'flowEdge',
          style: { strokeDasharray: '5,5' },
        });
      }
    }

    // dagre 自动布局
    const layouted = applyDagreLayout(rawNodes, rawEdges);
    return { nodes: layouted, edges: rawEdges };
  }, [steps, expandedNodes, lastRunData]);

  if (isLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 256, color: '#94a3b8' }}>加载中...</div>;
  }

  if (!flow) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 256, color: '#94a3b8' }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>📋</div>
        <div>暂无 &quot;{flowName}&quot; 流程配置</div>
        <div style={{ fontSize: 12, marginTop: 4 }}>请先在 selectors.json 中定义 navigationFlows</div>
      </div>
    );
  }

  return (
    <div style={{ height: 600, border: '1px solid #334155', borderRadius: 12, overflow: 'hidden', position: 'relative' }}>
      <div style={{ padding: '8px 12px', background: '#1e293b', borderBottom: '1px solid #334155', display: 'flex', gap: 8 }}>
        <button onClick={() => setShowFramework(true)} style={{ color: '#94a3b8', fontSize: 12 }}>框架管理</button>
        <button onClick={() => setShowApiPattern(true)} style={{ color: '#94a3b8', fontSize: 12 }}>API Pattern</button>
        <button onClick={() => setShowDataSource(true)} style={{ color: '#94a3b8', fontSize: 12 }}>DataSource</button>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#334155" gap={16} />
        <Controls />
        <MiniMap nodeColor="#1e293b" maskColor="rgba(0,0,0,0.5)" />
      </ReactFlow>

      {selectedNode && (
        <NodeDrawer
          node={selectedNode}
          steps={steps}
          platform={platform}
          flowName={flowName}
          onClose={() => setSelectedNode(null)}
        />
      )}
      {showFramework && <FrameworkManager platform={platform} onClose={() => setShowFramework(false)} />}
      {showApiPattern && <ApiPatternManager platform={platform} onClose={() => setShowApiPattern(false)} />}
      {showDataSource && <DataSourceManager platform={platform} onClose={() => setShowDataSource(false)} />}
    </div>
  );
}
