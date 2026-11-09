/**
 * M2 验收标准 2：撤销 / 重做 100 步后文档与初始状态完全一致（快照比对）。
 *
 * 这个测试是「撤销栈真的没漏东西」的唯一硬证据。它比逐个命令的单测更难糊弄：
 * 任何一条命令偷偷改写了没进快照的字段、或者撤销时少恢复一个字段，
 * 100 步之后的整份 JSON 就对不上。
 *
 * 两个刻意的设计：
 *
 * 1. 每步之间把时钟推进 1 秒。否则连续改名会落在 800ms 合并窗口里，
 *    100 次按键只留 1 条历史，「100 步」就名不副实了。
 * 2. 命令序列里每一种都保证**一定改变文档**（加粗按奇偶交替、移动在两个父节点
 *    之间来回、变色按调色板轮转）。空操作不进历史，混进一条就会让
 *    `past.length === 100` 的断言失真，掩盖真正的问题。
 */

import { describe, expect, it } from 'vitest';
import { createEditorStore } from './editor-store';
import {
  addChildCommand,
  addSiblingCommand,
  moveTopicCommand,
  removeTopicsCommand,
  renameTopicCommand,
  toggleCollapseCommand,
} from '../commands/topic';
import { updateStyleCommand } from '../commands/style';
import { defaultTheme } from '../model/create';
import { deterministicIds, docWithTree } from '../test-utils';

const COLORS = defaultTheme().palette.colors;

interface Harness {
  store: ReturnType<typeof createEditorStore>;
  advance: (ms: number) => void;
}

function makeStore(): Harness {
  let clock = 1_000;
  const store = createEditorStore({
    doc: docWithTree(),
    now: () => clock,
    nextId: deterministicIds('new'),
  });
  return {
    store,
    advance: (ms) => {
      clock += ms;
    },
  };
}

/**
 * 跑 `count` 条命令，返回新建出来的节点 id（按创建顺序）。
 *
 * 删除那一步只删自己新建的节点：固定骨架（a / b / b1 / a2…）一旦被删掉，
 * 后续命令会全部变成「找不到节点」的空操作，测试就悄悄退化成空转了。
 */
function runScript(harness: Harness, count: number): string[] {
  const { store, advance } = harness;
  const created: string[] = [];
  const round = (i: number) => Math.floor(i / 8);

  for (let i = 0; i < count; i += 1) {
    advance(1_000);
    const dispatch = store.getState().dispatch;

    switch (i % 8) {
      case 0:
        dispatch(addChildCommand('a'));
        created.push(store.getState().selection[0]!);
        break;
      case 1:
        dispatch(renameTopicCommand('a', `A-${i}`));
        break;
      case 2:
        dispatch(updateStyleCommand(['a'], { fontWeight: round(i) % 2 === 0 ? 700 : 400 }));
        break;
      case 3:
        dispatch(updateStyleCommand(['b1'], { fill: COLORS[i % COLORS.length]! }));
        break;
      case 4:
        dispatch(toggleCollapseCommand('a2'));
        break;
      case 5:
        dispatch(addSiblingCommand('b'));
        created.push(store.getState().selection[0]!);
        break;
      case 6: {
        // 在两个父节点之间来回，保证每次都是真实的移动（原地移动是空操作）。
        dispatch(moveTopicCommand('b1', round(i) % 2 === 0 ? 'a' : 'b'));
        break;
      }
      default: {
        const id = created.pop();
        if (id) dispatch(removeTopicsCommand([id]));
        else {
          dispatch(addChildCommand('root'));
          created.push(store.getState().selection[0]!);
        }
        break;
      }
    }
  }

  return created;
}

describe('100 步撤销 / 重做（验收标准 2）', () => {
  it('撤销 100 步回到初始快照，重做 100 步回到最终快照', () => {
    const harness = makeStore();
    const { store } = harness;
    const initial = store.getState().doc;
    const initialSnapshot = JSON.stringify(initial);

    runScript(harness, 100);

    expect(store.getState().past).toHaveLength(100);
    expect(store.getState().revision).toBe(100);
    const finalSnapshot = JSON.stringify(store.getState().doc);
    expect(finalSnapshot).not.toBe(initialSnapshot);

    for (let i = 0; i < 100; i += 1) store.getState().undo();

    // 逐字节一致：包含 meta.updatedAt、样式、折叠态、children 顺序。
    expect(JSON.stringify(store.getState().doc)).toBe(initialSnapshot);
    // 引用也回到最初那份（immer 结构共享 + 快照存原引用，不做深拷贝）。
    expect(store.getState().doc).toBe(initial);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(100);

    for (let i = 0; i < 100; i += 1) store.getState().redo();

    expect(JSON.stringify(store.getState().doc)).toBe(finalSnapshot);
    expect(store.getState().past).toHaveLength(100);
    expect(store.getState().future).toHaveLength(0);
  });

  it('撤销到底之后继续撤销是空操作，不会吃掉历史', () => {
    const harness = makeStore();
    const { store } = harness;
    const initialSnapshot = JSON.stringify(store.getState().doc);
    runScript(harness, 12);

    for (let i = 0; i < 40; i += 1) store.getState().undo();

    expect(JSON.stringify(store.getState().doc)).toBe(initialSnapshot);
    expect(store.getState().past).toHaveLength(0);
    expect(store.getState().future).toHaveLength(12);
  });

  it('中途撤销后继续编辑，重做栈被丢弃但文档仍自洽', () => {
    const harness = makeStore();
    const { store } = harness;
    runScript(harness, 24);

    for (let i = 0; i < 10; i += 1) store.getState().undo();
    const midSnapshot = JSON.stringify(store.getState().doc);

    harness.advance(1_000);
    store.getState().dispatch(renameTopicCommand('b', '新分支'));
    expect(store.getState().future).toHaveLength(0);

    // 新命令可以撤销回那个中间状态。
    store.getState().undo();
    expect(JSON.stringify(store.getState().doc)).toBe(midSnapshot);
  });

  it('撤销恢复选中态与画布，而不只是文档', () => {
    const harness = makeStore();
    const { store } = harness;
    store.getState().select(['b1']);
    harness.advance(1_000);
    store.getState().dispatch(addChildCommand('a'));
    expect(store.getState().selection).toEqual(['new-1']);

    store.getState().undo();
    expect(store.getState().selection).toEqual(['b1']);
    expect(store.getState().sheetId).toBe('sh-1');
  });
});
