export default function DashboardPage() {
  return (
    <div>
      <h2 className="text-headline-lg mb-6">运营看板</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-bento mb-8">
        {[
          { label: '监控用户数', value: '24', sub: '3 平台' },
          { label: '今日新评论', value: '1,247', sub: '↑ 12%' },
          { label: '待发布任务', value: '8', sub: '队列中' },
          { label: '系统状态', value: '运行中', sub: '正常' },
        ].map((c) => (
          <div key={c.label} className="bg-white rounded-lg p-6 border border-surface-high">
            <p className="text-sm text-on-surface-variant">{c.label}</p>
            <p className="text-2xl font-semibold mt-2">{c.value}</p>
            <p className="text-xs text-on-surface-variant mt-1">{c.sub}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
