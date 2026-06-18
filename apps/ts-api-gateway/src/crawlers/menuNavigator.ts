import type { Page } from 'patchright';
import type { PlatformName } from '@social-media/shared-config';
import { HumanActions } from '@social-media/browser-core';
import type { SelectorDef } from './menuSelectors';
import { getSelector, getSelectorChain, resolveCrawlerKey } from './menuSelectors';
import { createLogger } from '../lib/logger';
import { reportClickResult, type SelectorStrategy } from '../services/selectorEffectivenessService';

const logger = createLogger('menu-navigator');

/**
 * Resolve a menu selector key by traversing its parent chain, expanding
 * collapsed parent menus as needed, then clicking the final target element.
 *
 * @param page        - Patchright Page instance
 * @param selectorKey - Dot-delimited selector key (e.g. `'menu.content.work-manage'`)
 * @param platform    - Platform identifier
 * @param options     - Optional timeout override
 * @returns           - true if the final target was successfully clicked
 */
export async function resolveAndClick(
  page: Page,
  selectorKey: string,
  platform: PlatformName,
  options?: { timeout?: number },
): Promise<boolean> {
  const chain = getSelectorChain(selectorKey, platform);
  if (chain.length === 0) {
    logger.warn({ selectorKey, platform }, 'resolveAndClick: empty selector chain');
    return false;
  }

  logger.info({ chain, selectorKey, platform }, '[menuNav] Chain resolved');

  // Walk all parent entries in the chain (everything except the final target)
  for (let i = 0; i < chain.length - 1; i++) {
    const parentKey = chain[i];
    const childKey = chain[i + 1];

    // Bare parent keys (like "menu") may not be in CRAWLER_KEY_MAP.
    // In that case, just verify child visibility and skip parent interaction.
    const childDef = getSelector(childKey, platform);
    if (childDef.css) {
      const childVisible = await HumanActions.cdpIsElementVisible(page, childDef.css);
      if (childVisible) {
        logger.info({ parentKey, childKey }, 'Child already visible — parent must be expanded, skipping parent click');
        continue;
      }
    }

    const parentDef = getSelector(parentKey, platform);
    logger.info({ i, parentKey, childKey, parentDef_css: parentDef.css, parentDef_expandCss: parentDef.expandCheckCss, childDef_css: childDef.css, childDef_text: childDef.text }, '[menuNav] Chain step inspection');

    // Step 2: Check parent expand state via expandCheckCss (or parent's own css as fallback)
    const expandCss = parentDef.expandCheckCss || parentDef.css;
    if (expandCss) {
      const isExpanded = await HumanActions.cdpIsMenuExpanded(page, expandCss);
      if (isExpanded === true) {
        // 验证：expandCheckCss 可能误判（匹配到页面其他元素），需确认子菜单真的可见
        if (childDef.css) {
          await HumanActions.wait(page, 300, 500);
          const childActuallyVisible = await HumanActions.cdpIsElementVisible(page, childDef.css);
          if (childActuallyVisible) {
            logger.info({ parentKey }, 'Parent menu expanded AND child confirmed visible, skipping click');
            continue;
          }
          logger.warn({ parentKey, childKey, expandCss }, 'Parent reported expanded but child NOT visible — false positive, clicking anyway');
        } else {
          logger.info({ parentKey }, 'Parent menu expanded (no child CSS to verify), skipping click');
          continue;
        }
      }
      if (isExpanded === false) {
        logger.info({ parentKey }, 'Parent menu collapsed, expanding');
        const parentMapping = resolveCrawlerKey(parentKey, platform);
        const expanded = await tryClickBySelector(page, parentDef, {
          timeout: options?.timeout ?? 8000,
          platform,
          category: parentMapping?.category || 'menus',
          name: parentMapping?.name || parentKey,
        });
        if (expanded) {
          await HumanActions.wait(page, 800, 1500);
        } else {
          logger.warn({ parentKey }, 'Failed to expand collapsed parent menu');
        }
        continue;
      }
    }

    // Step 3: FALLTHROUGH — cannot determine parent state, attempt to expand anyway
    logger.info({ parentKey }, 'Cannot determine parent state, attempting to expand');
    const parentMapping = resolveCrawlerKey(parentKey, platform);
    const expanded = await tryClickBySelector(page, parentDef, {
      timeout: options?.timeout ?? 8000,
      platform,
      category: parentMapping?.category || 'menus',
      name: parentMapping?.name || parentKey,
    });
    if (expanded) {
      await HumanActions.wait(page, 800, 1500);
    } else {
      logger.warn({ parentKey }, 'Failed to expand parent menu');
    }
  }

  // Click the final target in the chain
  const targetKey = chain[chain.length - 1];
  const targetDef = getSelector(targetKey, platform);
  const targetMapping = resolveCrawlerKey(targetKey, platform);
  return tryClickBySelector(page, targetDef, {
    timeout: options?.timeout,
    platform,
    category: targetMapping?.category || 'menus',
    name: targetMapping?.name || targetKey,
  });
}

