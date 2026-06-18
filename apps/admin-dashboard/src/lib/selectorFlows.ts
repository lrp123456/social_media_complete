// @admin-dashboard/lib/selectorFlows.ts
// Business flow mapping — classifies selectors into workflow phases
// Used by the FlowView component to visualize selectors by monitoring/publishing workflow

import type { SelectorEntry } from '@/hooks/useApi';

// ── Types ──

export type FlowPhase = {
  id: string;
  label: string;
  description: string;
  icon: string;
};

export type FlowDefinition = {
  id: string;
  label: string;
  icon: string;
  color: string;
  phases: FlowPhase[];
};

export type SelectorFlowMapping = {
  flow: string;
  phase: string;
};

// ── Flow Definitions ──

export const FLOW_DEFINITIONS: Record<string, FlowDefinition> = {
  monitor: {
    id: 'monitor',
    label: '监控流程',
    icon: 'visibility',
    color: 'violet',
    phases: [
      { id: 'nav', label: '导航', description: '进入创作者中心', icon: 'navigation' },
      { id: 'scan', label: '作品扫描', description: '浏览作品列表，检测新评论', icon: 'analytics' },
      { id: 'comment-nav', label: '评论导航', description: '进入评论管理页面', icon: 'forum' },
      { id: 'collect', label: '评论采集', description: '抽屉选择作品，采集评论数据', icon: 'inventory_2' },
      { id: 'exit', label: '退出策略', description: '随机子菜单导航，养号行为', icon: 'logout' },
    ],
  },
  reply: {
    id: 'reply',
    label: '评论回复',
    icon: 'reply',
    color: 'emerald',
    phases: [
      { id: 'nav', label: '导航到评论', description: '进入互动管理 → 评论管理', icon: 'forum' },
      { id: 'select-work', label: '选择作品', description: '打开抽屉选择目标视频', icon: 'inventory_2' },
      { id: 'find-comment', label: '定位评论', description: '在评论树中查找目标评论', icon: 'search' },
      { id: 'execute', label: '执行回复', description: '输入回复内容并发送', icon: 'send' },
    ],
  },
  publish: {
    id: 'publish',
    label: '发布流程',
    icon: 'publish',
    color: 'sky',
    phases: [
      { id: 'nav', label: '导航', description: '进入发布页面', icon: 'navigation' },
      { id: 'upload', label: '内容上传', description: '上传视频/图片素材', icon: 'upload_file' },
      { id: 'form', label: '信息填写', description: '标题、描述、标签、封面', icon: 'edit_note' },
      { id: 'submit', label: '提交发布', description: '点击发布按钮并确认', icon: 'check_circle' },
    ],
  },
};

// ── Classification Rules ──
// Order matters — first match wins. Rules are evaluated top-to-bottom.

type ClassRule = {
  /** Regex or exact name matches */
  test: (name: string, category: string) => boolean;
  flow: string;
  phase: string;
};

function nameStarts(...prefixes: string[]) {
  return (name: string) => prefixes.some((p) => name.startsWith(p));
}
function nameContains(...substrings: string[]) {
  return (name: string) => substrings.some((s) => name.includes(s));
}
function nameIs(...names: string[]) {
  return (name: string) => names.includes(name);
}

const MONITOR_RULES: ClassRule[] = [
  // Navigation
  { test: (n) => nameStarts('nav_')(n) || nameIs('menu_home')(n), flow: 'monitor', phase: 'nav' },
  // Content Scan (Phase 1)
  {
    test: (n, c) =>
      nameStarts('menu_content', 'menu_work', 'menu_data', 'menu_collection', 'menu_cooperate', 'menu_right')(n) ||
      nameStarts('btn_radio', 'btn_works')(n) ||
      nameStarts('region_works_analysis', 'region_work_list')(n) ||
      (c === 'menus' && nameStarts('menu_business')(n)),
    flow: 'monitor',
    phase: 'scan',
  },
  // Comment Navigation (Phase 2)
  {
    test: (n) =>
      nameStarts('menu_interaction', 'menu_comment')(n) ||
      nameStarts('menu_follow_manage', 'menu_fans_manage', 'menu_danmaku', 'menu_message')(n) ||
      nameStarts('region_sidebar')(n),
    flow: 'monitor',
    phase: 'comment-nav',
  },
  // Comment Collection (Phase 3) — drawer + comment tree
  {
    test: (n) =>
      nameIs('btn_select_works')(n) ||
      nameStarts('region_drawer', 'btn_drawer')(n) ||
      nameStarts('region_comment', 'comment_root')(n) ||
      nameStarts('region_works_pick')(n),
    flow: 'monitor',
    phase: 'collect',
  },
  // Exit (remaining menu items not in other phases)
  {
    test: (n, c) => c === 'menus' && nameStarts('menu_')(n),
    flow: 'monitor',
    phase: 'exit',
  },
];

