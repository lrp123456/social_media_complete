'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { StatusPill } from '@/components/ui/StatusPill';
import { useFlowRules, useUpdateFlowRules, useResetFlowRules } from '@/hooks/useApi';

export default function FlowRulesPanel() {
  const flowRulesQuery = useFlowRules();
  const updateFlowRules = useUpdateFlowRules();
  const resetFlowRules = useResetFlowRules();
  const [flowRulesEdit, setFlowRulesEdit] = useState<Record<string, { json: string; isEditing: boolean }>>({});

  return (
    <div className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl">
      <div className="px-6 pt-6 pb-0">
        <h3 className="text-headline-md text-on-surface">发布流程控制规则</h3>
        <p className="font-body text-body-sm text-on-surface-variant mt-0.5">
          按钮搜索范围、disabled/可见性检测方式、URL 成功/导航模式、重试参数。所有规则来自
          <code className="mx-1 px-1.5 py-0.5 rounded bg-surface-container text-[12px]">data/selectors.json</code>
          的 <code className="mx-1 px-1.5 py-0.5 rounded bg-surface-container text-[12px]">flowRules</code> 字段。
        </p>
      </div>
      <div className="p-6">
        {flowRulesQuery.isLoading && (
          <div className="text-on-surface-variant text-sm">加载中…</div>
        )}
        {flowRulesQuery.data && Object.keys(flowRulesQuery.data).length === 0 && (
          <div className="text-on-surface-variant text-sm">暂无流程规则配置</div>
        )}
        <div className="space-y-4">
          {flowRulesQuery.data && Object.entries(flowRulesQuery.data).map(([plat, info]: [string, any]) => {
            const fr = info?.flowRules || {};
            const ruleCount = Object.keys(fr).length;
            const editing = flowRulesEdit[plat]?.isEditing ?? false;
            const draftJson = flowRulesEdit[plat]?.json ?? JSON.stringify(fr, null, 2);
            return (
              <div key={plat} className="border border-outline-variant rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 bg-surface-container/50">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{plat}</span>
                    <StatusPill tone={ruleCount > 0 ? 'primary' : 'warning'} dot>
                      {ruleCount > 0 ? `${ruleCount} 项规则` : '未配置 (使用代码兜底)'}
                    </StatusPill>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-on-surface-variant">
                      {info?.updatedAt ? `updated: ${new Date(info.updatedAt).toLocaleString('zh-CN')}` : '—'}
                    </span>
                    {editing ? (
                      <>
                        <button
                          onClick={async () => {
                            try {
                              const parsed = JSON.parse(flowRulesEdit[plat]?.json || '{}');
                              await updateFlowRules.mutateAsync({ platform: plat, flowRules: parsed });
                              setFlowRulesEdit((prev) => ({ ...prev, [plat]: { json: '', isEditing: false } }));
                            } catch (e: any) {
                              alert(`JSON 解析失败: ${e.message}`);
                            }
                          }}
                          disabled={updateFlowRules.isPending}
                          className="btn-primary text-xs px-2.5 py-1 flex items-center gap-1"
                        >
                          <MaterialIcon icon="save" size="sm" />保存
                        </button>
                        <button
                          onClick={() => setFlowRulesEdit((prev) => ({ ...prev, [plat]: { json: '', isEditing: false } }))}
                          className="btn-secondary text-xs px-2.5 py-1"
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => setFlowRulesEdit((prev) => ({
                            ...prev,
                            [plat]: { json: JSON.stringify(fr, null, 2), isEditing: true },
                          }))}
                          className="btn-secondary text-xs px-2.5 py-1 flex items-center gap-1"
                        >
                          <MaterialIcon icon="edit" size="sm" />编辑
                        </button>
                        {ruleCount > 0 && (
                          <button
                            onClick={async () => {
                              if (!confirm(`确认重置 ${plat} 的流程规则? 将回退到 BasePublisher 硬编码默认。`)) return;
                              await resetFlowRules.mutateAsync({ platform: plat });
                            }}
                            disabled={resetFlowRules.isPending}
                            className="btn-secondary text-xs px-2.5 py-1 text-error"
                          >
                            重置
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {editing ? (
                  <div className="p-3 bg-surface-container-lowest">
                    <textarea
                      value={draftJson}
                      onChange={(e) => setFlowRulesEdit((prev) => ({
                        ...prev,
                        [plat]: { json: e.target.value, isEditing: true },
                      }))}
                      className="w-full h-72 p-2 text-[11px] font-mono bg-surface-container border border-outline-variant rounded resize-y focus:outline-none focus:ring-2 focus:ring-primary/40"
                      spellCheck={false}
                    />
                    <div className="mt-2 text-[11px] text-on-surface-variant">
                      字段说明: <code>scopeSelectors</code> (发布按钮搜索容器) · <code>disabledCheckMethods</code> (dom-property/attr-disabled/aria-disabled/pseudo-disabled/class-disabled/cursor/opacity) · <code>successUrlPatterns</code> (发布成功后的 URL 模式) · <code>navRedirectUrlPatterns</code> (导航误命中模式, 触发重填) · <code>filterTag</code> (BUTTON/INPUT/A) · <code>declareModalMethod</code> (selector/page-text/both) · 其他: <code>publishMaxRetries</code> · <code>disabledRetryDelayMs</code> · <code>notFoundBackoffMs</code> · <code>postClickStabilizeMs</code> · <code>scrollAmountPx</code> · <code>publishWaitMs</code> · <code>viewportInsetPx</code>
                    </div>
                  </div>
                ) : ruleCount > 0 ? (
                  <pre className="bg-surface-container-lowest p-3 text-[11px] font-mono overflow-x-auto max-h-72 overflow-y-auto">
                    {JSON.stringify(fr, null, 2)}
                  </pre>
                ) : (
                  <div className="px-4 py-3 text-[12px] text-on-surface-variant">
                    该平台 <code className="px-1 py-0.5 rounded bg-surface-container">flowRules</code> 为空。
                    运行时将回退到代码中的默认值, 建议尽快在 <code className="px-1 py-0.5 rounded bg-surface-container">data/selectors.json</code> 补齐以避免漂移。
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-4 text-[12px] text-on-surface-variant">
          提示: 点击"编辑"可在线修改 (支持 <code>flowRules</code> 15 个字段, 修改后通过 <code>PUT /api/v1/config-automation/selectors/flow-rules</code> 热重载)。 重置后会回退到 BasePublisher 中硬编码的默认值。
        </div>
      </div>
    </div>
  );
}
