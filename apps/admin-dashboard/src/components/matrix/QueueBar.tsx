'use client';

import { useActiveQueueTasks } from '../../hooks/useApi';
import { TASK_TYPE_CONFIG, type QueueTask } from '../../types/queue';

interface QueueBarProps {
  onClickViewAll: () => void;
}

export default function QueueBar({ onClickViewAll }: QueueBarProps) {
  const { data, isLoading } = useActiveQueueTasks();
  const tasks = data?.tasks || [];
  const total = data?.total || 0;

  if (isLoading || total === 0) return null;

  return (
    <div
      onClick={onClickViewAll}
      className="flex items-center gap-3 px-4 py-2 mx-4 mb-2 rounded-lg bg-surface-container-high hover:bg-surface-container-higher cursor-pointer transition-colors"
    >
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-lg">⚡</span>
        <span className="text-label-sm font-semibold text-on-surface">执行队列</span>
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-error text-[10px] font-bold text-on-error">
          {total}
        </span>
      </div>

      <div className="h-4 w-px bg-outline-variant" />

      <div className="flex items-center gap-2 flex-1 overflow-x-auto no-scrollbar">
        {tasks.map((task: QueueTask) => {
          const config = TASK_TYPE_CONFIG[task.taskType] ?? { label: task.taskType, color: '#94a3b8', icon: 'help' };
          const phaseName = task.progress?.phase || task.taskType;
          const percent = task.progress?.percent ?? 0;
          const displayName = task.windowName || task.platform;
          return (
            <div
              key={task.taskId}
              className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-container"
              style={{ borderLeft: `3px solid ${config.color}` }}
            >
              <span
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded text-white shrink-0"
                style={{ backgroundColor: config.color }}
              >
                {config.label}
              </span>
              <span className="text-xs text-on-surface-variant whitespace-nowrap">
                {displayName} · {phaseName} · {percent}%
              </span>
            </div>
          );
        })}
      </div>

      <span className="text-label-sm text-primary shrink-0">查看全部 →</span>
    </div>
  );
}
