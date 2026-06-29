import {
  injectPlaceholders,
  replaceRaw,
  deepReplaceStrings,
  injectBodyPlaceholders,
  resolveQuery,
  runStyleSelection,
} from '../materialUpdateInjection';
import type { StyleDef } from '../materialUpdateConfig';

// ============================================================
// injectPlaceholders — URL/params/headers 场景
// ============================================================
describe('injectPlaceholders', () => {
  it('替换 {{API_KEY}} 并 URL 编码值', () => {
    const result = injectPlaceholders('https://api.example.com?key={{API_KEY}}', { API_KEY: 'abc123' });
    expect(result).toBe('https://api.example.com?key=abc123');
  });

  it('替换 {{QUERY}} 中文值进行 URL 编码', () => {
    const result = injectPlaceholders('https://api.example.com?q={{QUERY}}', { QUERY: '口播教程' });
    expect(result).toBe('https://api.example.com?q=%E5%8F%A3%E6%92%AD%E6%95%99%E7%A8%8B');
  });

  it('{{COUNT}} 不进行 URL 编码，直接插入数字', () => {
    const result = injectPlaceholders('/api/items?count={{COUNT}}', { COUNT: '50' });
    expect(result).toBe('/api/items?count=50');
  });

  it('替换 headers 中的占位符', () => {
    const result = injectPlaceholders('Bearer {{API_KEY}}', { API_KEY: 'tok_123' });
    expect(result).toBe('Bearer tok_123');
  });

  it('未匹配的占位符原样保留', () => {
    const result = injectPlaceholders('{{QUERY}}', { OTHER: 'value' });
    expect(result).toBe('{{QUERY}}');
  });

  it('多占位符同时替换', () => {
    const result = injectPlaceholders('{{API_KEY}}-{{PAGE}}', { API_KEY: 'key1', PAGE: '2' });
    expect(result).toBe('key1-2');
  });

  it('重复占位符全部替换', () => {
    const result = injectPlaceholders('{{X}}{{X}}{{X}}', { X: 'a' });
    expect(result).toBe('aaa');
  });

  it('空模板返回空字符串', () => {
    const result = injectPlaceholders('', { X: 'val' });
    expect(result).toBe('');
  });
});

// ============================================================
// replaceRaw — 原始替换（不 URL 编码）
// ============================================================
describe('replaceRaw', () => {
  it('原始替换中文值，不进行 URL 编码', () => {
    const result = replaceRaw('{"query":"{{QUERY}}"}', { QUERY: '口播' });
    expect(result).toBe('{"query":"口播"}');
  });

  it('替换 {{COUNT}} 为原始数字字符串', () => {
    const result = replaceRaw('{"count":"{{COUNT}}"}', { COUNT: '50' });
    expect(result).toBe('{"count":"50"}');
  });

  it('多占位符替换', () => {
    const result = replaceRaw('{{A}}-{{B}}', { A: 'hello', B: 'world' });
    expect(result).toBe('hello-world');
  });

  it('未匹配的占位符原样保留', () => {
    const result = replaceRaw('{{A}}-{{B}}', { A: 'x' });
    expect(result).toBe('x-{{B}}');
  });
});

// ============================================================
// deepReplaceStrings — 深度递归替换
// ============================================================
describe('deepReplaceStrings', () => {
  it('替换普通字符串值', () => {
    const result = deepReplaceStrings('hello {{NAME}}', { NAME: 'world' });
    expect(result).toBe('hello world');
  });

  it('{{COUNT}} 整个字符串替换为 number 类型', () => {
    const result = deepReplaceStrings('{{COUNT}}', { COUNT: '50' });
    expect(result).toBe(50);
  });

  it('嵌套对象中的字符串值递归替换', () => {
    const obj = { query: 'search {{QUERY}}', meta: { page: '{{PAGE}}' } };
    const result = deepReplaceStrings(obj, { QUERY: 'test', PAGE: '2' });
    expect(result).toEqual({ query: 'search test', meta: { page: '2' } });
  });

  it('数组中字符串值递归替换', () => {
    const arr = ['{{A}}', 'prefix-{{B}}', 'plain'];
    const result = deepReplaceStrings(arr, { A: 'x', B: 'y' });
    expect(result).toEqual(['x', 'prefix-y', 'plain']);
  });

  it('嵌套对象中 {{COUNT}} 整个字符串替换为 number', () => {
    const obj = { resultsPerPage: '{{COUNT}}', query: '{{QUERY}}' };
    const result = deepReplaceStrings(obj, { COUNT: '50', QUERY: 'test' });
    expect(result).toEqual({ resultsPerPage: 50, query: 'test' });
  });

  it('数字、布尔、null 等非字符串原样保留', () => {
    const obj = { num: 42, flag: true, empty: null, items: [1, 2, 3] };
    const result = deepReplaceStrings(obj, { X: 'y' });
    expect(result).toEqual({ num: 42, flag: true, empty: null, items: [1, 2, 3] });
  });

  it('undefined 值原样保留', () => {
    const result = deepReplaceStrings(undefined, { X: 'y' });
    expect(result).toBeUndefined();
  });

  it('空对象不做替换', () => {
    const result = deepReplaceStrings({}, { X: 'y' });
    expect(result).toEqual({});
  });

  it('多层级数组嵌套', () => {
    const obj = { queries: ['{{A}}', ['{{B}}', '{{C}}']] };
    const result = deepReplaceStrings(obj, { A: 'a', B: 'b', C: 'c' });
    expect(result).toEqual({ queries: ['a', ['b', 'c']] });
  });
});

