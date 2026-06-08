import { rootLogger } from '@social-media/browser-core';
import type { PlatformName } from '@social-media/shared-config';
import { PageType } from '@social-media/browser-core';
import { getSelectorReader } from '../lib/selectorStore';
import type { SelectorEntry, SelectorCategory } from '@social-media/browser-core';

const logger = rootLogger.child({ name: 'menuSelectors' });

// Convenience alias — the three platforms with dedicated selectors
type Platform = PlatformName;

export interface SelectorDef {
  css?: string;
  text?: string;
  textScope?: string;
  parentKey?: string;
  expandCheckCss?: string;
  description?: string;
}

export interface SelectorRegistry {
  [key: string]: SelectorDef;
}

/**
 * Maps crawler-style dot-separated keys to SelectorReader (category, name) tuples per platform.
 * This is the bridge between the legacy crawler key format and the data-driven JSON config.
 */
const CRAWLER_KEY_MAP: Record<string, Record<string, { category: SelectorCategory; name: string }>> = {
  douyin: {
    'nav.to-creator': { category: 'menus', name: 'nav_to_creator_center' },
    'menu.home': { category: 'menus', name: 'menu_home' },
    'menu.activity': { category: 'menus', name: 'menu_activity_management' },
    'menu.content': { category: 'menus', name: 'menu_content' },
    'menu.data-center': { category: 'menus', name: 'menu_data-center' },
    'menu.interact': { category: 'menus', name: 'menu_interaction' },
    'menu.monetize': { category: 'menus', name: 'menu_cash_square' },
    'menu.content.work-manage': { category: 'menus', name: 'menu_work_manage' },
    'menu.content.collection': { category: 'menus', name: 'menu_collection_manage' },
    'menu.content.co-creation': { category: 'menus', name: 'menu_cooperate_center' },
    'menu.content.original-protection': { category: 'menus', name: 'menu_right_manage' },
    'menu.interact.follow-manage': { category: 'menus', name: 'menu_follow_manage' },
    'menu.interact.fans-manage': { category: 'menus', name: 'menu_fans_manage' },
    'menu.interact.comment-manage': { category: 'menus', name: 'menu_comment_manage_new' },
    'menu.interact.danmaku-manage': { category: 'menus', name: 'menu_danmaku_manage' },
    'menu.interact.message-manage': { category: 'menus', name: 'menu_message_manage' },
    'menu.data-center.account-overview': { category: 'menus', name: 'menu_business_analysis' },
    'menu.data-center.content-analysis': { category: 'menus', name: 'menu_content_analysis' },
    'menu.data-center.fans-analysis': { category: 'menus', name: 'menu_fans_characteristic' },
    'menu.data-center.focus-care': { category: 'menus', name: 'menu_following' },
    'menu.monetize.plaza': { category: 'menus', name: 'menu_cash_square' },
    'menu.monetize.my-task': { category: 'menus', name: 'menu_my_task' },
    'menu.monetize.my-income': { category: 'menus', name: 'menu_my_income' },
    'page.post-list-tab': { category: 'buttons', name: 'btn_radio_投稿列表' },
    'page.refresh-data-btn': { category: 'buttons', name: 'btn_works_刷新数据' },
    'page.select-work-btn': { category: 'buttons', name: 'btn_select_works' },
    'scroll.main-content': { category: 'regions', name: 'region_works_analysis_scroll' },
    'scroll.drawer': { category: 'regions', name: 'region_works_pick_scroll' },
    'region.work-list-scroll': { category: 'regions', name: 'region_work_list_item' },
    // 抽屉相关选择器（评论管理）
    'drawer.portal': { category: 'regions', name: 'region_drawer_portal' },
    'drawer.sidesheet': { category: 'regions', name: 'region_drawer_sidesheet' },
    'drawer.mask': { category: 'regions', name: 'region_drawer_mask' },
    'drawer.content': { category: 'regions', name: 'region_drawer_content' },
    'drawer.video-item': { category: 'regions', name: 'region_drawer_video_item' },
    'drawer.video-title': { category: 'regions', name: 'region_drawer_video_title' },
    'drawer.confirm-btn': { category: 'buttons', name: 'btn_drawer_confirm' },
    'region.sidebar': { category: 'regions', name: 'region_sidebar' },
    // 评论展开/回复选择器
    'comment.expand-replies': { category: 'buttons', name: 'btn_expand_replies' },
    'comment.reply-btn': { category: 'buttons', name: 'btn_reply_comment' },
    'comment.reply-submit': { category: 'buttons', name: 'btn_reply_submit' },
    'comment.reply-list': { category: 'regions', name: 'region_reply_list' },
    'comment.container': { category: 'regions', name: 'region_comment_container' },
    'comment.reply-input': { category: 'regions', name: 'region_reply_input' },
    'comment.sidebar-scroll': { category: 'regions', name: 'region_sidebar_scroll' },
  },
  kuaishou: {
    'nav.to-creator': { category: 'menus', name: 'nav_to_creator_center' },
    'menu.home': { category: 'menus', name: 'menu_home' },
    'menu.content': { category: 'menus', name: 'menu_content_manage' },
    'menu.content.work-manage': { category: 'menus', name: 'menu_work_manage' },
    'menu.content.collection-manage': { category: 'menus', name: 'menu_collection_manage' },
    'menu.interact': { category: 'menus', name: 'menu_interact_manage' },
    'menu.interact.comment-manage': { category: 'menus', name: 'menu_comment_manage' },
    'menu.data-center': { category: 'menus', name: 'menu_data_center' },
    'menu.data-center.photo-analysis': { category: 'menus', name: 'menu_work_analysis' },
    'menu.data-center.fan-analysis': { category: 'menus', name: 'menu_fans_analysis' },
    'page.select-video-btn': { category: 'buttons', name: 'btn_select_videos' },
    'page.next-page-btn': { category: 'buttons', name: 'btn_page_next' },
    'scroll.main-content': { category: 'regions', name: 'region_work_list_scroll' },
    'scroll.drawer': { category: 'regions', name: 'region_video_pick_scroll' },
    // 抽屉相关选择器（评论管理）
    'drawer.container': { category: 'regions', name: 'region_drawer' },
    'drawer.sidesheet': { category: 'regions', name: 'region_drawer_sidesheet' },
    'drawer.mask': { category: 'regions', name: 'region_drawer_mask' },
    'drawer.video-item': { category: 'regions', name: 'region_drawer_video_item' },
    'region.sidebar': { category: 'regions', name: 'region_sidebar' },
    'region.work-list-table': { category: 'regions', name: 'region_work_list_table_body' },
  },
  xiaohongshu: {
    'nav.to-creator': { category: 'menus', name: 'nav_to_creator_center' },
    'menu.home': { category: 'menus', name: 'menu_home' },
    'menu.note-manage': { category: 'menus', name: 'menu_note_manage' },
    'menu.data-dashboard': { category: 'menus', name: 'menu_data_dashboard' },
    'menu.data-dashboard.data-overview': { category: 'menus', name: 'menu_account_overview' },
    'menu.data-dashboard.content-analysis': { category: 'menus', name: 'menu_content_analysis' },
    'menu.data-dashboard.fan-data': { category: 'menus', name: 'menu_fans_data' },
    'menu.activity-center': { category: 'menus', name: 'menu_activity_center' },
    'menu.note-inspiration': { category: 'menus', name: 'menu_note_inspiration' },
    'menu.creator-academy': { category: 'menus', name: 'menu_creator_academy' },
    'menu.creator-wiki': { category: 'menus', name: 'menu_creator_wiki' },
    'scroll.note-list': { category: 'regions', name: 'region_data_board_scroll' },
    // 笔记列表相关选择器
    'region.note-list': { category: 'regions', name: 'region_note_list' },
    'region.note-list-scroll': { category: 'regions', name: 'region_note_list_scroll' },
  },
};

