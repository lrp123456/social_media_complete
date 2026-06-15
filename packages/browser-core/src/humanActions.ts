import { Page } from 'patchright';
import { BrowserManager } from './browserManager';
import { CDPClient } from './cdpClient';
import { CDPDomNavigator } from './cdpDom';
import { CDPHumanMouse } from './cdpMouse';
import { CDPScroller, ScrollOptions } from './cdpScroller';
import { BehaviorNoise } from './behaviorNoise';
import { rootLogger } from '../logger';
const logger = rootLogger.child({ name: 'humanActions' });

interface CDPContext {
  cdp: CDPClient;
  dom: CDPDomNavigator;
  mouse: CDPHumanMouse;
  scroller: CDPScroller;
  noise: BehaviorNoise;
}

// ============================================================
// 多级回退元素查找 — 类型定义
// ============================================================

/** 查找结果 */
export class FindResult {
  constructor(
    public found: boolean,
    public method: 'role' | 'text' | 'placeholder' | 'label' | 'css' | 'coordinate' | 'none',
    public x: number = 0,
    public y: number = 0,
    public w: number = 0,
    public h: number = 0,
    public selector: string = '',
  ) {}
}

/** 多级回退配置 */
export type FallbackConfig = {
  /** Level 1: getByRole */
  role?: { name: string; options?: Record<string, string> };
  /** Level 2: getByText（按顺序尝试，自动过滤 display:none 蜜罐） */
  texts?: string[];
  /** Level 3a: getByPlaceholder */
  placeholder?: string;
  /** Level 3b: getByLabel */
  label?: string;
  /** Level 4: CSS 选择器（自动追加 :visible） */
  cssSelectors?: string[];
  /** Level 5: 坐标回退 — 基于容器的相对比例偏移 */
  coordinate?: { xRatio: number; yRatio: number; offsetX?: number; offsetY?: number };
  /** 坐标模式下基于哪个容器计算相对位置（默认 body） */
  coordinateContainer?: string;
  /** 元素最小宽高过滤（过滤隐藏蜜罐，默认 10x10） */
  minWidth?: number;
  minHeight?: number;
  /** 每个查找步骤之间的随机人类停顿 ms */
  pauseBetweenSteps?: { min: number; max: number };
  /** 找到后是否触发 hover（避免瞬时闪现，默认 true） */
  hover?: boolean;
  /** hover 后随机等待 ms */
  hoverPause?: { min: number; max: number };
};

export class HumanActions {
  private static traceCollector: { recordMouseTrace: (point: any) => void } | null = null;
  private static cdpContexts = new WeakMap<Page, CDPContext>();

  static setTraceCollector(collector: { recordMouseTrace: (point: any) => void } | null): void {
    HumanActions.traceCollector = collector;
  }

  private static trace(type: string, x: number, y: number, detail?: string): void {
    if (HumanActions.traceCollector) {
      HumanActions.traceCollector.recordMouseTrace({
        x,
        y,
        timestamp: Date.now(),
        type,
        detail,
      });
    }
  }

  static randomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  static randomInRange(minSec: number, maxSec: number): number {
    return Math.floor(Math.random() * (maxSec - minSec + 1) + minSec) * 1000;
  }

  static async wait(page: Page, minMs: number, maxMs: number): Promise<void> {
    const delay = HumanActions.randomDelay(minMs, maxMs);
    await page.waitForTimeout(delay);
  }

