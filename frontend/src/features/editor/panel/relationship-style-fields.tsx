import { useTranslation } from 'react-i18next';
import type { Relationship, Style, Theme } from '@/editor/model/types';
import { relationshipStyle } from '@/editor/layout/annotations';
import { ColorField, Field, SelectField } from './controls';

export function RelationshipStyleFields({ relationship, theme, onPatch }: {
  relationship: Relationship; theme: Theme; onPatch(patch: Partial<Style>): void;
}) {
  const { t } = useTranslation();
  const style = relationshipStyle(theme, relationship.style);
  const direction = style.lineStart === 'arrow'
    ? style.lineEnd === 'arrow' ? 'both' : 'reverse'
    : style.lineEnd === 'arrow' ? 'forward' : 'none';
  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-border/60 pt-2" data-relationship-style={relationship.id}>
      <ColorField label={t('editor.panel.style.lineColor')} value={style.lineColor}
        presets={[...new Set([...theme.palette.lineColors, '#1F1F1F', '#E32925', '#2E9E5B'])]}
        onChange={(lineColor) => onPatch({ lineColor })} onInherit={() => onPatch({ lineColor: undefined })} />
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('editor.panel.style.lineWidth')}>
          <SelectField label={t('editor.panel.style.lineWidth')} value={style.lineWidth}
            options={[1, 1.5, 2, 3, 4, 5, 6].map((value) => ({ value, label: `${value} px` }))}
            onChange={(lineWidth) => onPatch({ lineWidth })} />
        </Field>
        <Field label={t('editor.panel.style.lineStyle')}>
          <SelectField label={t('editor.panel.style.lineStyle')} value={style.lineStyle}
            options={(['straight', 'curve', 'elbow'] as const).map((value) => ({ value, label: t(`editor.panel.lines.${value}`) }))}
            onChange={(lineStyle) => onPatch({ lineStyle })} />
        </Field>
      </div>
      <Field label={t('editor.annotation.linePattern')}>
        <SelectField label={t('editor.annotation.linePattern')} value={style.borderStyle}
          options={(['solid', 'dash', 'dot'] as const).map((value) => ({ value, label: t(`editor.panel.borders.${value}`) }))}
          onChange={(borderStyle) => onPatch({ borderStyle })} />
      </Field>
      <Field label={t('editor.annotation.arrowDirection')}>
        <SelectField label={t('editor.annotation.arrowDirection')} value={direction}
          options={(['none', 'forward', 'reverse', 'both'] as const).map((value) => ({ value, label: t(`editor.annotation.direction.${value}`) }))}
          onChange={(value) => onPatch({ lineStart: value === 'reverse' || value === 'both' ? 'arrow' : 'none', lineEnd: value === 'forward' || value === 'both' ? 'arrow' : 'none' })} />
      </Field>
      <button type="button" className="self-end rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => onPatch({ lineColor: undefined, lineWidth: undefined, lineStyle: undefined, borderStyle: undefined, lineStart: undefined, lineEnd: undefined })}>
        {t('editor.panel.style.reset')}
      </button>
    </div>
  );
}
