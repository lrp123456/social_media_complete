'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  // 默认 retry=3 + 指数退避 (1s/2s/4s) 会让每个失败 API 拖到 ~7s 才返回 fallback,
  // 切到 retry=1 + 500ms 短退避, 既给瞬时网络波动留余地, 又不会让用户面对一片假死。
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: 1,
            retryDelay: 500,
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
