// @ts-api-gateway/services/intelligentCsService.ts
// 智能客服接口 — 预留 LangChain / LangGraph / RAGFlow 扩展点

import type { GenerateReplyResult, CommentContext } from './llmService';

/**
 * 智能客服接口
 * 未来对接 LangChain、LangGraph、RAGFlow 时实现此接口
 */
export interface IIntelligentCS {
  /** 生成回复建议 */
  generateReply(comment: CommentContext): Promise<GenerateReplyResult>;
  /** 服务是否就绪 */
  isReady(): boolean;
  /** 服务名称 */
  readonly name: string;
}

/**
 * 占位实现 — 智能客服尚未完整实现
 */
export class StubIntelligentCS implements IIntelligentCS {
  readonly name = 'stub-intelligent-cs';

  async generateReply(): Promise<GenerateReplyResult> {
    return {
      success: false,
      error: '智能客服尚未启用，请使用简单客服模式（serviceType: "simple"）',
    };
  }

  isReady(): boolean {
    return false;
  }
}

/** 全局智能客服实例（当前为占位） */
export const intelligentCS: IIntelligentCS = new StubIntelligentCS();
