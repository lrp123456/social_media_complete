'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { MaterialIcon, type MaterialIconName } from './MaterialIcon';

export type PillTone = 'success' | 'warning' | 'error' | 'info' | 'pending' | 'primary' | 'neutral';

interface StatusPillProps {
  tone: PillTone;
  icon?: MaterialIconName;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}

const TONE_CLASS: Record<PillTone, string> = {
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  error:   'bg-red-50 text-red-700',
  info:    'bg-blue-50 text-blue-700',
  pending: 'bg-surface-container text-on-surface-variant',
  primary: 'bg-primary/10 text-primary',
  neutral: 'bg-surface-container text-on-surface-variant',
};

const DOT_CLASS: Record<PillTone, string> = {
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error:   'bg-red-500',
  info:    'bg-blue-500',
  pending: 'bg-on-surface-variant',
  primary: 'bg-primary',
  neutral: 'bg-on-surface-variant',
};

/**
 * 状态药丸(对应设计图"Status Pills"组件)
 * 用法:
 *   <StatusPill tone="success" icon="check_circle">有效 (7天)</StatusPill>
 *   <StatusPill tone="warning" dot>即将过期 (2天)</StatusPill>
 */
export function StatusPill({ tone, icon, children, className, dot = false }: StatusPillProps) {
  return (
    <span className={cn('status-pill', TONE_CLASS[tone], className)}>
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full mr-1', DOT_CLASS[tone])} />}
      {icon && <MaterialIcon icon={icon} size="xs" className="mr-1" />}
      {children}
    </span>
  );
}

/** LLM Provider 角色标签(Primary / Fallback) */
export function RoleBadge({ role }: { role: 'primary' | 'fallback_1' | 'fallback_2' | string }) {
  if (role === 'primary') {
    return <StatusPill tone="primary">PRIMARY</StatusPill>;
  }
  if (role === 'fallback_1') {
    return <StatusPill tone="neutral">FALLBACK 1</StatusPill>;
  }
  return <StatusPill tone="neutral">{role.toUpperCase()}</StatusPill>;
}

/** 进度条(1px hairline,设计图大量使用) */
export function MetricBar({
  percent,
  tone = 'primary',
  className,
}: {
  percent: number;
  tone?: 'primary' | 'tertiary' | 'error' | 'success';
  className?: string;
}) {
  const colorMap = {
    primary: 'bg-primary',
    tertiary: 'bg-tertiary-container',
    error: 'bg-error',
    success: 'bg-emerald-500',
  };
  const trackColor = tone === 'error' ? 'bg-error/20' : 'bg-surface-variant';
  return (
    <div className={cn('w-full h-1 rounded-full overflow-hidden', trackColor, className)}>
      <div
        className={cn('h-full transition-all duration-500', colorMap[tone])}
        style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}
      />
    </div>
  );
}

/** Toggle 开关 — 设计图反复出现的开关 */
export function ToggleSwitch({
  checked,
  onChange,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <div className={cn('relative inline-block w-10 mr-2 align-middle select-none', disabled && 'opacity-50 pointer-events-none')}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer z-10 transition-all duration-300 border-outline-variant"
      />
      <label
        htmlFor={id}
        className="toggle-track"
      />
    </div>
  );
}

/** 平台颜色点(账号托管卡里的小圆点) */
export function PlatformDot({ platform, size = 8 }: { platform: string; size?: number }) {
  const colorMap: Record<string, string> = {
    douyin: '#000000',
    xiaohongshu: '#ff2442',
    tencent: '#07c160',
    kuaishou: '#fed91b',
    bilibili: '#fb7299',
    baijiahao: '#ff6f00',
    tiktok: '#111111',
  };
  return (
    <span
      className="rounded-full inline-block shrink-0"
      style={{ width: size, height: size, background: colorMap[platform] || '#6b7280' }}
    />
  );
}
