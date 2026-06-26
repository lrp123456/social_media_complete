'use client';

import { useState, useEffect } from 'react';
import { MaterialIcon, PlatformIcon, type MaterialIconName } from '@/components/ui/MaterialIcon';
import { StatusPill } from '@/components/ui/StatusPill';
import { cn } from '@/lib/utils';
import {
  useOperators,
  useCreateOperator,
  useUpdateOperator,
  useDeleteOperator,
  useBrowserWindows,
  useSyncWindows,
  useCreateWindow,
  useBindWindow,
  useUnbindWindow,
  useAddPlatform,
  useRemovePlatform,
  useVerifyLogin,
  useCreateLinkRequest,
  usePollLinkResult,
  usePlatformCapabilities,
  type Operator,
  type BrowserWindowItem,
  type PlatformCapability,
} from '@/hooks/useApi';

// ============================================================
// Constants
// ============================================================

const PLATFORM_OPTIONS = [
  { key: 'douyin', label: '抖音' },
  { key: 'kuaishou', label: '快手' },
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'bilibili', label: 'B站' },
  { key: 'baijiahao', label: '百家号' },
  { key: 'tencent', label: '腾讯视频号' },
  { key: 'tiktok', label: 'TikTok' },
] as const;

const LOGIN_STATUS_MAP: Record<string, { label: string; tone: 'success' | 'warning' | 'error' | 'neutral'; icon: MaterialIconName }> = {
  logged_in: { label: '有效', tone: 'success', icon: 'check_circle' },
  pending: { label: '待确认', tone: 'warning', icon: 'help' },
  not_logged_in: { label: '失效', tone: 'error', icon: 'error' },
  unknown: { label: '未验证', tone: 'neutral', icon: 'visibility_off' },
  checking: { label: '验证中…', tone: 'warning', icon: 'sync' },
};

// ============================================================
// Sub-components
// ============================================================

function LoginBadge({ status }: { status: string }) {
  const s = LOGIN_STATUS_MAP[status] || LOGIN_STATUS_MAP.unknown;
  return <StatusPill tone={s.tone} icon={s.icon}>{s.label}</StatusPill>;
}

function PlatformRow({
  platform,
  loginStatus,
  onVerify,
  onRemove,
  verifying,
  capability,
}: {
  platform: string;
  loginStatus: string;
  onVerify: () => void;
  onRemove: () => void;
  verifying: boolean;
  capability?: PlatformCapability;
}) {
  const meta = PLATFORM_OPTIONS.find((p) => p.key === platform);

  // Debug: Log capability for tencent platform
  if (platform === 'tencent') {
    console.log('[DEBUG] PlatformRow tencent capability:', capability);
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface border border-outline-variant group hover:border-primary/30 transition-colors">
      <PlatformIcon platform={platform as any} size={24} />
      <span className="text-body-sm text-on-surface font-medium flex-1">{meta?.label || platform}</span>

      {/* Capability indicators */}
      {capability && (
        <div className="flex items-center gap-1.5 mr-2">
          {capability.canPublish && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium" title="支持发布">
              发布
            </span>
          )}
          {capability.canMonitor && (
            <span className={cn(
              'text-[10px] px-1.5 py-0.5 rounded font-medium',
              capability.canDeepCrawl
                ? 'bg-emerald-500/10 text-emerald-600'
                : 'bg-amber-500/10 text-amber-600'
            )} title={capability.canDeepCrawl ? '支持深度爬取' : '仅支持轻量通知'}>
              监控{capability.canDeepCrawl ? '·深度' : '·轻量'}
            </span>
          )}
          {!capability.canPublish && !capability.canMonitor && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant">
              仅发布
            </span>
          )}
        </div>
      )}

      <LoginBadge status={loginStatus} />
      <button
        onClick={onVerify}
        disabled={verifying}
        className="opacity-0 group-hover:opacity-100 text-primary text-xs hover:underline transition-opacity disabled:opacity-40"
        title="验证登录状态"
      >
        {verifying ? '验证中…' : '验证'}
      </button>
      <button
        onClick={onRemove}
        className="opacity-0 group-hover:opacity-100 text-error text-xs hover:underline transition-opacity"
        title="移除平台"
      >
        移除
      </button>
    </div>
  );
}

