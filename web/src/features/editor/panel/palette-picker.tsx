import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Theme } from '@/editor/model/types';
import { BUILTIN_PALETTES, applyPalette, paletteById } from '@/editor/theme/palettes';
import { cn } from '@/lib/utils';

type Category = 'vivid' | 'classic';
const CATEGORIES: Category[] = ['vivid', 'classic'];

export function PaletteSwatch({ colors, active = false, diagonal = false }: {
  colors: readonly string[];
  active?: boolean;
  diagonal?: boolean;
}) {
  return (
    <span data-palette-swatch="" aria-hidden="true" className={cn(
      'flex h-6 w-full overflow-hidden rounded border border-foreground/15',
      active && 'ring-1 ring-foreground ring-offset-2 ring-offset-card',
    )}>
      {colors.map((color, index) => (
        <span key={`${index}-${color}`} className="h-full min-w-0 flex-1" style={{
          backgroundColor: color,
          backgroundImage: diagonal
            ? `linear-gradient(25deg, transparent 50%, ${colors[(index + 2) % colors.length]} 50%)`
            : undefined,
        }} />
      ))}
    </span>
  );
}

/** 分类是浏览状态，只有点击色板才修改 Theme。 */
export function PalettePicker({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const appliedCategory = paletteById(theme.id)?.category ?? 'vivid';
  const [browse, setBrowse] = useState({ themeId: theme.id, category: appliedCategory });
  // 撤销、重做及外部套用主题时跟随真实分类；手动浏览另一分类时保留浏览状态。
  // 必须同步记住每次应用的 ID，避免撤销回到旧 ID 时重新命中过期的浏览分类。
  if (browse.themeId !== theme.id) setBrowse({ themeId: theme.id, category: appliedCategory });
  const category = browse.themeId === theme.id ? browse.category : appliedCategory;
  const english = i18n.resolvedLanguage?.startsWith('en');
  const label = (value: Category) => t(value === 'vivid' ? 'editor.panel.canvas.vivid' : 'editor.panel.canvas.classic');
  const selectCategory = (value: Category) => setBrowse({ themeId: theme.id, category: value });

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowLeft') next = (index + CATEGORIES.length - 1) % CATEGORIES.length;
    else if (event.key === 'ArrowRight') next = (index + 1) % CATEGORIES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = CATEGORIES.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    selectCategory(CATEGORIES[next]!);
    refs.current[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label={t('editor.panel.canvas.paletteSection')} className="flex gap-3">
        {CATEGORIES.map((value, index) => (
          <button key={value} ref={(node) => { refs.current[index] = node; }} type="button" role="tab"
            id={`${id}-tab-${value}`} aria-controls={`${id}-panel-${value}`}
            aria-selected={category === value} tabIndex={category === value ? 0 : -1}
            onClick={() => selectCategory(value)} onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'h-9 flex-1 border-b-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              category === value ? 'border-foreground font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}>
            {label(value)}
          </button>
        ))}
      </div>
      {CATEGORIES.map((value) => (
        <div key={value} role="tabpanel" id={`${id}-panel-${value}`} aria-labelledby={`${id}-tab-${value}`}
          hidden={category !== value} className={category === value ? 'grid grid-cols-2 gap-x-3 gap-y-3 p-0.5' : 'hidden'}>
          {BUILTIN_PALETTES.filter((palette) => palette.category === value).map((palette) => {
            const name = english ? palette.nameEn : palette.name;
            return (
              <button key={palette.id} type="button" data-palette-id={palette.id}
                aria-pressed={theme.id === palette.id} aria-label={name}
                onClick={() => onChange(applyPalette(theme, palette))}
                className="flex min-w-0 flex-col gap-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                <span className="max-w-full truncate text-[11px] leading-4 text-foreground">{name}</span>
                <PaletteSwatch colors={palette.colors} active={theme.id === palette.id} diagonal={palette.id === 'classic-rainbow'} />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
