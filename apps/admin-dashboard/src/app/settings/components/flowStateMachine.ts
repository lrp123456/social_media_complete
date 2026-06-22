// apps/admin-dashboard/src/app/settings/components/flowStateMachine.ts
import { createMachine, type MachineConfig } from 'xstate';
import type { FlowNode, FlowBranch, FlowSubStep } from '@/hooks/useApi';

/**
 * 将 FlowNode[] 转换为 XState machine config
 * 支持层次状态机：高层状态包含子步骤作为嵌套状态
 */
export function flowNodesToMachineConfig(
  flowId: string,
  steps: FlowNode[]
): MachineConfig<any, any, any> {
  const states: Record<string, any> = {};

  for (const step of steps) {
    const state: any = {
      description: step.description,
      meta: {
        action: step.action,
        selector: step.selector,
        apiPatternKey: step.apiPatternKey,
        waitFor: step.waitFor,
        maxVideos: step.maxVideos,
        scrollConfig: step.scrollConfig,
        nextPageBtn: step.nextPageBtn,
      },
      on: {},
    };

    // 如果有子步骤，创建嵌套状态机
    if (step.steps && step.steps.length > 0) {
      state.initial = step.steps[0].id;
      state.states = {};
      for (const sub of step.steps) {
        state.states[sub.id] = {
          description: sub.description,
          meta: {
            action: sub.action,
            selector: sub.selector,
          },
          on: {},
        };
      }
      // 子步骤之间的线性连接
      for (let i = 0; i < step.steps.length - 1; i++) {
        state.states[step.steps[i].id].on['NEXT'] = step.steps[i + 1].id;
      }
      // 最后一个子步骤完成时触发高层 NEXT
      const lastSubStep = step.steps[step.steps.length - 1];
      state.states[lastSubStep.id].on['NEXT'] = '#done';
    }

    // 高层分支
    if (step.branches) {
      for (const branch of step.branches) {
        state.on[branch.condition] = {
          target: branch.target,
          description: branch.description,
        };
      }
    }

    // 默认转换
    if (step.next) {
      state.on['NEXT'] = { target: step.next };
    }

    states[step.id] = state;
  }

  return {
    id: flowId,
    initial: steps[0]?.id || 'done',
    states,
  };
}

/**
 * 创建 XState 状态机实例
 */
export function createFlowMachine(flowId: string, steps: FlowNode[]) {
  const config = flowNodesToMachineConfig(flowId, steps);
  return createMachine(config);
}