  private static async getCDPContext(page: Page): Promise<CDPContext> {
    let ctx = HumanActions.cdpContexts.get(page);
    if (ctx) {
      try {
        await Promise.race([
          ctx.cdp.getLayoutViewport(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('CDP health check timeout')), 5000))
        ]);
        return ctx;
      } catch {
        HumanActions.cdpContexts.delete(page);
      }
    }

    const session = await Promise.race([
      page.context().newCDPSession(page),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('CDP session creation timeout')), 15000))
    ]);

    const cdp = new CDPClient(session);
    await Promise.race([
      cdp.init(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('CDP init timeout')), 15000))
    ]);

    const dom = new CDPDomNavigator(cdp);
    const mouse = new CDPHumanMouse(cdp, dom);
    const scroller = new CDPScroller(cdp, dom, mouse);
    const noise = new BehaviorNoise(cdp, dom, mouse, scroller);

    if (HumanActions.traceCollector) {
      mouse.setTraceCollector(HumanActions.traceCollector);
    }

    try {
      const viewportPromise = cdp.getLayoutViewport();
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('getLayoutViewport timeout')), 5000)
      );
      const viewport = await Promise.race([viewportPromise, timeoutPromise]) as { clientWidth: number; clientHeight: number };
      await mouse.moveTo(
        { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 },
        { skipTrajectory: true }
      );
    } catch (viewportError: any) {
      logger.warn({ error: viewportError.message }, 'Failed to move mouse to viewport center, continuing anyway');
    }

    ctx = { cdp, dom, mouse, scroller, noise };
    HumanActions.cdpContexts.set(page, ctx);
    return ctx;
  }

  static clearCDPContext(page: Page): void {
    HumanActions.cdpContexts.delete(page);
  }

  private static async withCDPContext<T>(
    page: Page,
    fn: (ctx: CDPContext) => Promise<T>
  ): Promise<T> {
    try {
      const ctx = await HumanActions.getCDPContext(page);
      return await fn(ctx);
    } catch (error: any) {
      if (HumanActions.isSessionError(error)) {
        HumanActions.clearCDPContext(page);
        const ctx = await HumanActions.getCDPContext(page);
        return await fn(ctx);
      }
      throw error;
    }
  }

  private static isSessionError(error: any): boolean {
    const msg = error?.message?.toLowerCase() || '';
    return (
      msg.includes('session closed') ||
      msg.includes('target closed') ||
      msg.includes('frame was detached') ||
      msg.includes('not attached') ||
      msg.includes('context was destroyed')
    );
  }

  static async humanMoveTo(page: Page, selector: string): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      const location = await ctx.mouse.moveToElement(selector);
      if (!location) {
        await BrowserManager.logPageHtml(page, `element_not_found_${selector}`);
        throw new Error(`Element not found: ${selector}`);
      }
    });
  }

  static async humanClick(page: Page, selector: string): Promise<void> {
    const clicked = await HumanActions.cdpClick(page, selector);
    if (!clicked) {
      await BrowserManager.logPageHtml(page, `click_failed_${selector}`);
      throw new Error(`Click failed: ${selector}`);
    }
  }

  static async cdpClick(page: Page, selector: string, options?: { timeout?: number }): Promise<boolean> {
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.refreshDocument();
        // 先将元素滚动到视口内（与 cdpClickNode 行为一致）
        // CDP 原生 Input.dispatchMouseEvent 不会自动滚动，元素不在视口内会点空
        const nodeId = await ctx.cdp.querySelector(selector);
        if (nodeId && nodeId > 0) {
          await ctx.cdp.scrollIntoViewIfNeeded(nodeId);
          await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        }
        return await ctx.mouse.click(selector, { timeout: options?.timeout });
      });
    } catch (error: any) {
      logger.warn({ selector, error: error.message }, 'CDP click failed');
      return false;
    }
  }

  static async humanScroll(
    page: Page,
    scrollAmount: number,
    options?: { minPause?: number; maxPause?: number }
  ): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      const direction = scrollAmount > 0 ? 'down' : 'up';
      await ctx.scroller.scrollPage({
        direction,
        totalAmount: Math.abs(scrollAmount),
        segmentSize: { min: 50, max: 200 },
        segmentCount: { min: 2, max: 5 },
        pauseBetween: {
          min: options?.minPause ?? 200,
          max: options?.maxPause ?? 800,
        },
        overshootChance: 0.15,
      });
    });
  }

  static async randomBlankClick(page: Page): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.noise.randomBlankAction();
    });
  }

  static async cdpKeyPress(page: Page, key: string, code: string, vkCode: number): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.cdp.dispatchKeyEvent({
        type: 'rawKeyDown',
        key,
        code,
        windowsVirtualKeyCode: vkCode,
        nativeVirtualKeyCode: vkCode,
      });
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 50));
      await ctx.cdp.dispatchKeyEvent({
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: vkCode,
        nativeVirtualKeyCode: vkCode,
      });
    });
  }

  static async cdpF5Refresh(page: Page): Promise<void> {
    await HumanActions.cdpKeyPress(page, 'F5', 'F5', 116);
  }

  static async cdpPageDown(page: Page): Promise<void> {
    await HumanActions.cdpKeyPress(page, 'PageDown', 'PageDown', 34);
  }

  static async cdpGetBodyText(page: Page): Promise<string> {
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.refreshDocument();
        const bodyNodeId = await ctx.cdp.querySelector('body');
        if (!bodyNodeId) return '';

        const result = await ctx.cdp.send('DOM.getOuterHTML', { nodeId: bodyNodeId });
        const html = result.outerHTML || '';

        return html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#\d+;/g, ' ')
          .replace(/\s+/g, ' ')
          .toLowerCase()
          .trim();
      });
    } catch {
      return '';
    }
  }

  static async cdpGetTitle(page: Page): Promise<string> {
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.refreshDocument();
        const titleNodeId = await ctx.cdp.querySelector('title');
        if (!titleNodeId) return '';

        const result = await ctx.cdp.send('DOM.getOuterHTML', { nodeId: titleNodeId });
        const html = result.outerHTML || '';
        return html
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .trim()
          .toLowerCase();
      });
    } catch {
      return '';
    }
  }

  static async cdpIsElementVisible(page: Page, selector: string): Promise<boolean> {
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.refreshDocument();
        return await ctx.dom.isElementVisible(selector);
      });
    } catch {
      return false;
    }
  }

  /**
   * 通过 CDP 检查元素是否包含指定 class（无 JS 注入）
   */
  static async cdpHasClass(page: Page, selector: string, className: string): Promise<boolean> {
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.refreshDocument();
        const nodeId = await ctx.cdp.querySelector(selector);
        if (!nodeId || nodeId <= 0) return false;
        const attrs = await ctx.cdp.getAttributes(nodeId);
        if (!attrs) return false;
        const classValue = attrs['class'] || '';
        return classValue.split(/\s+/).includes(className);
      });
    } catch {
      return false;
    }
  }

  private static async findScrollContainer(
    ctx: CDPContext,
    selectors: string[],
    minWidth: number = 50,
    minHeight: number = 100
  ): Promise<{ x: number; y: number; w: number; h: number; sel: string } | null> {
    for (const sel of selectors) {
      const location = await ctx.dom.findElementNow(sel);
      if (location && location.rect.width > minWidth && location.rect.height > minHeight) {
        return {
          x: location.center.x,
          y: location.rect.y + location.rect.height * 0.6,
          w: location.rect.width,
          h: location.rect.height,
           sel,
          };
         }
       }
       return null;
     }

  /**
   * 公共包装: cdpFindScrollContainer — 100px 尺寸门控的滚动容器查找。
   * 仅用于"应位于大尺寸滚动容器内"的元素 (上传区/QR区/视频卡片等)。
   * 表单输入框 (title/desc/tag/publish-btn) 一律用 cdpFindElement (无门控) 避免被误杀。
   */
  static async cdpFindScrollContainer(
    page: Page,
    selectors: string[],
    minWidth: number = 50,
    minHeight: number = 100
  ): Promise<{ x: number; y: number; w: number; h: number; sel: string } | null> {
    return await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.dom.refreshDocument();
      return await HumanActions.findScrollContainer(ctx, selectors, minWidth, minHeight);
    });
  }

  /**
   * 在父元素范围内找匹配元素。父元素由 scopeSelector 定位 (如 form 提交栏)。
   * 用 Runtime.evaluate 在父元素内 querySelectorAll, 避免被页面其他区域的同名元素干扰
   * (例如抖音的 "发布" 既是发布按钮文本, 也是导航菜单项)。
   *
   * 额外 filterTag 过滤: 仅匹配指定 HTML 标签 (默认 'BUTTON'), 排除 <a> 链接。
   */
  static async cdpFindElementScoped(
    page: Page,
    scopeSelector: string,
    selectors: string[],
    options: { filterTag?: string; filterText?: string } = {},
  ): Promise<{ x: number; y: number; w: number; h: number; sel: string; tag: string } | null> {
    const filterTag = options.filterTag ?? 'BUTTON';
    const filterText = options.filterText;
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.refreshDocument();
        const scopeNodeId = await ctx.cdp.querySelector(scopeSelector);
        if (!scopeNodeId || scopeNodeId <= 0) return null;
        for (const sel of selectors) {
          // 在 scope 内查找 (用 Runtime.evaluate 拿到对象, 再 DOM.requestNode)
          const escSel = JSON.stringify(sel);
          const escTag = JSON.stringify(filterTag);
          const escText = filterText ? JSON.stringify(filterText) : 'null';
          const expr = `(() => {
            try {
              const scope = document.querySelector(${JSON.stringify(scopeSelector)});
              if (!scope) return null;
              const els = scope.querySelectorAll(${escSel});
              for (const el of Array.from(els)) {
                if (el.tagName !== ${escTag}) continue;
                if (${escText} !== null) {
                  const t = (el.textContent || '').trim();
                  if (t !== ${escText}) continue;
                }
                return el;
              }
              return null;
            } catch { return null; }
          })()`;
          const result = await ctx.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: false });
          const objectId = result.result?.objectId;
          if (!objectId) continue;
          const nr = await ctx.cdp.send('DOM.requestNode', { objectId });
          const nodeId = nr.nodeId;
          if (!nodeId || nodeId <= 0) continue;
          const location = await ctx.dom.getElementLocation(nodeId);
          if (!location) continue;
          return {
            x: location.center.x,
            y: location.rect.y + location.rect.height * 0.5,
            w: location.rect.width,
            h: location.rect.height,
            sel,
            tag: filterTag,
          };
        }
        return null;
      });
    } catch {
      return null;
    }
  }

  /**
   * 检查元素是否 disabled。
   * 用 Runtime.evaluate 直接读 el.disabled (HTMLButtonElement) 或 aria-disabled 属性,
   * 比 cdpIsElementVisible('selector[disabled]') 可靠 — 后者会构造出非法选择器 (例如对
   * Playwright 扩展语法 getByText 拼接 [disabled] 会翻译失败, 永远返回 null/false)。
   *
   * 多路检测 (默认全开, 可通过 methods 限制):
   *   - dom-property:   el.disabled === true
   *   - attr-disabled:  存在 disabled 属性 (覆盖 <fieldset disabled> 等)
   *   - aria-disabled:  aria-disabled="true"
   *   - pseudo-disabled: matches(':disabled')
   *   - class-disabled: classList 含 disabled / is-disabled / btn-disabled
   *   - cursor:         computed cursor === 'not-allowed'
   *   - opacity:        computed opacity < 0.5 (抖音/B站常用样式降级)
   */
  static async cdpIsElementDisabled(
    page: Page,
    selector: string,
    methods?: string[],
  ): Promise<boolean> {
    const useMethods = methods && methods.length > 0 ? methods : [
      'dom-property', 'attr-disabled', 'aria-disabled',
      'pseudo-disabled', 'class-disabled', 'cursor', 'opacity',
    ];
    // 把方法白名单转成 JS 数组, 序列化进 evaluate
    const methodsJson = JSON.stringify(useMethods);
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.refreshDocument();
        const nodeId = await ctx.cdp.querySelector(selector);
        if (!nodeId || nodeId <= 0) return false;
        const result = await ctx.cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            const methods = ${methodsJson};
            const set = new Set(methods);
            const get = (name) => el.getAttribute && el.getAttribute(name);
            if (set.has('dom-property') && el.disabled === true) return true;
            if (set.has('attr-disabled') && get('disabled') !== null) return true;
            if (set.has('aria-disabled') && get('aria-disabled') === 'true') return true;
            if (set.has('pseudo-disabled')) {
              try { if (el.matches && el.matches(':disabled')) return true; } catch {}
            }
            if (set.has('class-disabled') && el.classList) {
              const cls = el.className && typeof el.className === 'string' ? el.className : '';
              if (/\\bdisabled\\b/i.test(cls) || /\\bis-disabled\\b/i.test(cls) || /\\bbtn-disabled\\b/i.test(cls)) return true;
            }
            if (set.has('cursor') || set.has('opacity')) {
              const style = window.getComputedStyle(el);
              if (set.has('cursor') && style.cursor === 'not-allowed') return true;
              if (set.has('opacity')) {
                const op = parseFloat(style.opacity || '1');
                if (!isNaN(op) && op < 0.5) return true;
              }
            }
            return false;
          })()`,
          returnByValue: true,
        });
        return result.result?.value === true;
      });
    } catch {
      return false;
    }
  }

  /**
   * 元素是否"实际可点击" (可见 + 启用 + 视口内) — 这是点发布按钮前的最后一道关。
   * 比 cdpIsElementVisible 严格, 比 cdpIsElementDisabled 全面。
   *
   * visibilityMethods (默认全开):
   *   - offset-size:    offsetWidth/Height > 0
   *   - rect:           getBoundingClientRect 宽高 > 0
   *   - computed-style: display/visibility/opacity
   *   - viewport:       rect 与视口相交 (允许 insetPx 余量)
   */
  static async cdpIsElementActionable(
    page: Page,
    selector: string,
    options: {
      disabledMethods?: string[];
      visibilityMethods?: string[];
      viewportInsetPx?: number;
    } = {},
  ): Promise<{ actionable: boolean; visible: boolean; enabled: boolean; inViewport: boolean; reasons: string[] }> {
    const visMethods = options.visibilityMethods ?? ['offset-size', 'rect', 'computed-style', 'viewport'];
    const disMethods = options.disabledMethods ?? ['dom-property', 'attr-disabled', 'aria-disabled', 'pseudo-disabled', 'class-disabled', 'cursor', 'opacity'];
    const inset = options.viewportInsetPx ?? 50;
    const visJson = JSON.stringify(visMethods);
    const disJson = JSON.stringify(disMethods);
    const insetJson = JSON.stringify(inset);
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.refreshDocument();
        const nodeId = await ctx.cdp.querySelector(selector);
        if (!nodeId || nodeId <= 0) {
          return { actionable: false, visible: false, enabled: false, inViewport: false, reasons: ['element-not-found'] };
        }
        const result = await ctx.cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { actionable: false, visible: false, enabled: false, inViewport: false, reasons: ['element-not-found'] };
            const visMethods = ${visJson};
            const disMethods = ${disJson};
            const insetPx = ${insetJson};
            const reasons = [];
            const visSet = new Set(visMethods);
            const disSet = new Set(disMethods);
            const get = (name) => el.getAttribute && el.getAttribute(name);

            // 可见性检测
            let visible = true;
            if (visSet.has('offset-size') && !(el.offsetWidth > 0) && !(el.offsetHeight > 0)) {
              visible = false; reasons.push('offset-size-zero');
            }
            const rect = el.getBoundingClientRect();
            if (visSet.has('rect') && (rect.width === 0 || rect.height === 0)) {
              visible = false; reasons.push('rect-zero');
            }
            const style = window.getComputedStyle(el);
            if (visSet.has('computed-style')) {
              if (style.display === 'none') { visible = false; reasons.push('display-none'); }
              else if (style.visibility === 'hidden' || style.visibility === 'collapse') { visible = false; reasons.push('visibility-hidden'); }
              else {
                const op = parseFloat(style.opacity || '1');
                if (!isNaN(op) && op < 0.1) { visible = false; reasons.push('opacity-too-low'); }
              }
            }
            // 视口检测
            let inViewport = true;
            if (visSet.has('viewport')) {
              const vw = window.innerWidth || document.documentElement.clientWidth;
              const vh = window.innerHeight || document.documentElement.clientHeight;
              const ix = insetPx, iy = insetPx;
              const x1 = rect.x, y1 = rect.y, x2 = rect.x + rect.width, y2 = rect.y + rect.height;
              if (x2 <= ix || y2 <= iy || x1 >= vw - ix || y1 >= vh - iy) {
                inViewport = false; reasons.push('out-of-viewport');
              }
            }

            // 启用检测
            let enabled = true;
            if (disSet.has('dom-property') && el.disabled === true) { enabled = false; reasons.push('el-disabled'); }
            if (disSet.has('attr-disabled') && get('disabled') !== null) { enabled = false; reasons.push('attr-disabled'); }
            if (disSet.has('aria-disabled') && get('aria-disabled') === 'true') { enabled = false; reasons.push('aria-disabled'); }
            if (disSet.has('pseudo-disabled')) {
              try { if (el.matches && el.matches(':disabled')) { enabled = false; reasons.push(':disabled'); } } catch {}
            }
            if (disSet.has('class-disabled') && el.classList) {
              const cls = el.className && typeof el.className === 'string' ? el.className : '';
              if (/\\bdisabled\\b/i.test(cls) || /\\bis-disabled\\b/i.test(cls) || /\\bbtn-disabled\\b/i.test(cls)) { enabled = false; reasons.push('class-disabled'); }
            }
            if (disSet.has('cursor') && style.cursor === 'not-allowed') { enabled = false; reasons.push('cursor-not-allowed'); }
            if (disSet.has('opacity') && !isNaN(parseFloat(style.opacity || '1')) && parseFloat(style.opacity) < 0.5) { enabled = false; reasons.push('opacity-low'); }

            return { actionable: visible && enabled && inViewport, visible, enabled, inViewport, reasons };
          })()`,
          returnByValue: true,
        });
        const val = result.result?.value;
        if (!val || typeof val !== 'object') {
          return { actionable: false, visible: false, enabled: false, inViewport: false, reasons: ['evaluate-failed'] };
        }
        return val as { actionable: boolean; visible: boolean; enabled: boolean; inViewport: boolean; reasons: string[] };
      });
    } catch {
      return { actionable: false, visible: false, enabled: false, inViewport: false, reasons: ['exception'] };
    }
  }

  /**
   * 找第一个匹配的元素（不做尺寸过滤）
   * 适用于表单元素 (input / button / contenteditable) — 这些元素通常 < 100px 高,
   * 会被 cdpFindScrollContainer 的 minHeight=100 门挡掉。
   * 与 cdpFindScrollContainer 不同: 不要求容器尺寸, 返回首个可见元素即可。
   */
  static async cdpFindElement(
    page: Page,
    selectors: string[],
  ): Promise<{ x: number; y: number; w: number; h: number; sel: string; tag: string } | null> {
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.refreshDocument();
        for (const sel of selectors) {
          const location = await ctx.dom.findElementNow(sel);
          if (location) {
            return {
              x: location.center.x,
              y: location.rect.y + location.rect.height * 0.5,
              w: location.rect.width,
              h: location.rect.height,
              sel,
              tag: '',
            };
          }
        }
        return null;
      });
    } catch {
      return null;
    }
  }

  static async cdpSmartScroll(
    page: Page,
    containerSelectors: string[],
    scrollAmount: number = 300,
    direction: 'down' | 'up' = 'down'
  ): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.dom.refreshDocument();

      const container = await HumanActions.findScrollContainer(ctx, containerSelectors);

      const scrollOptions: ScrollOptions = {
        direction,
        totalAmount: scrollAmount,
        segmentSize: { min: 60, max: 150 },
        segmentCount: { min: 2, max: 4 },
        pauseBetween: { min: 60, max: 200 },
        overshootChance: 0.15,
      };

      if (container) {
        await ctx.scroller.scrollInContainer(container.sel, scrollOptions);
      } else {
        await ctx.scroller.scrollPage(scrollOptions);
      }
    });
  }

  static async safeCDPType(page: Page, text: string, selector?: string): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      if (selector) {
        const clicked = await ctx.mouse.click(selector);
        if (!clicked) {
          logger.warn({ selector }, 'Cannot type - element not found');
          return;
        }
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
      }

      for (const char of text) {
        const vkCode = HumanActions.charToVirtualKey(char);
        const code = HumanActions.charToCode(char);
        const isPrintable = char.length === 1 && char.charCodeAt(0) >= 32;

        await ctx.cdp.dispatchKeyEvent({
          type: 'keyDown',
          key: char,
          code,
          windowsVirtualKeyCode: vkCode,
          nativeVirtualKeyCode: vkCode,
        });

        await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));

        if (isPrintable) {
          await ctx.cdp.dispatchKeyEvent({
            type: 'char',
            key: char,
            text: char,
            windowsVirtualKeyCode: vkCode,
            nativeVirtualKeyCode: vkCode,
          });
          await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
        }

        await ctx.cdp.dispatchKeyEvent({
          type: 'keyUp',
          key: char,
          code,
          windowsVirtualKeyCode: vkCode,
          nativeVirtualKeyCode: vkCode,
        });

        await new Promise((r) => setTimeout(r, 30 + Math.random() * 100));
      }
    });
  }

  private static charToVirtualKey(char: string): number {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return code;
    if (code >= 97 && code <= 122) return code - 32;
    if (code >= 48 && code <= 57) return code;
    return code;
  }

  private static charToCode(char: string): string {
    const code = char.charCodeAt(0);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      return `Key${char.toUpperCase()}`;
    }
    if (code >= 48 && code <= 57) {
      return `Digit${char}`;
    }
    if (code === 32) return 'Space';
    return char;
  }

  static async cdpIdleMove(page: Page, x: number, y: number): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.mouse.moveTo({ x, y }, { skipTrajectory: true });
    });
  }

  static async cdpIdleWheel(page: Page, deltaY: number): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.mouse.dispatchWheel(0, deltaY);
    });
  }

  static async pageLoadBehavior(page: Page): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.noise.pageLoadBehavior();
    });
  }

  static async thinkingPause(page: Page, minMs: number = 500, maxMs: number = 2000): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.noise.thinkingPause(minMs, maxMs);
    });
  }

  static async betweenActionsPause(page: Page): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.noise.betweenActionsPause();
    });
  }

  static async randomHoverOnPath(page: Page, targetSelector: string): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.noise.randomHoverOnPath(targetSelector);
    });
  }

  static async queryElementsWithInfo(
    page: Page,
    selector: string
  ): Promise<Array<{ nodeId: number; attrs: Record<string, string>; text: string; visible: boolean }>> {
    return HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.dom.refreshDocument();
      const nodeIds = await ctx.cdp.querySelectorAll(selector);
      const results: Array<{ nodeId: number; attrs: Record<string, string>; text: string; visible: boolean }> = [];

      for (const nodeId of nodeIds) {
        try {
          const attrs = await ctx.cdp.getAttributes(nodeId) || {};

          let text = '';
          try {
            const htmlResult = await ctx.cdp.send('DOM.getOuterHTML', { nodeId });
            text = (htmlResult.outerHTML || '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();
          } catch {}

          const boxModel = await ctx.cdp.getBoxModel(nodeId);
          const visible = boxModel !== null && boxModel.width > 0 && boxModel.height > 0;

          results.push({ nodeId, attrs, text, visible });
        } catch {
          continue;
        }
      }
      return results;
    });
  }

  static async clickAtCoordinates(page: Page, x: number, y: number): Promise<void> {
    await HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.mouse.clickAt(Math.round(x), Math.round(y));
    });
  }

  static async getNodeParentId(page: Page, nodeId: number): Promise<number | null> {
    return HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.dom.refreshDocument();
      const desc = await ctx.cdp.describeNode(nodeId, 0);
      return (desc as any)?.parentId || null;
    });
  }

  static async getElementBoxModel(page: Page, nodeId: number): Promise<import('./cdpClient').BoxModel | null> {
    return HumanActions.withCDPContext(page, async (ctx) => {
      await ctx.dom.refreshDocument();
      return ctx.cdp.getBoxModel(nodeId);
    });
  }

  static async cdpIsMenuExpanded(page: Page, selector: string): Promise<boolean | null> {
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.refreshDocument();
        const nodeId = await ctx.cdp.querySelector(selector);
        if (!nodeId) return null;

        const attrs = await ctx.cdp.getAttributes(nodeId);
        if (attrs) {
          if (attrs['aria-expanded'] === 'true') return true;
          if (attrs['aria-expanded'] === 'false') return false;

          const classAttr = attrs['class'] || '';
          if (classAttr.includes('is-opened') || classAttr.includes('is-expanded') || classAttr.includes('is-active')) {
            return true;
          }
          if (classAttr.includes('el-submenu') && !classAttr.includes('is-opened')) {
            return false;
          }
        }

        return null;
      });
    } catch {
      return null;
    }
  }

  static async cdpScrollNodeIntoView(page: Page, nodeId: number): Promise<boolean> {
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.scrollNodeIntoView(nodeId);
        return true;
      });
    } catch {
      return false;
    }
  }

  static async cdpClickNode(page: Page, nodeId: number): Promise<boolean> {
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.cdp.scrollIntoViewIfNeeded(nodeId);
        await HumanActions.wait(page, 200, 400);

        const boxModel = await ctx.cdp.getBoxModel(nodeId);
        if (boxModel && boxModel.width > 0 && boxModel.height > 0) {
          const quad = boxModel.content;
          const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
          const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
          await ctx.mouse.clickAt(Math.round(x), Math.round(y));
          return true;
        }

        const contentQuads = await ctx.cdp.getContentQuads(nodeId);
        if (contentQuads && contentQuads.length > 0) {
          const quad = contentQuads[0];
          const x = (quad[0] + quad[2]) / 2;
          const y = (quad[1] + quad[3]) / 2;
          await ctx.mouse.clickAt(Math.round(x), Math.round(y));
          return true;
        }

        return false;
      });
    } catch {
      return false;
    }
  }

  static async cdpClickByText(page: Page, text: string, options?: { timeout?: number }): Promise<boolean> {
    const startTime = Date.now();
    const timeout = options?.timeout ?? 10000;

    while (Date.now() - startTime < timeout) {
      try {
        const result = await HumanActions.withCDPContext(page, async (ctx) => {
          await ctx.dom.refreshDocument();

          const searchResult = await ctx.cdp.performSearch(text);
          if (!searchResult || searchResult.resultCount === 0) return false;

          const nodeIds = await ctx.cdp.getSearchResults(
            searchResult.searchId,
            0,
            Math.min(searchResult.resultCount, 10)
          );
          await ctx.cdp.discardSearchResults(searchResult.searchId);

          // 获取视口尺寸，用于判断元素是否已在视口内
          const viewport = await ctx.cdp.getLayoutViewport();
          const vpW = viewport.clientWidth;
          const vpH = viewport.clientHeight;

          // 第一轮：优先点击已在视口内的元素（避免不必要的滚动）
          for (const nodeId of nodeIds) {
            const boxModel = await ctx.cdp.getBoxModel(nodeId);
            if (boxModel && boxModel.width > 0 && boxModel.height > 0) {
              const cx = boxModel.content[0] + boxModel.width / 2;
              const cy = boxModel.content[1] + boxModel.height / 2;
              // 检查是否在视口内
              if (cx >= 0 && cx <= vpW && cy >= 0 && cy <= vpH) {
                await ctx.mouse.clickAt(Math.round(cx), Math.round(cy));
                return true;
              }
            }

            const desc = await ctx.cdp.describeNode(nodeId, 0);
            const parentId = (desc as any)?.parentId;
            if (parentId) {
              const parentBox = await ctx.cdp.getBoxModel(parentId);
              if (parentBox && parentBox.width > 0 && parentBox.height > 0) {
                const cx = parentBox.content[0] + parentBox.width / 2;
                const cy = parentBox.content[1] + parentBox.height / 2;
                if (cx >= 0 && cx <= vpW && cy >= 0 && cy <= vpH) {
                  await ctx.mouse.clickAt(Math.round(cx), Math.round(cy));
                  return true;
                }
              }
            }
          }

          // 第二轮：视口内没有匹配元素，滚动到第一个元素再点击
          for (const nodeId of nodeIds) {
            await ctx.cdp.scrollIntoViewIfNeeded(nodeId);
            await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

            const boxModel = await ctx.cdp.getBoxModel(nodeId);
            if (boxModel && boxModel.width > 0 && boxModel.height > 0) {
              const cx = boxModel.content[0] + boxModel.width / 2;
              const cy = boxModel.content[1] + boxModel.height / 2;
              await ctx.mouse.clickAt(Math.round(cx), Math.round(cy));
              return true;
            }
          }

          return false;
        });

        if (result) return true;
      } catch {}

      await page.waitForTimeout(400);
    }

    return false;
  }

  static async cdpClickByTextFiltered(
    page: Page,
    text: string,
    options?: {
      timeout?: number;
      minWidth?: number;
      minHeight?: number;
      yMin?: number;
      yMax?: number;
      xMin?: number;
      xMax?: number;
    }
  ): Promise<boolean> {
    const startTime = Date.now();
    const timeout = options?.timeout ?? 10000;
    const minWidth = options?.minWidth ?? 10;
    const minHeight = options?.minHeight ?? 10;

    while (Date.now() - startTime < timeout) {
      try {
        const result = await HumanActions.withCDPContext(page, async (ctx) => {
          await ctx.dom.refreshDocument();

          const searchResult = await ctx.cdp.performSearch(text);
          if (!searchResult || searchResult.resultCount === 0) return false;

          const nodeIds = await ctx.cdp.getSearchResults(
            searchResult.searchId,
            0,
            Math.min(searchResult.resultCount, 20)
          );
          await ctx.cdp.discardSearchResults(searchResult.searchId);

          for (const nodeId of nodeIds) {
            let targetBox = await ctx.cdp.getBoxModel(nodeId);

            if (!targetBox || targetBox.width <= 0 || targetBox.height <= 0) {
              const desc = await ctx.cdp.describeNode(nodeId, 0);
              const parentId = (desc as any)?.parentId;
              if (parentId) {
                targetBox = await ctx.cdp.getBoxModel(parentId);
              }
            }

            if (!targetBox || targetBox.width < minWidth || targetBox.height < minHeight) continue;

            const cx = targetBox.content[0] + targetBox.width / 2;
            const cy = targetBox.content[1] + targetBox.height / 2;

            if (options?.yMin !== undefined && cy < options.yMin) continue;
            if (options?.yMax !== undefined && cy > options.yMax) continue;
            if (options?.xMin !== undefined && cx < options.xMin) continue;
            if (options?.xMax !== undefined && cx > options.xMax) continue;

            logger.info({ text, x: Math.round(cx), y: Math.round(cy), w: targetBox.width, h: targetBox.height }, 'Clicking text element with spatial filter');

            await ctx.mouse.clickAt(Math.round(cx), Math.round(cy));
            return true;
          }

          return false;
        });

        if (result) return true;
      } catch {}

      await page.waitForTimeout(400);
    }

    return false;
  }

  // ============================================================
  // iframe 文本搜索 + 点击 — 用于 wujie 等微前端的 iframe 内交互
  // ============================================================

  /**
   * 在指定 iframe 内查找文本并点击（通过 frame.evaluate 查找，无 JS 注入风险）
   * 用于 wujie 微前端的 iframe 内按钮点击（如「展开更多回复」）
   *
   * 策略:
   *   1. 按 frame.name 精确匹配
   *   2. 回退: 按 frame.url 包含 /{frameName}/ 匹配（wujie 预加载 frame）
   *   3. 通过 TreeWalker 遍历文本节点，找到后调用 element.click()
   *
   * @param page      - 当前 page
   * @param frameName - iframe 的 name 属性（如 'interaction'）
   * @param text      - 要点击的文本（精确 trim 匹配）
   * @param options   - timeout (默认 5000ms)
   * @returns         是否点击成功
   */
  static async cdpClickByTextInFrame(
    page: Page,
    frameName: string,
    text: string,
    options?: { timeout?: number },
  ): Promise<boolean> {
    const startTime = Date.now();
    const timeout = options?.timeout ?? 5000;

    while (Date.now() - startTime < timeout) {
      try {
        // Strategy 1: 按 frame.name 精确匹配
        let frame = page.frames().find(f => f.name() === frameName);

        // Strategy 2: 回退 — URL 包含 /{frameName}/
        if (!frame) {
          frame = page.frames().find(f => f.url().includes(`/${frameName}/`));
        }

        if (!frame) {
          await new Promise(r => setTimeout(r, 200));
          continue;
        }

        const clicked = await frame.evaluate((searchText: string) => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node: Text | null;
          while ((node = walker.nextNode() as Text | null)) {
            if (node.textContent?.trim() === searchText) {
              const el = node.parentElement;
              if (el) {
                el.click();
                return true;
              }
            }
          }
          return false;
        }, text);

        if (clicked) return true;
      } catch {}

      await new Promise(r => setTimeout(r, 400 + Math.random() * 200));
    }

    return false;
  }

  static async findElementMultiLevel(
    page: Page,
    config: FallbackConfig,
  ): Promise<FindResult> {
    const minW = config.minWidth ?? 10;
    const minH = config.minHeight ?? 10;
    const pause = config.pauseBetweenSteps ?? { min: 100, max: 300 };

    // ── Level 1: Role ──
    if (config.role) {
      try {
        const loc = page.getByRole(config.role.name as any, config.role.options);
        const box = await loc.boundingBox().catch(() => null);
        if (box && box.width >= minW && box.height >= minH) {
          await HumanActions.wait(page, pause.min, pause.max);
          if (config.hover !== false) { await loc.hover().catch(() => {}); }
          if (config.hoverPause) await HumanActions.wait(page, config.hoverPause.min, config.hoverPause.max);
          logger.info({ method: 'role', name: config.role.name, x: box.x, y: box.y }, 'findElementMultiLevel: found by role');
          return new FindResult(true, 'role', box.x, box.y, box.width, box.height, `role:${config.role.name}`);
        }
      } catch { /* fall through */ }
    }

    // ── Level 2: Text ──
    if (config.texts && config.texts.length > 0) {
      for (const t of config.texts) {
        try {
          const loc = page.getByText(t, { exact: false });
          const count = await loc.count();
          for (let i = 0; i < count; i++) {
            const el = loc.nth(i);
            if (!(await el.isVisible().catch(() => false))) continue;
            const box = await el.boundingBox().catch(() => null);
            if (box && box.width >= minW && box.height >= minH) {
              await HumanActions.wait(page, pause.min, pause.max);
              if (config.hover !== false) { await el.hover().catch(() => {}); }
              if (config.hoverPause) await HumanActions.wait(page, config.hoverPause.min, config.hoverPause.max);
              logger.info({ method: 'text', text: t }, 'findElementMultiLevel: found by text');
              return new FindResult(true, 'text', box.x, box.y, box.width, box.height, `text:${t}`);
            }
          }
        } catch { /* fall through */ }
      }
    }

    // ── Level 3: Placeholder / Label ──
    if (config.placeholder) {
      try {
        const loc = page.getByPlaceholder(config.placeholder);
        const box = await loc.boundingBox().catch(() => null);
        if (box && box.width >= minW && box.height >= minH) {
          await HumanActions.wait(page, pause.min, pause.max);
          if (config.hover !== false) { await loc.hover().catch(() => {}); }
          if (config.hoverPause) await HumanActions.wait(page, config.hoverPause.min, config.hoverPause.max);
          logger.info({ method: 'placeholder', placeholder: config.placeholder }, 'findElementMultiLevel: found by placeholder');
          return new FindResult(true, 'placeholder', box.x, box.y, box.width, box.height, `placeholder:${config.placeholder}`);
        }
      } catch { /* fall through */ }
    }
    if (config.label) {
      try {
        const loc = page.getByLabel(config.label);
        const box = await loc.boundingBox().catch(() => null);
        if (box && box.width >= minW && box.height >= minH) {
          await HumanActions.wait(page, pause.min, pause.max);
          if (config.hover !== false) { await loc.hover().catch(() => {}); }
          if (config.hoverPause) await HumanActions.wait(page, config.hoverPause.min, config.hoverPause.max);
          logger.info({ method: 'label', label: config.label }, 'findElementMultiLevel: found by label');
          return new FindResult(true, 'label', box.x, box.y, box.width, box.height, `label:${config.label}`);
        }
      } catch { /* fall through */ }
    }

    // ── Level 4: CSS Selector（自动追加 :visible） ──
    if (config.cssSelectors && config.cssSelectors.length > 0) {
      for (const sel of config.cssSelectors) {
        try {
          const loc = page.locator(`${sel}:visible`).first();
          if ((await loc.count()) === 0) continue;
          const box = await loc.boundingBox().catch(() => null);
          if (box && box.width >= minW && box.height >= minH) {
            await HumanActions.wait(page, pause.min, pause.max);
            if (config.hover !== false) { await loc.hover().catch(() => {}); }
            if (config.hoverPause) await HumanActions.wait(page, config.hoverPause.min, config.hoverPause.max);
            logger.info({ method: 'css', selector: sel }, 'findElementMultiLevel: found by CSS');
            return new FindResult(true, 'css', box.x, box.y, box.width, box.height, sel);
          }
        } catch { /* fall through */ }
      }
    }

    // ── Level 5: 坐标回退 — 相对容器偏移 ──
    if (config.coordinate) {
      const containerSel = config.coordinateContainer || 'body';
      try {
        const container = page.locator(containerSel).first();
        const cBox = await container.boundingBox().catch(() => null);
        if (cBox) {
          const tx = cBox.x + cBox.width * config.coordinate.xRatio + (config.coordinate.offsetX ?? 0);
          const ty = cBox.y + cBox.height * config.coordinate.yRatio + (config.coordinate.offsetY ?? 0);
          const fx = tx + (Math.random() - 0.5) * 10;
          const fy = ty + (Math.random() - 0.5) * 10;
          logger.info({ method: 'coordinate', x: Math.round(fx), y: Math.round(fy) }, 'findElementMultiLevel: found by coordinate');
          return new FindResult(true, 'coordinate', fx, fy, 0, 0, containerSel);
        }
      } catch { /* fall through */ }
    }

    logger.warn({ config }, 'findElementMultiLevel: all levels exhausted');
    return new FindResult(false, 'none');
  }

  // ============================================================
  // 文件上传 — CDP 安全注入（不触发 OS 级 filechooser 事件）
  // ============================================================

  /**
   * 通过 CDP 安全设置文件上传
   * 先通过多级回退找到上传容器/input，再使用 patchright 的 setInputFiles
   * 不使用 page.waitForEvent('filechooser')，避免 OS 级对话框检测
   */
  static async cdpSetInputFiles(
    page: Page,
    filePath: string,
    options?: {
      containerSelector?: string;   // 上传容器（可选，参考 douyin: div.container-drag-VAfIfu）
      inputSelector?: string;       // 文件 input（可选，默认 input[type='file']）
      clickBeforeUpload?: boolean;   // 是否在设置文件前点击上传区域
      clickSelector?: string;       // 要点击的上传区域选择器
      fallbackSelectors?: string[];  // 回退容器选择器列表
    },
  ): Promise<boolean> {
    const container = options?.containerSelector;
    const input = options?.inputSelector || "input[type='file']";
    const clickBefore = options?.clickBeforeUpload !== false;
    const clickTarget = options?.clickSelector || container;
    const fallbacks = options?.fallbackSelectors || [
      '[class*="upload"]', '[class*="drag"]', '[class*="container-drag"]',
    ];

    const tryUpload = async (sel: string): Promise<boolean> => {
      try {
        const loc = page.locator(sel).first();
        const cnt = await loc.count();
        if (!cnt) return false;

        // 人类行为：hover + 短暂停顿后再操作
        await loc.hover().catch(() => {});
        await HumanActions.wait(page, 200, 500);

        // 如果指定了点击目标，先触发上传区域（部分网站需要点击才能展开 file input）
        if (clickBefore && clickTarget) {
          const clickLoc = page.locator(clickTarget).first();
          if (await clickLoc.count()) {
            await HumanActions.cdpClick(page, clickTarget);
            await HumanActions.wait(page, 300, 800);
          }
        }

        // CDP 安全文件注入
        await loc.setInputFiles(filePath);
        return true;
      } catch {
        return false;
      }
    };

    // 主线：通过指定容器 > 内部 input
    if (container) {
      try {
        const cnt = await page.locator(container).first().count();
        if (cnt) {
          const innerInput = page.locator(container).locator(input).first();
          const icnt = await innerInput.count();
          if (icnt) {
            await innerInput.hover().catch(() => {});
            await HumanActions.wait(page, 200, 500);
            await innerInput.setInputFiles(filePath);
            logger.info({ container, file: filePath }, 'cdpSetInputFiles: uploaded via container');
            return true;
          }
        }
      } catch {
        // 容器方案失败，继续回退
      }
    }

    // 回退 1：通过用户指定的回退选择器
    for (const sel of fallbacks) {
      if (await tryUpload(sel)) {
        logger.info({ selector: sel, file: filePath }, 'cdpSetInputFiles: uploaded via fallback');
        return true;
      }
    }

    // 回退 2：直接找任意 file input
    try {
      const anyInput = page.locator("input[type='file']").first();
      if (await anyInput.count()) {
        await anyInput.setInputFiles(filePath);
        logger.info({ file: filePath }, 'cdpSetInputFiles: uploaded via direct file input');
        return true;
      }
    } catch {
      // 最终失败
    }

    logger.warn({ file: filePath }, 'cdpSetInputFiles: all methods exhausted');
    return false;
  }

  // ============================================================
  // 等待选择器状态 — CDP 安全等待
  // ============================================================

  /**
   * 通过 CDP 安全等待选择器状态变化
   * 使用 CDP document 查询 + 轮询，避免直接 page.waitForSelector 产生的检测特征
   */
  static async cdpWaitForSelector(
    page: Page,
    selector: string,
    options?: { state?: 'visible' | 'hidden' | 'attached' | 'detached'; timeout?: number; pollInterval?: number },
  ): Promise<boolean> {
    const timeout = options?.timeout ?? 30000;
    const interval = options?.pollInterval ?? 500;
    const state = options?.state ?? 'visible';
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const visible = await HumanActions.cdpIsElementVisible(page, selector);
        if ((state === 'visible' && visible) || (state === 'hidden' && !visible)) {
          return true;
        }
        if (state === 'attached') {
          // 通过 CDP 检查 DOM 中是否存在
          try {
            await HumanActions.withCDPContext(page, async (ctx) => {
              await ctx.dom.refreshDocument();
              const loc = await ctx.dom.findElementNow(selector);
              if (loc) return true;
            });
          } catch {}
        }
      } catch {
        // 轮询中忽略瞬时错误
      }
      await page.waitForTimeout(interval);
    }

    return false;
  }

  // ============================================================
  // 跨 iframe 操作 — 用于 wujie 等微前端架构
  // 优先通过 patchright 的 Frame API (无需 JS 注入)，
  // 回退到 contentDocument evaluate (兼容动态 iframe)
  // ============================================================

  /**
   * 通过 frame name 在同源 iframe 内查找元素并点击。
   *
   * 策略：
   * 1. page.frame(name) → frame.$$() + frame.click() (无 JS 注入)
   * 2. 回退: page.evaluate 穿透 iframe contentDocument (兼容动态创建/替换的 iframe)
   *
   * @param page       - Patchright Page
   * @param frameName  - iframe 的 name 属性 (如 'interaction')
   * @param selector   - CSS 选择器 (如 '.comment-feed-wrap')
   * @param options.text - 可选，匹配元素的文本内容 (精确匹配)
   * @param options.exact - 精确匹配文本 (默认 true)
   * @returns          - true 如果成功点击
   */
  static async cdpClickInFrame(
    page: Page,
    frameName: string,
    selector: string,
    options?: { text?: string; exact?: boolean },
  ): Promise<boolean> {
    try {
      const exact = options?.exact ?? true;

      // ── 策略1: patchright Frame API (无 JS 注入) ──
      // 先按 name 查找，回退到 URL 路径匹配（wujie iframe name 可能为空）
      let frame = page.frames().find(f => f.name() === frameName);
      if (!frame) {
        // URL fallback: 用 frameName 作为 URL 路径段匹配（如 'interaction' → '/interaction/'）
        frame = page.frames().find(f => f.url().includes(`/${frameName}/`));
      }
      if (frame) {
        if (options?.text) {
          const elements = await frame.$$(selector);
          for (const el of elements) {
            const text = await el.evaluate((node: Element) => node.textContent?.trim() || '');
            if (exact && text === options.text) {
              // 先 hover 再点击（部分页面依赖 mouseenter 事件）
              const box = await el.boundingBox();
              if (box) {
                await HumanActions.cdpIdleMove(page, box.x + box.width / 2, box.y + box.height / 2);
                await HumanActions.wait(page, 150, 300);
              }
              await el.click();
              return true;
            }
            if (!exact && text.includes(options.text.slice(0, 10))) {
              const box = await el.boundingBox();
              if (box) {
                await HumanActions.cdpIdleMove(page, box.x + box.width / 2, box.y + box.height / 2);
                await HumanActions.wait(page, 150, 300);
              }
              await el.click();
              return true;
            }
          }
        } else {
          const el = await frame.$(selector);
          if (el) {
            const box = await el.boundingBox();
            if (box) {
              await HumanActions.cdpIdleMove(page, box.x + box.width / 2, box.y + box.height / 2);
              await HumanActions.wait(page, 150, 300);
            }
            await el.click();
            return true;
          }
        }
      }

      // ── 策略2: contentDocument 回退 (动态 iframe, 含 shadow DOM) ──
      const result = await page.evaluate(
        ({ frameName, selector, text, exact }) => {
          /**
           * 深度 querySelectorAll — 穿透 wujie-app 等 custom element 的 shadowRoot
           */
          function deepQueryIframes(root: Document | ShadowRoot): HTMLIFrameElement[] {
            const directIframes = Array.from(root.querySelectorAll('iframe'));
            const shadowIframes: HTMLIFrameElement[] = [];
            // 遍历所有元素，检查是否有 shadowRoot
            for (const el of Array.from(root.querySelectorAll('*'))) {
              const sr = (el as HTMLElement).shadowRoot;
              if (sr) {
                shadowIframes.push(...Array.from(sr.querySelectorAll('iframe')));
              }
            }
            return [...directIframes, ...shadowIframes];
          }

          function queryInDoc(doc: Document): Element[] {
            return Array.from(doc.querySelectorAll(selector));
          }

          const allIframes = deepQueryIframes(document);
          for (const iframe of allIframes) {
            if (iframe.name !== frameName && !iframe.hasAttribute('data-wujie-flag')) continue;
            try {
              const doc = (iframe as HTMLIFrameElement).contentDocument
                || (iframe as HTMLIFrameElement).contentWindow?.document;
              if (!doc) continue;
              const matches = queryInDoc(doc);
              if (text) {
                const target = exact
                  ? matches.find(m => m.textContent?.trim() === text)
                  : matches.find(m => m.textContent?.trim().includes(text.slice(0, 10)));
                if (target) {
                  // 先 dispatch mouseenter/mousemove，再 click
                  target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                  target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
                  (target as HTMLElement).click();
                  return true;
                }
              } else if (matches[0]) {
                matches[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                matches[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
                (matches[0] as HTMLElement).click();
                return true;
              }
            } catch { /* cross-origin */ }
          }
          return false;
        },
        { frameName, selector, text: options?.text, exact }
      );

      if (result) return true;
    } catch (err: any) {
      logger.warn({ frameName, selector, error: err.message }, 'cdpClickInFrame failed');
    }
    return false;
  }

  /**
   * 检查同源 iframe 内是否包含匹配的元素（含文本过滤）。
   */
  static async cdpIsElementInFrame(
    page: Page,
    frameName: string,
    selector: string,
    options?: { text?: string; exact?: boolean },
  ): Promise<boolean> {
    try {
      const exact = options?.exact ?? true;

      // ── 策略1: patchright Frame API (无 JS 注入) ──
      // 先按 name 查找，回退到 URL 路径匹配（wujie iframe name 可能为空）
      let frame = page.frames().find(f => f.name() === frameName);
      if (!frame) {
        frame = page.frames().find(f => f.url().includes(`/${frameName}/`));
      }
      if (frame) {
        if (options?.text) {
          const elements = await frame.$$(selector);
          for (const el of elements) {
            const text = await el.evaluate((node: Element) => node.textContent?.trim() || '');
            if (exact && text === options.text) return true;
            if (!exact && text.includes(options.text.slice(0, 10))) return true;
          }
          return false;
        }
        const el = await frame.$(selector);
        return el !== null;
      }

      // ── 策略2: contentDocument 回退 (含 shadow DOM) ──
      const found = await page.evaluate(
        ({ frameName, selector, text, exact }: { frameName: string; selector: string; text?: string; exact: boolean }) => {
          function deepQueryIframes(root: Document | ShadowRoot): HTMLIFrameElement[] {
            const directIframes = Array.from(root.querySelectorAll('iframe'));
            const shadowIframes: HTMLIFrameElement[] = [];
            for (const el of Array.from(root.querySelectorAll('*'))) {
              const sr = (el as HTMLElement).shadowRoot;
              if (sr) {
                shadowIframes.push(...Array.from(sr.querySelectorAll('iframe')));
              }
            }
            return [...directIframes, ...shadowIframes];
          }

          const allIframes = deepQueryIframes(document);
          for (const iframe of allIframes) {
            if (iframe.name !== frameName && !iframe.hasAttribute('data-wujie-flag')) continue;
            try {
              const doc = (iframe as HTMLIFrameElement).contentDocument
                || (iframe as HTMLIFrameElement).contentWindow?.document;
              if (!doc) continue;
              const matches = Array.from(doc.querySelectorAll(selector));
              if (!text) return matches.length > 0;
              if (exact) return matches.some(m => m.textContent?.trim() === text);
              return matches.some(m => m.textContent?.trim().includes(text.slice(0, 10)));
            } catch { /* cross-origin */ }
          }
          return false;
        },
        { frameName, selector, text: options?.text, exact }
      );

      return found;
    } catch {
      return false;
    }
  }

  /**
   * 在同源 iframe 内滚动容器。
   * 用于 wujie 瀑布流等场景，需要在 iframe 内滚动容器而不是 viewport。
   *
   * 策略：
   * 1. 获取容器在视口中的位置
   * 2. 将鼠标移到容器上（hover，触发 mouseenter 事件）
   * 3. 使用 CDP 鼠标滚轮事件模拟滚动
   *    （某些页面要求先 hover 才能激活滚轮监听，如 vue-infinite-scroll）
   */
  static async cdpScrollContainerInFrame(
    page: Page,
    frameName: string,
    containerSelector: string,
    distance: number,
  ): Promise<boolean> {
    try {
      // ── 步骤1: 获取容器在视口中的位置（从 iframe contentDocument 或 shadow DOM）──
      const rect = await page.evaluate(
        ({ frameName, containerSelector }: { frameName: string; containerSelector: string }) => {
          function deepQueryIframes(root: Document | ShadowRoot): HTMLIFrameElement[] {
            const directIframes = Array.from(root.querySelectorAll('iframe'));
            const shadowIframes: HTMLIFrameElement[] = [];
            for (const el of Array.from(root.querySelectorAll('*'))) {
              const sr = (el as HTMLElement).shadowRoot;
              if (sr) {
                shadowIframes.push(...Array.from(sr.querySelectorAll('iframe')));
              }
            }
            return [...directIframes, ...shadowIframes];
          }

          function findContainer(doc: Document | ShadowRoot): Element | null {
            return doc.querySelector(containerSelector)
              || doc.querySelector('.scroll-list__wrp')
              || doc.querySelector('.feeds-container')
              || doc.querySelector('.scroll-list');
          }

          // 尝试从 iframe 中获取（穿透 shadow DOM 查找）
          const allIframes = deepQueryIframes(document);
          for (const iframe of allIframes) {
            // 只处理匹配的 frameName 或 data-wujie-flag iframe
            if (iframe.name !== frameName && !iframe.hasAttribute('data-wujie-flag')) continue;
            try {
              const doc = (iframe as HTMLIFrameElement).contentDocument
                || (iframe as HTMLIFrameElement).contentWindow?.document;
              if (doc) {
                const container = findContainer(doc);
                if (container) {
                  const r = container.getBoundingClientRect();
                  return { top: r.top, left: r.left, width: r.width, height: r.height };
                }
              }
            } catch { /* cross-origin */ }
          }

          // 尝试从 wujie-app shadow DOM 获取
          const wujieApps = document.querySelectorAll('wujie-app');
          for (const app of Array.from(wujieApps)) {
            const sr = (app as HTMLElement).shadowRoot;
            if (!sr) continue;
            const container = findContainer(sr);
            if (container) {
              const r = container.getBoundingClientRect();
              return { top: r.top, left: r.left, width: r.width, height: r.height };
            }
          }

          // 主文档
          const container = findContainer(document);
          if (container) {
            const r = container.getBoundingClientRect();
            return { top: r.top, left: r.left, width: r.width, height: r.height };
          }
          return null;
        },
        { frameName, containerSelector }
      );

      if (!rect) {
        logger.warn({ frameName, containerSelector }, 'cdpScrollContainerInFrame: container not found');
        return false;
      }

      // ── 步骤2: 将鼠标移到容器中央（hover，触发 mouseenter/over）──
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      await HumanActions.cdpIdleMove(page, centerX, centerY);
      await HumanActions.wait(page, 200, 400);

      // ── 步骤3: 使用鼠标滚轮滚动（模拟真实用户滚动）──
      // CDP Input.dispatchMouseEvent 的 mouseWheel 类型会滚动鼠标悬停的元素
      // 调用 cdpIdleWheel 多次，模拟分段滚动
      const segments = Math.max(2, Math.ceil(Math.abs(distance) / 150));
      const segmentSize = Math.floor(distance / segments);
      for (let i = 0; i < segments; i++) {
        // 每次滚轮前微移鼠标（模拟真实手部抖动）
        if (i % 3 === 2) {
          const jitterX = centerX + (Math.random() - 0.5) * 4;
          const jitterY = centerY + (Math.random() - 0.5) * 4;
          await HumanActions.cdpIdleMove(page, jitterX, jitterY);
        }
        await HumanActions.cdpIdleWheel(page, segmentSize);
        await HumanActions.wait(page, 100, 300);
      }

      return true;
    } catch (err: any) {
      logger.warn({ frameName, containerSelector, error: err.message }, 'cdpScrollContainerInFrame failed');
      return false;
    }
  }
}
