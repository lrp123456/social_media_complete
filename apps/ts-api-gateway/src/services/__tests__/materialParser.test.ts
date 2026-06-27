import { parseVideoList, getByDotPath } from '../materialParser';

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

describe('parseVideoList', () => {
  const parseConfig = {
    listPath: 'data.videos',
    fields: {
      videoId: 'video_id',
      title: 'desc',
      author: 'author.nickname',
      playCount: 'stats.play',
      cover: 'cover.url',
      videoUrl: 'video_url',
      publishTime: 'create_time',
    },
  };

  it('解析标准响应体', () => {
    const response = {
      data: {
        videos: [
          {
            video_id: 'v001',
            desc: '测试视频',
            author: { nickname: '创作者A' },
            stats: { play: 12345 },
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
      playCount: 12345,
      cover: 'https://img.example.com/1.jpg',
      videoUrl: 'https://video.example.com/1.mp4',
      publishTime: expect.any(Number),
    });
  });

  it('字段缺失时对应字段为 undefined', () => {
    const response = { data: { videos: [{ video_id: 'v002' }] } };
    const result = parseVideoList(response, parseConfig);
    expect(result).toHaveLength(1);
    expect(result[0].videoId).toBe('v002');
    expect(result[0].title).toBeUndefined();
    expect(result[0].videoUrl).toBeUndefined();
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

  it('publishTime Unix 时间戳转为毫秒时间戳', () => {
    const response = { data: { videos: [{ video_id: 'v003', create_time: 1719480000 }] } };
    const result = parseVideoList(response, parseConfig);
    expect(result[0].publishTime).toBe(1719480000 * 1000);
  });
});
