/**
 * 「样式」Tab：改**选中节点**的样式。
 *
 * 面板显示的是**解析后**的样式（`resolveStyle` 的结果），不是 `topic.style`。
 * 一级分支的填充色是渲染期按 `branchIndex` 从调色板算出来的，`topic.style.fill`
 * 通常是 `undefined`；拿后者当显示值，面板会显示「继承」而画布上明明是红色。
 *
 * 每个字段都有三种状态，界面上必须能区分：
 *
 * - 继承（字段不在 `topic.style` 里）→ 跟着主题/配色走；
 * - 显式值（`#E32925`）→ 固定下来，换配色也不变（验收标准 3）；
 * - 无（仅填充）→ 透明。
 */

import { useTranslation } from 'react-i18next';
import type { ComputedStyle, FontFamily, ShapeClass, StructureClass, Style, Theme } from '@/editor/model/types';
import { FONT_DEFINITIONS, FONT_IDS } from '@/editor/theme/fonts';
import {
  ColorField,
  Field,
  Section,
  Segmented,
  SelectField,
  ToggleField,
} from './controls';

const SHAPES: ShapeClass[] = [
  'rect',
  'rounded-rect',
  'capsule',
  'ellipse',
  'circle',
  'diamond',
  'hexagon',
  'parallelogram',
  'underline',
  'none',
];

const FONT_SIZES = [10, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48];
const WEIGHTS = [
  { value: 300, label: '细 300' },
  { value: 400, label: '常规 400' },
  { value: 600, label: '中粗 600' },
  { value: 700, label: '粗 700' },
  { value: 800, label: '特粗 800' },
];
const LINE_WIDTHS = [1, 2, 3, 4, 5, 6];

export interface StyleTabProps {
  /** 作用对象：选中节点；未选中时是中心主题。 */
  targets: readonly string[];
  /** 第一个作用对象的解析后样式，用于回显。 */
  style: ComputedStyle;
  theme: Theme;
  structure: StructureClass;
  onPatch: (patch: Partial<Style>) => void;
  onStructure: (structure: StructureClass) => void;
  onReset: () => void;
}

