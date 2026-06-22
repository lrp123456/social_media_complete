'use client';

import { useState } from 'react';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { Avatar } from '@/components/ui/MaterialIcon';
import { StatusPill } from '@/components/ui/StatusPill';

export interface RbacUser {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: string;
  status: string;
  createdAt?: string;
  lastLoginAt?: string;
}

export function RbacPanel({
  users,
  isLoading,
  onCreate,
  onUpdate,
  onDelete,
  creating,
}: {
  users: RbacUser[];
  isLoading: boolean;
  onCreate: (u: Omit<RbacUser, 'id' | 'createdAt' | 'lastLoginAt'>) => void;
  onUpdate: (u: Partial<RbacUser> & { id: number }) => void;
  onDelete: (id: number) => void;
  creating: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Omit<RbacUser, 'id' | 'createdAt' | 'lastLoginAt'>>({
    username: '',
    displayName: '',
    email: '',
    role: 'viewer',
    status: 'active',
  });

  return (
    <div className="p-inner-component-padding space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-headline-md text-[18px] text-on-surface">用户与角色</h4>
          <p className="font-body text-body-sm text-on-surface-variant mt-0.5">
            共 {users.length} 个账号 · 角色: admin / operator / viewer
          </p>
        </div>
        <button onClick={() => setShowForm((s) => !s)} className="btn-primary text-sm">
          <MaterialIcon icon="add" size="sm" />
          {showForm ? '取消' : '新增用户'}
        </button>
      </div>

      {showForm && (
        <div className="bento-card bg-surface space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              className="form-input"
              placeholder="用户名 (login)"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <input
              className="form-input"
              placeholder="显示名"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <input
              className="form-input"
              type="email"
              placeholder="邮箱"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <select
              className="form-input"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as RbacUser['role'] })}
            >
              <option value="admin">admin</option>
              <option value="operator">operator</option>
              <option value="viewer">viewer</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowForm(false)} className="btn-ghost">取消</button>
            <button
              onClick={() => {
                onCreate(form);
                setShowForm(false);
                setForm({ username: '', displayName: '', email: '', role: 'viewer', status: 'active' });
              }}
              disabled={!form.username || !form.displayName || creating}
              className="btn-primary"
            >
              {creating ? '创建中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto border border-outline-variant rounded-md">
        <table className="table-flat w-full">
          <thead>
            <tr>
              <th className="text-left">用户</th>
              <th className="text-left">邮箱</th>
              <th className="text-left">角色</th>
              <th className="text-left">状态</th>
              <th className="text-left">最后登录</th>
              <th className="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="text-center text-on-surface-variant py-8">加载中…</td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center text-on-surface-variant py-8">暂无用户</td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Avatar name={u.displayName} size={28} />
                      <div>
                        <div className="text-sm font-medium">{u.displayName}</div>
                        <div className="font-mono text-[11px] text-outline">@{u.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="text-sm text-on-surface-variant">{u.email}</td>
                  <td>
                    <select
                      className="form-input py-1 text-xs w-auto inline-block"
                      value={u.role}
                      onChange={(e) => onUpdate({ id: u.id, role: e.target.value as RbacUser['role'] })}
                    >
                      <option value="admin">admin</option>
                      <option value="operator">operator</option>
                      <option value="viewer">viewer</option>
                    </select>
                  </td>
                  <td>
                    <button
                      onClick={() => onUpdate({ id: u.id, status: u.status === 'active' ? 'disabled' : 'active' })}
                    >
                      {u.status === 'active' ? (
                        <StatusPill tone="success" dot>启用</StatusPill>
                      ) : (
                        <StatusPill tone="neutral" dot>已停用</StatusPill>
                      )}
                    </button>
                  </td>
                  <td className="font-mono text-[12px] text-outline">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '从未'}
                  </td>
                  <td className="text-right">
                    <button
                      onClick={() => {
                        if (confirm(`确定删除用户 ${u.displayName}?`)) onDelete(u.id);
                      }}
                      className="btn-ghost text-error"
                    >
                      <MaterialIcon icon="delete" size="sm" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
