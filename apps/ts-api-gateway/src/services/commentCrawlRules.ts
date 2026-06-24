export type CommentCrawlDecisionReason =
  | 'new_video_with_comments'
  | 'new_video_without_comments'
  | 'comment_count_changed'
  | 'comment_count_unchanged';

export interface CommentCrawlDecision {
  shouldQueue: boolean;
  isFirstCrawl: boolean;
  reason: CommentCrawlDecisionReason;
}

export function getCommentCrawlDecision(input: {
  currentCount: number;
  storedCount: number | null | undefined;
}): CommentCrawlDecision {
  const currentCount = Number(input.currentCount || 0);
  const storedCount = input.storedCount;

  if (storedCount === null || storedCount === undefined) {
    if (currentCount > 0) {
      return { shouldQueue: true, isFirstCrawl: true, reason: 'new_video_with_comments' };
    }
    return { shouldQueue: false, isFirstCrawl: false, reason: 'new_video_without_comments' };
  }

  if (currentCount !== storedCount) {
    return { shouldQueue: true, isFirstCrawl: false, reason: 'comment_count_changed' };
  }

  return { shouldQueue: false, isFirstCrawl: false, reason: 'comment_count_unchanged' };
}

export function shouldCompareReplyCounts(lastSnapshots: Map<string, number>): boolean {
  return lastSnapshots.size > 0;
}

export function getRootCidSetForIncremental(
  lastSnapshots: Map<string, number>,
  dbAllCids: Set<string>,
  currentSnapshots: Array<{ cid: string }>,
): Set<string> {
  if (lastSnapshots.size > 0) {
    return new Set(lastSnapshots.keys());
  }

  const currentRootCids = new Set(currentSnapshots.map((s) => s.cid));
  return new Set([...dbAllCids].filter((cid) => currentRootCids.has(cid)));
}

/**
 * 按 create_time 倒序取最新 limit 条。
 * create_time 缺失按 0 处理（排到末尾），不抛异常。不修改入参数组。
 */
export function truncateToNewest<T extends { create_time?: number }>(
  items: T[],
  limit: number,
): T[] {
  return [...items]
    .sort((a, b) => (b.create_time ?? 0) - (a.create_time ?? 0))
    .slice(0, limit);
}
