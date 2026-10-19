/**
 * 把键盘事件接到动作上。
 *
 * 监听挂在**编辑器根节点**而不是 `window`：只有焦点在编辑器内部时快捷键才
 * 生效。挂在 window 上的话，用户在搜索框里按 Backspace、在侧栏链接上按 Tab，
 * 都会被导图截走——这类 bug 用户只会描述成「输入框坏了」。
 *
 * 两级过滤（见 `isTextEntryTarget` / `isInteractiveTarget`）：
 *
 * - 文本输入框里一个键都不拦；
 * - 按钮 / 下拉 / 选项卡里只拦裸键，⌘Z、⌘S 这类组合照常作用于导图。
 *
 * 第二级是画布面板出现之后补的：面板里的控件都是按钮和下拉，焦点停在色块上
 * 按 ⌘Z 却什么也不发生，用户会以为撤销坏了。反过来，裸 Tab 在面板里必须
 * 走焦点切换，不能被「新建子主题」吃掉。
 *
 * 用 ref 保存 handlers 而不是放进 effect 依赖：动作回调每次渲染都是新函数，
 * 放进依赖会导致每个按键都重新绑定监听器（以及每次渲染都要解绑重绑）。
 */

import { useEffect, useRef } from 'react';
import { isInteractiveTarget, isTextEntryTarget, resolveKey, type EditorAction } from './keymap';

export type HotkeyHandlers = Partial<Record<EditorAction, (event: KeyboardEvent) => void>>;

export interface HotkeyOptions {
  /**
   * 关掉整张表。编辑态（输入框打开）时传 `false`——此时 Esc / Enter /
   * Shift+Enter / Tab 全部由输入框自己处理，导图不该再插手。
   */
  enabled?: boolean;
}

export function useHotkeys(
  ref: React.RefObject<HTMLElement | null>,
  handlers: HotkeyHandlers,
  options: HotkeyOptions = {},
): void {
  const { enabled = true } = options;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      // 焦点在输入框里时一个键都不拦（含画布内的编辑输入框，
      // 虽然那时 enabled 已经是 false，这里再挡一次以防时序问题）。
      if (isTextEntryTarget(event.target)) return;
      // 面板/页头里的按钮与下拉：裸键留给它们自己（Tab 切焦点、方向键选值）。
      if (!event.ctrlKey && !event.metaKey && isInteractiveTarget(event.target)) return;
      if (event.isComposing) return;

      const action = resolveKey(event);
      if (!action) return;
      const handler = handlersRef.current[action];
      if (!handler) return;

      // 只对真正处理了的动作 preventDefault：Tab 要挡掉焦点切换，
      // 方向键要挡掉页面滚动。查不到 handler 的（比如 M2.6 之前的 Ctrl+S）
      // 不动浏览器默认行为。
      event.preventDefault();
      handler(event);
    };

    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [ref, enabled]);
}
