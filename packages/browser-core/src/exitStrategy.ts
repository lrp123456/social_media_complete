import { rootLogger } from '../logger';
const logger = rootLogger.child({ name: 'exitStrategy' });

export type ExitAction = 'navigate_submenu' | 'idle_wander' | 'cdp_refresh';
export type QuerySource = 'work_list' | 'item_list';
export type PageType =
  | 'content_management' | 'data_center' | 'other'
  | 'kuaishou_content' | 'kuaishou_data_center' | 'kuaishou_interact'
  | 'xhs_note_manage' | 'xhs_data_dashboard'
  | 'tencent_interact';

export class ExitStrategy {
  static getRandomExitAction(): ExitAction {
    const roll = Math.random();

    if (roll < 0.80) {
      logger.info({ roll: roll.toFixed(3), action: 'navigate_submenu' }, 'Exit strategy: navigate to random submenu (80%)');
      return 'navigate_submenu';
    } else if (roll < 0.95) {
      logger.info({ roll: roll.toFixed(3), action: 'idle_wander' }, 'Exit strategy: idle wander (15%)');
      return 'idle_wander';
    }

    logger.info({ roll: roll.toFixed(3), action: 'cdp_refresh' }, 'Exit strategy: CDP refresh (5%)');
    return 'cdp_refresh';
  }

  static getQuerySource(): QuerySource {
    const source: QuerySource = 'work_list';
    logger.info({ source }, 'Query source (item_list disabled, always work_list)');
    return source;
  }

  static getRandomQuerySource(): QuerySource {
    return ExitStrategy.getQuerySource();
  }

  static getNextPageAction(currentPage: PageType): 'refresh' | 'switch_source' {
    switch (currentPage) {
      case 'content_management':
      case 'data_center':
      case 'kuaishou_content':
      case 'kuaishou_data_center':
      case 'kuaishou_interact':
      case 'xhs_note_manage':
      case 'xhs_data_dashboard':
        return 'refresh';
      case 'other':
        return 'switch_source';
    }
  }
}