// ============================================================
// Operator Detail Panel (right column)
// ============================================================

function OperatorDetail({
  operator,
  unboundWindows,
  windows,
  capabilitiesData,
  bindWindow,
  unbindWindow,
  addPlatform,
  removePlatform,
  verifyLogin,
  verifyingPlatforms,
  setVerifyingPlatforms,
}: {
  operator: Operator;
  unboundWindows: BrowserWindowItem[];
  windows: BrowserWindowItem[];
  capabilitiesData?: PlatformCapability[];
  bindWindow: any;
  unbindWindow: any;
  addPlatform: any;
  removePlatform: any;
  verifyLogin: any;
  verifyingPlatforms: Set<string>;
  setVerifyingPlatforms: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const [selectedBindWindowId, setSelectedBindWindowId] = useState<number | ''>('');
  const [addPlatformForWindow, setAddPlatformForWindow] = useState<number | null>(null);
  const [newPlatformKey, setNewPlatformKey] = useState('');

  // Resolve full window info for each bound window id
  const boundWindows = operator.windows.map((w) => {
    const full = windows.find((x) => x.id === w.id);
    return { ...w, browserVendor: full?.browserVendor || w.browserVendor, externalId: full?.externalId || '' };
  });

  return (
    <div className="space-y-4">
      {/* Operator header */}
      <div className="flex items-center gap-3 px-5 py-4 rounded-xl bg-surface-container-lowest border border-outline-variant">
        <div className="w-10 h-10 rounded-full bg-primary-container text-on-primary flex items-center justify-center shrink-0">
          <MaterialIcon icon="person" size="md" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-label-md text-on-surface font-bold">{operator.displayName}</h3>
            <span className="text-xs text-on-surface-variant bg-surface-container px-2 py-0.5 rounded-full font-mono">
              {operator.wechatUserId}
            </span>
            {!operator.enabled && <StatusPill tone="error">已禁用</StatusPill>}
          </div>
          <p className="text-body-sm text-on-surface-variant mt-0.5">
            {operator.windows.length} 个窗口 · {operator.platforms.length} 个平台
          </p>
        </div>
      </div>

      {/* Add window binding */}
      <div className="flex items-center gap-2">
        <select
          className="form-input text-sm py-1.5 flex-1"
          value={selectedBindWindowId}
          onChange={(e) => setSelectedBindWindowId(e.target.value ? Number(e.target.value) : '')}
        >
          <option value="">选择可用窗口…</option>
          {unboundWindows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.windowName || w.externalId} ({w.browserVendor})
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            if (selectedBindWindowId) {
              bindWindow.mutate(
                { windowId: selectedBindWindowId, operatorId: operator.id },
                {
                  onSuccess: () => setSelectedBindWindowId(''),
                  onError: (err: any) => {
                    alert(`绑定窗口失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
                  },
                },
              );
            }
          }}
          disabled={!selectedBindWindowId || bindWindow.isPending}
          className="btn-primary text-sm flex items-center gap-1"
        >
          <MaterialIcon icon="add" size="sm" />
          添加窗口
        </button>
      </div>

      {/* Bound windows list */}
      {boundWindows.length === 0 ? (
        <div className="bento-card text-center py-8 rounded-xl border border-dashed border-outline-variant/50">
          <MaterialIcon icon="open_in_new" size="2xl" className="text-outline mb-2 opacity-30" />
          <p className="text-body-sm text-on-surface-variant">该操作员尚未绑定窗口</p>
          <p className="text-xs text-on-surface-variant/60 mt-1">请从上方下拉框选择一个可用窗口</p>
        </div>
      ) : (
        <div className="space-y-4">
          {boundWindows.map((w) => {
            const isAddingPlatform = addPlatformForWindow === w.id;
            const usedPlatforms = w.platforms.map((p) => p.platform);
            const availablePlatforms = PLATFORM_OPTIONS.filter((p) => !usedPlatforms.includes(p.key));

            return (
              <div
                key={w.id}
                className="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden"
              >
                {/* Window header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant bg-surface-container/40">
                  <div className="flex items-center gap-2 min-w-0">
                    <MaterialIcon icon="open_in_new" size="sm" className="text-primary shrink-0" />
                    <span className="font-mono text-label-md text-on-surface truncate">{w.windowName || w.externalId}</span>
                    <span className="text-xs text-on-surface-variant bg-surface-container px-1.5 py-0.5 rounded">
                      {w.browserVendor}
                    </span>
                  </div>
                  <button
                    onClick={() => unbindWindow.mutate(w.id, {
                      onError: (err: any) => {
                        alert(`解绑窗口失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
                      },
                    })}
                    disabled={unbindWindow.isPending}
                    className="text-xs text-error hover:underline flex items-center gap-1"
                  >
                    <MaterialIcon icon="link_off" size="xs" />
                    解绑
                  </button>
                </div>

                {/* Window platforms */}
                <div className="px-4 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-label-md text-on-surface-variant">平台账号</h4>
                    {availablePlatforms.length > 0 && (
                      <button
                        onClick={() => setAddPlatformForWindow(isAddingPlatform ? null : w.id)}
                        className="text-xs text-primary hover:underline flex items-center gap-1"
                      >
                        <MaterialIcon icon="add" size="xs" />
                        {isAddingPlatform ? '取消' : '添加平台'}
                      </button>
                    )}
                  </div>

                  {/* Add platform inline */}
                  {isAddingPlatform && (
                    <div className="flex items-center gap-2 mb-3 p-2 bg-surface-container rounded-lg border border-outline-variant">
                      <select
                        className="form-input text-sm py-1 flex-1"
                        value={newPlatformKey}
                        onChange={(e) => setNewPlatformKey(e.target.value)}
                      >
                        <option value="">选择平台…</option>
                        {availablePlatforms.map((p) => (
                          <option key={p.key} value={p.key}>{p.label}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => {
                          if (!newPlatformKey) return;
                          addPlatform.mutate(
                            { operatorId: operator.id, platform: newPlatformKey },
                            {
                              onSuccess: () => { setAddPlatformForWindow(null); setNewPlatformKey(''); },
                              onError: (err: any) => {
                                alert(`添加平台失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
                              },
                            },
                          );
                        }}
                        disabled={!newPlatformKey || addPlatform.isPending}
                        className="btn-primary text-xs px-3 py-1"
                      >
                        {addPlatform.isPending ? '添加中…' : '确认'}
                      </button>
                    </div>
                  )}

                  {/* Platform rows */}
                  {w.platforms.length === 0 ? (
                    <p className="text-body-sm text-on-surface-variant text-center py-4">该窗口暂无平台账号</p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {w.platforms.map((plat) => {
                        const capability = capabilitiesData?.find((c) => c.platform === plat.platform);
                        const verifyKey = `${operator.id}_${w.id}_${plat.platform}`;
                        return (
                          <PlatformRow
                            key={plat.platform}
                            platform={plat.platform}
                            loginStatus={plat.loginStatus}
                            onVerify={() => {
                              setVerifyingPlatforms(prev => new Set(prev).add(verifyKey));
                              verifyLogin.mutate(
                                { operatorId: operator.id, platform: plat.platform },
                                { onSettled: () => setVerifyingPlatforms(prev => {
                                  const next = new Set(prev);
                                  next.delete(verifyKey);
                                  return next;
                                })},
                              );
                            }}
                            onRemove={() => removePlatform.mutate(
                              { operatorId: operator.id, platform: plat.platform },
                              {
                                onError: (err: any) => {
                                  alert(`移除平台失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
                                },
                              },
                            )}
                            verifying={verifyingPlatforms.has(verifyKey)}
                            capability={capability}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Main Component
// ============================================================

export default function OperatorManagement() {
  // Data
  const { data: operators = [], isLoading } = useOperators() as { data: Operator[]; isLoading: boolean };
  const { data: windowsData } = useBrowserWindows('all') as { data: { windows: BrowserWindowItem[]; limits: any } };
  const windows = windowsData?.windows || [];
  const limits = windowsData?.limits || { bitbrowser: { current: 0, max: 10 }, roxybrowser: { current: 0, max: 5 }, total: { current: 0, max: 15 } };
  const { data: capabilitiesData } = usePlatformCapabilities() as { data: PlatformCapability[] };
  const createOperator = useCreateOperator();

  // Debug: Log capabilities data
  useEffect(() => {
    console.log('[DEBUG] capabilitiesData:', capabilitiesData);
    if (capabilitiesData) {
      const tencentCap = capabilitiesData.find((c) => c.platform === 'tencent');
      console.log('[DEBUG] tencent capability:', tencentCap);
    }
  }, [capabilitiesData]);
  const updateOperator = useUpdateOperator();
  const deleteOperator = useDeleteOperator();
  const syncWindows = useSyncWindows();
  const createWindow = useCreateWindow();
  const bindWindow = useBindWindow();
  const unbindWindow = useUnbindWindow();
  const addPlatform = useAddPlatform();
  const removePlatform = useRemovePlatform();
  const verifyLogin = useVerifyLogin();
  const createLinkRequest = useCreateLinkRequest();

  // UI State
  const [selectedOperatorId, setSelectedOperatorId] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // 页面加载时自动同步所有厂商的窗口（容错：某厂商不可用不影响其他）
  useEffect(() => {
    syncWindows.mutate('all');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [showCreateWindow, setShowCreateWindow] = useState(false);
  const [newWindowName, setNewWindowName] = useState('');
  const [selectedVendor, setSelectedVendor] = useState('bitbrowser');
  const [verifyingPlatforms, setVerifyingPlatforms] = useState<Set<string>>(new Set());

  // Link request state
  const [linkCode, setLinkCode] = useState('');
  const [linkPolling, setLinkPolling] = useState(false);
  const { data: linkResult } = usePollLinkResult(linkCode, linkPolling);

  // Add form state
  const [formWechatId, setFormWechatId] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formPhone, setFormPhone] = useState('');


  const resetForm = () => {
    setFormWechatId('');
    setFormDisplayName('');
    setFormPhone('');
    setShowAddForm(false);
    setEditingId(null);
    setLinkCode('');
    setLinkPolling(false);
  };

  const handleStartLink = () => {
    createLinkRequest.mutate(
      { timeoutMs: 120_000 },
      {
        onSuccess: (data: any) => {
          setLinkCode(data?.code || '');
          setLinkPolling(true);
        },
      },
    );
  };

  // When link result comes back, auto-fill wechatUserId
  if (linkResult?.status === 'completed' && linkResult?.userid) {
    const userid = linkResult.userid;
    if (formWechatId !== userid) {
      setFormWechatId(userid);
      setLinkPolling(false);
      setLinkCode('');
    }
  }
  if (linkResult?.status === 'timeout') {
    setLinkPolling(false);
    setLinkCode('');
  }

  const handleCreate = () => {
    if (!formWechatId.trim() || !formDisplayName.trim()) return;
    createOperator.mutate(
      { wechatUserId: formWechatId.trim(), displayName: formDisplayName.trim(), phone: formPhone.trim() || undefined },
      {
        onSuccess: () => { resetForm(); },
        onError: (err: any) => {
          alert(`创建用户失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
        },
      },
    );
  };

  const handleUpdate = () => {
    if (!editingId || !formDisplayName.trim() || !formWechatId.trim()) return;
    updateOperator.mutate(
      { id: editingId, wechatUserId: formWechatId.trim(), displayName: formDisplayName.trim(), phone: formPhone.trim() || undefined },
      {
        onSuccess: () => { resetForm(); },
        onError: (err: any) => {
          alert(`更新用户失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
        },
      },
    );
  };

  const startEdit = (op: Operator) => {
    setEditingId(op.id);
    setFormWechatId(op.wechatUserId);
    setFormDisplayName(op.displayName);
    setFormPhone(op.phone || '');
    setShowAddForm(true);
  };

  const handleDelete = (id: number) => {
    deleteOperator.mutate(id, {
      onSuccess: () => setDeletingId(null),
      onError: (err: any) => {
        alert(`删除用户失败: ${err?.response?.data?.error || err?.message || '未知错误'}`);
      },
    });
  };

  // Derived data
  const selectedOperator = operators.find((op) => op.id === selectedOperatorId) || null;

  // Windows not bound to any operator
  const boundOperatorIds = new Set(operators.flatMap((op) => op.windows.map((w) => w.id)));
  const unboundWindows = windows.filter((w) => !boundOperatorIds.has(w.id) && w.status === 'available');

  // All windows not bound to the selected operator
  const unboundForSelected = selectedOperator
    ? windows.filter((w) => {
        const isBoundToSelected = selectedOperator.windows.some((ow) => ow.id === w.id);
        const isBoundToOther = operators.some(
          (op) => op.id !== selectedOperator.id && op.windows.some((ow) => ow.id === w.id),
        );
        return !isBoundToSelected && !isBoundToOther && w.status === 'available';
      })
    : [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-headline-md text-on-surface">操作员管理</h2>
          <p className="text-body-sm text-on-surface-variant mt-1">
            每个操作员对应一个企业微信用户，可绑定多个窗口，每个窗口独立管理平台账号。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => syncWindows.mutate(selectedVendor)}
            disabled={syncWindows.isPending}
            className="btn-ghost flex items-center gap-1.5 text-sm"
          >
            <MaterialIcon icon="sync" size="sm" className={syncWindows.isPending ? 'animate-spin-slow' : ''} />
            {syncWindows.isPending ? '同步中…' : '同步窗口'}
          </button>
          <button
            onClick={() => { setShowAddForm(true); setEditingId(null); setFormWechatId(''); setFormDisplayName(''); setFormPhone(''); }}
            className="btn-primary flex items-center gap-1.5"
          >
            <MaterialIcon icon="add" size="sm" />
            新增操作员
          </button>
        </div>
      </div>

      {/* Create Window Form (inline) */}
      {showCreateWindow && (
        <div className="p-4 bg-surface-container-lowest rounded-xl border border-primary/30 shadow-sm">
          <h3 className="text-label-md text-on-surface mb-3">
            创建新窗口 — {selectedVendor === 'bitbrowser' ? 'BitBrowser' : 'RoxyBrowser'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-body-sm text-on-surface-variant block mb-1">窗口名称 *</label>
              <input
                className="form-input w-full"
                value={newWindowName}
                onChange={(e) => setNewWindowName(e.target.value)}
                placeholder="例如: 抖音运营01"
              />
            </div>
            <div>
              <label className="text-body-sm text-on-surface-variant block mb-1">供应商</label>
              <select
                className="form-input w-full"
                value={selectedVendor}
                onChange={(e) => setSelectedVendor(e.target.value)}
              >
                <option value="bitbrowser">BitBrowser (剩余 {limits.bitbrowser.max - limits.bitbrowser.current} 个)</option>
                <option value="roxybrowser">RoxyBrowser (剩余 {limits.roxybrowser.max - limits.roxybrowser.current} 个)</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button className="btn-ghost" onClick={() => { setShowCreateWindow(false); setNewWindowName(''); }}>取消</button>
            <button
              className="btn-primary"
              onClick={() => {
                if (!newWindowName.trim()) return;
                createWindow.mutate(
                  { vendor: selectedVendor, name: newWindowName.trim() },
                  { onSuccess: () => { setShowCreateWindow(false); setNewWindowName(''); } },
                );
              }}
              disabled={createWindow.isPending || !newWindowName.trim()}
            >
              {createWindow.isPending ? '创建中…' : '创建窗口'}
            </button>
          </div>
        </div>
      )}

      {/* Add / Edit Form (inline) */}
      {(showAddForm || editingId) && (
        <div className="p-4 bg-surface-container-lowest rounded-xl border border-primary/30 shadow-sm">
          <h3 className="text-label-md text-on-surface mb-3">{editingId ? '编辑操作员' : '新增操作员'}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="text-body-sm text-on-surface-variant block mb-1">企业微信用户ID *</label>
              <div className="flex gap-2">
                <input
                  className="form-input flex-1"
                  value={formWechatId}
                  onChange={(e) => setFormWechatId(e.target.value)}
                  placeholder="例如: WangXiaoMing"
                />
                {!editingId && (
                  <button
                    type="button"
                    onClick={handleStartLink}
                    disabled={createLinkRequest.isPending || linkPolling}
                    className="btn-ghost text-xs px-2 py-1 shrink-0 flex items-center gap-1 border border-outline-variant rounded hover:border-primary"
                    title="通过企业微信机器人自动获取用户ID"
                  >
                    <MaterialIcon icon="link" size="sm" />
                    {linkPolling ? '等待中…' : '获取ID'}
                  </button>
                )}
              </div>
              {/* Link request status */}
              {linkPolling && linkCode && (
                <div className="mt-2 p-2 bg-primary/5 border border-primary/20 rounded-lg text-xs text-on-surface-variant">
                  <p className="flex items-center gap-1 mb-1">
                    <MaterialIcon icon="sync" size="xs" className="animate-spin-slow text-primary" />
                    <span className="text-primary font-medium">等待用户回复验证码…</span>
                  </p>
                  <p>验证码: <span className="font-mono text-primary font-bold text-sm">{linkCode}</span></p>
                  <p className="mt-1 opacity-70">请让用户向企业微信机器人发送此验证码，系统将自动获取用户ID。</p>
                </div>
              )}
            </div>
            <div>
              <label className="text-body-sm text-on-surface-variant block mb-1">显示名称 *</label>
              <input
                className="form-input w-full"
                value={formDisplayName}
                onChange={(e) => setFormDisplayName(e.target.value)}
                placeholder="例如: 王小明"
              />
            </div>
            <div>
              <label className="text-body-sm text-on-surface-variant block mb-1">手机号（可选）</label>
              <input
                className="form-input w-full"
                value={formPhone}
                onChange={(e) => setFormPhone(e.target.value)}
                placeholder="例如: 13800138000"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button className="btn-ghost" onClick={resetForm}>取消</button>
            <button
              className="btn-primary"
              onClick={editingId ? handleUpdate : handleCreate}
              disabled={createOperator.isPending || updateOperator.isPending || !formWechatId.trim() || !formDisplayName.trim()}
            >
              {(createOperator.isPending || updateOperator.isPending) ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* Master-Detail Layout */}
      {/* ================================================================ */}
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4 items-start">

        {/* ---- Left Column: Operator List ---- */}
        <div className="space-y-2">
          <h3 className="text-label-md text-on-surface-variant px-1">操作员列表</h3>

          {/* Loading skeleton */}
          {isLoading && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 bg-surface-container rounded-xl animate-pulse" />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!isLoading && operators.length === 0 && (
            <div className="bento-card text-center py-8 rounded-xl border border-dashed border-outline-variant/50">
              <MaterialIcon icon="people" size="2xl" className="text-outline mb-2 opacity-30" />
              <p className="text-body-sm text-on-surface-variant">暂无操作员</p>
              <p className="text-xs text-on-surface-variant/60 mt-1">点击上方"新增操作员"开始</p>
            </div>
          )}

          {/* Operator list items */}
          {!isLoading && operators.map((op) => {
            const isSelected = selectedOperatorId === op.id;
            const isDeleting = deletingId === op.id;

            return (
              <div key={op.id} className="space-y-1">
                <button
                  onClick={() => {
                    setSelectedOperatorId(op.id);
                    // Close add form when selecting an operator
                    if (showAddForm && !editingId) setShowAddForm(false);
                  }}
                  className={cn(
                    'w-full text-left px-4 py-3 rounded-xl border transition-all',
                    isSelected
                      ? 'bg-primary-container/30 border-primary/40 shadow-sm'
                      : 'bg-surface-container-lowest border-outline-variant hover:border-primary/30 hover:bg-surface-container/60',
                    isDeleting && 'border-error/50 bg-error/5',
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                      isSelected ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant',
                    )}>
                      <MaterialIcon icon="person" size="sm" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={cn(
                          'text-label-md truncate',
                          isSelected ? 'text-primary font-bold' : 'text-on-surface font-medium',
                        )}>
                          {op.displayName}
                        </span>
                        {!op.enabled && (
                          <StatusPill tone="error">禁用</StatusPill>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-on-surface-variant mt-0.5">
                        <span className="font-mono">{op.wechatUserId}</span>
                        <span>{op.windows.length}个窗口</span>
                      </div>
                    </div>
                  </div>
                </button>
                {/* Inline actions for this operator */}
                <div className={cn(
                  'flex items-center gap-1 px-4 pb-1',
                  isSelected ? 'flex' : 'hidden',
                )}>
                  <button
                    onClick={() => startEdit(op)}
                    className="text-xs text-primary hover:underline flex items-center gap-0.5"
                  >
                    <MaterialIcon icon="edit" size="xs" />
                    编辑
                  </button>
                  <span className="text-outline-variant">|</span>
                  {isDeleting ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleDelete(op.id)}
                        className="text-xs text-error hover:underline"
                        disabled={deleteOperator.isPending}
                      >
                        {deleteOperator.isPending ? '删除中…' : '确认删除'}
                      </button>
                      <span className="text-outline-variant">|</span>
                      <button
                        onClick={() => setDeletingId(null)}
                        className="text-xs text-on-surface-variant hover:underline"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeletingId(op.id)}
                      className="text-xs text-error hover:underline flex items-center gap-0.5"
                    >
                      <MaterialIcon icon="delete" size="xs" />
                      删除
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ---- Right Column: Operator Detail ---- */}
        <div>
          {!selectedOperator ? (
            <div className="bento-card text-center py-16 rounded-xl border border-dashed border-outline-variant/50">
              <MaterialIcon icon="chevron_left" size="3xl" className="text-outline mb-3 opacity-30" />
              <p className="text-body-sm text-on-surface-variant">请从左侧选择一个操作员</p>
              <p className="text-xs text-on-surface-variant/60 mt-1">选择后在此查看详情、管理窗口和平台账号</p>
            </div>
          ) : (
            <OperatorDetail
              operator={selectedOperator}
              unboundWindows={unboundForSelected}
              windows={windows}
              capabilitiesData={capabilitiesData}
              bindWindow={bindWindow}
              unbindWindow={unbindWindow}
              addPlatform={addPlatform}
              removePlatform={removePlatform}
              verifyLogin={verifyLogin}
              verifyingPlatforms={verifyingPlatforms}
              setVerifyingPlatforms={setVerifyingPlatforms}
            />
          )}
        </div>
      </div>

      {/* ================================================================ */}
      {/* Bottom: Unbound Window Pool */}
      {/* ================================================================ */}
      <div className="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-outline-variant bg-surface-container/40">
          <h3 className="text-label-md text-on-surface flex items-center gap-2">
            <MaterialIcon icon="dashboard" size="sm" className="text-on-surface-variant" />
            未绑定窗口池
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-xs text-on-surface-variant">
              可用: {unboundWindows.length} 个
            </span>
            <button
              onClick={() => setShowCreateWindow(!showCreateWindow)}
              className="btn-ghost text-xs flex items-center gap-1"
            >
              <MaterialIcon icon="add" size="xs" />
              创建窗口
            </button>
          </div>
        </div>

        {unboundWindows.length === 0 ? (
          <div className="text-center py-8">
            <MaterialIcon icon="check_circle" size="2xl" className="text-outline mb-2 opacity-30" />
            <p className="text-body-sm text-on-surface-variant">所有窗口已绑定</p>
            <p className="text-xs text-on-surface-variant/60 mt-1">创建新窗口后会自动出现在此池中</p>
          </div>
        ) : (
          <div className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {unboundWindows.map((w) => {
                // Group by vendor
                return (
                  <div
                    key={w.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-outline-variant bg-surface text-xs"
                  >
                    <MaterialIcon icon="open_in_new" size="xs" className="text-primary shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-on-surface truncate">{w.windowName || w.externalId}</p>
                      <p className="text-on-surface-variant/60 text-[10px]">{w.browserVendor}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
