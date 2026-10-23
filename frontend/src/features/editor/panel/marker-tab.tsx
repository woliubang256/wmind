import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { MARKER_GROUPS } from '@/editor/import/markers';
import type { Topic } from '@/editor/model/types';
import { MarkerIcon } from '@/editor/viewer/marker-icon';
import { ToolbarButton } from '../toolbar-button';

export function MarkerTab({ topics, onToggle, onClear }: {
  topics: readonly Topic[];
  onToggle(markerId: string): void;
  onClear(): void;
}) {
  const { t } = useTranslation();
  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground" role="status">{topics.length ? t('editor.marker.selection', { count: topics.length }) : t('editor.emptySelection')}</p>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!topics.some((topic) => topic.markers.length)} onClick={onClear}>{t('editor.marker.clear')}</Button>
    </div>
    {Object.entries(MARKER_GROUPS).map(([group, ids]) => <fieldset key={group}>
      <legend className="mb-2 text-xs font-medium">{t(`editor.marker.group.${group}`)}</legend>
      <div className="grid grid-cols-7 gap-1">
        {ids.map((markerId) => {
          const applied = topics.filter((topic) => topic.markers.some((item) => item.markerId === markerId)).length;
          const selected = topics.length > 0 && applied === topics.length;
          const mixed = applied > 0 && !selected;
          return <ToolbarButton key={markerId} size="icon" variant={selected ? 'secondary' : 'ghost'}
            className={`size-8 rounded-md border ${selected ? 'border-primary/50' : mixed ? 'border-dashed border-primary/50' : 'border-transparent'}`}
            aria-label={t(`editor.marker.${markerId}`)} aria-pressed={mixed ? 'mixed' : selected}
            disabled={topics.length === 0} disabledReason={t('editor.emptySelection')}
            onClick={() => onToggle(markerId)}>
            <MarkerIcon markerId={markerId} className="size-5" />
          </ToolbarButton>;
        })}
      </div>
    </fieldset>)}
  </div>;
}
