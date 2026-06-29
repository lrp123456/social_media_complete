import { parseVideoList, getByDotPath, parsePublishTime } from '../materialParser';

describe('getByDotPath', () => {
  it('从嵌套对象按点路径取值', () => {
    const obj = { data: { videos: [{ id: 1 }] } };
    expect(getByDotPath(obj, 'data.videos')).toEqual([{ id: 1 }]);
  });

  it('路径不存在返回 undefined', () => {
    const obj = { data: {} };
    expect(getByDotPath(obj, 'data.missing')).toBeUndefined();
  });

  it('单层路径', () => {
    const obj = { name: 'hello' };
    expect(getByDotPath(obj, 'name')).toBe('hello');
  });

  it('空路径返回原对象', () => {
    const obj = { a: 1 };
    expect(getByDotPath(obj, '')).toBe(obj);
  });
});

describe('parsePublishTime', () => {
  it('Unix 秒时间戳（<1e12）转为 Date', () => {
    const result = parsePublishTime(1719480000);
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(1719480000 * 1000);
  });

  it('Unix 毫秒时间戳（>=1e12）直接使用', () => {
    const result = parsePublishTime(1719480000000);
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(1719480000000);
  });

  it('ISO 字符串转为 Date', () => {
    const result = parsePublishTime('2024-06-27T12:00:00Z');
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe('2024-06-27T12:00:00.000Z');
  });

  it('数字字符串时间戳转为 Date', () => {
    const result = parsePublishTime('1719480000');
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(1719480000 * 1000);
  });

  it('null/undefined 返回 undefined', () => {
    expect(parsePublishTime(null)).toBeUndefined();
    expect(parsePublishTime(undefined)).toBeUndefined();
  });

  it('NaN 返回 undefined', () => {
    expect(parsePublishTime(NaN)).toBeUndefined();
  });

  it('空字符串返回 undefined', () => {
    expect(parsePublishTime('')).toBeUndefined();
  });

  it('非法字符串返回 undefined', () => {
    expect(parsePublishTime('not-a-date')).toBeUndefined();
  });
});

