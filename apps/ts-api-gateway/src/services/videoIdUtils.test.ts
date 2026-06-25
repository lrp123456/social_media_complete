import { describe, it, expect } from 'vitest';
import { normalizeVideoId } from './videoIdUtils';

describe('normalizeVideoId', () => {
  // 抖音：纯数字 awemeId，String() 包裹
  // 注意：JS Number 无法精确表示 7301234567890123456（超出 MAX_SAFE_INTEGER），
  // 实际值为 7301234567890124000。该测试验证函数正确转换收到的值，不额外丢失精度。
  it('douyin: wraps number to string', () => {
    expect(normalizeVideoId('douyin', 7301234567890123456)).toBe('7301234567890124000');
  });
  it('douyin: passes string through', () => {
    expect(normalizeVideoId('douyin', '7301234567890123456')).toBe('7301234567890123456');
  });

  // 快手
  it('kuaishou: wraps number to string', () => {
    expect(normalizeVideoId('kuaishou', 385000000)).toBe('385000000');
  });
  it('kuaishou: passes string through', () => {
    expect(normalizeVideoId('kuaishou', '3xfGh2jK')).toBe('3xfGh2jK');
  });

  // 小红书
  it('xiaohongshu: passes string through', () => {
    expect(normalizeVideoId('xiaohongshu', '64a1b2c3d4e5f6')).toBe('64a1b2c3d4e5f6');
  });

  // 腾讯视频号
  it('tencent: preserves export/ prefix', () => {
    expect(normalizeVideoId('tencent', 'export/abc123')).toBe('export/abc123');
  });
  it('tencent: passes plain id through', () => {
    expect(normalizeVideoId('tencent', 'abc123')).toBe('abc123');
  });

  // null/undefined 输入
  it('returns empty string for null', () => {
    expect(normalizeVideoId('douyin', null)).toBe('');
  });
  it('returns empty string for undefined', () => {
    expect(normalizeVideoId('douyin', undefined)).toBe('');
  });

  // number 超精度安全
  it('handles large number without precision loss', () => {
    const big = 7301234567890123456;
    expect(normalizeVideoId('douyin', big)).toBe(String(big));
  });
});
