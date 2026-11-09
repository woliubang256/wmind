/**
 * 命令接口与执行结果。
 *
 * 命令是**纯数据 + 一个 apply 函数**，在 immer draft 上原地修改文档。
 * 这样做的三个理由：
 *
 * 1. 撤销栈只需要保存文档快照，不需要为每种操作写反向操作；
 * 2. 命令可以被序列化、录制、重放（将来做协同编辑与操作日志都靠它）；
 * 3. 命令的合法性校验可以集中写，不用在 UI 事件里重复。
 *
 * `apply` 返回 `CommandResult` 而不是直接改 store：命令不该知道选中态、
 * 编辑态这些视图概念，它们由 store 根据返回值统一处理。
 */

import type { WmindDocument } from '../model/types';

export interface CommandContext {
  /** 当前画布 id。命令默认作用于这张画布。 */
  sheetId: string;
  /** 时间戳，用于 `meta.updatedAt` 与合并判断。 */
  now: number;
  /** 生成新 id。测试可注入确定性实现。 */
  nextId: () => string;
}

export interface CommandResult {
  /** 执行后应选中的节点。省略表示保持原选中。 */
  select?: string[];
  /** 执行后是否立即进入编辑态（新建节点后要能直接打字）。 */
  edit?: boolean;
}

export interface EditorCommand {
  /** 命令类型，形如 `topic.add`。用于合并判断与日志。 */
  type: string;
  /** 撤销提示文案，如「新建主题」。 */
  label: string;
  /**
   * 合并键。连续的同类型 + 同键命令在时间窗口内只产生一条历史记录。
   *
   * 主要用途是连续打字：每敲一个字符都入栈会让「撤销」退化成退格键。
   * 文档里写的是 `coalesceWith(prev)` 回调，这里改成键比较——回调需要把
   * `prev` 断言成具体命令类型才能取字段，是类型不安全的口子，而键比较
   * 表达力等价。
   */
  coalesceKey?: string;
  /** 在 draft 上执行。抛错即整体回滚（immer 保证）。 */
  apply(draft: WmindDocument, ctx: CommandContext): CommandResult | void;
}

/** 便捷构造器：让命令字面量不用重复写 `apply` 签名。 */
export function defineCommand(
  command: Omit<EditorCommand, 'apply'> & { apply: EditorCommand['apply'] },
): EditorCommand {
  return command;
}
