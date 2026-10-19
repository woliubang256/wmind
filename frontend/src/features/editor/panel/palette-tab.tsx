/**
 * 「画布」Tab：改**整份导图**的主题（配色方案、背景、全局字体、线宽、彩虹分支、布局）。
 *
 * 与「样式」Tab 的分工：样式改的是节点（写进 `topic.style`，是内容的一部分），
 * 画布改的是主题（写进 `doc.theme`，不碰任何节点）。这也是为什么换配色方案不会
 * 丢内容、不会动用户手动指定的颜色——那两类信息根本不在同一个字段里。
 */

import { useTranslation } from 'react-i18next';
import type { Theme, ThemeLayout } from '@/editor/model/types';
import { FONT_DEFINITIONS, FONT_IDS } from '@/editor/theme/fonts';
import { BUILTIN_PALETTES, applyPalette, paletteById } from '@/editor/theme/palettes';
import { ColorField, Field, Section, SelectField, ToggleField } from './controls';

const LAYOUT_KEYS: (keyof ThemeLayout)[] = ['autoBalance', 'compact', 'alignSiblings'];

export interface PaletteTabProps {
  theme: Theme;
  onChange: (theme: Theme) => void;
}

export function PaletteTab({ theme, onChange }: PaletteTabProps) {
  const { t } = useTranslation();

  const setLayout = (key: keyof ThemeLayout, value: boolean) => {
    onChange({ ...theme, layout: { ...theme.layout, [key]: value } });
  };

  const setRainbowColor = (index: number, color: string) => {
    const next = [...theme.rainbowColors];
    next[index] = color;
    onChange({ ...theme, rainbowColors: next });
  };

  const groups = [
    { id: 'vivid', label: t('editor.panel.canvas.vivid') },
    { id: 'classic', label: t('editor.panel.canvas.classic') },
  ] as const;

  return (
    <div className="flex flex-col gap-3">
      <Section title={t('editor.panel.canvas.paletteSection')}>
        {groups.map((group) => (
          <div key={group.id} className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">{group.label}</span>
            <div className="grid grid-cols-2 gap-1.5">
              {BUILTIN_PALETTES.filter((palette) => palette.category === group.id).map((palette) => {
                const active = theme.id === palette.id;
                return (
                  <button
                    key={palette.id}
                    type="button"
                    aria-pressed={active}
                    aria-label={palette.name}
                    onClick={() => {
                      const source = paletteById(palette.id);
                      if (source) onChange(applyPalette(theme, source));
                    }}
                    className={[
                      'flex flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'border-primary bg-primary/10'
                        : 'border-input bg-background hover:bg-accent',
                    ].join(' ')}
                  >
                    <span className="flex gap-0.5">
                      {palette.colors.map((color) => (
                        <span
                          key={color}
                          style={{ backgroundColor: color }}
                          className="h-3 flex-1 rounded-sm border border-black/10"
                        />
                      ))}
                    </span>
                    <span className="text-[11px] text-foreground">{palette.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
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
          options={FONT_IDS.map((id) => ({ value: id, label: FONT_DEFINITIONS[id].label }))}
          onChange={(fontFamily) => onChange({ ...theme, global: { ...theme.global, fontFamily } })}
        />
        <SelectField
          label={t('editor.panel.canvas.lineWidth')}
          value={theme.global.lineWidth}
          options={[1, 2, 3].map((value) => ({ value, label: t(`editor.panel.canvas.lineWidths.${value}`) }))}
          onChange={(lineWidth) => onChange({ ...theme, global: { ...theme.global, lineWidth } })}
        />
      </Section>

      <Section title={t('editor.panel.canvas.rainbowSection')}>
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
      </Section>

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