// ============================================================
// injectBodyPlaceholders — JSON body 注入
// ============================================================
describe('injectBodyPlaceholders', () => {
  it('合法 JSON body 注入占位符', () => {
    const body = '{"query":"{{QUERY}}","count":"{{COUNT}}"}';
    const result = injectBodyPlaceholders(body, { QUERY: 'test', COUNT: '50' });
    // {{COUNT}} 整个字符串替换为 number，不保留引号
    expect(result).toBe('{"query":"test","count":50}');
  });

  it('{{COUNT}} 在 JSON 中替换为 number 类型', () => {
    const body = '{"resultsPerPage":"{{COUNT}}"}';
    const result = injectBodyPlaceholders(body, { COUNT: '50' });
    expect(result).toBe('{"resultsPerPage":50}');
  });

  it('{{QUERY}} 在嵌套 JSON 数组中替换', () => {
    const body = '{"searchQueries":["{{QUERY}}"],"count":30}';
    const result = injectBodyPlaceholders(body, { QUERY: '口播教程' });
    expect(result).toBe('{"searchQueries":["口播教程"],"count":30}');
  });

  it('非法 JSON body 走纯字符串替换', () => {
    const body = 'not-json-{{QUERY}}-string';
    const result = injectBodyPlaceholders(body, { QUERY: 'test' });
    expect(result).toBe('not-json-test-string');
  });

  it('空对象 body', () => {
    const result = injectBodyPlaceholders('{}', { QUERY: 'test' });
    expect(result).toBe('{}');
  });

  it('多占位符在 JSON body 中同时替换', () => {
    const body = '{"q":"{{QUERY}}","p":"{{PAGE}}","c":"{{COUNT}}"}';
    const result = injectBodyPlaceholders(body, { QUERY: 'hello', PAGE: '3', COUNT: '20' });
    // {{COUNT}} 替换为 number，其他为 string
    expect(JSON.parse(result)).toEqual({ q: 'hello', p: '3', c: 20 });
  });

  it('非法 JSON 中含未匹配占位符原样保留', () => {
    const body = 'some-{{A}}-{{B}}';
    const result = injectBodyPlaceholders(body, { A: 'x' });
    expect(result).toBe('some-x-{{B}}');
  });
});

// ============================================================
// resolveQuery — 风格查询词解析
// ============================================================
describe('resolveQuery', () => {
  const style: StyleDef = {
    name: '口播',
    dir: '口播',
    keywords: ['口播', '讲解', '说话'],
  };

  it('无 platformOverrides 时使用 style.keywords', () => {
    const result = resolveQuery(style, 'platform_xxx');
    expect(result).toBe('口播,讲解,说话');
  });

  it('有 platformOverrides 时使用覆盖值', () => {
    const overriddenStyle: StyleDef = {
      ...style,
      platformOverrides: {
        platform_xxx: ['口播教程', '讲解视频'],
      },
    };
    const result = resolveQuery(overriddenStyle, 'platform_xxx');
    expect(result).toBe('口播教程,讲解视频');
  });

  it('platformOverrides 不影响未覆盖的平台', () => {
    const overriddenStyle: StyleDef = {
      ...style,
      platformOverrides: {
        platform_xxx: ['口播教程'],
      },
    };
    const result = resolveQuery(overriddenStyle, 'platform_yyy');
    expect(result).toBe('口播,讲解,说话');
  });

  it('空关键词列表返回空字符串', () => {
    const emptyKeywords: StyleDef = { name: '空', dir: 'empty', keywords: [] };
    const result = resolveQuery(emptyKeywords, 'any');
    expect(result).toBe('');
  });

  it('platformOverrides 中空数组返回空字符串', () => {
    const styleWithEmptyOverride: StyleDef = {
      ...style,
      platformOverrides: { platform_xxx: [] },
    };
    const result = resolveQuery(styleWithEmptyOverride, 'platform_xxx');
    expect(result).toBe('');
  });

  it('单关键词返回该关键词本身（无逗号）', () => {
    const singleStyle: StyleDef = { name: '单', dir: 'single', keywords: ['only'] };
    const result = resolveQuery(singleStyle, 'any');
    expect(result).toBe('only');
  });
});

// ============================================================
// runStyleSelection — 运行风格选择
// ============================================================
describe('runStyleSelection', () => {
  const styles: StyleDef[] = [
    { name: '口播', dir: '口播', keywords: ['口播'] },
    { name: '场景', dir: '场景', keywords: ['户外'] },
    { name: '美食', dir: '美食', keywords: ['做饭'] },
  ];

  it('无 styleDir 时返回所有风格的副本', () => {
    const result = runStyleSelection(styles);
    expect(result).toHaveLength(3);
    expect(result).toEqual(styles);
    expect(result).not.toBe(styles); // 应返回新数组
  });

  it('有 styleDir 时返回匹配的风格', () => {
    const result = runStyleSelection(styles, '场景');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('场景');
  });

  it('styleDir 不匹配时返回空数组', () => {
    const result = runStyleSelection(styles, '不存在的风格');
    expect(result).toEqual([]);
  });

  it('空风格列表返回空数组', () => {
    const result = runStyleSelection([]);
    expect(result).toEqual([]);
  });

  it('空风格列表指定 styleDir 仍返回空数组', () => {
    const result = runStyleSelection([], '口播');
    expect(result).toEqual([]);
  });

  it('无 styleDir 时不影响原数组', () => {
    const copy = [...styles];
    const result = runStyleSelection(styles);
    result.push({ name: '新', dir: 'new', keywords: ['new'] });
    expect(styles).toHaveLength(3); // 原数组不变
  });
});
