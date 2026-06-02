'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard, Settings, MonitorPlay, Send, Wand2,
} from 'lucide-react';

const navItems = [
  { href: '/',           label: '运营看板', icon: LayoutDashboard },
  { href: '/matrix',     label: '矩阵运营中心', icon: MonitorPlay },
  { href: '/creation',   label: '智能创作', icon: Wand2 },
  { href: '/publish',    label: '一键发布', icon: Send },
  { href: '/settings',   label: '系统设置', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 h-screen bg-white border-r border-surface-high flex flex-col">
      {/* Logo */}
      <div className="px-5 py-6 border-b border-surface-high">
        <h1 className="text-lg font-semibold text-primary">矩阵智能运营系统</h1>
        <p className="text-xs text-on-surface-variant mt-1">Social Media Matrix</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant hover:bg-surface hover:text-on-surface',
              )}
            >
              <Icon size={20} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-4 border-t border-surface-high text-xs text-on-surface-variant">
        v3.0.0 · Matrix Platform
      </div>
    </aside>
  );
}