export function StyleTab({
  targets,
  style,
  theme,
  structure,
  onPatch,
  onStructure,
  onReset,
}: StyleTabProps) {
  const { t } = useTranslation();
  const multi = targets.length > 1;
  const presets = [...theme.palette.colors, '#FFFFFF', '#1F1F1F', '#BDBDBD', '#F5F5F5'];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {multi ? t('editor.panel.style.multi', { count: targets.length }) : t('editor.panel.style.single')}
        </span>
        <button
          type="button"
          onClick={onReset}
          className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {t('editor.panel.style.reset')}
        </button>
      </div>

      <Section title={t('editor.panel.style.shapeSection')}>
        <SelectField
          label={t('editor.panel.style.shape')}
          value={style.shape}
          options={SHAPES.map((shape) => ({ value: shape, label: t(`editor.panel.shapes.${shape}`) }))}
          onChange={(shape) => onPatch({ shape })}
        />
        <SelectField
          label={t('editor.panel.style.structure')}
          value={structure}
          options={(['mindmap', 'logic-right', 'logic-left', 'tree-right', 'org-chart'] as StructureClass[]).map(
            (value) => ({ value, label: t(`editor.structures.${value}`) }),
          )}
          onChange={onStructure}
        />
      </Section>

      <Section title={t('editor.panel.style.fillSection')}>
        <ColorField
          label={t('editor.panel.style.fill')}
          value={style.fill}
          presets={presets}
          onChange={(fill) => onPatch({ fill })}
          onNone={() => onPatch({ fill: null })}
          onInherit={() => onPatch({ fill: undefined })}
        />
        <ColorField
          label={t('editor.panel.style.borderColor')}
          value={style.borderColor}
          presets={presets}
          onChange={(borderColor) => onPatch({ borderColor })}
          onInherit={() => onPatch({ borderColor: undefined })}
        />
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('editor.panel.style.borderWidth')}>
            <SelectField
              label={t('editor.panel.style.borderWidth')}
              value={style.borderWidth}
              options={[0, 1, 2, 3, 4, 6].map((value) => ({ value, label: `${value} px` }))}
              onChange={(borderWidth) => onPatch({ borderWidth })}
            />
          </Field>
          <Field label={t('editor.panel.style.borderStyle')}>
            <SelectField
              label={t('editor.panel.style.borderStyle')}
              value={style.borderStyle}
              options={(['solid', 'dash', 'dot', 'none'] as const).map((value) => ({
                value,
                label: t(`editor.panel.borders.${value}`),
              }))}
              onChange={(borderStyle) => onPatch({ borderStyle })}
            />
          </Field>
        </div>
      </Section>

      <Section title={t('editor.panel.style.textSection')}>
        <Field label={t('editor.panel.style.fontFamily')}>
          <SelectField
            label={t('editor.panel.style.fontFamily')}
            value={style.fontFamily}
            options={FONT_IDS.map((id) => ({ value: id, label: FONT_DEFINITIONS[id].label }))}
            onChange={(fontFamily: FontFamily) => onPatch({ fontFamily })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('editor.panel.style.fontSize')}>
            <SelectField
              label={t('editor.panel.style.fontSize')}
              value={style.fontSize}
              options={FONT_SIZES.map((value) => ({ value, label: `${value} px` }))}
              onChange={(fontSize) => onPatch({ fontSize })}
            />
          </Field>
          <Field label={t('editor.panel.style.fontWeight')}>
            <SelectField
              label={t('editor.panel.style.fontWeight')}
              value={style.fontWeight}
              options={WEIGHTS}
              onChange={(fontWeight) => onPatch({ fontWeight })}
            />
          </Field>
        </div>

        <Field label={t('editor.panel.style.decoration')}>
          <div className="flex gap-1">
            <button
              type="button"
              aria-pressed={style.fontWeight >= 600}
              title={t('editor.panel.style.bold')}
              onClick={() => onPatch({ fontWeight: style.fontWeight >= 600 ? 400 : 700 })}
              className={toggleClass(style.fontWeight >= 600, 'font-bold')}
            >
              B
            </button>
            <button
              type="button"
              aria-pressed={style.fontStyle === 'italic'}
              title={t('editor.panel.style.italic')}
              onClick={() => onPatch({ fontStyle: style.fontStyle === 'italic' ? 'normal' : 'italic' })}
              className={toggleClass(style.fontStyle === 'italic', 'italic font-serif')}
            >
              I
            </button>
            <button
              type="button"
              aria-pressed={style.textDecoration === 'underline'}
              title={t('editor.panel.style.underline')}
              onClick={() =>
                onPatch({ textDecoration: style.textDecoration === 'underline' ? 'none' : 'underline' })
              }
              className={toggleClass(style.textDecoration === 'underline', 'underline')}
            >
              U
            </button>
            <button
              type="button"
              aria-pressed={style.textDecoration === 'line-through'}
              title={t('editor.panel.style.strike')}
              onClick={() =>
                onPatch({ textDecoration: style.textDecoration === 'line-through' ? 'none' : 'line-through' })
              }
              className={toggleClass(style.textDecoration === 'line-through', 'line-through')}
            >
              S
            </button>
          </div>
        </Field>

        <ColorField
          label={t('editor.panel.style.textColor')}
          value={style.textColor}
          presets={['#1F1F1F', '#616161', '#FFFFFF', ...theme.palette.colors]}
          onChange={(textColor) => onPatch({ textColor })}
          onInherit={() => onPatch({ textColor: undefined })}
        />

        <Field label={t('editor.panel.style.align')}>
          <Segmented
            label={t('editor.panel.style.align')}
            value={style.textAlign}
            options={[
              { value: 'left', label: '左' },
              { value: 'center', label: '中' },
              { value: 'right', label: '右' },
            ]}
            onChange={(textAlign) => onPatch({ textAlign })}
          />
        </Field>
      </Section>

      <Section title={t('editor.panel.style.branchSection')}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('editor.panel.style.lineStyle')}>
            <SelectField
              label={t('editor.panel.style.lineStyle')}
              value={style.lineStyle}
              options={(['straight', 'curve', 'elbow', 'none'] as const).map((value) => ({
                value,
                label: t(`editor.panel.lines.${value}`),
              }))}
              onChange={(lineStyle) => onPatch({ lineStyle })}
            />
          </Field>
          <Field label={t('editor.panel.style.lineEnd')}>
            <SelectField
              label={t('editor.panel.style.lineEnd')}
              value={style.lineEnd}
              options={(['none', 'arrow', 'dot'] as const).map((value) => ({
                value,
                label: t(`editor.panel.ends.${value}`),
              }))}
              onChange={(lineEnd) => onPatch({ lineEnd })}
            />
          </Field>
        </div>
        <Field label={t('editor.panel.style.lineWidth')}>
          <SelectField
            label={t('editor.panel.style.lineWidth')}
            value={style.lineWidth}
            options={LINE_WIDTHS.map((value) => ({ value, label: `${value} px` }))}
            onChange={(lineWidth) => onPatch({ lineWidth })}
          />
        </Field>
        <ColorField
          label={t('editor.panel.style.lineColor')}
          value={style.lineColor}
          presets={presets}
          onChange={(lineColor) => onPatch({ lineColor })}
          onInherit={() => onPatch({ lineColor: undefined })}
        />
      </Section>

      <Section title={t('editor.panel.style.widthSection')}>
        <ToggleField
          label={t('editor.panel.style.autoWidth')}
          checked={style.autoWidth}
          onChange={(autoWidth) => onPatch({ autoWidth })}
          hint={t('editor.panel.style.autoWidthHint')}
        />
        <Field label={t('editor.panel.style.width')}>
          <input
            type="number"
            min={40}
            max={800}
            step={10}
            aria-label={t('editor.panel.style.width')}
            disabled={style.autoWidth}
            value={Math.round(style.width)}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isFinite(value) && value >= 40) onPatch({ width: value, autoWidth: false });
            }}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
        </Field>
      </Section>
    </div>
  );
}

/** 装饰按钮的统一外观：选中态与 `Segmented` 保持一致，避免两套高亮规则。 */
function toggleClass(active: boolean, extra: string): string {
  return [
    'inline-flex h-8 w-9 items-center justify-center rounded-md border text-xs transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    active
      ? 'border-primary bg-primary/10 font-semibold text-foreground'
      : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
    extra,
  ].join(' ');
}
