// apps/admin-dashboard/src/app/settings/components/FlowEdge.tsx
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

type FlowEdgeData = {
  label?: string;
  labelStyle?: 'error' | 'default';
};

export default function FlowEdge(props: EdgeProps) {
  const {
    id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
    style, markerEnd,
  } = props;
  const data = props.data as FlowEdgeData | undefined;

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {data?.label && (
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            fontSize: 11,
            padding: '2px 6px',
            borderRadius: 4,
            background: data.labelStyle === 'error' ? '#7f1d1d' : '#1e293b',
            border: `1px solid ${data.labelStyle === 'error' ? '#ef4444' : '#334155'}`,
            color: data.labelStyle === 'error' ? '#fca5a5' : '#94a3b8',
            whiteSpace: 'nowrap',
          }}
        >
          {data.label}
        </div>
      )}
    </>
  );
}
