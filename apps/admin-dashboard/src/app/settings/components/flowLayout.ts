// apps/admin-dashboard/src/app/settings/components/flowLayout.ts
import dagre from 'dagre';
import type { Node, Edge } from '@xyflow/react';

export type LayoutDirection = 'TB' | 'LR';

export interface LayoutOptions {
  direction?: LayoutDirection;
  nodeWidth?: number;
  nodeHeight?: number;
  rankSep?: number;
  nodeSep?: number;
}

/**
 * 使用 dagre 做自动布局
 */
export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  options: LayoutOptions = {}
): Node[] {
  const {
    direction = 'TB',
    nodeWidth = 200,
    nodeHeight = 80,
    rankSep = 50,
    nodeSep = 30,
  } = options;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, ranksep: rankSep, nodesep: nodeSep });

  for (const node of nodes) {
    g.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - nodeWidth / 2, y: pos.y - nodeHeight / 2 },
    };
  });
}
