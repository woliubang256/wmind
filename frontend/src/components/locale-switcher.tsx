import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import { Select } from '@/components/ui/select';
import { useLocaleStore } from '@/app/locale-store';
import { LOCALE_LABEL, LOCALE_ORDER, type LocalePreference } from '@/lib/i18n/preference';
import { cn } from '@/lib/utils';

/**
 * 角落里的语言切换（登录/注册页右上角、登录后的全站顶栏）。
 *
 * 为什么这两个页面需要它：**语言偏好存在浏览器里，而这两个页面是唯一还没有
 * 登录态的入口**。用户在设置页改过语言当然已经生效；但第一次来的人——浏览器
 * 报的是 `en-US`、界面却是中文，或者反过来——在这一页没有任何出路：进不了
 * 设置页，也读不懂「用户名」两个字，只能硬着头皮猜。所以入口必须放在这里，
 * 而且必须排在这些文字之前。
 *
 * 为什么是自绘下拉而不是原生 `<select>`：原生弹层由操作系统绘制，深色主题下
 * 会在卡片上盖一块系统色的方角面板，和整个界面不是一套语言。自绘的下拉与
 * 设置页、编辑器面板里的是同一个组件，三处观感一致。
 *
 * 选项文字用 `LOCALE_LABEL`：具体语言永远用该语言自己的写法（中文 / English），
 * 只有「跟随浏览器」跟着界面语言变。
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const { t } = useTranslation();
  const preference = useLocaleStore((state) => state.preference);
  const setPreference = useLocaleStore((state) => state.setPreference);

  return (
    <div className={cn('flex items-center gap-1 text-muted-foreground', className)}>
      <Icon name="globe" className="size-3.5 shrink-0" aria-hidden="true" />
      <Select
        aria-label={t('account.language')}
        size="sm"
        value={preference}
        options={LOCALE_ORDER.map((option) => ({
          value: option,
          label: t(LOCALE_LABEL[option]),
        }))}
        onChange={(next) => setPreference(next as LocalePreference)}
        // 触发器只有「中文」两个字宽，弹层至少 8rem，否则「跟随浏览器」会被截。
        menuMinWidth={128}
        className="h-7 w-auto gap-1 border-transparent bg-transparent px-1 hover:bg-accent/60"
      />
    </div>
  );
}
