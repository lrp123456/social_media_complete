'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useState } from 'react';
import { MaterialIcon, IconButton, Avatar } from '@/components/ui/MaterialIcon';

const PAGE_TITLE: Record<string, string> = {
  '/':         '运营看板',
  '/matrix':   '矩阵评论监控与发现',
  '/publish':  '一键发布与账号托管',
  '/creation': '智能创作工作台',
  '/settings': '系统设置中心',
};

export function TopBar() {
  const router = useRouter();
  const pathname = usePathname();
  const title = PAGE_TITLE[pathname] || PAGE_TITLE[Object.keys(PAGE_TITLE).find((k) => k !== '/' && pathname.startsWith(k)) || '/'] || '矩阵智能运营系统';
  const [search, setSearch] = useState('');

  return (
    <header className="h-16 bg-surface-container-lowest border-b border-outline-variant flex items-center justify-between px-4 md:px-6 shrink-0 gap-4">
      {/* 左:页标题(移动端) + 搜索(桌面) */}
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <h2 className="text-headline-md text-headline-md-mobile text-on-surface md:hidden truncate">{title}</h2>

        <div className="hidden md:flex items-center bg-surface-container-low rounded-full px-4 py-2 border border-outline-variant focus-within:border-primary focus-within:ring-2 ring-primary/20 transition-all w-80 max-w-full">
          <MaterialIcon icon="search" size="md" className="text-on-surface-variant mr-2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent border-none focus:ring-0 text-body-sm font-body w-full placeholder:text-on-surface-variant/60 outline-none text-on-surface"
            placeholder="搜索任务、素材、配置..."
            type="text"
          />
        </div>
      </div>

      {/* 右:通知 / 帮助 / 应用 / 头像 */}
      <div className="flex items-center gap-1 md:gap-2">
        <IconButton icon="notifications" badge title="通知" />
        <IconButton icon="help" title="帮助" />
        <IconButton icon="apps" title="应用" className="hidden md:inline-flex" />
        <div className="w-px h-6 bg-outline-variant mx-1 hidden md:block" />
        <button
          onClick={() => router.push('/settings')}
          className="w-8 h-8 rounded-full overflow-hidden border border-outline-variant cursor-pointer hover:ring-2 ring-primary/30 transition-all ml-1"
        >
          <Avatar name="A" size={32} />
        </button>
      </div>
    </header>
  );
}
