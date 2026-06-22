import { StatusPill, type PillTone } from '@/components/ui/StatusPill';
import { MaterialIcon, type MaterialIconName } from '@/components/ui/MaterialIcon';

export function StrategyBadge({ strategy, carrier }: { strategy: string; carrier: string }) {
  const toneMap: Record<string, PillTone> = {
    restart: 'warning',
    hot: 'success',
    cold: 'info',
    instant: 'primary',
    readonly: 'neutral',
  };
  const iconMap: Record<string, MaterialIconName> = {
    restart: 'replay',
    hot: 'trending_up',
    cold: 'cloud',
    instant: 'bolt',
    readonly: 'visibility',
  };
  const labelMap: Record<string, string> = {
    restart: '重启更新',
    hot: '热更新',
    cold: '冷更新',
    instant: '即时路由热轮换',
    readonly: '只读历史流',
  };
  const tone = toneMap[strategy] || 'neutral';
  const icon = iconMap[strategy] || 'info';
  const label = labelMap[strategy] || strategy;
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[11px] text-on-surface-variant hidden md:inline">{carrier}</span>
      <StatusPill tone={tone} icon={icon}>{label}</StatusPill>
    </div>
  );
}
