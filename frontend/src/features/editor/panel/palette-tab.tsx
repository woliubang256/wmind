/**
 * 「画布」Tab：改**整份导图**的主题（配色方案、背景、全局字体、线宽、彩虹分支、布局）。
 *
 * 与「样式」Tab 的分工：样式改的是节点（写进 `topic.style`，是内容的一部分），
 * 画布改的是主题（写进 `doc.theme`，不碰任何节点）。这也是为什么换配色方案不会
 * 丢内容、不会动用户手动指定的颜色——那两类信息根本不在同一个字段里。
 *
 * 「我的主题」把当前主题整份存到后端（`/themes`），之后可以一键套回别的导图。
 * 存的是 `Theme` 而不是 `Palette`：用户点保存时的意图是「记住现在这个样子」，
 * 只存 6 个颜色会漏掉字体、背景、彩虹开关和布局开关。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Theme, ThemeLayout } from '@/editor/model/types';
import { themeFromCustomConfig, themeSwatchColors } from '@/editor/theme/custom';
import { FONT_DEFINITIONS, FONT_IDS } from '@/editor/theme/fonts';
import { cn } from '@/lib/utils';
import { ColorField, Field, Section, SelectField, ToggleField } from './controls';
import { useCustomThemes } from './use-custom-themes';
import { PalettePicker, PaletteSwatch } from './palette-picker';

const LAYOUT_KEYS: (keyof ThemeLayout)[] = ['autoBalance', 'compact', 'alignSiblings'];

export interface PaletteTabProps {
  theme: Theme;
  onChange: (theme: Theme) => void;
  /**
   * 是否能写后端。`/maps/demo` 与 `/maps/stress` 是纯本地文档，那里发请求
   * 会 401，进而触发静默刷新失败、跳登录页——点开演示却要求登录。
   */
  canPersist: boolean;
}

