'use client';

import { useSystemStatus } from '@/hooks/useApi';
import { Activity, Users, MessageCircle, Send } from 'lucide-react';

export default function DashboardPage() {
  const { data: status } = useSystemStatus();

  return (
    <div>
      <h2 className="text-headline-lg mb-1">运营看板</h2>
      <p className="text-sm text-on-surface-variant mb-8">
        系统状态: {status?.status || '未知'} · 服务时间: {status?.timestamp ? new Date(status.timestamp).toLocaleTimeString('zh-CN') : '--'}
      </p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-bento mb-8">
        {[
          { label: '监控用户数', value: '24', sub: '3 平台', icon: Users },
          { label: '今日新评论', value: '1,247', sub: '↑ 12%', icon: MessageCircle },
          { label: '待发布任务', value: '8', sub: '队列中', icon: Send },
          { label: '系统状态', value: '运行中', sub: '正常', icon: Activity },
        ].map((c) => {
          const Icon = c.icon;
          return (
            <div key={c.label} className="bg-white rounded-lg p-6 border border-surface-high">
              <div className="flex items-center gap-2 mb-2">
                <Icon size={18} className="text-on-surface-variant" />
                <p className="text-sm text-on-surface-variant">{c.label}</p>
              </div>
              <p className="text-2xl font-semibold">{c.value}</p>
              <p className="text-xs text-on-surface-variant mt-1">{c.sub}</p>
            </div>
          );
        })}
      </div>

      {/* 快捷入口 */}
      <div className="bg-white rounded-lg border border-surface-high p-6">
        <h3 className="font-semibold mb-4">快捷操作</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Pinterest 采集', href: '/creation', desc: '搜索采集素材' },
            { label: '素材更新', href: '/creation', desc: '切分/评级/归档' },
            { label: '一键发布', href: '/publish', desc: '多平台分发' },
            { label: '系统配置', href: '/settings', desc: 'LLM Keys/选择器' },
          ].map((action) => (
            <a
              key={action.label}
              href={action.href}
              className="block p-4 rounded-lg border border-surface-high hover:border-primary/30 hover:bg-primary/5 transition-colors"
            >
              <p className="text-sm font-medium">{action.label}</p>
              <p className="text-xs text-on-surface-variant mt-1">{action.desc}</p>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
