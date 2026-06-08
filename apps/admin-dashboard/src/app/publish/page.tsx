'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * /publish 路由已合并到 /matrix 的 "一键发布管理" Tab 中。
 * 此页面自动重定向到 /matrix。
 */
export default function PublishRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/matrix');
  }, [router]);

  return null;
}
