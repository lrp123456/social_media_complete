// materialUpdateInjection.ts — 占位符注入 + 风格查询词解析 + 运行风格选择
import type { StyleDef } from './materialUpdateConfig';

/**
 * 注入占位符到字符串（URL 编码 value，除 COUNT 外）。
 *
 * `{{PLACEHOLDER}}` → 编码后的值
 * `{{COUNT}}` → 直接插入数字（不编码）
 *
 * 用于 URL、headers、params 等 URL 编码场景。
 */
export function injectPlaceholders(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [placeholder, value] of Object.entries(vars)) {
    const regex = new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g');
    const isNumeric = placeholder === 'COUNT';
    result = result.replace(regex, isNumeric ? value : encodeURIComponent(value));
  }
  return result;
}

/**
 * 原始替换（不 URL 编码）。
 *
 * `{{PLACEHOLDER}}` → value 原样插入
 * `{{COUNT}}` → 直接数字字符串
 *
 * 用于 JSON body 内的占位符替换，避免 encodeURIComponent 破坏 JSON 结构。
 */
export function replaceRaw(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [placeholder, value] of Object.entries(vars)) {
    const regex = new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g');
    result = result.replace(regex, value);
  }
  return result;
}

/**
 * 深度递归替换对象中所有字符串值的占位符（原始替换）。
 *
 * 特殊规则：
 * - 若整个字符串等于 `{{COUNT}}`，替换为 number 类型
 * - 否则对字符串值调用 `replaceRaw`
 * - 数组和对象递归遍历
 *
 * @param obj - 任意 JSON 兼容值
 * @param vars - 占位符变量
 * @returns 替换后的新值（不会修改原对象）
 */
export function deepReplaceStrings(obj: unknown, vars: Record<string, string>): unknown {
  if (typeof obj === 'string') {
    // 若整个字符串就是 {{COUNT}}，替换为 number 类型
    if (obj === '{{COUNT}}') {
      return parseInt(vars.COUNT, 10);
    }
    return replaceRaw(obj, vars);
  }

  if (Array.isArray(obj)) {
    return obj.map((v) => deepReplaceStrings(v, vars));
  }

  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deepReplaceStrings(v, vars);
    }
    return result;
  }

  return obj;
}

/**
 * 对 JSON body 字符串进行占位符注入。
 *
 * 1. 尝试 JSON.parse → deepReplaceStrings → JSON.stringify
 * 2. 若不是合法 JSON，按纯字符串原始替换
 *
 * @param bodyStr - 原始 body 模板字符串
 * @param vars - 占位符变量
 * @returns 注入后的 JSON 字符串
 */
export function injectBodyPlaceholders(bodyStr: string, vars: Record<string, string>): string {
  try {
    const parsed = JSON.parse(bodyStr);
    const injected = deepReplaceStrings(parsed, vars);
    return JSON.stringify(injected);
  } catch {
    // 不是合法 JSON，按纯字符串原始替换
    return replaceRaw(bodyStr, vars);
  }
}

/**
 * 解析风格对应的查询词。
 *
 * 逻辑：
 * 1. 若 style 有 platformOverrides[platformId]，使用该平台覆盖关键词
 * 2. 否则使用 style.keywords
 * 3. 多个关键词用逗号连接
 *
 * 返回的字符串将作为 `{{QUERY}}` 的值注入请求。
 *
 * @param style - 风格定义
 * @param platformId - 平台 ID
 * @returns 逗号连接的查询词字符串
 */
export function resolveQuery(style: StyleDef, platformId: string): string {
  const keywords = style.platformOverrides?.[platformId] ?? style.keywords;
  return keywords.join(',');
}

/**
 * 运行风格选择。
 *
 * 用于 `runMaterialUpdate` 确定本次要遍历哪些风格：
 * - 若指定 `styleDir`：返回匹配该目录的风格（找不到返回空数组）
 * - 若未指定 `styleDir`：返回所有风格
 *
 * @param styles - 全部可用风格列表
 * @param styleDir - 可选，指定要运行的风格目录
 * @returns 要执行的风格列表
 */
export function runStyleSelection(styles: StyleDef[], styleDir?: string): StyleDef[] {
  if (styleDir) {
    return styles.filter((s) => s.dir === styleDir);
  }
  return [...styles];
}