let customSelectors: SelectorRegistry = {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract display text from a SelectorEntry's primary or fallback selectors. */
function extractTextFromSelector(entry: SelectorEntry): string | undefined {
  // Try getByText("...") or getByRole(..., name="...")
  const textMatch =
    entry.primary.match(/getByText\("([^"]+)"(?:,\s*exact=True)?\)/) ||
    entry.primary.match(/getByRole\("\w+",\s*name="([^"]+)"\)/);
  if (textMatch) return textMatch[1];

  // Check fallbacks for text= prefix or getByText patterns
  for (const fb of entry.fallbacks) {
    if (fb.startsWith('text=')) return fb.slice(5);
    const fbMatch = fb.match(/getByText\("([^"]+)"(?:,\s*exact=True)?\)/);
    if (fbMatch) return fbMatch[1];
  }
  return undefined;
}

/** Convert a SelectorEntry from the SelectorReader into the legacy SelectorDef shape. */
function entryToDef(entry: SelectorEntry): SelectorDef {
  return {
    // If the primary is a getBy* locator, use the first CSS fallback as the css value
    css: entry.primary.startsWith('getBy')
      ? entry.fallbacks[0] || entry.primary
      : entry.primary,
    text: extractTextFromSelector(entry),
    parentKey: entry.parent,
    expandCheckCss: entry.expandCheckCss,
    description: entry.description,
  };
}

/**
 * Derive the parent crawler key from a dot-notation key.
 * E.g. 'menu.content.work-manage' → 'menu.content'.
 */
function deriveParentKey(key: string): string | undefined {
  const lastDot = key.lastIndexOf('.');
  if (lastDot <= 0) return undefined;
  return key.slice(0, lastDot);
}

// ---------------------------------------------------------------------------
// Core selector lookup
// ---------------------------------------------------------------------------

export function getSelector(key: string, platform: Platform = 'douyin'): SelectorDef {
  // Custom overrides take precedence (hot-patch layer)
  if (customSelectors[key]) {
    return customSelectors[key];
  }

  const platformMap = CRAWLER_KEY_MAP[platform];
  if (!platformMap) {
    logger.warn({ key, platform }, 'CRAWLER_KEY_MAP missing for platform');
    return {};
  }

  const mapping = platformMap[key];
  if (!mapping) {
    logger.warn({ key, platform }, 'Key not found in CRAWLER_KEY_MAP');
    return {};
  }

  const reader = getSelectorReader();
  const entry = reader.getSelector(platform, mapping.category, mapping.name);
  if (!entry) {
    logger.warn(
      { key, platform, category: mapping.category, name: mapping.name },
      'Selector not found in config',
    );
    return {};
  }

  const def = entryToDef(entry);

  // If the JSON entry doesn't carry an explicit parent link, derive it from the
  // crawler-key naming convention (e.g. menu.content.work-manage → menu.content).
  if (!def.parentKey) {
    def.parentKey = deriveParentKey(key);
  }

  return def;
}

// ---------------------------------------------------------------------------
// Custom-selector hot-patch (in-memory override, not persisted)
// ---------------------------------------------------------------------------

export function updateSelector(key: string, def: SelectorDef): void {
  customSelectors[key] = def;
  logger.info({ key, def }, 'Selector updated (hot, custom overlay)');
}

export function resetSelector(key: string): void {
  delete customSelectors[key];
  logger.info({ key }, 'Selector reset to default');
}

// ---------------------------------------------------------------------------
// Bulk enumeration
// ---------------------------------------------------------------------------

export function getAllSelectors(platform: Platform = 'douyin'): SelectorRegistry {
  const platformMap = CRAWLER_KEY_MAP[platform];
  if (!platformMap) return { ...customSelectors };

  const result: SelectorRegistry = { ...customSelectors };
  for (const key of Object.keys(platformMap)) {
    if (!(key in result)) {
      const def = getSelector(key, platform);
      if (Object.keys(def).length > 0) {
        result[key] = def;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exit / submenu-key helpers
// ---------------------------------------------------------------------------

/**
 * Returns the list of crawler keys whose Menu entries carry the 'monitor'
 * purpose in the data-driven config.  These are valid navigation targets for
 * the exit strategy / screenshot rotation.
 */
export function getExitSubmenuKeys(platform: Platform = 'douyin'): string[] {
  const reader = getSelectorReader();
  const monitorEntries = reader.getByPurpose(platform, 'monitor');
  const platformMap = CRAWLER_KEY_MAP[platform];
  if (!platformMap) return [];

  const keys: string[] = [];
  for (const [crawlerKey, mapping] of Object.entries(platformMap)) {
    // Only menu entries are valid exit targets
    if (!crawlerKey.startsWith('menu.')) continue;
    const catEntries = monitorEntries[mapping.category];
    if (catEntries && catEntries[mapping.name]) {
      keys.push(crawlerKey);
    }
  }
  return keys;
}

export function getRandomExitSubmenuKey(
  platform: Platform = 'douyin',
  ...excludeKeys: string[]
): string {
  const allKeys = getExitSubmenuKeys(platform);
  const candidates =
    excludeKeys.length > 0
      ? allKeys.filter(k => !excludeKeys.includes(k))
      : allKeys;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  logger.info(
    { chosen, allKeys, candidates, exclude: excludeKeys, candidateCount: candidates.length, allCount: allKeys.length, platform },
    'Random exit submenu key chosen',
  );
  return chosen;
}

export function getRandomExitSubmenuKeyExcludeComment(
  platform: Platform = 'douyin',
): string {
  const commentKey =
    platform === 'kuaishou'
      ? 'menu.interact.comment-manage'
      : 'menu.interact.comment-manage';
  return getRandomExitSubmenuKey(platform, commentKey);
}

// ---------------------------------------------------------------------------
// PageType → submenu key
// ---------------------------------------------------------------------------

export function getSubmenuKeyForPageType(
  pageType: PageType,
  platform: Platform = 'douyin',
): string | undefined {
  if (platform === 'kuaishou') {
    switch (pageType) {
      case 'kuaishou_content':
        return 'menu.content.work-manage';
      case 'kuaishou_data_center':
        return 'menu.data-center.photo-analysis';
      case 'kuaishou_interact':
        return 'menu.interact.comment-manage';
      default:
        return undefined;
    }
  }
  if (platform === 'xiaohongshu') {
    switch (pageType) {
      case 'xhs_note_manage':
        return 'menu.note-manage';
      case 'xhs_data_dashboard':
        return 'menu.data-dashboard.content-analysis';
      default:
        return undefined;
    }
  }
  switch (pageType) {
    case 'content_management':
      return 'menu.content.work-manage';
    case 'data_center':
      return 'menu.data-center.content-analysis';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Chain traversal
// ---------------------------------------------------------------------------

export function getSelectorChain(
  key: string,
  platform: Platform = 'douyin',
): string[] {
  const chain: string[] = [];
  let currentKey: string | undefined = key;
  const visited = new Set<string>();

  while (currentKey) {
    if (visited.has(currentKey)) break;
    visited.add(currentKey);
    chain.unshift(currentKey);
    const def = getSelector(currentKey, platform);
    currentKey = def.parentKey;
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Legacy aliases (delegate to the new implementations)
// ---------------------------------------------------------------------------

export function getPlatformSelectors(platform: Platform): SelectorRegistry {
  return getAllSelectors(platform);
}

export function getExitSubmenuKeysForPlatform(platform: Platform): string[] {
  return getExitSubmenuKeys(platform);
}

export function getRandomExitSubmenuKeyForPlatform(
  platform: Platform,
  ...excludeKeys: string[]
): string {
  return getRandomExitSubmenuKey(platform, ...excludeKeys);
}
