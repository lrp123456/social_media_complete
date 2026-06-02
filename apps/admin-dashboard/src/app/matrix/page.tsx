'use client';

import { useState } from 'react';
import { Search, MessageCircle, Eye } from 'lucide-react';

const MOCK_USERS = [
  { id: 1, name: '@用户A', platform: 'douyin', videos: 45, comments: 328, status: '监控中' },
  { id: 2, name: '@创作者B', platform: 'kuaishou', videos: 32, comments: 215, status: '监控中' },
  { id: 3, name: '@博主C', platform: 'xiaohongshu', videos: 28, comments: 156, status: '暂停' },
];

export default function MatrixPage() {
  const [search, setSearch] = useState('');

  return (
    <div>
      <h2 className="text-headline-lg mb-1">矩阵运营中心</h2>
      <p className="text-sm text-on-surface-variant mb-8">评论监控与发现 · 用户托管</p>

      {/* Search */}
      <div className="relative mb-6">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
        <input
          type="text"
          placeholder="搜索监控用户..."
          className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-surface-high text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Users Table */}
      <div className="bg-white rounded-lg border border-surface-high overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface text-on-surface-variant">
            <tr>
              <th className="text-left px-4 py-3">用户</th>
              <th className="text-left px-4 py-3">平台</th>
              <th className="text-right px-4 py-3">视频数</th>
              <th className="text-right px-4 py-3">评论数</th>
              <th className="text-center px-4 py-3">状态</th>
              <th className="text-right px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {MOCK_USERS.filter((u) => u.name.includes(search)).map((u) => (
              <tr key={u.id} className="border-t border-surface-high hover:bg-surface/50">
                <td className="px-4 py-3 font-medium">{u.name}</td>
                <td className="px-4 py-3 text-on-surface-variant">{u.platform}</td>
                <td className="px-4 py-3 text-right">{u.videos}</td>
                <td className="px-4 py-3 text-right">{u.comments}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                    u.status === '监控中' ? 'bg-green-100 text-green-700' : 'bg-surface text-on-surface-variant'
                  }`}>{u.status}</span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button className="inline-flex items-center gap-1 text-primary hover:underline text-xs">
                    <MessageCircle size={14} /> 评论
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
