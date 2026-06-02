import { CDPClient, ViewportRect } from './cdpClient';
import { CDPDomNavigator, ElementLocation } from './cdpDom';
import { CDPHumanMouse } from './cdpMouse';
import { rootLogger } from '../logger';
const logger = rootLogger.child({ name: 'cdpScroller' });

export type ScrollContainerType = 'iframe_floater' | 'virtual_list' | 'page_body' | 'unknown';

export interface ScrollOptions {
  direction: 'down' | 'up';
  totalAmount: number;
  segmentSize?: { min: number; max: number };
  segmentCount?: { min: number; max: number };
  pauseBetween?: { min: number; max: number };
  overshootChance?: number;
}

export class CDPScroller {
  private cdp: CDPClient;
  private dom: CDPDomNavigator;
  private mouse: CDPHumanMouse;

  constructor(cdp: CDPClient, dom: CDPDomNavigator, mouse: CDPHumanMouse) {
    this.cdp = cdp;
    this.dom = dom;
    this.mouse = mouse;
  }

  async scrollPage(options: ScrollOptions): Promise<void> {
    const viewport = await this.cdp.getLayoutViewport();
    const mouseState = this.mouse.getState();

    const inViewport = mouseState.x >= 0
      && mouseState.x <= viewport.clientWidth
      && mouseState.y >= 0
      && mouseState.y <= viewport.clientHeight;

    if (!inViewport) {
      const targetX = viewport.clientWidth / 2 + (Math.random() - 0.5) * 100;
      const targetY = viewport.clientHeight / 2 + (Math.random() - 0.5) * 100;
      await this.mouse.moveTo({ x: targetX, y: targetY });
    }

    await this.executeScroll(options);
  }

  async scrollInContainer(
    containerSelector: string,
    options: ScrollOptions
  ): Promise<boolean> {
    const containerType = await this.detectContainerType(containerSelector);

    logger.debug({ containerSelector, containerType }, 'Detected scroll container type');

    switch (containerType) {
      case 'iframe_floater':
        return this.scrollIframeContainer(containerSelector, options);
      case 'virtual_list':
        return this.scrollVirtualList(containerSelector, options);
      case 'page_body':
        return this.scrollPageBodyContainer(containerSelector, options);
      default:
        return this.scrollGenericContainer(containerSelector, options);
    }
  }

  async scrollUntil(
    containerSelector: string | null,
    condition: () => Promise<boolean>,
    options: ScrollOptions & { maxScrolls?: number }
  ): Promise<boolean> {
    const maxScrolls = options.maxScrolls ?? 20;
    let scrollCount = 0;

    while (scrollCount < maxScrolls) {
      if (await condition()) return true;

      if (containerSelector) {
        await this.scrollInContainer(containerSelector, options);
      } else {
        await this.scrollPage(options);
      }

      scrollCount++;
    }

    return false;
  }

  private async detectContainerType(selector: string): Promise<ScrollContainerType> {
    const nodeId = await this.cdp.querySelector(selector);
    if (!nodeId || nodeId <= 0) return 'unknown';

    const attrs = await this.cdp.getAttributes(nodeId);
    if (!attrs) return 'unknown';

    const style = attrs.style || '';
    if (style.includes('translate') || style.includes('transform')) {
      const node = await this.cdp.describeNode(nodeId, 1);
      if (node?.children?.some(c => c.nodeName?.toLowerCase() === 'iframe')) {
        return 'iframe_floater';
      }
    }

    const className = attrs.class || '';
    const id = attrs.id || '';
    const identifier = `${className} ${id}`.toLowerCase();

    if (
      identifier.includes('list')
      || identifier.includes('sidesheet-body')
      || identifier.includes('virtual')
      || identifier.includes('scroll')
    ) {
      return 'virtual_list';
    }

    if (selector === 'body' || selector === 'html') {
      return 'page_body';
    }

    return 'unknown';
  }

