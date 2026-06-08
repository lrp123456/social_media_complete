'use client';

import type { ReactNode, HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Bento 主卡片 — 设计图里 12 栅格里最常用的容器 */
export function BentoCard({
  children,
  className,
  hover = true,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'bg-surface-container-lowest border border-outline-variant rounded-md p-inner-component-padding transition-all duration-200',
        hover && 'hover:border-primary/50',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** 段节容器(带标题 + 副标题 + 右上角操作) */
export function Section({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('mb-section-margin', className)}>
      <div className="flex items-end justify-between mb-stack-md">
        <div>
          <h2 className="text-headline-md text-headline-md text-on-surface">{title}</h2>
          {subtitle && (
            <p className="font-body text-body-sm text-on-surface-variant mt-1">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 段节卡片(带 padding 内部 + 浅边框容器) */
export function SectionCard({
  children,
  className,
  noPadding,
}: {
  children: ReactNode;
  className?: string;
  noPadding?: boolean;
}) {
  return (
    <div
      className={cn(
        'bg-surface-container-lowest border border-outline-variant rounded-md overflow-hidden',
        !noPadding && 'p-inner-component-padding',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 头部小卡(深色或浅色,用于 Bento 顶部信息带) */
export function HeaderStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'p-inner-component-padding border-b border-outline-variant flex justify-between items-center bg-surface/50',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 1px 状态条(Bento 容器左侧强调色,设计图大量使用) */
export function AccentBar({ color = 'primary', className }: { color?: 'primary' | 'tertiary' | 'error' | 'success'; className?: string }) {
  const map = {
    primary: 'bg-primary',
    tertiary: 'bg-tertiary-container',
    error: 'bg-error',
    success: 'bg-emerald-500',
  };
  return (
    <div className={cn('absolute left-0 top-0 bottom-0 w-1', map[color], className)} />
  );
}
