import {
  isKuaishouDrawerVideoTextMatch,
  normalizeKuaishouVideoText,
  shouldStopKuaishouDrawerSearch,
} from '../kuaishouDrawerUtils';

describe('normalizeKuaishouVideoText', () => {
  it('removes normal whitespace, newlines, and NBSP while lowercasing text', () => {
    expect(normalizeKuaishouVideoText('  #Air\n空气 清新 环境优美  ')).toBe('#air空气清新环境优美');
  });

  it('keeps Chinese characters, numbers, and hashtag markers', () => {
    expect(normalizeKuaishouVideoText('#好心情 2026 No.1')).toBe('#好心情2026no.1');
  });
});

describe('isKuaishouDrawerVideoTextMatch', () => {
  it('matches hashtag-only titles with trailing NBSP differences', () => {
    expect(isKuaishouDrawerVideoTextMatch('#空气清新环境优美', '#空气清新环境优美 ')).toBe(true);
  });

  it('matches multiline descriptions when the drawer DOM contains the normalized prefix', () => {
    const target = '奶油风客厅，温柔自成一派\n柔和线条，低饱和配色\n阳光透过纱帘，日子慢得刚好';
    const domText = '奶油风客厅，温柔自成一派 柔和线条 2026-06-19 12:07:35';
    expect(isKuaishouDrawerVideoTextMatch(domText, target)).toBe(true);
  });

  it('does not match a completely different drawer title', () => {
    expect(isKuaishouDrawerVideoTextMatch('雪山下的小屋 2026-06-19 12:07:35', '#空气清新环境优美')).toBe(false);
  });
});

describe('shouldStopKuaishouDrawerSearch', () => {
  it('stops after repeated empty drawer item lists', () => {
    expect(shouldStopKuaishouDrawerSearch({
      itemCount: 0,
      emptyRounds: 2,
      noGrowthRounds: 0,
      hasScrolled: true,
      minTimestamp: null,
      targetCreateTime: 1779930199,
      tolerance: 60,
    })).toMatchObject({ stop: true, reason: 'empty-list' });
  });

  it('does not stop only because the oldest loaded timestamp is older than the target', () => {
    expect(shouldStopKuaishouDrawerSearch({
      itemCount: 30,
      emptyRounds: 0,
      noGrowthRounds: 0,
      hasScrolled: true,
      minTimestamp: 1779265282,
      targetCreateTime: 1779930199,
      tolerance: 60,
    })).toMatchObject({ stop: false });
  });

  it('stops when the list has stopped growing after scrolling and has moved past the target window', () => {
    expect(shouldStopKuaishouDrawerSearch({
      itemCount: 30,
      emptyRounds: 0,
      noGrowthRounds: 2,
      hasScrolled: true,
      minTimestamp: 1779265282,
      targetCreateTime: 1779930199,
      tolerance: 60,
    })).toMatchObject({ stop: true, reason: 'no-growth-past-target' });
  });
});