/**
 * Attempt to click an element using multiple fallback strategies:
 *
 *  1. **CSS selector** – via `HumanActions.cdpClick`
 *  2. **Filtered text** – via `HumanActions.cdpClickByTextFiltered` (spatial filter)
 *  3. **Unfiltered text** – via `HumanActions.cdpClickByText`
 *
 * For platforms that require pre-scrolling (e.g. kuaishou), set
 * `scrollIntoView: true` in the options to scroll the element into the
 * viewport before attempting the CSS-based click.
 *
 * @param page    - Patchright Page instance
 * @param def     - Selector definition (css / text / textScope)
 * @param options - Optional timeout override and scrollIntoView flag
 * @returns       - true if any strategy succeeded
 */
export async function tryClickBySelector(
  page: Page,
  def: SelectorDef,
  options?: { timeout?: number; scrollIntoView?: boolean; platform?: string; category?: string; name?: string },
): Promise<boolean> {
  const timeout = options?.timeout ?? 10000;
  const scrollIntoView = options?.scrollIntoView ?? false;
  const platform = options?.platform || 'unknown';
  const category = options?.category || 'unknown';
  const name = options?.name || 'unknown';
  const startTime = Date.now();

  // --- Strategy 1: Text click with spatial filter (preferred — humans read text first) ---
  if (def.text) {
    const filteredStart = Date.now();
    const filteredClicked = await HumanActions.cdpClickByTextFiltered(page, def.text, {
      timeout,
    });
    if (filteredClicked) {
      logger.debug({ text: def.text }, 'Clicked via text (spatially filtered)');
      reportClickResult(platform, category, name, 'spatial-filter', def.text, true, Date.now() - filteredStart);
      return true;
    }
    logger.warn({ text: def.text }, 'Filtered text click failed');
    reportClickResult(platform, category, name, 'spatial-filter', def.text, false, Date.now() - filteredStart);

    // --- Strategy 2: Unfiltered text click ---
    const unfilteredStart = Date.now();
    const unfilteredClicked = await HumanActions.cdpClickByText(page, def.text, {
      timeout,
    });
    if (unfilteredClicked) {
      logger.debug({ text: def.text }, 'Clicked via text (unfiltered)');
      reportClickResult(platform, category, name, 'unfiltered-text', def.text, true, Date.now() - unfilteredStart);
      return true;
    }
    logger.warn({ text: def.text }, 'Unfiltered text click failed');
    reportClickResult(platform, category, name, 'unfiltered-text', def.text, false, Date.now() - unfilteredStart);
  }

  // --- Strategy 3: CSS selector click (fallback — less specific, may hit wrong element) ---
  if (def.css) {
    // 对 douyin/kuaishou 或显式 scrollIntoView，先滚动元素到视口
    const needsScroll = scrollIntoView || platform === 'douyin';
    if (needsScroll) {
      logger.debug({ css: def.css, platform }, 'Scrolling element into view via CDP');
      try {
        const elements = await HumanActions.queryElementsWithInfo(page, def.css);
        if (elements.length > 0) {
          await HumanActions.cdpScrollNodeIntoView(page, elements[0].nodeId);
          await HumanActions.wait(page, 200, 400);
        }
      } catch {
        // Non-critical — cdpClick will handle scrolling if possible
      }
    }

    const cssStart = Date.now();
    const clicked = await HumanActions.cdpClick(page, def.css, { timeout });
    if (clicked) {
      logger.debug({ css: def.css }, 'Clicked via CSS selector');
      reportClickResult(platform, category, name, 'fallback-css', def.css, true, Date.now() - cssStart);
      return true;
    }
    logger.warn({ css: def.css }, 'CSS click failed');
    reportClickResult(platform, category, name, 'fallback-css', def.css, false, Date.now() - cssStart);
  }

  logger.error({ def }, 'All click strategies failed');
  reportClickResult(platform, category, name, 'primary', 'none', false, Date.now() - startTime, 'All strategies failed');
  return false;
}