const REPLY_RULES: ClassRule[] = [
  // Navigation to comment management
  {
    test: (n) =>
      nameStarts('nav_')(n) || nameIs('menu_home')(n) ||
      nameStarts('menu_interaction', 'menu_comment')(n) ||
      nameStarts('region_sidebar')(n),
    flow: 'reply',
    phase: 'nav',
  },
  // Select work (drawer)
  {
    test: (n) =>
      nameIs('btn_select_works')(n) ||
      nameStarts('region_drawer', 'btn_drawer')(n) ||
      nameStarts('region_works_pick')(n),
    flow: 'reply',
    phase: 'select-work',
  },
  // Find comment in tree
  {
    test: (n) =>
      nameStarts('btn_expand_replies')(n) ||
      nameStarts('region_comment', 'comment_root')(n),
    flow: 'reply',
    phase: 'find-comment',
  },
  // Execute reply (input + send)
  {
    test: (n) =>
      nameStarts('btn_reply', 'comment_reply_btn', 'reply_send_btn', 'btn_reply_submit')(n) ||
      nameStarts('region_reply')(n),
    flow: 'reply',
    phase: 'execute',
  },
];

const PUBLISH_RULES: ClassRule[] = [
  // Navigation
  { test: (n) => nameStarts('nav_')(n) || nameIs('menu_home')(n), flow: 'publish', phase: 'nav' },
  // Upload
  {
    test: (n) =>
      nameStarts('btn_upload', 'region_upload')(n) ||
      nameContains('upload')(n),
    flow: 'publish',
    phase: 'upload',
  },
  // Form (textboxes, title, description, tags)
  {
    test: (n, c) =>
      c === 'textboxes' ||
      nameStarts('tb_', 'input_', 'textarea_')(n) ||
      nameContains('title', 'desc', 'tag', 'cover')(n),
    flow: 'publish',
    phase: 'form',
  },
  // Submit
  {
    test: (n) =>
      nameStarts('btn_publish', 'btn_submit')(n) ||
      nameContains('publish', 'submit')(n),
    flow: 'publish',
    phase: 'submit',
  },
];

/**
 * Classify a selector into one or more flow/phase assignments.
 * A selector can appear in both monitor and publish flows.
 */
export function classifySelector(
  platform: string,
  category: string,
  name: string,
  entry: { purposes: string[] },
): SelectorFlowMapping[] {
  const results: SelectorFlowMapping[] = [];
  const purposes = entry.purposes || [];

  // Only classify into flows the selector is purposed for
  if (purposes.includes('monitor')) {
    for (const rule of MONITOR_RULES) {
      if (rule.test(name, category)) {
        results.push({ flow: rule.flow, phase: rule.phase });
        break;
      }
    }
    // Also classify into reply flow (monitor selectors often participate in reply)
    for (const rule of REPLY_RULES) {
      if (rule.test(name, category)) {
        results.push({ flow: rule.flow, phase: rule.phase });
        break;
      }
    }
  }

  if (purposes.includes('publish')) {
    for (const rule of PUBLISH_RULES) {
      if (rule.test(name, category)) {
        results.push({ flow: rule.flow, phase: rule.phase });
        break;
      }
    }
  }

  // Fallback: if no rule matched but has a purpose, assign to first phase of that flow
  if (results.length === 0) {
    if (purposes.includes('monitor')) results.push({ flow: 'monitor', phase: 'exit' });
    if (purposes.includes('publish')) results.push({ flow: 'publish', phase: 'form' });
  }

  return results;
}

/**
 * Group an array of selectors into flows → phases → entries.
 * Returns a nested map: flowId → phaseId → entries[]
 */
export function groupSelectorsByFlow(
  platform: string,
  entries: Array<{ category: string; name: string; entry: SelectorEntry }>,
): Record<string, Record<string, Array<{ category: string; name: string; entry: SelectorEntry }>>> {
  const result: Record<string, Record<string, Array<{ category: string; name: string; entry: SelectorEntry }>>> = {};

  for (const item of entries) {
    const mappings = classifySelector(platform, item.category, item.name, item.entry);
    for (const m of mappings) {
      if (!result[m.flow]) result[m.flow] = {};
      if (!result[m.flow][m.phase]) result[m.flow][m.phase] = [];
      result[m.flow][m.phase].push(item);
    }
  }

  return result;
}