export function PaletteTab({ theme, onChange, canPersist }: PaletteTabProps) {
  const { t } = useTranslation();
  const custom = useCustomThemes(canPersist);
  const [themeName, setThemeName] = useState('');

  const setLayout = (key: keyof ThemeLayout, value: boolean) => {
    onChange({ ...theme, layout: { ...theme.layout, [key]: value } });
  };

  const setRainbowColor = (index: number, color: string) => {
    const next = [...theme.rainbowColors];
    next[index] = color;
    onChange({ ...theme, rainbowColors: next });
  };

  const saveTheme = async () => {
    const name = themeName.trim();
    if (name.length === 0 || custom.saving) return;
    // 成功后清空输入框：留着上次的名字，用户再点一次会存出两条同名主题。
    if (await custom.save(name, theme)) setThemeName('');
  };

  return (
    <div className="flex flex-col gap-3">
      <Section title={t('editor.panel.canvas.customSection')}>
        {canPersist ? (
          <>
            <Field label={t('editor.panel.canvas.customName')}>
              <div className="flex gap-1">
                <input
                  value={themeName}
                  maxLength={64}
                  aria-label={t('editor.panel.canvas.customName')}
                  placeholder={t('editor.panel.canvas.customNamePlaceholder')}
                  onChange={(event) => setThemeName(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter 直接保存：这是一个单行输入框，用户的期待就是回车提交。
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void saveTheme();
                    }
                  }}
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button
                  type="button"
                  disabled={themeName.trim().length === 0 || custom.saving}
                  onClick={() => void saveTheme()}
                  className="inline-flex h-8 shrink-0 items-center rounded-md border border-input bg-background px-2 text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  {custom.saving
                    ? t('editor.panel.canvas.customSaving')
                    : t('editor.panel.canvas.customSave')}
                </button>
              </div>
            </Field>

            {custom.error ? (
              <p role="alert" className="text-[11px] leading-snug text-destructive">
                {custom.error}
              </p>
            ) : null}

            {custom.themes.length === 0 && !custom.loading && !custom.error ? (
              <p className="text-[11px] leading-snug text-muted-foreground/80">
                {t('editor.panel.canvas.customEmpty')}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {custom.themes.map((entry) => {
                  const saved = themeFromCustomConfig(entry);
                  const active = theme.id === entry.uid;
                  return (
                    /*
                      应用与删除是两个并排的按钮，不是「卡片里嵌一个 ×」：
                      按钮里套按钮是非法 HTML，浏览器会把内层拆出去，键盘用户
                      会发现「删除」不在 Tab 顺序里。并排结构下两者各自可聚焦。
                    */
                    <div
                      key={entry.uid}
                      className={cn(
                        'flex items-stretch overflow-hidden rounded-lg border',
                        active ? 'border-primary bg-primary/10' : 'border-input bg-background',
                      )}
                    >
                      <button
                        type="button"
                        aria-pressed={active}
                        aria-label={entry.name}
                        onClick={() => onChange(saved)}
                        className="flex min-w-0 flex-1 flex-col gap-1 p-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <PaletteSwatch colors={themeSwatchColors(saved)} />
                        {/* leading-4 显式给出行高：截断（overflow-hidden）配上继承来的
                            紧凑行高，中文字形的上下缘会被切掉一截。 */}
                        <span className="truncate text-[11px] leading-4 text-foreground">
                          {entry.name}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={t('editor.panel.canvas.customRemove', { name: entry.name })}
                        title={t('editor.panel.canvas.customRemove', { name: entry.name })}
                        disabled={custom.removing}
                        onClick={() => void custom.remove(entry.uid)}
                        className="grid w-6 shrink-0 place-items-center border-l border-border/60 text-[13px] leading-none text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <p className="text-[11px] leading-snug text-muted-foreground/80">
            {t('editor.panel.canvas.customLocalOnly')}
          </p>
        )}
      </Section>

      <Section title={t('editor.panel.canvas.paletteSection')}>
        <PalettePicker theme={theme} onChange={onChange} />
      </Section>

      <Section title={t('editor.panel.canvas.globalSection')}>
        <ColorField
          label={t('editor.panel.canvas.background')}
          value={theme.global.backgroundColor}
          presets={['#FFFFFF', '#FAFAFA', '#F5F5F5', '#FFF8E1', '#1F1F1F']}
          onChange={(backgroundColor) =>
            onChange({
              ...theme,
              global: { ...theme.global, backgroundColor },
              palette: { ...theme.palette, backgroundColor },
            })
          }
        />
        <SelectField
          label={t('editor.panel.canvas.fontFamily')}
          value={theme.global.fontFamily}
          options={FONT_IDS.map((id) => ({ value: id, label: t(FONT_DEFINITIONS[id].labelKey) }))}
          onChange={(fontFamily) => onChange({ ...theme, global: { ...theme.global, fontFamily } })}
        />
        <SelectField
          label={t('editor.panel.canvas.lineWidth')}
          value={theme.global.lineWidth}
          options={[1, 2, 3].map((value) => ({ value, label: t(`editor.panel.canvas.lineWidths.${value}`) }))}
          onChange={(lineWidth) => onChange({ ...theme, global: { ...theme.global, lineWidth } })}
        />
      </Section>

      <section className="flex flex-col gap-2 border-t border-border/60 pt-3">
        <ToggleField
          label={t('editor.panel.canvas.rainbowBranch')}
          checked={theme.rainbowBranch}
          onChange={(rainbowBranch) => onChange({ ...theme, rainbowBranch })}
          hint={t('editor.panel.canvas.rainbowHint')}
        />
        {theme.rainbowBranch ? (
          <Field label={t('editor.panel.canvas.rainbowColors')}>
            <div className="flex flex-wrap gap-1">
              {theme.rainbowColors.map((color, index) => (
                <input
                  key={`${index}-${color}`}
                  type="color"
                  aria-label={t('editor.panel.canvas.rainbowColorN', { index: index + 1 })}
                  value={color}
                  onChange={(event) => setRainbowColor(index, event.target.value.toUpperCase())}
                  className="h-7 w-8 cursor-pointer rounded-md border border-input bg-background p-0.5"
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                onChange({ ...theme, rainbowColors: [...theme.palette.colors] })
              }
              className="self-start rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {t('editor.panel.canvas.rainbowReset')}
            </button>
          </Field>
        ) : null}
      </section>

      <Section title={t('editor.panel.canvas.layoutSection')}>
        {LAYOUT_KEYS.map((key) => (
          <ToggleField
            key={key}
            label={t(`editor.panel.canvas.layouts.${key}`)}
            checked={theme.layout[key]}
            onChange={(value) => setLayout(key, value)}
            hint={t(`editor.panel.canvas.layoutHints.${key}`)}
          />
        ))}
      </Section>
    </div>
  );
}
