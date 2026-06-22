'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { MaterialIcon, type MaterialIconName } from '@/components/ui/MaterialIcon';

interface NavItem {
  href: string;
  label: string;
  icon: MaterialIconName;
}

// 设计图使用 icon-only 侧栏 + 展开文本栏的二级导航
// 这里采用"图标窄列 + 文本展开"的二段式:窄列固定 64px,文本栏根据 collapse 状态伸缩
const navItems: NavItem[] = [
  { href: '/',         label: '运营看板',   icon: 'dashboard' },
  { href: '/material', label: '素材更新',   icon: 'inventory_2' },
  { href: '/creation', label: '智能创作',   icon: 'auto_awesome' },
  { href: '/matrix',              label: '社媒矩阵',   icon: 'public' },
  { href: '/settings',            label: '系统设置',   icon: 'settings' },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // 最长前缀匹配：精确匹配 > 最长 startsWith 前缀 > 无匹配
  // 避免 /settings/selectors 同时激活 /settings 和 /settings/selectors
  const activeHref = (() => {
    // 精确匹配优先
    for (const item of navItems) {
      if (pathname === item.href) return item.href;
    }
    // 最长前缀匹配（仅对子路径生效，排除根路径）
    let best = '';
    for (const item of navItems) {
      if (item.href !== '/' && pathname.startsWith(item.href + '/') && item.href.length > best.length) {
        best = item.href;
      }
    }
    return best;
  })();

  return (
    <aside
      className={cn(
        'h-screen bg-surface-container-lowest border-r border-outline-variant flex flex-col shrink-0 transition-all duration-300',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      {/* Logo 区域 */}
      <div className={cn(
        'h-16 flex items-center border-b border-outline-variant shrink-0',
        collapsed ? 'justify-center px-0' : 'px-5 gap-3',
      )}>
        <div className="w-9 h-9 rounded-md bg-primary-container text-on-primary flex items-center justify-center shrink-0">
          <MaterialIcon icon="bolt" size="lg" fill />
        </div>
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <h1 className="text-body-md font-semibold text-on-surface truncate">矩阵运营</h1>
            <p className="text-label-sm text-on-surface-variant">Matrix Platform</p>
          </div>
        )}
      </div>

      {/* 一级导航:图标列(始终可见) */}
      <nav className="flex-1 py-3 flex flex-col gap-1">
        {navItems.map((item) => {
          const active = item.href === activeHref;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'relative flex items-center gap-3 mx-3 px-3 py-2.5 rounded-md text-body-sm font-medium transition-colors',
                collapsed && 'justify-center px-0 mx-2',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface',
              )}
              title={collapsed ? item.label : undefined}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary-container rounded-r-full" />
              )}
              <MaterialIcon icon={item.icon} size="md" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* 底部:折叠开关 + 状态 */}
      <div className={cn('border-t border-outline-variant p-3', collapsed && 'px-2')}>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className={cn(
            'btn-ghost w-full',
            collapsed && 'justify-center px-0',
          )}
          title={collapsed ? '展开' : '折叠'}
        >
          <MaterialIcon icon={collapsed ? 'chevron_right' : 'chevron_left'} size="sm" />
          {!collapsed && <span>收起侧栏</span>}
        </button>
        {!collapsed && (
          <div className="mt-3 px-2 text-label-sm text-on-surface-variant">
            <p>v3.0.0</p>
            <p className="flex items-center gap-1 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse-dot" />
              系统正常
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
