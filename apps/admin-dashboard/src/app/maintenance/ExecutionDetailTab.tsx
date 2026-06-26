'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { StatusPill } from '@/components/ui/StatusPill';
import { BentoCard, SectionCard } from '@/components/ui/Bento';
import { cn } from '@/lib/utils';
import { useMaintenanceExecutionDetail, useMaintenanceSteps, useRetryStep } from '@/hooks/useApi';
import { HealthBadge, StepHealthBadge, SelectorResultBadge, FlowLabel, relativeTime } from './components';

export default function ExecutionDetailTab({
  executionId,
  onBack,
}: {
  executionId: string;
  onBack: () => void;
}) {
  const { data: detail, isLoading: detailLoading } = useMaintenanceExecutionDetail(executionId);
  const { data: stepsData, isLoading: stepsLoading } = useMaintenanceSteps(executionId);
  const retryStep = useRetryStep();
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);
  const [retryingStep, setRetryingStep] = useState<string | null>(null);

  const isLoading = detailLoading || stepsLoading;

  const steps = Array.isArray(stepsData) ? stepsData : stepsData?.steps ?? [];

  // Group steps by phase
  const phasesMap = new Map<string, any[]>();
  for (const step of steps) {
    const phase = step.phase || 'default';
    if (!phasesMap.has(phase)) phasesMap.set(phase, []);
    phasesMap.get(phase)!.push(step);
  }
  const phases = Array.from(phasesMap.entries());

  const handleRetry = async (stepId: string) => {
    setRetryingStep(stepId);
    try {
      await retryStep.mutateAsync({ executionId, stepId });
    } finally {
      setRetryingStep(null);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={onBack} className="btn-icon">
            <MaterialIcon icon="arrow_back" size="lg" />
          </button>
          <div className="h-5 w-48 rounded bg-on-surface-variant/10 animate-pulse" />
        </div>
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 rounded bg-on-surface-variant/10 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Back button */}
      <button onClick={onBack} className="btn-ghost mb-4">
        <MaterialIcon icon="arrow_back" size="sm" />
        返回执行列表
      </button>

      {/* Execution summary card */}
      <BentoCard className="mb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <span className="text-label-md text-label-md text-on-surface-variant block mb-1">平台</span>
            <span className="font-mono text-body-md">{detail?.platform || '-'}</span>
          </div>
          <div>
            <span className="text-label-md text-label-md text-on-surface-variant block mb-1">流程类型</span>
            {detail?.flowType ? <FlowLabel flowType={detail.flowType} /> : '-'}
          </div>
          <div>
            <span className="text-label-md text-label-md text-on-surface-variant block mb-1">窗口</span>
            <span className="font-mono text-body-sm">{detail?.windowId || '-'}</span>
          </div>
          <div>
            <span className="text-label-md text-label-md text-on-surface-variant block mb-1">健康状态</span>
            {detail?.overallHealth ? <HealthBadge health={detail.overallHealth} /> : '-'}
          </div>
          <div>
            <span className="text-label-md text-label-md text-on-surface-variant block mb-1">步骤</span>
            <span className="text-body-md">
              {detail?.healthySteps ?? 0}/{detail?.totalSteps ?? 0}
              {detail && detail.totalSteps > 0 && (
                <span className="text-on-surface-variant text-body-sm ml-1">
                  ({detail.degradedSteps > 0 ? `降级 ${detail.degradedSteps}, ` : ''}失败 {detail.failedSteps})
                </span>
              )}
            </span>
          </div>
          <div>
            <span className="text-label-md text-label-md text-on-surface-variant block mb-1">选择器</span>
            <SelectorResultBadge passed={detail?.passedSelectors ?? 0} total={detail?.totalSelectors ?? 0} />
          </div>
          <div>
            <span className="text-label-md text-label-md text-on-surface-variant block mb-1">URL 检测</span>
            <SelectorResultBadge passed={detail?.passedUrlChecks ?? 0} total={detail?.totalUrlChecks ?? 0} />
          </div>
          <div>
            <span className="text-label-md text-label-md text-on-surface-variant block mb-1">执行时间</span>
            <span className="text-body-sm text-on-surface-variant">
              {detail?.startedAt ? relativeTime(detail.startedAt) : '-'}
            </span>
          </div>
        </div>
      </BentoCard>

      {/* Steps tree grouped by phase */}
      {phases.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant">
          <MaterialIcon icon="history" size="2xl" className="opacity-30 mb-2" />
          <p className="font-body text-body-sm">暂无步骤记录</p>
        </div>
      ) : (
        <div className="space-y-3">
          {phases.map(([phase, phaseSteps]) => {
            const isExpanded = expandedPhase === phase;
            const phaseHealth = phaseSteps.every((s: any) => s.status === 'passed')
              ? 'healthy'
              : phaseSteps.some((s: any) => s.status === 'failed')
                ? 'failed'
                : 'degraded';

            return (
              <SectionCard key={phase} noPadding>
                {/* Phase header */}
                <button
                  onClick={() => setExpandedPhase(isExpanded ? null : phase)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-container-low transition-colors text-left"
                >
                  <MaterialIcon
                    icon={isExpanded ? 'expand_less' : 'expand_more'}
                    size="md"
                    className="text-on-surface-variant"
                  />
                  <span className="flex-1 text-label-md text-label-md font-semibold text-on-surface">
                    {phase}
                  </span>
                  <HealthBadge health={phaseHealth as any} />
                  <span className="text-body-sm text-on-surface-variant">
                    {phaseSteps.filter((s: any) => s.status === 'passed').length}/{phaseSteps.length}
                  </span>
                </button>

                {/* Step list */}
                {isExpanded && (
                  <div className="border-t border-outline-variant">
                    {phaseSteps.map((step: any, idx: number) => (
                      <div key={step.id || idx}>
                        <div className="flex items-start gap-3 px-4 py-3 hover:bg-surface-container-low/50">
                          <div className="w-6 h-6 rounded-full bg-surface-container flex items-center justify-center shrink-0 mt-0.5">
                            <span className="text-label-sm text-label-sm text-on-surface-variant">{idx + 1}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-body-md font-medium text-on-surface">
                                {step.label || step.action || step.name || `步骤 ${idx + 1}`}
                              </span>
                              <StepHealthBadge status={step.status} />
                            </div>
                            {step.description && (
                              <p className="text-body-sm text-on-surface-variant mt-0.5">{step.description}</p>
                            )}
                            {step.error && (
                              <p className="text-body-sm text-error mt-1">{step.error}</p>
                            )}
                            {step.durationMs != null && (
                              <p className="text-label-sm text-label-sm text-on-surface-variant mt-0.5">
                                耗时: {(step.durationMs / 1000).toFixed(1)}s
                              </p>
                            )}

                            {/* Nested selector/URL results */}
                            {(step.selectors?.length > 0 || step.urlChecks?.length > 0) && (
                              <div className="mt-2 space-y-1 pl-2 border-l-2 border-outline-variant/50">
                                {step.selectors?.map((sel: any, si: number) => (
                                  <div key={si} className="flex items-center gap-2 text-body-sm">
                                    <MaterialIcon
                                      icon={sel.passed ? 'check_circle' : 'error'}
                                      size="xs"
                                      className={sel.passed ? 'text-emerald-500' : 'text-error'}
                                    />
                                    <span className="font-mono text-on-surface-variant">{sel.key || sel.name}</span>
                                    {sel.durationMs != null && (
                                      <span className="text-label-sm text-label-sm text-on-surface-variant">
                                        ({(sel.durationMs / 1000).toFixed(1)}s)
                                      </span>
                                    )}
                                  </div>
                                ))}
                                {step.urlChecks?.map((url: any, ui: number) => (
                                  <div key={ui} className="flex items-center gap-2 text-body-sm">
                                    <MaterialIcon
                                      icon={url.passed ? 'check_circle' : 'error'}
                                      size="xs"
                                      className={url.passed ? 'text-emerald-500' : 'text-error'}
                                    />
                                    <span className="text-on-surface-variant truncate max-w-xs">{url.url}</span>
                                    {url.statusCode && (
                                      <StatusPill tone={url.statusCode < 400 ? 'success' : 'error'}>
                                        {url.statusCode}
                                      </StatusPill>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          {/* Retry button */}
                          <button
                            onClick={() => handleRetry(step.id)}
                            disabled={retryingStep === step.id}
                            className="btn-ghost shrink-0"
                            title="重试此步骤"
                          >
                            <MaterialIcon
                              icon="refresh"
                              size="sm"
                              className={retryingStep === step.id ? 'animate-spin-slow' : ''}
                            />
                            <span className="text-label-sm text-label-sm">重试</span>
                          </button>
                        </div>
                        {idx < phaseSteps.length - 1 && (
                          <div className="border-b border-outline-variant/30 mx-4" />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
