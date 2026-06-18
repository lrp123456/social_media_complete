'use client';

import { useState } from 'react';
import { useActiveQueueTasks, useQueueHistory } from '../../hooks/useApi';
import {
  TASK_TYPE_CONFIG,
  type QueueTask,
  type ExecutionHistoryItem,
} from '../../types/queue';
import ExecutionDetail from './ExecutionDetail';
import { StatusPill } from '../ui/StatusPill';

export default function QueueTab() {
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTaskType, setHistoryTaskType] = useState<string>('');
  const [historyStatus, setHistoryStatus] = useState<string>('');

  const { data: activeData } = useActiveQueueTasks();
  const { data: historyData } = useQueueHistory({
    page: historyPage,
    limit: 20,
    taskType: historyTaskType || undefined,
    status: historyStatus || undefined,
  });

  if (selectedExecutionId) {
    return (
      <ExecutionDetail
        executionId={selectedExecutionId}
        onBack={() => setSelectedExecutionId(null)}
      />
    );
  }

  const activeTasks = activeData?.tasks || [];
  const historyItems = historyData?.items || [];
  const totalHistory = historyData?.total || 0;
  const totalPages = Math.ceil(totalHistory / 20);

  const statusCount = (status: string) =>
    activeTasks.filter(t => t.status === status).length;

  return (
    <div className="max-w-6xl mx-auto px-4 pb-12">
      {/* 统计卡 */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: '执行中', value: statusCount('running'), color: '#f59e0b' },
          { label: '排队中', value: statusCount('queued'), color: '#64748b' },
          { label: '今日完成', value: activeData ? historyItems.filter(i => i.status === 'completed').length : 0, color: '#10b981' },
          { label: '失败', value: activeData ? historyItems.filter(i => i.status === 'failed').length : 0, color: '#ef4444' },
        ].map(stat => (
          <div key={stat.label} className="rounded-xl bg-surface-container p-4 text-center">
            <div className="text-title-lg font-bold" style={{ color: stat.color }}>{stat.value}</div>
            <div className="text-label-sm text-on-surface-variant">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* 活跃任务 */}
      {activeTasks.length > 0 && (
        <div className="mb-6">
          <h2 className="text-title-md font-semibold mb-3">实时活跃</h2>
          <div className="space-y-2">
            {activeTasks.map((task: QueueTask) => {
              const config = TASK_TYPE_CONFIG[task.taskType];
              const percent = task.progress?.percent ?? 0;
              const phaseName = task.progress?.phase || '';
              return (
                <div
                  key={task.taskId}
                  className="rounded-xl bg-surface-container p-4 border border-outline-variant cursor-pointer hover:bg-surface-container-high transition-colors"
                  style={{ borderLeft: `4px solid ${task.status === 'running' ? '#f59e0b' : '#64748b'}` }}
                  onClick={() => task.executionId && setSelectedExecutionId(task.executionId)}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-label-sm font-semibold px-2 py-0.5 rounded text-white"
                        style={{ backgroundColor: config?.color || '#94a3b8' }}
                      >
                        {config?.label || task.taskType}
                      </span>
                      <span className="text-label-md font-semibold">{task.platform}</span>
                    </div>
                    <span className="text-label-sm text-on-surface-variant">
                      {task.status === 'running' ? '▶ 执行中' : '⏳ 排队中'}
                    </span>
                  </div>
                  {percent > 0 && (
                    <div>
                      <div className="flex justify-between text-label-sm text-on-surface-variant mb-1">
                        <span>{phaseName}</span>
                        <span>{percent}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-surface-container-high overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${percent}%`, backgroundColor: config?.color || '#94a3b8' }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 历史记录 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-title-md font-semibold">历史记录</h2>
          <div className="flex gap-2">
            <select
              className="rounded-lg bg-surface-container px-3 py-1.5 text-label-sm"
              value={historyTaskType}
              onChange={e => { setHistoryTaskType(e.target.value); setHistoryPage(1); }}
            >
              <option value="">全部类型</option>
              <option value="reply">回复评论</option>
              <option value="monitor">视频监控</option>
              <option value="publish">视频发布</option>
            </select>
            <select
              className="rounded-lg bg-surface-container px-3 py-1.5 text-label-sm"
              value={historyStatus}
              onChange={e => { setHistoryStatus(e.target.value); setHistoryPage(1); }}
            >
              <option value="">全部状态</option>
              <option value="completed">成功</option>
              <option value="failed">失败</option>
              <option value="cancelled">已取消</option>
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          {historyItems.map((item: ExecutionHistoryItem) => {
            const config = TASK_TYPE_CONFIG[item.taskType as keyof typeof TASK_TYPE_CONFIG];
            return (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-xl bg-surface-container px-4 py-3 cursor-pointer hover:bg-surface-container-high transition-colors"
                onClick={() => setSelectedExecutionId(item.id)}
              >
                <span
                  className="text-label-sm font-semibold px-2 py-0.5 rounded text-white shrink-0"
                  style={{ backgroundColor: config?.color || '#94a3b8' }}
                >
                  {config?.label || item.taskType}
                </span>
                <span className="text-label-md flex-1">
                  {item.platform}{item.userId ? ` · 用户${item.userId}` : ''}
                </span>
                <span className="text-label-sm text-on-surface-variant">
                  {item.currentPhase || '-'}
                </span>
                <StatusPill
                  tone={item.status === 'completed' ? 'success' : item.status === 'failed' ? 'error' : 'warning'}
                >
                  {item.status === 'completed' ? '成功' : item.status === 'failed' ? '失败' : item.status === 'cancelled' ? '已取消' : item.status}
                </StatusPill>
                <span className="text-label-sm text-on-surface-variant">
                  {item.durationMs ? `${(item.durationMs / 1000).toFixed(0)}s` : '-'}
                </span>
              </div>
            );
          })}
          {historyItems.length === 0 && (
            <div className="text-center py-8 text-on-surface-variant">暂无历史记录</div>
          )}
        </div>

        {/* 分页 */}
        {totalPages > 1 && (
          <div className="flex justify-center gap-2 mt-4">
            <button
              className="px-3 py-1 rounded-lg bg-surface-container disabled:opacity-40"
              disabled={historyPage <= 1}
              onClick={() => setHistoryPage(p => p - 1)}
            >
              上一页
            </button>
            <span className="px-3 py-1 text-label-sm text-on-surface-variant">
              {historyPage} / {totalPages}
            </span>
            <button
              className="px-3 py-1 rounded-lg bg-surface-container disabled:opacity-40"
              disabled={historyPage >= totalPages}
              onClick={() => setHistoryPage(p => p + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
