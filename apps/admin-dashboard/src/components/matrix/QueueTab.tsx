'use client';

import { useState, useMemo } from 'react';
import {
  useActiveQueueTasks,
  useQueueHistory,
  useCancelMonitorTask,
  useCancelAllMonitorTasks,
  useClearQueueHistory,
  useDebugMode,
  useUpdateDebugMode,
} from '../../hooks/useApi';
import {
  TASK_TYPE_CONFIG,
  type QueueTask,
  type ExecutionHistoryItem,
} from '../../types/queue';
import ExecutionDetail from './ExecutionDetail';
import { StatusPill, ToggleSwitch } from '../ui/StatusPill';

export default function QueueTab() {
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTaskType, setHistoryTaskType] = useState<string>('');
  const [historyStatus, setHistoryStatus] = useState<string>('');
  const [historyWindowId, setHistoryWindowId] = useState<string>('');

  const { data: activeData } = useActiveQueueTasks();
  const { data: historyData } = useQueueHistory({
    page: historyPage,
    limit: 20,
    taskType: historyTaskType || undefined,
    status: historyStatus || undefined,
    windowId: historyWindowId || undefined,
  });

  const cancelTask = useCancelMonitorTask();
  const cancelAllTasks = useCancelAllMonitorTasks();
  const clearHistory = useClearQueueHistory();
  const { data: debugModeData } = useDebugMode();
  const updateDebugMode = useUpdateDebugMode();
  const isDebugMode = debugModeData?.enabled ?? false;

  const activeTasks = activeData?.tasks || [];
  const historyItems = historyData?.items || [];
  const totalHistory = historyData?.total || 0;
  const totalPages = Math.ceil(totalHistory / 20);

  const statusCount = (status: string) =>
    activeTasks.filter(t => t.status === status).length;

  // 按窗口分组活跃任务
  const windowGroups = useMemo(() => {
    const map = new Map<string, { windowName: string; tasks: QueueTask[] }>();
    for (const task of activeTasks) {
      const wid = task.windowId || '_unknown';
      const wname = task.windowName || task.platform || '未知窗口';
      if (!map.has(wid)) {
        map.set(wid, { windowName: wname, tasks: [] });
      }
      map.get(wid)!.tasks.push(task);
    }
    return Array.from(map.entries());
  }, [activeTasks]);

  // 提取可用窗口列表（从历史记录中提取）
  const availableWindows = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of historyItems) {
      if (item.windowId) {
        map.set(item.windowId, item.windowName || item.windowId.slice(0, 12));
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [historyItems]);

  if (selectedExecutionId) {
    return (
      <ExecutionDetail
        executionId={selectedExecutionId}
        onBack={() => setSelectedExecutionId(null)}
      />
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 pb-12">
      {/* 统计卡 + Debug 开关 */}
      <div className="flex items-center gap-4 mb-6">
        <div className="grid grid-cols-4 gap-3 flex-1">
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
        {/* Debug 模式开关 */}
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-surface-container shrink-0">
          <span className="text-label-sm font-medium text-on-surface">调试模式</span>
          <ToggleSwitch
            checked={isDebugMode}
            onChange={(v) => updateDebugMode.mutate(v)}
            disabled={updateDebugMode.isPending}
            id="queue-debug-toggle"
          />
          <span className={`text-[10px] font-medium ${isDebugMode ? 'text-primary' : 'text-on-surface-variant'}`}>
            {isDebugMode ? '已开启' : '已关闭'}
          </span>
        </div>
      </div>

      {/* 活跃任务 — 按窗口分组 */}
      {windowGroups.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-title-md font-semibold">实时活跃</h2>
            <button
              onClick={async () => {
                if (!confirm('确定取消所有执行中的任务？')) return;
                try {
                  await cancelAllTasks.mutateAsync();
                } catch (e: any) {
                  alert(e?.response?.data?.error || e?.message || '取消失败');
                }
              }}
              disabled={cancelAllTasks.isPending}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors disabled:opacity-30"
            >
              {cancelAllTasks.isPending ? '取消中...' : '取消全部'}
            </button>
          </div>
          <div className="space-y-3">
            {windowGroups.map(([windowId, group]) => (
              <div key={windowId} className="border border-outline-variant rounded-xl overflow-hidden">
                {/* 窗口头 */}
                <div className="px-4 py-2.5 bg-surface-container-low border-b border-outline-variant/30 flex items-center gap-2">
                  <span className="text-label-sm font-semibold text-on-surface">{group.windowName}</span>
                  <span className="text-[10px] text-on-surface-variant ml-auto">
                    {group.tasks.length} 任务 · {group.tasks.filter(t => t.status === 'running').length} 执行中
                  </span>
                </div>
                {/* 该窗口的任务列表 */}
                <div className="divide-y divide-outline-variant/30">
                  {group.tasks.map((task: QueueTask) => {
                    const config = TASK_TYPE_CONFIG[task.taskType];
                    const percent = task.progress?.percent ?? 0;
                    const phaseName = task.progress?.phase || '';
                    return (
                      <div
                        key={task.taskId}
                        className="px-4 py-3 cursor-pointer hover:bg-surface-container-high transition-colors"
                        onClick={() => task.executionId && setSelectedExecutionId(task.executionId)}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span
                              className="text-label-sm font-semibold px-2 py-0.5 rounded text-white"
                              style={{ backgroundColor: config?.color || '#94a3b8' }}
                            >
                              {config?.label || task.taskType}
                            </span>
                            <span className="text-label-md text-on-surface-variant">{task.platform}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-label-sm text-on-surface-variant">
                              {task.status === 'running' ? '▶ 执行中' : '⏳ 排队中'}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!confirm(`确定取消此${task.status === 'running' ? '运行中' : '等待中'}的任务？`)) return;
                                cancelTask.mutate(task.taskId);
                              }}
                              disabled={cancelTask.isPending}
                              className="px-2 py-1 rounded text-[10px] font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors disabled:opacity-30"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                        {percent > 0 && (
                          <div className="mt-1.5">
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
            ))}
          </div>
        </div>
      )}

      {/* 历史记录 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-title-md font-semibold">历史记录</h2>
          <div className="flex items-center gap-2">
            {/* 窗口筛选 */}
            <select
              className="rounded-lg bg-surface-container px-3 py-1.5 text-label-sm"
              value={historyWindowId}
              onChange={e => { setHistoryWindowId(e.target.value); setHistoryPage(1); }}
            >
              <option value="">全部窗口</option>
              {availableWindows.map(w => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
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
            {/* 清空历史 */}
            <button
              onClick={async () => {
                if (!confirm('确定清空所有执行历史记录？此操作不可恢复。')) return;
                try {
                  await clearHistory.mutateAsync();
                } catch (e: any) {
                  alert(e?.response?.data?.error || e?.message || '清空失败');
                }
              }}
              disabled={clearHistory.isPending || totalHistory === 0}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors disabled:opacity-30"
            >
              {clearHistory.isPending ? '清空中...' : '清空历史'}
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          {historyItems.map((item: ExecutionHistoryItem) => {
            const config = TASK_TYPE_CONFIG[item.taskType as keyof typeof TASK_TYPE_CONFIG];
            const displayName = item.windowName || item.platform;
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
                  {displayName}
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
