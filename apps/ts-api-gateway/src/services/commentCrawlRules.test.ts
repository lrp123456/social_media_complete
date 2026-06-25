import {
  getCommentCrawlDecision,
  getRootCidSetForIncremental,
  shouldCompareReplyCounts,
  truncateToNewest,
  ROOT_COMMENT_RETRY_LIMIT,
} from './commentCrawlRules';

describe('getCommentCrawlDecision', () => {
  describe('原有 4 种 reason（回归测试）', () => {
    it('queues a new video with comments as first crawl', () => {
      expect(getCommentCrawlDecision({ currentCount: 3, storedCount: null })).toEqual({
        shouldQueue: true,
        isFirstCrawl: true,
        reason: 'new_video_with_comments',
      });
    });

    it('does not queue a new video with zero comments', () => {
      expect(getCommentCrawlDecision({ currentCount: 0, storedCount: null })).toEqual({
        shouldQueue: false,
        isFirstCrawl: false,
        reason: 'new_video_without_comments',
      });
    });

    it('queues an existing video when comment count increases', () => {
      expect(getCommentCrawlDecision({ currentCount: 8, storedCount: 5 })).toEqual({
        shouldQueue: true,
        isFirstCrawl: false,
        reason: 'comment_count_changed',
      });
    });

    it('queues an existing video when comment count decreases', () => {
      expect(getCommentCrawlDecision({ currentCount: 2, storedCount: 5 })).toEqual({
        shouldQueue: true,
        isFirstCrawl: false,
        reason: 'comment_count_changed',
      });
    });

    it('does not queue an existing video when comment count is unchanged', () => {
      expect(getCommentCrawlDecision({ currentCount: 5, storedCount: 5, rootCommentCount: 5 })).toEqual({
        shouldQueue: false,
        isFirstCrawl: false,
        reason: 'comment_count_unchanged',
      });
    });
  });

  describe('root_comments_missing 新分支', () => {
    it('queues when comment count unchanged but root comments missing and retry under limit', () => {
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: 56,
        rootCommentCount: 0,
        retryCount: 0,
      });
      expect(result).toEqual({
        shouldQueue: true,
        isFirstCrawl: false,
        reason: 'root_comments_missing',
      });
    });

    it('queues when retryCount is below limit', () => {
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: 56,
        rootCommentCount: 0,
        retryCount: ROOT_COMMENT_RETRY_LIMIT - 1,
      });
      expect(result).toEqual({
        shouldQueue: true,
        isFirstCrawl: false,
        reason: 'root_comments_missing',
      });
    });

    it('does not queue when retryCount reaches limit (gives up)', () => {
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: 56,
        rootCommentCount: 0,
        retryCount: ROOT_COMMENT_RETRY_LIMIT,
      });
      expect(result).toEqual({
        shouldQueue: false,
        isFirstCrawl: false,
        reason: 'comment_count_unchanged',
      });
    });

    it('does not trigger when rootCommentCount > 0 (normal unchanged)', () => {
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: 56,
        rootCommentCount: 10,
        retryCount: 0,
      });
      expect(result).toEqual({
        shouldQueue: false,
        isFirstCrawl: false,
        reason: 'comment_count_unchanged',
      });
    });

    it('does not trigger when currentCount is 0', () => {
      const result = getCommentCrawlDecision({
        currentCount: 0,
        storedCount: 0,
        rootCommentCount: 0,
        retryCount: 0,
      });
      expect(result).toEqual({
        shouldQueue: false,
        isFirstCrawl: false,
        reason: 'comment_count_unchanged',
      });
    });

    it('does not trigger for new video (storedCount is null)', () => {
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: null,
        rootCommentCount: 0,
        retryCount: 0,
      });
      expect(result).toEqual({
        shouldQueue: true,
        isFirstCrawl: true,
        reason: 'new_video_with_comments',
      });
    });

    it('defaults rootCommentCount and retryCount to 0 when undefined', () => {
      // 模拟调用方未传这两个参数的场景
      const result = getCommentCrawlDecision({
        currentCount: 56,
        storedCount: 56,
      });
      expect(result).toEqual({
        shouldQueue: true,
        isFirstCrawl: false,
        reason: 'root_comments_missing',
      });
    });
  });
});

describe('truncateToNewest', () => {
  it('returns the newest N items sorted by create_time desc', () => {
    const items = [
      { id: '1', create_time: 100 },
      { id: '2', create_time: 300 },
      { id: '3', create_time: 200 },
      { id: '4', create_time: 500 },
      { id: '5', create_time: 400 },
    ];
    const result = truncateToNewest(items, 3);
    expect(result.map((i) => i.id)).toEqual(['4', '5', '2']);
  });

  it('returns all items (sorted) when fewer than limit', () => {
    const items = [
      { id: '1', create_time: 100 },
      { id: '2', create_time: 300 },
    ];
    const result = truncateToNewest(items, 20);
    expect(result.map((i) => i.id)).toEqual(['2', '1']);
  });

  it('treats missing create_time as 0 (sorted to end) without throwing', () => {
    const items: Array<{ id: string; create_time?: number }> = [
      { id: '1', create_time: 100 },
      { id: '2' },
      { id: '3', create_time: 50 },
    ];
    const result = truncateToNewest(items, 20);
    expect(result.map((i) => i.id)).toEqual(['1', '3', '2']);
  });

  it('returns empty array for empty input', () => {
    expect(truncateToNewest([], 20)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const items = [
      { id: '1', create_time: 100 },
      { id: '2', create_time: 300 },
    ];
    const snapshot = items.map((i) => ({ ...i }));
    truncateToNewest(items, 1);
    expect(items).toEqual(snapshot);
  });
});

describe('snapshot fallback helpers', () => {
  it('uses last snapshot cids when snapshots exist', () => {
    const lastSnapshots = new Map<string, number>([
      ['root-a', 0],
      ['root-b', 2],
    ]);
    const dbAllCids = new Set<string>(['root-a', 'root-c']);
    const currentSnapshots = [{ cid: 'root-a' }, { cid: 'root-b' }, { cid: 'root-c' }];

    expect([...getRootCidSetForIncremental(lastSnapshots, dbAllCids, currentSnapshots)].sort()).toEqual(['root-a', 'root-b']);
    expect(shouldCompareReplyCounts(lastSnapshots)).toBe(true);
  });

  it('falls back to local comment cids when snapshots are missing', () => {
    const lastSnapshots = new Map<string, number>();
    const dbAllCids = new Set<string>(['root-a', 'old-sub-reply']);
    const currentSnapshots = [{ cid: 'root-a' }, { cid: 'root-b' }];

    expect([...getRootCidSetForIncremental(lastSnapshots, dbAllCids, currentSnapshots)].sort()).toEqual(['root-a']);
    expect(shouldCompareReplyCounts(lastSnapshots)).toBe(false);
  });
});
