'use client';

import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Material Symbols 图标封装
 * 设计图全部使用 material-symbols-outlined 字符实体
 * 用法:
 *   <MaterialIcon icon="terminal" />
 *   <MaterialIcon icon="database" fill size="lg" />
 *   <MaterialIcon icon="settings" className="text-primary" />
 */
export type MaterialIconName =
  // 通用
  | 'search' | 'notifications' | 'help' | 'apps' | 'close' | 'check' | 'chevron_left' | 'chevron_right'
  | 'expand_more' | 'expand_less' | 'arrow_back' | 'arrow_forward' | 'more_horiz' | 'refresh' | 'filter_list'
  | 'sort' | 'download' | 'upload' | 'send' | 'play_arrow' | 'add' | 'edit' | 'delete' | 'save' | 'settings'
  | 'sync' | 'auto_awesome' | 'movie' | 'tune' | 'monitoring' | 'terminal' | 'psychology' | 'admin_panel_settings'
  | 'campaign' | 'database' | 'memory' | 'router' | 'bolt' | 'cloud_upload' | 'videocam' | 'book' | 'check_circle'
  | 'error' | 'reply' | 'play_circle' | 'done_all' | 'thumb_up' | 'campaign' | 'language' | 'light_mode'
  | 'logout' | 'person' | 'dashboard' | 'analytics' | 'message' | 'image' | 'visibility' | 'shield' | 'lock'
  | 'history' | 'public' | 'people' | 'tag' | 'attach_file' | 'schedule' | 'event' | 'calendar_today' | 'star'
  | 'verified' | 'trending_up' | 'warning' | 'info' | 'play_arrow' | 'volume_up' | 'mic' | 'construction'
  | 'pause' | 'stop' | 'fast_forward' | 'replay' | 'shuffle' | 'repeat' | 'queue_music' | 'movie_filter' | 'movie_creation'
  | 'logout' | 'menu' | 'input' | 'output' | 'rocket_launch' | 'science' | 'style' | 'auto_fix_high' | 'graphic_eq'
  | 'work' | 'label' | 'inventory_2' | 'pending' | 'priority_high' | 'cloud' | 'storage' | 'link' | 'content_copy'
  | 'open_in_new' | 'visibility_off' | 'music_note'
  | 'cloud_download' | 'wall_art' | 'bookmark' | 'link_off' | 'bug_report';

export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';

interface MaterialIconProps {
  icon: MaterialIconName;
  size?: IconSize;
  fill?: boolean;
  spin?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  title?: string;
}

const SIZE_CLASS: Record<IconSize, string> = {
  xs:  'icon-xs',   // 14
  sm:  'icon-sm',   // 16
  md:  'icon-md',   // 18
  lg:  'icon-lg',   // 20
  xl:  'icon-xl',   // 24
  '2xl': 'icon-2xl', // 32
  '3xl': 'icon-3xl', // 40
};

export function MaterialIcon({
  icon,
  size = 'md',
  fill = false,
  spin = false,
  className,
  style,
  onClick,
  title,
}: MaterialIconProps) {
  return (
    <span
      className={cn(
        'material-symbols-outlined',
        SIZE_CLASS[size],
        fill && 'fill',
        spin && 'animate-spin-slow',
        onClick && 'cursor-pointer',
        className,
      )}
      style={style}
      onClick={onClick}
      title={title}
      aria-hidden={!title}
      role={onClick ? 'button' : undefined}
    >
      {icon}
    </span>
  );
}

/** 平台账号图标(用品牌色 + 圆形) */
export function PlatformIcon({
  platform,
  size = 48,
  className,
}: {
  platform: 'douyin' | 'xiaohongshu' | 'tencent' | 'kuaishou' | 'bilibili' | 'baijiahao' | 'tiktok';
  size?: number;
  className?: string;
}) {
  const colorMap: Record<string, string> = {
    douyin:      '#000000',
    xiaohongshu: '#ff2442',
    tencent:     '#07c160',
    kuaishou:    '#fed91b',
    bilibili:    '#fb7299',
    baijiahao:   '#ff6f00',
    tiktok:      '#111111',
  };
  const iconMap: Record<string, MaterialIconName> = {
    douyin:      'play_arrow',
    xiaohongshu: 'book',
    tencent:     'videocam',
    kuaishou:    'movie_filter',
    bilibili:    'movie_creation',
    baijiahao:   'language',
    tiktok:      'music_note',
  };

  return (
    <div
      className={cn(
        'rounded-full bg-surface overflow-hidden border border-outline-variant flex items-center justify-center shrink-0',
        className,
      )}
      style={{ width: size, height: size, color: colorMap[platform] }}
    >
      <MaterialIcon icon={iconMap[platform] || 'language'} size={size >= 40 ? 'xl' : 'md'} />
    </div>
  );
}

/** 占位头像(用户首字母) */
export function Avatar({ name, size = 32, color }: { name: string; size?: number; color?: string }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  const bg = color || 'var(--primary-container)';
  const fg = color ? 'white' : 'var(--on-primary)';
  return (
    <div
      className="rounded-full flex items-center justify-center font-bold shrink-0"
      style={{
        width: size,
        height: size,
        background: bg,
        color: fg,
        fontSize: size * 0.4,
      }}
    >
      {initial}
    </div>
  );
}

/** 图标按钮圆形封装(用于顶栏右上角图标按钮) */
export function IconButton({
  icon,
  size = 'lg',
  badge,
  className,
  onClick,
  title,
}: {
  icon: MaterialIconName;
  size?: IconSize;
  badge?: boolean;
  className?: string;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'btn-icon relative',
        className,
      )}
    >
      <MaterialIcon icon={icon} size={size} />
      {badge && (
        <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-error rounded-full" />
      )}
    </button>
  );
}
