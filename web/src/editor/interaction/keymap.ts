/**
 * 键盘映射表：`KeyboardEvent` → 语义动作。
 *
 * 单独拆出来的理由很实际：**这是整个交互层里最容易出错、也最难在浏览器里
 * 验证的部分**。把「按键 → 动作」做成纯函数，就能在 node 里用几十行测试
 * 覆盖全部组合（含 Ctrl+Shift+Z 与 Ctrl+Y 两个重做入口、macOS 的 ⌘），
 * 而不用开浏览器一个个按。
 *
 * 动作是字符串而不是回调：调用方查表派发，键位表与命令实现解耦。将来加
 * 「自定义快捷键」只需换这张表，不用碰命令。
 *
 * 与 docs/05 §4.6.2 的对应关系（未列出的组合一律不拦截，交还给浏览器）：
 *
 * | 按键 | 动作 |
 * | --- | --- |
 * | Tab | 新建子主题并进入编辑 |
 * | Shift + Tab | **不拦**：反向离开画布（见下面 `case 'Tab'` 的注释） |
 * | Enter | 新建同级主题并进入编辑 |
 * | F2 | 进入编辑 |
 * | Esc | 取消选中 |
 * | Delete / Backspace | 删除选中 |
 * | Ctrl/⌘ + . | 折叠 / 展开选中节点 |
 * | ← ↑ ↓ → | 几何邻接 |
 * | Ctrl/⌘ + ← ↑ ↓ → | 父 / 上一个兄弟 / 下一个兄弟 / 第一个子节点 |
 * | Ctrl/⌘ + Z | 撤销 |
 * | Ctrl/⌘ + Shift + Z、Ctrl + Y | 重做 |
 * | Ctrl/⌘ + A | 选中同级全部 |
 * | Ctrl/⌘ + C / X / V | 复制 / 剪切 / 粘贴 |
 * | Ctrl/⌘ + B | 加粗 / 取消加粗 |
 * | Ctrl/⌘ + Shift + H | 循环填充色（走调色板，末位之后回到继承） |
 * | Ctrl/⌘ + S | 立即保存 |
 * | Ctrl/⌘ + 0 | 缩放复位 |
 * | Ctrl/⌘ + 1 | 缩放到适应 |
 *
 * 「变色」为什么是**循环**而不是取色器：M2 的验收要求「纯键盘完成加粗变色」，
 * 而原生 `<input type="color">` 的取色面板只能点。调色板是封闭的六个颜色，
 * 循环一遍既满足纯键盘，也顺带保住了「换主题整体生效」——写进 `topic.style`
 * 的只是调色板里的某个色值，不改变其余字段的继承关系。
 *
 * 注意 Shift+Enter 不在这里：它只在编辑态有意义（主题内换行），由输入框
 * 自己处理。编辑态下整个表都不生效——见 `useHotkeys` 的 `enabled`。
 */

export type EditorAction =
  | 'topic.add-child'
  | 'topic.add-sibling'
  | 'topic.edit'
  | 'topic.delete'
  | 'topic.toggle-collapse'
  | 'select.all'
  | 'select.clear'
  | 'nav.up'
  | 'nav.down'
  | 'nav.left'
  | 'nav.right'
  | 'nav.parent'
  | 'nav.child'
  | 'nav.prev-sibling'
  | 'nav.next-sibling'
  | 'history.undo'
  | 'history.redo'
  | 'clipboard.copy'
  | 'clipboard.cut'
  | 'clipboard.paste'
  | 'style.bold'
  | 'style.cycle-fill'
  | 'view.reset'
  | 'view.fit'
  | 'doc.save';

/** 只取用得到的字段，测试里构造对象更方便。 */
export interface KeyLike {
  key: string;
  code?: string;
  keyCode?: number;
  isComposing?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  getModifierState?(key: string): boolean;
}

/** 首键仍走浏览器默认输入；空格保留给拖动，组合键保留给系统。 */
export function isTypeToEditKey(event: KeyLike): boolean {
  if (event.key === ' ' || event.code === 'Space' || event.metaKey) return false;
  const altGraph = event.getModifierState?.('AltGraph') === true;
  if (event.ctrlKey && !altGraph) return false;
  if (event.altKey && !altGraph && event.key !== 'Dead') return false;
  if (event.isComposing || event.keyCode === 229 || event.key === 'Process' || event.key === 'Dead') return true;
  return Array.from(event.key).length === 1 && !/[\u0000-\u001f\u007f]/u.test(event.key);
}

/**
 * 单字符键统一小写：`Ctrl+Shift+Z` 在多数浏览器里 `key` 是 `'Z'`，
 * 而 `Ctrl+z` 是 `'z'`。不归一化的话重做要写两条规则。
 */
