import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import { useLocaleStore } from '@/app/locale-store';
import { LOCALE_LABEL, LOCALE_ORDER, type LocalePreference } from '@/lib/i18n/preference';
import { cn } from '@/lib/utils';

/**
 * 角落里的语言切换（登录页、注册页的右上角）。
 *
 * 为什么这两个页面需要它：**语言偏好存在浏览器里，而这两个页面是唯一还没有
 * 登录态的入口**。用户在设置页改过语言当然已经生效；但第一次来的人——浏览器
 * 报的是 `en-US`、界面却是中文，或者反过来——在这一页没有任何出路：进不了
 * 设置页，也读不懂「用户名」两个字，只能硬着头皮猜。所以入口必须放在这里，
 * 而且必须排在这些文字之前。
 *
 * 为什么是原生 `<select>` 而不是按钮 + 弹出层：
 *
 * - 三个选项，不需要分组、搜索、多选，弹出层能做的它都能做；
 * - 键盘、读屏、触摸、移动端选择器全部由浏览器负责，不用自己管焦点陷阱与
 *   `Escape`；
 * - `color-scheme` 已经在 `styles.css` 里按 light/dark 设过，原生下拉在深色
 *   主题下也是深色，不会出现「白底白字」。
 *
 * 选项文字用 `LOCALE_LABEL`：具体语言永远用该语言自己的写法（中文 / English），
 * 只有「跟随浏览器」跟着界面语言变。
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const { t } = useTranslation();
  const preference = useLocaleStore((state) => state.preference);
  const setPreference = useLocaleStore((state) => state.setPreference);
  const id = useId();

  return (
    <div className={cn('flex items-center gap-1 text-muted-foreground', className)}>
      <Icon name="globe" className="size-3.5 shrink-0" aria-hidden="true" />
      <label htmlFor={id} className="sr-only">
        {t('account.language')}
      </label>
      <select
        id={id}
        value={preference}
        onChange={(event) => setPreference(event.target.value as LocalePreference)}
        className={cn(
          'cursor-pointer rounded-md bg-transparent py-0.5 pr-1 text-xs font-medium text-foreground/75',
          'transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {LOCALE_ORDER.map((option) => (
          <option
            key={option}
            value={option}
            // 语言名用该语言自己的写法，`lang` 一并标对：读屏会按这个语言发音，
            // 否则英文语音包念「中文」两个字会念成拼音。
            lang={option === 'system' ? undefined : option}
          >
            {t(LOCALE_LABEL[option])}
          </option>
        ))}
      </select>
    </div>
  );
}
