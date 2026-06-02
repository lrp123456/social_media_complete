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

  static async cdpFindScrollContainer(
    page: Page,
    selectors: string[],
    minWidth: number = 50,
    minHeight: number = 100
  ): Promise<{ x: number; y: number; w: number; h: number; sel: string } | null> {
    try {
      return await HumanActions.withCDPContext(page, async (ctx) => {
        await ctx.dom.refreshDocument();
        return HumanActions.findScrollContainer(ctx, selectors, minWidth, minHeight);
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

          for (const nodeId of nodeIds) {
            const boxModel = await ctx.cdp.getBoxModel(nodeId);
            if (boxModel && boxModel.width > 0 && boxModel.height > 0) {
              const cx = boxModel.content[0] + boxModel.width / 2;
              const cy = boxModel.content[1] + boxModel.height / 2;
              await ctx.mouse.clickAt(Math.round(cx), Math.round(cy));
              return true;
            }

            const desc = await ctx.cdp.describeNode(nodeId, 0);
            const parentId = (desc as any)?.parentId;
            if (parentId) {
              const parentBox = await ctx.cdp.getBoxModel(parentId);
              if (parentBox && parentBox.width > 0 && parentBox.height > 0) {
                const cx = parentBox.content[0] + parentBox.width / 2;
                const cy = parentBox.content[1] + parentBox.height / 2;
                await ctx.mouse.clickAt(Math.round(cx), Math.round(cy));
                return true;
              }
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
}