function normalize(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function resolveKey(event: KeyLike): EditorAction | null {
  if (event.isComposing || event.keyCode === 229) return null;
  // Alt 让给系统与浏览器（Alt+← 是「后退」），一个都不拦。
  if (event.altKey) return null;

  const key = normalize(event.key);
  const mod = Boolean(event.metaKey || event.ctrlKey);
  const shift = Boolean(event.shiftKey);

  if (mod) {
    switch (key) {
      case 'z':
        return shift ? 'history.redo' : 'history.undo';
      // Windows / Linux 习惯的重做入口。macOS 上 Ctrl+Y 也会命中，
      // 但那边用户按的是 ⌘+Shift+Z，两者不冲突。
      case 'y':
        return 'history.redo';
      case 'a':
        return 'select.all';
      case 'c':
        return 'clipboard.copy';
      case 'x':
        return 'clipboard.cut';
      case 'v':
        return 'clipboard.paste';
      case 'b':
        return 'style.bold';
      // 只认带 Shift 的组合：⌘+H 在 macOS 上是「隐藏应用」，不能抢。
      case 'h':
        return shift ? 'style.cycle-fill' : null;
      // 折叠 / 展开。⌘+. 在浏览器里没有任何默认行为，也不会和「按住空格平移」打架。
      case '.':
        return 'topic.toggle-collapse';
      case 's':
        return 'doc.save';
      case '0':
        return 'view.reset';
      case '1':
        return 'view.fit';
      case 'ArrowLeft':
        return 'nav.parent';
      case 'ArrowRight':
        return 'nav.child';
      case 'ArrowUp':
        return 'nav.prev-sibling';
      case 'ArrowDown':
        return 'nav.next-sibling';
      default:
        // 带修饰键的其他组合（⌘+R、⌘+W…）留给浏览器，不 preventDefault。
        return null;
    }
  }

  switch (key) {
    case 'Tab':
      // Shift+Tab 不拦：它是键盘用户**反向离开画布的唯一出路**。
      //
      // 这里踩过一次：初版只判 `key === 'Tab'`，于是 Shift+Tab 也被当成
      // 「新建子主题」。用户按 Tab 进来（加了个节点），再按 Shift+Tab 想退回去
      // （又加了个节点）——焦点永远出不去，是个标准的键盘陷阱（WCAG 2.1.2）。
      // 裸 Tab 仍然要拦：那时用户想在当前节点下新建子主题，放行的话焦点就跳走了。
      return event.shiftKey ? null : 'topic.add-child';
    case 'Enter':
      return 'topic.add-sibling';
    case 'F2':
      return 'topic.edit';
    case 'Escape':
      return 'select.clear';
    case 'Delete':
    case 'Backspace':
      return 'topic.delete';
    // 折叠不用空格：空格已经被「按住空格拖动平移」占用（见 pan-zoom 插件），
    // 一个键干两件事，用户按住空格准备平移时节点会莫名其妙收起来。
    // 树形控件里 ←/→ 折叠展开的惯例在这里也不适用——方向键是几何导航。
    case 'ArrowLeft':
      return 'nav.left';
    case 'ArrowRight':
      return 'nav.right';
    case 'ArrowUp':
      return 'nav.up';
    case 'ArrowDown':
      return 'nav.down';
    default:
      return null;
  }
}

/**
 * 是否落在文本输入控件里。
 *
 * 在输入框里按 Tab 应该走焦点切换、按 Backspace 应该删字——这些键一个都
 * 不能被导图截走。判断放在事件派发处而不是 `resolveKey` 里，是为了让
 * 映射表保持「纯按键」语义，测试不用造 DOM 节点。
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== 'string') return false;
  const element = target as HTMLElement;
  const tag = element.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return element.isContentEditable === true;
}

/**
 * 是否落在任何「自己能吃按键」的控件上（按钮、链接、选项卡、复选开关……）。
 *
 * 与 `isTextEntryTarget` 分开是因为两者的处置不同：
 *
 * - 文本输入框里**所有**键都不拦，连 ⌘Z 也要留给浏览器做文字撤销；
 * - 按钮/下拉/选项卡里只拦**不带修饰键**的键（Tab 要走焦点、方向键要在
 *   下拉里选值），而 ⌘Z / ⌘S 这类组合仍然作用于导图——用户刚点完面板里的
 *   色块，焦点停在那个按钮上，此时按 ⌘Z 想撤销的显然是刚才那次改色。
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  return Boolean(
    (target as Element).closest(
      'button, a[href], select, input, textarea, summary, [contenteditable="true"], [role="tab"], [role="checkbox"], [role="switch"]',
    ),
  );
}
