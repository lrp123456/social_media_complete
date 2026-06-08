'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { MaterialIcon, PlatformIcon } from '@/components/ui/MaterialIcon';
import { BentoCard, Section } from '@/components/ui/Bento';
import { StatusPill } from '@/components/ui/StatusPill';
import {
  useMonitorAccounts,
  useMonitorAccountDetail,
  useNewCommentsOverview,
  useVideoComments,
  useMarkAllCommentsRead,
  type NewCommentVideo,
  type MonitorAccount,
} from '@/hooks/useApi';

/* ── helpers ──────────────────────────────────────────────── */

function relativeTime(ts: string | number) {
  const date = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  return `${days} 天前`;
}

function formatTime(ts: number) {
  const d = new Date(ts * 1000);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const PLATFORM_NAMES: Record<string, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  tencent: '视频号',
  bilibili: 'B站',
  baijiahao: '百家号',
  tiktok: 'TikTok',
};

/* ── types for comment tree ───────────────────────────────── */

interface CommentItem {
  id: number;
  cid: string;
  text: string;
  userNickname: string;
  userUid: string;
  diggCount: number;
  createTime: number;
  replyId: string | null;
  isNew: boolean;
}

interface CommentNode extends CommentItem {
  replies: CommentNode[];
}

function buildCommentTree(flat: CommentItem[]): CommentNode[] {
  const map = new Map<string, CommentNode>();
  const roots: CommentNode[] = [];

  // First pass: create nodes
  for (const item of flat) {
    map.set(item.cid, { ...item, replies: [] });
  }

  // Second pass: link replies
  for (const item of flat) {
    const node = map.get(item.cid)!;
    if (item.replyId && map.has(item.replyId)) {
      const parent = map.get(item.replyId)!;
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/* ── skeleton ─────────────────────────────────────────────── */

function SkeletonBar({ className }: { className?: string }) {
  return <div className={cn('h-4 rounded bg-on-surface-variant/10 animate-pulse', className)} />;
}

/* ── Comment Tree Component ───────────────────────────────── */

function CommentTree({
  videoId,
  onMarkAllRead,
}: {
  videoId: string;
  onMarkAllRead: (videoId: string) => Promise<void>;
}) {
  const { data, isLoading } = useVideoComments(videoId);

  const tree = useMemo(() => {
    if (!data?.data) return [];
    return buildCommentTree(data.data);
  }, [data]);

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        <SkeletonBar className="w-3/4" />
        <SkeletonBar className="w-1/2 ml-6" />
        <SkeletonBar className="w-2/3 ml-6" />
      </div>
    );
  }

  if (tree.length === 0) {
    return (
      <div className="p-6 flex flex-col items-center justify-center text-on-surface-variant">
        <MaterialIcon icon="message" size="2xl" className="opacity-30 mb-2" />
        <p className="font-body text-body-sm">暂无评论</p>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-label-sm text-on-surface-variant">
          共 {data?.data?.length || 0} 条评论
        </span>
        <button
          onClick={() => onMarkAllRead(videoId)}
          className="btn-ghost text-xs py-1 px-2"
        >
          <MaterialIcon icon="done_all" size="xs" />
          全部已读
        </button>
      </div>
      {tree.map((node) => (
        <CommentNodeView key={node.cid} node={node} depth={0} />
      ))}
    </div>
  );
}

function CommentNodeView({ node, depth }: { node: CommentNode; depth: number }) {
  const isRoot = depth === 0;
  const hasReplies = node.replies.length > 0;

  return (
    <div className={cn('relative', !isRoot && 'ml-6')}>
      {/* Connector line for nested replies */}
      {!isRoot && (
        <div className="absolute -left-4 top-0 bottom-0 w-px bg-outline-variant/50" />
      )}

      <div
        className={cn(
          'rounded-md p-3 transition-all duration-200',
          isRoot
            ? 'border-l-2 border-amber-500 bg-surface-container-low/50'
            : 'border-l-2 border-outline-variant/50 bg-surface-container-lowest/80',
          node.isNew && 'bg-amber-50/30',
        )}
      >
        <div className="flex items-start gap-2">
          {/* New indicator dot */}
          {node.isNew && (
            <span className="mt-1.5 w-2 h-2 rounded-full bg-amber-500 shrink-0 animate-pulse-dot" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-label-md text-label-md text-on-surface font-semibold">
                {node.userNickname}
              </span>
              <span className="text-label-sm text-on-surface-variant">
                {formatTime(node.createTime)}
              </span>
              {node.diggCount > 0 && (
                <span className="inline-flex items-center gap-0.5 text-label-sm text-on-surface-variant">
                  <MaterialIcon icon="thumb_up" size="xs" />
                  {node.diggCount}
                </span>
              )}
            </div>
            <p className="font-body text-body-sm text-on-surface mt-1 break-words">
              {node.text}
            </p>
          </div>
        </div>
      </div>

      {/* Replies */}
      {hasReplies && (
        <div className="mt-2 space-y-2">
          {node.replies.map((reply) => (
            <CommentNodeView key={reply.cid} node={reply} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Video Card with Expandable Comments ────────────────── */

function NewCommentVideoCard({
  video,
  isExpanded,
  onToggle,
  onMarkAllRead,
}: {
  video: NewCommentVideo;
  isExpanded: boolean;
  onToggle: () => void;
  onMarkAllRead: (videoId: string) => Promise<void>;
}) {
  return (
    <div className="overflow-hidden">
      <BentoCard
        hover={false}
        className={cn(
          'cursor-pointer transition-all duration-200',
          isExpanded && 'border-primary/30 shadow-floating',
        )}
        onClick={onToggle}
      >
        <div className="flex items-center gap-3">
          <PlatformIcon platform={video.platform as any} size={40} />
          <div className="flex-1 min-w-0">
            <p className="text-label-md text-label-md text-on-surface truncate">
              {video.description || '无标题视频'}
            </p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-label-sm text-on-surface-variant">
                {PLATFORM_NAMES[video.platform] || video.platform}
              </span>
              <span className="text-label-sm text-on-surface-variant">·</span>
              <span className="text-label-sm text-on-surface-variant">
                {relativeTime(video.updatedAt)}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <StatusPill tone="warning" dot>
              +{video.newCommentCount} 新评论
            </StatusPill>
            <MaterialIcon
              icon={isExpanded ? 'expand_less' : 'expand_more'}
              size="lg"
              className={cn(
                'text-on-surface-variant transition-transform duration-200',
                isExpanded && 'rotate-180',
              )}
            />
          </div>
        </div>
      </BentoCard>

      {/* Expandable comment tree */}
      <div
        className={cn(
          'overflow-hidden transition-all duration-300 ease-out',
          isExpanded ? 'max-h-[600px] opacity-100 mt-2' : 'max-h-0 opacity-0',
        )}
      >
        <BentoCard hover={false} className="bg-surface-container-low/50">
          <CommentTree videoId={video.id} onMarkAllRead={onMarkAllRead} />
        </BentoCard>
      </div>
    </div>
  );
}

/* ── Monitor Accounts List ────────────────────────────────── */

function MonitorAccountsSection() {
  const { data: accounts, isLoading } = useMonitorAccounts();

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <BentoCard key={i} hover={false}>
            <div className="flex items-center gap-3">
              <SkeletonBar className="w-10 h-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <SkeletonBar className="w-1/3" />
                <SkeletonBar className="w-1/4" />
              </div>
            </div>
          </BentoCard>
        ))}
      </div>
    );
  }

  const list: MonitorAccount[] = accounts?.data ?? [];

  if (list.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant">
        <MaterialIcon icon="monitoring" size="2xl" className="opacity-30 mb-2" />
        <p className="font-body text-body-sm">暂无监控账号</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {list.map((account) => (
        <MonitorAccountCard key={account.id} account={account} />
      ))}
    </div>
  );
}

function MonitorAccountCard({ account }: { account: MonitorAccount }) {
  const [expanded, setExpanded] = useState(false);
  const { data: detail } = useMonitorAccountDetail(expanded ? account.id : null);

  return (
    <div className="overflow-hidden">
      <BentoCard
        hover={false}
        className={cn('cursor-pointer transition-all', expanded && 'border-primary/30')}
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="flex items-center gap-3">
          <PlatformIcon platform={account.platform as any} size={40} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-label-md text-label-md text-on-surface font-semibold">
                {account.platformName}
              </span>
              <StatusPill tone={account.monitoringEnabled ? 'success' : 'pending'} dot>
                {account.monitoringEnabled ? '监控中' : '已暂停'}
              </StatusPill>
            </div>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-label-sm text-on-surface-variant">
                {account.videoCount} 视频
              </span>
              <span className="text-label-sm text-on-surface-variant">
                {account.totalComments} 评论
              </span>
              {account.newComments > 0 && (
                <StatusPill tone="warning" dot>
                  {account.newComments} 新评论
                </StatusPill>
              )}
            </div>
          </div>
          <MaterialIcon
            icon={expanded ? 'expand_less' : 'expand_more'}
            size="lg"
            className={cn('text-on-surface-variant transition-transform', expanded && 'rotate-180')}
          />
        </div>
      </BentoCard>

      {/* Expanded detail */}
      <div
        className={cn(
          'overflow-hidden transition-all duration-300',
          expanded ? 'max-h-[800px] opacity-100 mt-2' : 'max-h-0 opacity-0',
        )}
      >
        <BentoCard hover={false} className="bg-surface-container-low/30">
          {detail?.data?.videos?.length > 0 ? (
            <div className="space-y-2">
              <p className="text-label-md text-label-md text-on-surface font-semibold mb-2">
                视频列表
              </p>
              {detail.data.videos.map((video: any) => (
                <div
                  key={video.id}
                  className="flex items-center justify-between p-2 rounded bg-surface-container-lowest border border-outline-variant/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-body-sm text-on-surface truncate">
                      {video.description || '无标题'}
                    </p>
                    <p className="text-label-sm text-on-surface-variant">
                      {video.commentCount} 评论
                      {video.newCommentCount > 0 && (
                        <span className="text-amber-600 ml-1">+{video.newCommentCount} 新</span>
                      )}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-body-sm text-on-surface-variant text-center py-4">暂无视频数据</p>
          )}
        </BentoCard>
      </div>
    </div>
  );
}

/* ── New Comments Section ───────────────────────────────── */

function NewCommentsSection() {
  const { data, isLoading } = useNewCommentsOverview();
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const markAllRead = useMarkAllCommentsRead();

  const videos: NewCommentVideo[] = data?.data ?? [];

  const handleToggle = async (videoId: string) => {
    const isOpening = selectedVideoId !== videoId;
    setSelectedVideoId(isOpening ? videoId : null);

    if (isOpening) {
      // Mark all comments for this video as read
      try {
        await markAllRead.mutateAsync({ videoId });
      } catch {
        // Silently fail - the UI will still work
      }
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <BentoCard key={i} hover={false}>
            <div className="flex items-center gap-3">
              <SkeletonBar className="w-10 h-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <SkeletonBar className="w-2/3" />
                <SkeletonBar className="w-1/3" />
              </div>
            </div>
          </BentoCard>
        ))}
      </div>
    );
  }

  if (videos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant">
        <MaterialIcon icon="check_circle" size="2xl" className="opacity-30 mb-2" />
        <p className="font-body text-body-sm">暂无新评论</p>
        <p className="font-body text-body-sm text-on-surface-variant/60 mt-1">
          所有评论已读，监控正常运行
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {videos.map((video) => (
        <NewCommentVideoCard
          key={video.id}
          video={video}
          isExpanded={selectedVideoId === video.id}
          onToggle={() => handleToggle(video.id)}
          onMarkAllRead={async (id) => {
            await markAllRead.mutateAsync({ videoId: id });
          }}
        />
      ))}
    </div>
  );
}

/* ── Main Page ──────────────────────────────────────────── */

export default function MatrixPage() {
  const [activeTab, setActiveTab] = useState<'accounts' | 'comments'>('comments');

  return (
    <div>
      {/* ── Page Header ─────────────────────────────────── */}
      <div className="mb-section-margin">
        <h2 className="text-headline-lg text-headline-lg text-on-surface">矩阵监控中心</h2>
        <p className="font-body text-body-sm text-on-surface-variant mt-1">
          评论监控与发现 · 用户托管
        </p>
      </div>

      {/* ── Tabs ────────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b border-outline-variant mb-section-margin">
        <button
          onClick={() => setActiveTab('comments')}
          className={cn(
            'tab-internal',
            activeTab === 'comments' && 'active',
          )}
        >
          <span className="flex items-center gap-1.5">
            <MaterialIcon icon="notifications" size="sm" />
            新评论发现
          </span>
        </button>
        <button
          onClick={() => setActiveTab('accounts')}
          className={cn(
            'tab-internal',
            activeTab === 'accounts' && 'active',
          )}
        >
          <span className="flex items-center gap-1.5">
            <MaterialIcon icon="monitoring" size="sm" />
            监控账号
          </span>
        </button>
      </div>

      {/* ── Tab Content ─────────────────────────────────── */}
      {activeTab === 'comments' ? (
        <Section
          title="新评论视频"
          subtitle="点击视频卡片查看完整评论树，自动标记已读"
        >
          <NewCommentsSection />
        </Section>
      ) : (
        <Section
          title="监控账号"
          subtitle="所有平台监控账号状态"
        >
          <MonitorAccountsSection />
        </Section>
      )}
    </div>
  );
}
