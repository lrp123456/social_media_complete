import { truncateToNewest, getCommentCrawlDecision } from '../commentCrawlRules';

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

describe('getCommentCrawlDecision (regression)', () => {
  it('new video with comments queues first crawl', () => {
    const d = getCommentCrawlDecision({ currentCount: 5, storedCount: undefined });
    expect(d).toEqual({ shouldQueue: true, isFirstCrawl: true, reason: 'new_video_with_comments' });
  });

  it('existing video unchanged count does not queue', () => {
    const d = getCommentCrawlDecision({ currentCount: 5, storedCount: 5 });
    expect(d).toEqual({ shouldQueue: false, isFirstCrawl: false, reason: 'comment_count_unchanged' });
  });
});
