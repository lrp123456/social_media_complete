'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { StatusPill } from '@/components/ui/StatusPill';
import { BentoCard, SectionCard } from '@/components/ui/Bento';
import { cn } from '@/lib/utils';
import {
  useConfigSnapshots,
  useCreateSnapshot,
  useRollbackSnapshot,
  useExportConfig,
  useImportConfig,
} from '@/hooks/useApi';
import { relativeTime } from './components';

const PLATFORMS = ['douyin', 'kuaishou', 'xiaohongshu', 'bilibili', 'baijiahao', 'tencent', 'tiktok'];
const CONFIG_TYPES = ['selectors', 'flow_rules', 'url_monitors', 'frameworks', 'api_patterns', 'data_sources', 'navigation_flows'];

export default function ConfigSnapshotTab() {
  const [platform, setPlatform] = useState('');
  const { data, isLoading, refetch } = useConfigSnapshots(platform || undefined);
  const createSnapshot = useCreateSnapshot();
  const rollbackSnapshot = useRollbackSnapshot();
  const exportConfig = useExportConfig();
  const importConfig = useImportConfig();

  // Create snapshot modal
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ platform: '', configType: '', snapshotName: '', createdBy: '' });

  // Export/Import state
  const [exportImport, setExportImport] = useState<{ type: 'export' | 'import'; platform: string; configType: string } | null>(null);
  const [importData, setImportData] = useState('');

  const snapshots = Array.isArray(data) ? data : data?.snapshots ?? [];

  const handleCreate = async () => {
    try {
      await createSnapshot.mutateAsync({
        platform: createForm.platform,
        configType: createForm.configType,
        snapshotName: createForm.snapshotName,
        configData: {},
        createdBy: createForm.createdBy || undefined,
      });
      setShowCreate(false);
      setCreateForm({ platform: '', configType: '', snapshotName: '', createdBy: '' });
    } catch {
      // Error handled by react-query
    }
  };

  const handleRollback = async (snapshot: any) => {
    if (!window.confirm(`确认回滚到快照 "${snapshot.snapshotName}"？此操作不可逆。`)) return;
    try {
      await rollbackSnapshot.mutateAsync({
        id: snapshot.id,
        platform: snapshot.platform,
        configType: snapshot.configType,
        currentVersion: snapshot.version,
      });
    } catch {
      // Error handled by react-query
    }
  };

  const handleExport = async () => {
    if (!exportImport) return;
    try {
      const result = await exportConfig.mutateAsync(exportImport);
      // Download as JSON file
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exportImport.platform}_${exportImport.configType}_config.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Error handled by react-query
    }
    setExportImport(null);
  };

  const handleImport = async () => {
    if (!exportImport) return;
    try {
      const configData = JSON.parse(importData);
      await importConfig.mutateAsync({
        platform: exportImport.platform,
        configType: exportImport.configType,
        snapshotName: `import_${Date.now()}`,
        configData,
      });
      setExportImport(null);
      setImportData('');
    } catch {
      alert('JSON 格式无效，请检查输入');
    }
  };

  return (
    <div className="space-y-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-headline-md text-headline-md text-on-surface">配置管理</h2>
          <p className="font-body text-body-sm text-on-surface-variant mt-1">
            管理平台配置快照，支持创建、回滚、导出与导入
          </p>
        </div>
        <div className="flex gap-2">
          <div className="flex gap-2 items-center">
            <select
              className="form-input w-auto"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              <option value="">全部平台</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <button onClick={() => setShowCreate(true)} className="btn-primary">
            <MaterialIcon icon="add" size="sm" />
            创建快照
          </button>
          <button onClick={() => refetch()} className="btn-secondary">
            <MaterialIcon icon="refresh" size="sm" />
            刷新
          </button>
        </div>
      </div>

      {/* Snapshot list */}
      <SectionCard noPadding>
        {isLoading ? (
          <div className="p-8">
            <div className="space-y-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-14 rounded bg-on-surface-variant/10 animate-pulse" />
              ))}
            </div>
          </div>
        ) : snapshots.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant">
            <MaterialIcon icon="history" size="2xl" className="opacity-30 mb-2" />
            <p className="font-body text-body-sm">暂无配置快照</p>
            <button onClick={() => setShowCreate(true)} className="btn-ghost mt-3">
              <MaterialIcon icon="add" size="sm" />
              创建第一个快照
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-flat">
              <thead>
                <tr>
                  <th className="whitespace-nowrap">快照名称</th>
                  <th className="whitespace-nowrap">平台</th>
                  <th className="whitespace-nowrap">配置类型</th>
                  <th className="whitespace-nowrap">版本</th>
                  <th className="whitespace-nowrap">创建人</th>
                  <th className="whitespace-nowrap">创建时间</th>
                  <th className="whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snap: any, idx: number) => (
                  <tr key={snap.id || idx}>
                    <td className="font-medium">{snap.snapshotName}</td>
                    <td>
                      <StatusPill tone="neutral">{snap.platform}</StatusPill>
                    </td>
                    <td className="font-mono text-body-sm">{snap.configType}</td>
                    <td>
                      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-surface-container text-label-sm text-label-sm">
                        v{snap.version ?? 1}
                      </span>
                    </td>
                    <td className="text-on-surface-variant">{snap.createdBy || '-'}</td>
                    <td className="text-on-surface-variant whitespace-nowrap text-body-sm">
                      {snap.createdAt ? relativeTime(snap.createdAt) : '-'}
                    </td>
                    <td>
                      <div className="flex gap-1">
                        <button
                          className="btn-ghost"
                          title="回滚"
                          onClick={() => handleRollback(snap)}
                          disabled={rollbackSnapshot.isPending}
                        >
                          <MaterialIcon icon="history" size="sm" />
                          <span className="text-label-sm text-label-sm">回滚</span>
                        </button>
                        <button
                          className="btn-ghost"
                          title="从此快照导出"
                          onClick={() =>
                            setExportImport({
                              type: 'export',
                              platform: snap.platform,
                              configType: snap.configType,
                            })
                          }
                        >
                          <MaterialIcon icon="download" size="sm" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Export/Import section */}
      <BentoCard>
        <h3 className="text-label-md text-label-md font-semibold mb-3">导出 / 导入配置</h3>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="text-label-sm text-label-sm text-on-surface-variant block mb-1">平台</label>
            <select
              className="form-input w-32"
              value={exportImport?.platform ?? ''}
              onChange={(e) =>
                setExportImport((prev) => ({
                  type: prev?.type ?? 'export',
                  platform: e.target.value,
                  configType: prev?.configType ?? '',
                }))
              }
            >
              <option value="">选择</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-label-sm text-label-sm text-on-surface-variant block mb-1">配置类型</label>
            <select
              className="form-input w-36"
              value={exportImport?.configType ?? ''}
              onChange={(e) =>
                setExportImport((prev) => ({
                  type: prev?.type ?? 'export',
                  platform: prev?.platform ?? '',
                  configType: e.target.value,
                }))
              }
            >
              <option value="">选择</option>
              {CONFIG_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <button
            className="btn-secondary"
            onClick={() => {
              if (!exportImport?.platform || !exportImport?.configType) return;
              setExportImport({ type: 'export', platform: exportImport.platform, configType: exportImport.configType });
              handleExport();
            }}
            disabled={!exportImport?.platform || !exportImport?.configType || exportConfig.isPending}
          >
            <MaterialIcon icon="download" size="sm" />
            导出
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              if (!exportImport?.platform || !exportImport?.configType) return;
              setExportImport({ type: 'import', platform: exportImport.platform, configType: exportImport.configType });
              const json = prompt('粘贴 JSON 配置数据：');
              if (json) {
                setImportData(json);
                setExportImport({ type: 'import', platform: exportImport.platform, configType: exportImport.configType });
                handleImport();
              }
            }}
            disabled={!exportImport?.platform || !exportImport?.configType || importConfig.isPending}
          >
            <MaterialIcon icon="upload" size="sm" />
            导入
          </button>
        </div>
      </BentoCard>

      {/* Create snapshot modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowCreate(false)}>
          <div
            className="bg-surface-container-lowest rounded-lg p-6 w-full max-w-md shadow-modal mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-headline-sm">创建配置快照</h3>
              <button className="btn-icon" onClick={() => setShowCreate(false)}>
                <MaterialIcon icon="close" size="lg" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-label-sm text-label-sm text-on-surface-variant block mb-1">平台</label>
                <select
                  className="form-input"
                  value={createForm.platform}
                  onChange={(e) => setCreateForm((f) => ({ ...f, platform: e.target.value }))}
                >
                  <option value="">选择平台</option>
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-label-sm text-label-sm text-on-surface-variant block mb-1">配置类型</label>
                <select
                  className="form-input"
                  value={createForm.configType}
                  onChange={(e) => setCreateForm((f) => ({ ...f, configType: e.target.value }))}
                >
                  <option value="">选择类型</option>
                  {CONFIG_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-label-sm text-label-sm text-on-surface-variant block mb-1">快照名称</label>
                <input
                  className="form-input"
                  placeholder="例如: v2.5.1 稳定版"
                  value={createForm.snapshotName}
                  onChange={(e) => setCreateForm((f) => ({ ...f, snapshotName: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-label-sm text-label-sm text-on-surface-variant block mb-1">创建人（可选）</label>
                <input
                  className="form-input"
                  placeholder="操作人标识"
                  value={createForm.createdBy}
                  onChange={(e) => setCreateForm((f) => ({ ...f, createdBy: e.target.value }))}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button className="btn-secondary" onClick={() => setShowCreate(false)}>
                取消
              </button>
              <button
                className="btn-primary"
                onClick={handleCreate}
                disabled={!createForm.platform || !createForm.configType || !createForm.snapshotName || createSnapshot.isPending}
              >
                {createSnapshot.isPending ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
