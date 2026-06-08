import type { Metadata } from 'next';
import { Providers } from '@/components/Providers';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import './globals.css';

export const metadata: Metadata = {
  title: '矩阵智能运营系统',
  description: '社交媒体矩阵运营平台',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            <div className="flex-1 flex flex-col min-w-0">
              <TopBar />
              <main className="flex-1 overflow-y-auto bg-surface">
                <div className="p-4 md:p-container-padding max-w-[1600px] mx-auto">
                  {children}
                </div>
              </main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