  private async scrollIframeContainer(selector: string, options: ScrollOptions): Promise<boolean> {
    const iframeSelector = `${selector} iframe`;
    const location = await this.dom.findElement(iframeSelector);
    if (!location) {
      logger.debug({ selector }, 'Iframe not found in container');
      return false;
    }

    const center = location.center;
    await this.mouse.moveTo({
      x: center.x + (Math.random() - 0.5) * 10,
      y: center.y + (Math.random() - 0.5) * 10,
    });

    await this.sleep(100 + Math.random() * 200);

    await this.executeScroll(options);
    return true;
  }

  private async scrollVirtualList(selector: string, options: ScrollOptions): Promise<boolean> {
    const location = await this.dom.findElement(selector);
    if (!location) return false;

    const targetY = location.rect.y + location.rect.height * (0.3 + Math.random() * 0.4);
    const targetX = location.rect.x + location.rect.width / 2;

    await this.mouse.moveTo({
      x: targetX + (Math.random() - 0.5) * 20,
      y: targetY + (Math.random() - 0.5) * 10,
    });

    await this.sleep(100 + Math.random() * 200);

    await this.executeScroll(options);
    return true;
  }

  private async scrollPageBodyContainer(selector: string, options: ScrollOptions): Promise<boolean> {
    const viewport = await this.cdp.getLayoutViewport();
    const targetX = viewport.clientWidth / 2 + (Math.random() - 0.5) * 100;
    const targetY = viewport.clientHeight / 2 + (Math.random() - 0.5) * 100;

    await this.mouse.moveTo({ x: targetX, y: targetY });
    await this.executeScroll(options);
    return true;
  }

  private async scrollGenericContainer(selector: string, options: ScrollOptions): Promise<boolean> {
    const location = await this.dom.findElement(selector);
    if (!location) return false;

    if (!this.isPointInRect(this.mouse.getState(), location.rect)) {
      const targetX = location.rect.x + location.rect.width / 2;
      const targetY = location.rect.y + location.rect.height * (0.3 + Math.random() * 0.4);
      await this.mouse.moveTo({ x: targetX, y: targetY });
    }

    await this.sleep(100 + Math.random() * 200);
    await this.executeScroll(options);
    return true;
  }

  private async executeScroll(options: ScrollOptions): Promise<void> {
    const segMin = options.segmentSize?.min ?? 60;
    const segMax = options.segmentSize?.max ?? 100;
    const countMin = options.segmentCount?.min ?? 2;
    const countMax = options.segmentCount?.max ?? 5;
    const pauseMin = options.pauseBetween?.min ?? 400;
    const pauseMax = options.pauseBetween?.max ?? 1200;
    const overshootChance = options.overshootChance ?? 0.15;

    let remaining = Math.abs(options.totalAmount);
    const direction = options.direction === 'down' ? 1 : -1;

    while (remaining > 0) {
      const segmentCount = countMin + Math.floor(Math.random() * (countMax - countMin + 1));

      for (let i = 0; i < segmentCount && remaining > 0; i++) {
        const step = Math.min(segMin + Math.random() * (segMax - segMin), remaining);
        const deltaY = step * direction;

        const overshoot = Math.random() < overshootChance
          ? (10 + Math.random() * 20) * direction
          : 0;

        await this.mouse.dispatchWheel(0, deltaY + overshoot);
        remaining -= step;

        await this.sleep(20 + Math.random() * 30);

        if (overshoot !== 0) {
          await this.sleep(50 + Math.random() * 100);
          await this.mouse.dispatchWheel(0, -overshoot);
        }
      }

      if (remaining > 0) {
        const pauseTime = pauseMin + Math.random() * (pauseMax - pauseMin);
        await this.sleep(pauseTime);
      }
    }
  }

  private isPointInRect(point: { x: number; y: number }, rect: ViewportRect): boolean {
    return point.x >= rect.x
      && point.x <= rect.x + rect.width
      && point.y >= rect.y
      && point.y <= rect.y + rect.height;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