describe('parseVideoList', () => {
  const parseConfig = {
    listPath: 'data.videos',
    fieldMap: {
      videoId: 'video_id',
      title: 'desc',
      author: 'author.nickname',
      likeCount: 'stats.diggCount',
      commentCount: 'stats.commentCount',
      cover: 'cover.url',
      videoUrl: 'video_url',
      publishTime: 'create_time',
    },
  };

  it('解析标准响应体，包含 likeCount/commentCount 不包含 playCount', () => {
    const response = {
      data: {
        videos: [
          {
            video_id: 'v001',
            desc: '测试视频',
            author: { nickname: '创作者A' },
            stats: { diggCount: 12345, commentCount: 678 },
            cover: { url: 'https://img.example.com/1.jpg' },
            video_url: 'https://video.example.com/1.mp4',
            create_time: 1719480000,
          },
        ],
      },
    };

    const result = parseVideoList(response, parseConfig);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      videoId: 'v001',
      title: '测试视频',
      author: '创作者A',
      likeCount: 12345,
      commentCount: 678,
      cover: 'https://img.example.com/1.jpg',
      videoUrl: 'https://video.example.com/1.mp4',
      publishTime: new Date(1719480000 * 1000),
    });
    // 确保没有 playCount
    expect((result[0] as any).playCount).toBeUndefined();
  });

  it('数字型 likeCount/commentCount 正确处理', () => {
    const response = {
      data: {
        videos: [
          {
            video_id: 'v002',
            stats: { diggCount: 999, commentCount: 0 },
          },
        ],
      },
    };
    const result = parseVideoList(response, parseConfig);
    expect(result[0].likeCount).toBe(999);
    expect(result[0].commentCount).toBe(0);
  });

  it('字符串型 likeCount/commentCount 转为 number', () => {
    const response = {
      data: {
        videos: [
          {
            video_id: 'v003',
            stats: { diggCount: '888', commentCount: '77' },
          },
        ],
      },
    };
    const result = parseVideoList(response, parseConfig);
    expect(result[0].likeCount).toBe(888);
    expect(result[0].commentCount).toBe(77);
  });

  it('字段缺失时对应字段为 undefined（videoId 除外）', () => {
    const response = { data: { videos: [{ video_id: 'v004' }] } };
    const result = parseVideoList(response, parseConfig);
    expect(result).toHaveLength(1);
    expect(result[0].videoId).toBe('v004');
    expect(result[0].title).toBeUndefined();
    expect(result[0].author).toBeUndefined();
    expect(result[0].videoUrl).toBeUndefined();
    expect(result[0].likeCount).toBeUndefined();
    expect(result[0].commentCount).toBeUndefined();
  });

  it('listPath 指向非数组时返回空数组', () => {
    const response = { data: { videos: 'not_an_array' } };
    const result = parseVideoList(response, parseConfig);
    expect(result).toEqual([]);
  });

  it('listPath 不存在时返回空数组', () => {
    const response = { other: {} };
    const result = parseVideoList(response, parseConfig);
    expect(result).toEqual([]);
  });

  it('publishTime Unix 秒时间戳转为 Date', () => {
    const response = { data: { videos: [{ video_id: 'v005', create_time: 1719480000 }] } };
    const result = parseVideoList(response, parseConfig);
    expect(result[0].publishTime).toEqual(new Date(1719480000 * 1000));
  });

  it('publishTime Unix 毫秒时间戳直接使用', () => {
    const response = { data: { videos: [{ video_id: 'v006', create_time: 1719480000000 }] } };
    const result = parseVideoList(response, parseConfig);
    expect(result[0].publishTime).toEqual(new Date(1719480000000));
  });

  it('publishTime ISO 字符串解析', () => {
    const response = { data: { videos: [{ video_id: 'v007', create_time: '2024-06-27T12:00:00Z' }] } };
    const result = parseVideoList(response, parseConfig);
    expect(result[0].publishTime).toEqual(new Date('2024-06-27T12:00:00Z'));
  });

  it('嵌套点路径取值正确', () => {
    const config = {
      listPath: 'result.items',
      fieldMap: {
        videoId: 'id',
        title: 'snippet.title',
        likeCount: 'statistics.likeCount',
        commentCount: 'statistics.commentCount',
        author: 'snippet.channelTitle',
        cover: 'snippet.thumbnails.high.url',
        videoUrl: 'id',
        publishTime: 'snippet.publishedAt',
      },
    };
    const response = {
      result: {
        items: [
          {
            id: 'abc123',
            snippet: {
              title: 'Test Video',
              channelTitle: 'Test Channel',
              thumbnails: { high: { url: 'https://img.example.com/hq.jpg' } },
              publishedAt: '2024-01-15T10:30:00Z',
            },
            statistics: { likeCount: 5000, commentCount: 300 },
          },
        ],
      },
    };
    const result = parseVideoList(response, config);
    expect(result).toHaveLength(1);
    expect(result[0].videoId).toBe('abc123');
    expect(result[0].title).toBe('Test Video');
    expect(result[0].author).toBe('Test Channel');
    expect(result[0].likeCount).toBe(5000);
    expect(result[0].commentCount).toBe(300);
    expect(result[0].cover).toBe('https://img.example.com/hq.jpg');
    expect(result[0].videoUrl).toBe('abc123');
    expect(result[0].publishTime).toEqual(new Date('2024-01-15T10:30:00Z'));
  });

  it('fieldMap 中未配置的字段跳过不处理', () => {
    const partialConfig = {
      listPath: 'items',
      fieldMap: {
        videoId: 'id',
        title: '',
        likeCount: '',
        commentCount: '',
        videoUrl: '',
        cover: '',
        author: '',
        publishTime: '',
      },
    };
    const response = { items: [{ id: 'v001', desc: 'should be ignored' }] };
    const result = parseVideoList(response, partialConfig);
    expect(result).toHaveLength(1);
    expect(result[0].videoId).toBe('v001');
    expect(result[0].title).toBeUndefined();
  });
});
