'use client';

import { useState, useEffect, useRef } from 'react';
import {
  useInfraConfig,
  useUpdateInfraConfig,
  useNetworkConfig,
  useUpdateNetworkConfig,
  useWecomConfig,
  useUpdateWecomConfig,
  useNotificationChannels,
  useUpdateNotificationChannel,
  useNotificationRules,
  useUpdateNotificationRule,
  useRbacUsers,
  useCreateRbacUser,
  useUpdateRbacUser,
  useDeleteRbacUser,
  useAuditLogs,
  useSecurityApiKey,
  useRotateApiKey,
  type WecomConfig,
} from '@/hooks/useApi';
import { MaterialIcon, Avatar } from '@/components/ui/MaterialIcon';
import { HeaderStrip, AccentBar } from '@/components/ui/Bento';
import { StatusPill } from '@/components/ui/StatusPill';
import { cn } from '@/lib/utils';
import { INFRA_KEYS, RAPIDAPI_PRESEED, HOSTS_PRESEED } from '../shared/constants';
import { PanelSkeleton } from '../shared/PanelSkeleton';
import { QueryError } from '../shared/QueryError';
import { KeyValueEditor } from '../shared/KeyValueEditor';
import { NotificationChannelsPanel } from '../shared/NotificationChannelsPanel';
import { RbacPanel } from '../shared/RbacPanel';
import { StrategyBadge } from '../shared/StrategyBadge';
import { statusPillFor, maskKey } from '../shared/utils';

const MOCK_LOGS = [
  { id: '1', time: '2024-03-15 14:32:01', actor: 'Admin User', action: 'UPDATE_ENV', resource: 'system_env.REDIS_PORT', status: 'SUCCESS' },
  { id: '2', time: '2024-03-15 14:15:22', actor: 'System Agent', action: 'FAILOVER_TRIGGER', resource: 'llm_router.zhipu_glm', status: 'WARN' },
  { id: '3', time: '2024-03-15 09:01:45', actor: 'Admin User', action: 'USER_LOGIN', resource: 'auth.session', status: 'SUCCESS' },
];

