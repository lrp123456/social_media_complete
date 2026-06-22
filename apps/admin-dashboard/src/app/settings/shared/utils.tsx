import { StatusPill } from '@/components/ui/StatusPill';

export function statusPillFor(status: string) {
  if (status === 'SUCCESS') return <StatusPill tone="success">{status}</StatusPill>;
  if (status === 'WARN') return <StatusPill tone="warning">{status}</StatusPill>;
  return <StatusPill tone="error">{status}</StatusPill>;
}

export const maskKey = (key: string) => {
  if (!key || key.length < 8) return '********';
  return key.slice(0, 3) + '...' + key.slice(-4);
};
