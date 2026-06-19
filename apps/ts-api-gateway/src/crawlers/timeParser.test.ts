import { parseDomTimestamp, isTimestampMatch, isDescriptionMatch } from './timeParser';

describe('parseDomTimestamp', () => {
  it('douyin: 发布于2026年05月25日 14:43', () => {
    const ts = parseDomTimestamp('some text 发布于2026年05月25日 14:43 more text', 'douyin');
    expect(ts).toBe(Math.floor(new Date('2026-05-25T14:43:00+08:00').getTime() / 1000));
  });

  it('kuaishou: 2026-05-28 09:03:19', () => {
    const ts = parseDomTimestamp('title 2026-05-28 09:03:19 detail', 'kuaishou');
    expect(ts).toBe(Math.floor(new Date('2026-05-28T09:03:19+08:00').getTime() / 1000));
  });

  it('xiaohongshu: 2026-06-18 18:01', () => {
    const ts = parseDomTimestamp('title 2026-06-18 18:01 stats', 'xiaohongshu');
    expect(ts).toBe(Math.floor(new Date('2026-06-18T18:01:00+08:00').getTime() / 1000));
  });

  it('tencent: 2026/06/13 13:58', () => {
    const ts = parseDomTimestamp('title 2026/06/13 13:58 stats', 'tencent');
    expect(ts).toBe(Math.floor(new Date('2026-06-13T13:58:00+08:00').getTime() / 1000));
  });

  it('returns null when no time found', () => {
    expect(parseDomTimestamp('no time here', 'douyin')).toBeNull();
  });

  it('returns null for unknown platform', () => {
    expect(parseDomTimestamp('2026-01-01 00:00', 'unknown')).toBeNull();
  });
});

describe('isTimestampMatch', () => {
  it('exact match', () => {
    expect(isTimestampMatch(1000, 1000, 60)).toBe(true);
  });

  it('within tolerance', () => {
    expect(isTimestampMatch(1000, 1059, 60)).toBe(true);
  });

  it('outside tolerance', () => {
    expect(isTimestampMatch(1000, 1061, 60)).toBe(false);
  });
});

describe('isDescriptionMatch', () => {
  it('matches prefix', () => {
    expect(isDescriptionMatch('title: #好心情从欣赏美景开始 more', '#好心情从欣赏美景开始')).toBe(true);
  });

  it('no match', () => {
    expect(isDescriptionMatch('title: #其他内容 more', '#好心情从欣赏美景开始')).toBe(false);
  });

  it('empty description always matches', () => {
    expect(isDescriptionMatch('anything', '')).toBe(true);
  });
});
