'use client';

import { useExecutionDetail } from '../../hooks/useApi';
import { TASK_TYPE_CONFIG } from '../../types/queue';
import { StatusPill } from '../ui/StatusPill';

interface ExecutionDetailProps {
  executionId: string;
  onBack: () => void;
}

export default function ExecutionDetail({ executionId, onBack }: ExecutionDetailProps) {
  const { data, isLoading, error } = useExecutionDetail(executionId);

  if (isLoading) {
    return <div className="p-8 text-center text-on-surface-variant">加载中...</div>;
  }
  if (error || !data) {
    return (
      <div className="p-8 text-center">
        <p className="text-error mb-4">加载失败</p>
        <button onClick={onBack} className="text-primary underline">返回队列</button>
      </div>
    );
  }

  const config = TASK_TYPE_CONFIG[data.taskType as keyof typeof TASK_TYPE_CONFIG];
  const elapsed = data.durationMs ? `${(data.durationMs / 1000).toFixed(0)}s` : '-';

  return (
    <div className="max-w-4xl mx-auto px-4 pb-12">
      {/* 返回按钮 */}
      <button onClick={onBack} className="flex items-center gap-1 text-label-md text-primary mb-4 hover:underline">
        ← 返回队列
      </button>

      {/* 头部 */}
      <div className="rounded-xl bg-surface-container p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <span
              className="text-label-md font-semibold px-2.5 py-1 rounded text-white"
              style={{ backgroundColor: config?.color || '#94a3b8' }}
            >
              {config?.label || data.taskType}
            </span>
            <span className="text-title-md font-semibold">{data.platform}</span>
          </div>
          <StatusPill
            tone={data.status === 'completed' ? 'success' : data.status === 'failed' ? 'error' : 'warning'}
          >
            {data.status === 'completed' ? '成功' : data.status === 'failed' ? '失败' : data.status === 'cancelled' ? '已取消' : '执行中'}
          </StatusPill>
        </div>
        <div className="grid grid-cols-2 gap-4 text-label-sm">
          <div>
            <span className="text-on-surface-variant">执行 ID：</span>
            <span className="font-mono text-xs">{data.id}</span>
          </div>
          <div>
            <span className="text-on-surface-variant">任务 ID：</span>
            <span className="font-mono text-xs">{data.taskId}</span>
          </div>
          <div>
            <span className="text-on-surface-variant">开始时间：</span>
            {new Date(data.startedAt).toLocaleString('zh-CN')}
          </div>
          <div>
            <span className="text-on-surface-variant">耗时：</span>
            {elapsed}
          </div>
          {data.errorMessage && (
            <div className="col-span-2">
              <span className="text-on-surface-variant">错误信息：</span>
              <span className="text-error">{data.errorMessage}</span>
            </div>
          )}
        </div>
      </div>

      {/* 阶段时间线 */}
      {data.totalPhases && (
        <div className="rounded-xl bg-surface-container p-5 mb-6">
          <h3 className="text-label-md font-semibold mb-3">阶段时间线</h3>
          <div className="flex items-center gap-2 flex-wrap">
            {Array.from({ length: data.totalPhases! }, (_, i) => {
              const idx = i + 1;
              const isPast = idx < (data.phaseIndex || 0);
              const isCurrent = idx === (data.phaseIndex || 0);
              return (
                <div key={i} className="flex items-center gap-2">
                  <div
                    className={`px-2.5 py-1 rounded-full text-label-sm font-medium ${
                      isPast ? 'bg-primary/20 text-primary' :
                      isCurrent ? 'bg-primary text-on-primary' :
                      'bg-surface-container-high text-on-surface-variant'
                    }`}
                  >
                    {idx}
                  </div>
                  {idx < data.totalPhases! && <span className="text-outline-variant text-xs">→</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 详细步骤（仅 debug 模式） */}
      {data.isDebugMode ? (
        <div className="rounded-xl bg-surface-container p-5">
          <h3 className="text-label-md font-semibold mb-3">详细执行步骤</h3>
          {data.steps && data.steps.length > 0 ? (
            <div className="space-y-2">
              {data.steps.map((step: any) => (
                <div key={step.id} className="rounded-lg bg-surface-container-high p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-label-sm font-medium">{step.label}</span>
                      {step.status === 'success' && <span className="text-success text-xs">✓</span>}
                      {step.status === 'fallback' && <span className="text-warning text-xs">⚠ 降级</span>}
                      {step.status === 'failed' && <span className="text-error text-xs">✗</span>}
                    </div>
                    <span className="text-label-sm text-on-surface-variant">
                      {step.durationMs ? `${step.durationMs}ms` : ''}
                    </span>
                  </div>

                  {/* 选择器尝试链 */}
                  {step.selectorTries && step.selectorTries.length > 0 && (
                    <div className="mt-1.5 text-label-sm font-mono">
                      {step.selectorTries.map((st: any, i: number) => (
                        <div key={i} className="flex items-center gap-1">
                          <span className={st.hit ? 'text-success' : 'text-error line-through'}>
                            {st.isPrimary ? '主' : `备${i}`}
                          </span>
                          <span className={st.hit ? 'text-success' : 'text-error'}>{st.selector}</span>
                          <span>{st.hit ? '✓' : '✗'}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {step.mouseAction && (
                    <div className="mt-1 text-label-sm text-on-surface-variant">🖱 {step.mouseAction}</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-on-surface-variant text-label-sm">该任务执行过程中未记录步骤（无关键操作）</p>
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-surface-container p-5">
          <p className="text-on-surface-variant text-label-sm">
            该任务未在 debug 模式下执行，无详细步骤。开启调试模式后重新执行可查看选择器命中链路。
          </p>
        </div>
      )}
    </div>
  );
}
