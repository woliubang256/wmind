import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { isTypeToEditKey } from './keymap';

/** 仅在画布自身聚焦时接收首键，侧栏与画布内控件仍处理自己的输入。 */
export function useTypeToEdit(
  ref: React.RefObject<HTMLElement | null>,
  beginEdit: () => void,
  enabled: boolean,
): void {
  const beginEditRef = useRef(beginEdit);
  beginEditRef.current = beginEdit;

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.target !== element || !isTypeToEditKey(event)) return;
      // 在浏览器执行本次按键的默认输入前，挂载并聚焦选中原标题的 textarea。
      // 不 preventDefault、不重放字符，首字符与 IME 都走同一个原生输入过程。
      flushSync(() => beginEditRef.current());
    };
    element.addEventListener('keydown', onKeyDown);
    return () => element.removeEventListener('keydown', onKeyDown);
  }, [ref, enabled]);
}