export default function GeneralTab() {
  // Panel 1: Infrastructure
  const infraQuery = useInfraConfig();
  const updateInfra = useUpdateInfraConfig();
  const [infraForm, setInfraForm] = useState<Record<string, string>>({});
  const infraInitRef = useRef(false);

  // Panel 6: Network
  const netQuery = useNetworkConfig();
  const updateNetwork = useUpdateNetworkConfig();
  const [netForm, setNetForm] = useState({
    proxy: { download_proxy_url: '' },
    api: { rapidapi_keys: {}, hosts: {} },
  });
  const netInitRef = useRef(false);

  // Panel 7: Notification
  const channelsQuery = useNotificationChannels();
  const updateChannel = useUpdateNotificationChannel();
  const rulesQuery = useNotificationRules();
  const updateRule = useUpdateNotificationRule();
  const wecomQuery = useWecomConfig();
  const updateWecom = useUpdateWecomConfig();
  const [wecomForm, setWecomForm] = useState<Partial<WecomConfig>>({});
  const [mappingText, setMappingText] = useState('{}');
  const wecomInitRef = useRef(false);
  const channels = channelsQuery.data || [];
  const rules = rulesQuery.data || [];
  const notifLoading = channelsQuery.isLoading || rulesQuery.isLoading;

  // Panel 8: Security
  const rbacQuery = useRbacUsers();
  const createUser = useCreateRbacUser();
  const updateUser = useUpdateRbacUser();
  const deleteUser = useDeleteRbacUser();
  const auditQuery = useAuditLogs();
  const apiKeyQuery = useSecurityApiKey();
  const rotateKey = useRotateApiKey();
  const [rbacTab, setRbacTab] = useState<'audit' | 'rbac'>('audit');
  const rbacUsers = rbacQuery.data || [];
  const rbacLoading = rbacQuery.isLoading;
  const logs = (auditQuery.data?.length ? auditQuery.data : MOCK_LOGS) as typeof MOCK_LOGS;

  // Init effects
  useEffect(() => {
    if (infraQuery.data && !infraInitRef.current) {
      const initial: Record<string, string> = {};
      INFRA_KEYS.forEach((k) => { initial[k] = String(infraQuery.data[k] ?? ''); });
      setInfraForm(initial);
      infraInitRef.current = true;
    }
  }, [infraQuery.data]);

  useEffect(() => {
    if (netQuery.data && !netInitRef.current) {
      setNetForm({
        proxy: { download_proxy_url: netQuery.data.proxy?.download_proxy_url || '' },
        api: { rapidapi_keys: netQuery.data.api?.rapidapi_keys || {}, hosts: netQuery.data.api?.hosts || {} },
      });
      netInitRef.current = true;
    }
  }, [netQuery.data]);

  useEffect(() => {
    if (wecomQuery.data && !wecomInitRef.current) {
      setWecomForm(wecomQuery.data);
      setMappingText(JSON.stringify(wecomQuery.data.account_chat_mapping || {}, null, 2));
      wecomInitRef.current = true;
    }
  }, [wecomQuery.data]);

  // Handlers
  const handleSaveInfra = () => {
    const updates: Record<string, string | number> = {};
    INFRA_KEYS.forEach((k) => { if (k !== 'DATABASE_URL') updates[k] = infraForm[k]; });
    updateInfra.mutate(updates);
  };

  const handleSaveNetwork = () => updateNetwork.mutate(netForm);

  const handleSaveWecom = () => {
    let mapping: Record<string, string> = {};
    try { mapping = JSON.parse(mappingText); } catch { alert('JSON 格式错误，请检查 account_chat_mapping'); return; }
    updateWecom.mutate({ ...wecomForm, account_chat_mapping: mapping });
  };

  const handleRotateKey = () => {
    if (confirm('确定要轮换 API Key 吗？旧 Key 将立即失效。')) rotateKey.mutate('');
  };

  return (
    <div className="space-y-6 p-6">
          <section id="panel-infra" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color="primary" />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">基础设施变量</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">核心服务连接字符串与端口配置。修改后需重启实例生效。</p>
              </div>
              <div className="flex items-center gap-3">
                <StrategyBadge strategy="restart" carrier=".env → Docker Compose" />
                <button onClick={handleSaveInfra} disabled={updateInfra.isPending} className="btn-secondary flex items-center gap-1.5 text-sm">
                  <MaterialIcon icon="save" size="sm" />
                  {updateInfra.isPending ? '保存中…' : '保存配置'}
                </button>
              </div>
            </HeaderStrip>
            <div className="p-inner-component-padding">
              {infraQuery.isLoading ? <PanelSkeleton rows={5} /> : infraQuery.isError ? <QueryError /> : (
                <div className="overflow-x-auto">
                  <table className="table-flat w-full">
                    <thead><tr><th className="text-left w-1/3">配置项</th><th className="text-left">值</th></tr></thead>
                    <tbody>
                      {INFRA_KEYS.map((key) => (
                        <tr key={key}>
                          <td className="font-mono text-sm text-on-surface-variant">{key}</td>
                          <td>
                            {key === 'DATABASE_URL' ? (
                              <span className="text-body-sm text-on-surface-variant italic">READ-ONLY</span>
                            ) : (
                              <input
                                type={/PASSWORD|SECRET|KEY/.test(key) ? 'password' : 'text'}
                                value={String(infraForm[key] ?? '')}
                                onChange={(e) => setInfraForm((prev) => ({ ...prev, [key]: e.target.value }))}
                                className="form-input font-mono text-sm"
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>


          <section id="panel-network" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color="primary" />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">网络路由与物理代理</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">下载代理、RapidAPI 密钥与域名映射。</p>
              </div>
              <div className="flex items-center gap-3">
                <StrategyBadge strategy="cold" carrier="PostgreSQL config_entries" />
                <button onClick={handleSaveNetwork} disabled={updateNetwork.isPending} className="btn-secondary flex items-center gap-1.5 text-sm">
                  <MaterialIcon icon="save" size="sm" />
                  {updateNetwork.isPending ? '保存中…' : '保存配置'}
                </button>
              </div>
            </HeaderStrip>
            <div className="p-inner-component-padding space-y-6">
              <div>
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">下载代理</h4>
                {netQuery.isLoading ? <PanelSkeleton rows={1} /> : netQuery.isError ? <QueryError /> : (
                  <div className="relative">
                    <MaterialIcon icon="router" size="sm" className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
                    <input
                      type="text"
                      className="form-input pl-10 font-mono text-sm"
                      placeholder="http://proxy.internal:8080"
                      value={netForm.proxy.download_proxy_url}
                      onChange={(e) => setNetForm((prev) => ({ ...prev, proxy: { ...prev.proxy, download_proxy_url: e.target.value } }))}
                    />
                  </div>
                )}
              </div>
              <div className="border-t border-outline-variant pt-6">
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">RapidAPI Keys</h4>
                {netQuery.isLoading ? <PanelSkeleton rows={3} /> : netQuery.isError ? <QueryError /> : (
                  <KeyValueEditor value={netForm.api.rapidapi_keys} onChange={(v) => setNetForm((prev) => ({ ...prev, api: { ...prev.api, rapidapi_keys: v } }))} preseedKeys={RAPIDAPI_PRESEED} />
                )}
              </div>
              <div className="border-t border-outline-variant pt-6">
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">API 域名映射</h4>
                {netQuery.isLoading ? <PanelSkeleton rows={2} /> : netQuery.isError ? <QueryError /> : (
                  <KeyValueEditor value={netForm.api.hosts} onChange={(v) => setNetForm((prev) => ({ ...prev, api: { ...prev.api, hosts: v } }))} preseedKeys={HOSTS_PRESEED} />
                )}
              </div>
            </div>
          </section>


          <section id="panel-notification" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color="success" />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">企业微信与通知路由</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">企业微信连接、通知渠道与触发规则。</p>
              </div>
              <StrategyBadge strategy="hot" carrier="PostgreSQL config_entries" />
            </HeaderStrip>
            <div className="p-inner-component-padding space-y-6">
              <div>
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">企业微信连接</h4>
                {wecomQuery.isLoading ? <PanelSkeleton rows={3} /> : wecomQuery.isError ? <QueryError /> : (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-label-md text-label-md text-on-surface-variant">Bot ID</label>
                        <input className="form-input font-mono text-sm" value={wecomForm.bot_id || ''} onChange={(e) => setWecomForm((prev) => ({ ...prev, bot_id: e.target.value }))} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-label-md text-label-md text-on-surface-variant">Bot Secret</label>
                        <input type="password" className="form-input font-mono text-sm" value={wecomForm.bot_secret || ''} onChange={(e) => setWecomForm((prev) => ({ ...prev, bot_secret: e.target.value }))} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-label-md text-label-md text-on-surface-variant">Global Chat ID</label>
                        <input className="form-input font-mono text-sm" value={wecomForm.global_chat_id || ''} onChange={(e) => setWecomForm((prev) => ({ ...prev, global_chat_id: e.target.value }))} />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-label-md text-label-md text-on-surface-variant">Account Chat Mapping (JSON)</label>
                      <textarea
                        className="form-input font-mono text-sm h-24"
                        value={mappingText}
                        onChange={(e) => setMappingText(e.target.value)}
                      />
                      {(() => {
                        let parsed: Record<string, string> = {};
                        let err = false;
                        try { parsed = JSON.parse(mappingText); } catch { err = true; }
                        if (err) return <p className="text-error text-body-sm mt-1">JSON 格式错误</p>;
                        return (
                          <div className="flex flex-wrap gap-2 mt-2">
                            {Object.entries(parsed).map(([windowId, chatId]) => (
                              <span key={windowId} className="status-pill bg-surface-container text-on-surface-variant">
                                {windowId} → {chatId}
                              </span>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="flex justify-end">
                      <button onClick={handleSaveWecom} disabled={updateWecom.isPending} className="btn-secondary text-sm">
                        <MaterialIcon icon="save" size="sm" />
                        {updateWecom.isPending ? '保存中…' : '保存'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-outline-variant pt-6">
                <NotificationChannelsPanel
                  channels={channels}
                  rules={rules}
                  isLoading={notifLoading}
                  onUpdateChannel={(c) => updateChannel.mutate(c)}
                  onUpdateRule={(r) => updateRule.mutate(r)}
                />
              </div>
            </div>
          </section>


          <section id="panel-security" className="relative overflow-hidden bg-surface-container-lowest border border-outline-variant rounded-xl scroll-mt-24">
            <AccentBar color="error" />
            <HeaderStrip>
              <div>
                <h3 className="text-headline-md text-headline-md text-on-surface">权限、安全与审计</h3>
                <p className="font-body text-body-sm text-on-surface-variant mt-0.5">API 密钥轮换、RBAC 用户管理与审计日志。</p>
              </div>
              <StrategyBadge strategy="readonly" carrier="PostgreSQL config_audit_log (只读历史流)" />
            </HeaderStrip>
            <div className="p-inner-component-padding space-y-6">
              <div>
                <h4 className="text-headline-md text-[18px] text-on-surface mb-stack-md">API 安全密钥</h4>
                {apiKeyQuery.isLoading ? <PanelSkeleton rows={1} /> : apiKeyQuery.isError ? <QueryError /> : (
                  <div className="bento-card flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-3">
                      <MaterialIcon icon="shield" size="xl" className="text-primary" />
                      <div>
                        <div className="text-label-md text-label-md text-on-surface-variant">当前 API Key</div>
                        <div className="font-mono text-headline-md text-headline-md text-on-surface">
                          {maskKey(typeof apiKeyQuery.data === 'string' ? apiKeyQuery.data : apiKeyQuery.data?.key || '')}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={handleRotateKey}
                      disabled={rotateKey.isPending}
                      className="btn-secondary flex items-center gap-1.5"
                    >
                      <MaterialIcon icon={rotateKey.isPending ? 'sync' : 'refresh'} size="sm" spin={rotateKey.isPending} />
                      {rotateKey.isPending ? '轮换中…' : '轮换 Key'}
                    </button>
                  </div>
                )}
              </div>

              <div className="border-t border-outline-variant pt-6">
                <div className="border-b border-outline-variant bg-surface/50 mb-4">
                  <div className="flex items-center px-4 pt-2 gap-6">
                    <button
                      onClick={() => setRbacTab('rbac')}
                      className={cn(
                        'pb-3 border-b-2 text-label-md text-label-md pt-2 px-1 transition-colors',
                        rbacTab === 'rbac' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface',
                      )}
                    >
                      权限策略 (RBAC)
                    </button>
                    <button
                      onClick={() => setRbacTab('audit')}
                      className={cn(
                        'pb-3 border-b-2 text-label-md text-label-md pt-2 px-1 transition-colors',
                        rbacTab === 'audit' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface',
                      )}
                    >
                      安全审计日志
                    </button>
                  </div>
                </div>

                {rbacTab === 'rbac' && (
                  <RbacPanel
                    users={rbacUsers}
                    isLoading={rbacLoading}
                    onCreate={(u: any) => createUser.mutate(u)}
                    onUpdate={(u: any) => updateUser.mutate(u)}
                    onDelete={(id) => deleteUser.mutate(id)}
                    creating={createUser.isPending}
                  />
                )}

                {rbacTab === 'audit' && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-label-md text-label-md text-on-surface-variant">最近审计事件</span>
                      <button className="btn-secondary flex items-center gap-1.5 text-sm">
                        <MaterialIcon icon="download" size="sm" />
                        导出 CSV
                      </button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="table-flat w-full">
                        <thead>
                          <tr>
                            <th className="text-left">时间 (UTC+8)</th>
                            <th className="text-left">用户/实体</th>
                            <th className="text-left">操作类型</th>
                            <th className="text-left">资源对象</th>
                            <th className="text-right">状态</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditQuery.isLoading ? (
                            <tr><td colSpan={5} className="text-center text-on-surface-variant py-8">加载中…</td></tr>
                          ) : auditQuery.isError ? (
                            <tr><td colSpan={5} className="text-center text-error py-8">加载失败</td></tr>
                          ) : (
                            logs.map((log) => (
                              <tr key={log.id}>
                                <td className="font-mono text-[13px] text-outline">{log.time}</td>
                                <td>
                                  <div className="flex items-center gap-2">
                                    <Avatar name={log.actor} size={24} />
                                    <span className="text-sm">{log.actor}</span>
                                  </div>
                                </td>
                                <td className="font-medium text-on-surface">{log.action}</td>
                                <td className="font-mono text-[13px] text-outline">{log.resource}</td>
                                <td className="text-right">{statusPillFor(log.status)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex justify-center pt-2">
                      <button className="btn-secondary text-sm">加载更多记录</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
    </div>
  );
}
