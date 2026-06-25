export type KuaishouDrawerStopReason = 'empty-list' | 'no-growth-past-target';

export interface KuaishouDrawerStopInput {
  itemCount: number;
  emptyRounds: number;
  noGrowthRounds: number;
  hasScrolled: boolean;
  minTimestamp: number | null;
  targetCreateTime: number;
  tolerance: number;
}

export interface KuaishouDrawerStopDecision {
  stop: boolean;
  reason?: KuaishouDrawerStopReason;
}

export function normalizeKuaishouVideoText(text: string): string {
  return String(text || '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function isKuaishouDrawerVideoTextMatch(domText: string, targetDescription: string): boolean {
  const normalizedDom = normalizeKuaishouVideoText(domText);
  const normalizedTarget = normalizeKuaishouVideoText(targetDescription);

  if (!normalizedDom || !normalizedTarget) return false;

  const primaryPrefix = normalizedTarget.slice(0, Math.min(20, normalizedTarget.length));
  if (primaryPrefix.length >= 8 && normalizedDom.includes(primaryPrefix)) return true;

  const shortPrefix = normalizedTarget.slice(0, Math.min(10, normalizedTarget.length));
  if (shortPrefix.length >= 6 && normalizedDom.includes(shortPrefix)) return true;

  const hashtagParts = normalizedTarget
    .split('#')
    .map(part => part.trim())
    .filter(part => part.length >= 4)
    .map(part => `#${part}`);

  return hashtagParts.some(part => normalizedDom.includes(part));
}

export function shouldStopKuaishouDrawerSearch(input: KuaishouDrawerStopInput): KuaishouDrawerStopDecision {
  if (input.itemCount === 0 && input.emptyRounds >= 2) {
    return { stop: true, reason: 'empty-list' };
  }

  const passedTargetWindow = input.minTimestamp !== null
    && Number.isFinite(input.minTimestamp)
    && input.minTimestamp < input.targetCreateTime - input.tolerance;

  if (input.itemCount > 0 && input.hasScrolled && input.noGrowthRounds >= 2 && passedTargetWindow) {
    return { stop: true, reason: 'no-growth-past-target' };
  }

  return { stop: false };
}
