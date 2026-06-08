'use client';

import Link from 'next/link';
import { MaterialIcon } from '@/components/ui/MaterialIcon';
import { BentoCard } from '@/components/ui/Bento';
import { StatusPill } from '@/components/ui/StatusPill';
import { useSystemOverview } from '@/hooks/useApi';
import { cn } from '@/lib/utils';

/* ── helpers ──────────────────────────────────────────────── */

function statusConfig(s: 'normal' | 'degraded' | 'error') {
  switch (s) {
    case 'normal':
      return { text: '运行正常', tone: 'success' as const };
    case 'degraded':
      return { text: '性能降级', tone: 'warning' as const };
    case 'error':
      return { text: '服务异常', tone: 'error' as const };
  }
}

function relativeTime(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  return `${days} 天前`;
}

function actionColor(action: string) {
  if (action.includes('发布')) return 'bg-primary';
  if (action.includes('创作') || action.includes('合成')) return 'bg-tertiary-container';
  if (action.includes('监控') || action.includes('采集')) return 'bg-blue-500';
  return 'bg-on-surface-variant';
}

/* ── skeleton ─────────────────────────────────────────────── */

function SkeletonBar({ className }: { className?: string }) {
  return <div className={cn('h-4 rounded bg-on-surface-variant/10 animate-pulse', className)} />;
}

/* ── main ─────────────────────────────────────────────────── */

export default function DashboardPage() {
  const { data, isLoading } = useSystemOverview();

  const monitorUsers = data?.monitorUsers ?? 0;
  const todayNewComments = data?.todayNewComments ?? 0;
  const pendingPublishTasks = data?.pendingPublishTasks ?? 0;
  const systemStatus = data?.systemStatus ?? 'normal';
  const recentActivities = data?.recentActivities ?? [];

  const sys = statusConfig(systemStatus);

  /* ── KPI cards data ────────────────────────────────────── */
  const kpis = [
    {
      icon: 'people' as const,
      label: '监控用户数',
      value: monitorUsers.toLocaleString('zh-CN'),
      sub: '个平台',
    },
    {
      icon: 'message' as const,
      label: '今日新评论',
      value: todayNewComments.toLocaleString('zh-CN'),
      sub: '今日新增',
    },
    {
      icon: 'send' as const,
      label: '待发布任务',
      value: pendingPublishTasks.toLocaleString('zh-CN'),
      sub: '队列中',
    },
    {
      icon: 'check_circle' as const,
      label: '系统状态',
      value: sys.text,
      sub: '__status_pill__' as const,
      fill: true,
    },
  ];

  /* ── quick actions ─────────────────────────────────────── */
  const actions = [
    {
      icon: 'auto_awesome' as const,
      title: '智能创作',
      desc: 'AI 视频合成与脚本生成',
      href: '/creation',
    },
    {
      icon: 'analytics' as const,
      title: '矩阵监控',
      desc: '评论监控与互动发现',
      href: '/matrix',
    },
    {
      icon: 'send' as const,
      title: '一键发布',
      desc: '多平台视频分发',
      href: '/publish',
    },
    {
      icon: 'settings' as const,
      title: '系统设置',
      desc: 'LLM 凭证与环境配置',
      href: '/settings',
    },
  ];

  return (
    <div>
      {/* ── Page Header ─────────────────────────────────── */}
      <div className="mb-section-margin">
        <h2 className="text-headline-lg text-headline-lg text-on-surface">运营看板</h2>
        <p className="font-body text-body-sm text-on-surface-variant mt-1">系统概览与快捷操作</p>
      </div>

      {/* ── Row 1: KPI Cards ─────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-bento mb-section-margin">
        {kpis.map((kpi, i) => (
          <BentoCard
            key={kpi.label}
            className={cn('animate-fade-in')}
            style={{ animationDelay: `${i * 50}ms` }}
          >
            {isLoading ? (
              <div className="space-y-3">
                <SkeletonBar className="w-1/2" />
                <SkeletonBar className="w-3/4 h-7" />
                <SkeletonBar className="w-1/3" />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <MaterialIcon
                    icon={kpi.icon}
                    size="lg"
                    fill={'fill' in kpi && kpi.fill}
                    className="text-on-surface-variant"
                  />
                  <span className="font-body text-body-sm text-on-surface-variant">
                    {kpi.label}
                  </span>
                </div>
                <p className="text-headline-lg text-headline-lg text-on-surface mt-2">
                  {kpi.value}
                </p>
                {kpi.sub === '__status_pill__' ? (
                  <StatusPill tone={sys.tone} dot className="mt-1">
                    {sys.text}
                  </StatusPill>
                ) : (
                  <p className="font-body text-body-sm text-on-surface-variant mt-1">
                    {kpi.sub}
                  </p>
                )}
              </>
            )}
          </BentoCard>
        ))}
      </div>

      {/* ── Row 2: Quick Actions ─────────────────────────── */}
      <div className="mb-section-margin">
        <h3 className="text-headline-md text-headline-md text-on-surface mb-bento">
          快捷操作
        </h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-bento">
          {actions.map((action) => (
            <Link key={action.href} href={action.href} className="block">
              <BentoCard hover className="group flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <MaterialIcon
                    icon={action.icon}
                    size="lg"
                    className="text-on-surface-variant mb-2"
                  />
                  <p className="text-label-md text-label-md text-on-surface">{action.title}</p>
                  <p className="font-body text-body-sm text-on-surface-variant mt-1">
                    {action.desc}
                  </p>
                </div>
                <MaterialIcon
                  icon="arrow_forward"
                  size="sm"
                  className="text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity mt-1 shrink-0"
                />
              </BentoCard>
            </Link>
          ))}
        </div>
      </div>

      {/* ── Row 3: Recent Activity ───────────────────────── */}
      <BentoCard hover={false}>
        <div className="flex items-center gap-2 mb-bento">
          <MaterialIcon icon="history" size="lg" className="text-on-surface-variant" />
          <h3 className="text-headline-md text-headline-md text-on-surface">最近活动</h3>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 pl-4">
                <SkeletonBar className="w-2 h-2 rounded-full shrink-0" />
                <SkeletonBar className="flex-1" />
              </div>
            ))}
          </div>
        ) : recentActivities.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-on-surface-variant">
            <MaterialIcon icon="history" size="2xl" className="opacity-30 mb-2" />
            <p className="font-body text-body-sm">暂无活动记录</p>
          </div>
        ) : (
          <div className="border-l-2 border-outline-variant ml-1">
            {recentActivities.map((act: any) => (
              <div key={act.id} className="relative pl-6 pb-4 last:pb-0">
                {/* timeline dot */}
                <span
                  className={cn(
                    'absolute -left-[5px] top-1 w-2.5 h-2.5 rounded-full border-2 border-surface-container-lowest',
                    actionColor(act.action),
                  )}
                />
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-label-md text-label-md text-on-surface">
                    {act.actor}
                  </span>
                  <span className="font-body text-body-sm text-on-surface-variant">
                    {act.action}
                  </span>
                  <span className="font-body text-body-sm text-on-surface-variant ml-auto shrink-0">
                    {relativeTime(act.timestamp)}
                  </span>
                </div>
                {act.detail && (
                  <p className="font-body text-body-sm text-on-surface-variant mt-0.5">
                    {act.detail}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </BentoCard>
    </div>
  );
}
