import { CDPClient } from './cdpClient';
import { TrajectoryGenerator, Point } from './trajectory';
import { CDPDomNavigator, ElementLocation } from './cdpDom';
import { rootLogger } from '../logger';
const logger = rootLogger.child({ name: 'cdpMouse' });

export interface MouseState {
  x: number;
  y: number;
  buttonPressed: 'none' | 'left' | 'right' | 'middle';
}

export class CDPHumanMouse {
  private cdp: CDPClient;
  private dom: CDPDomNavigator;
  private state: MouseState;
  private traceCollector: { recordMouseTrace: (point: any) => void } | null = null;

  constructor(cdp: CDPClient, dom: CDPDomNavigator) {
    this.cdp = cdp;
    this.dom = dom;
    this.state = { x: 0, y: 0, buttonPressed: 'none' };
  }

  setTraceCollector(collector: { recordMouseTrace: (point: any) => void } | null): void {
    this.traceCollector = collector;
  }

  getState(): MouseState {
    return { ...this.state };
  }

  async moveTo(target: Point, options?: { skipTrajectory?: boolean }): Promise<void> {
    if (options?.skipTrajectory) {
      await this.dispatchMove(target.x, target.y);
      this.state.x = target.x;
      this.state.y = target.y;
      return;
    }

    const start: Point = { x: this.state.x, y: this.state.y };
    const trajectory = TrajectoryGenerator.generateBezierPath(start, target);

    for (const point of trajectory) {
      await this.dispatchMove(point.x, point.y);
      this.state.x = point.x;
      this.state.y = point.y;
      this.trace('move', point.x, point.y);
      await this.sleep(point.delay);
    }
  }

  async moveToElement(selector: string, options?: { timeout?: number; offset?: Point }): Promise<ElementLocation | null> {
    const location = await this.dom.findElement(selector, { timeout: options?.timeout });
    if (!location) {
      logger.warn({ selector }, 'Element not found for mouse move');
      return null;
    }

    let target = { ...location.center };

    const maxOffsetX = Math.min(location.rect.width * 0.15, location.rect.width * 0.4 - 2);
    const maxOffsetY = Math.min(location.rect.height * 0.15, location.rect.height * 0.4 - 2);
    target.x += this.gaussianOffset(Math.max(maxOffsetX, 0));
    target.y += this.gaussianOffset(Math.max(maxOffsetY, 0));

    if (options?.offset) {
      target.x += options.offset.x;
      target.y += options.offset.y;
    }

    target.x = Math.round(target.x * 10) / 10;
    target.y = Math.round(target.y * 10) / 10;

    await this.moveTo(target);
    return location;
  }

  async hover(selector: string, duration?: number): Promise<ElementLocation | null> {
    const location = await this.moveToElement(selector);
    if (!location) return null;

    const hoverTime = duration ?? (300 + Math.random() * 500);
    await this.sleep(hoverTime);

    return location;
  }

  async click(selector: string, options?: { timeout?: number }): Promise<boolean> {
    const location = await this.moveToElement(selector, { timeout: options?.timeout });
    if (!location) return false;

    await this.performClick(location.center);
    return true;
  }

  async clickAt(x: number, y: number): Promise<void> {
    await this.moveTo({ x, y });
    await this.performClick({ x, y });
  }

  async doubleClick(selector: string): Promise<boolean> {
    const location = await this.moveToElement(selector);
    if (!location) return false;

    await this.performClick(location.center, { clickCount: 1 });
    await this.sleep(80 + Math.random() * 120);
    await this.performClick(location.center, { clickCount: 2 });
    return true;
  }

  async rightClick(selector: string): Promise<boolean> {
    const location = await this.moveToElement(selector);
    if (!location) return false;

    const target = location.center;
    await this.sleep(50 + Math.random() * 150);

    await this.cdp.dispatchMouseEvent({
      type: 'mousePressed',
      x: target.x,
      y: target.y,
      button: 'right',
      buttons: 2,
      clickCount: 1,
    });
    this.trace('down', target.x, target.y, 'right');

    await this.sleep(30 + Math.random() * 50);

    await this.cdp.dispatchMouseEvent({
      type: 'mouseReleased',
      x: target.x,
      y: target.y,
      button: 'right',
      buttons: 0,
      clickCount: 1,
    });
    this.trace('up', target.x, target.y, 'right');

    return true;
  }

  private async performClick(target: Point, options?: { clickCount?: number }): Promise<void> {
    const clickCount = options?.clickCount ?? 1;

    await this.sleep(50 + Math.random() * 150);

    if (Math.random() < 0.05) {
      const jitterX = (Math.random() - 0.5) * 2;
      const jitterY = (Math.random() - 0.5) * 2;
      await this.dispatchMove(target.x + jitterX, target.y + jitterY);
      await this.sleep(10 + Math.random() * 20);
    }

    await this.cdp.dispatchMouseEvent({
      type: 'mousePressed',
      x: target.x,
      y: target.y,
      button: 'left',
      buttons: 1,
      clickCount,
    });
    this.state.buttonPressed = 'left';
    this.trace('down', target.x, target.y);

    const pressDuration = 20 + Math.random() * 60;
    await this.sleep(pressDuration);

    await this.cdp.dispatchMouseEvent({
      type: 'mouseReleased',
      x: target.x,
      y: target.y,
      button: 'left',
      buttons: 0,
      clickCount,
    });
    this.state.buttonPressed = 'none';
    this.trace('up', target.x, target.y);
  }

  async dispatchWheel(deltaX: number, deltaY: number, x?: number, y?: number): Promise<void> {
    const posX = x ?? this.state.x;
    const posY = y ?? this.state.y;

    await this.cdp.dispatchMouseEvent({
      type: 'mouseWheel',
      x: posX,
      y: posY,
      deltaX,
      deltaY,
    });
    this.trace('wheel', posX, posY, `deltaY:${deltaY}`);
  }

  private async dispatchMove(x: number, y: number): Promise<void> {
    await this.cdp.dispatchMouseEvent({
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: this.state.buttonPressed === 'left' ? 1 : 0,
    });
  }

  private gaussianOffset(maxOffset: number): number {
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(Math.max(u1, 0.0001))) * Math.cos(2 * Math.PI * u2);
    return Math.round(z * (maxOffset / 3));
  }

  private trace(type: string, x: number, y: number, detail?: string): void {
    if (this.traceCollector) {
      this.traceCollector.recordMouseTrace({
        x,
        y,
        timestamp: Date.now(),
        type,
        detail,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
