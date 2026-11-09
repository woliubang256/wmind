/**
 * 模板页（`/templates`）。
 *
 * 上半是 8 个内置模板（只读，点一下就从它建图），下半是「我的模板」
 * （改名、删除）。两半共用一个卡片外壳，差异只在预览来源与有没有行内操作。
 *
 * 内置模板不来自接口，所以这一页在接口还没回来时也能立刻显示上半部分——
 * 关掉用户模板的站点（`feature.user_template_enabled = false`）也一样。
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LoadingState } from '@/components/ui/loading-state';
import { LoadingImage } from '@/components/ui/loading-image';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Icon } from '@/components/ui/icon';
import { TextField } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { EmptyState, PageHeader } from '@/components/ui/panel';
import { templateApi, type TemplateSummary } from '@/lib/api/templates';
import { createDocument } from '@/editor/model/create';
import { useFontsReady } from '@/features/editor/use-fonts-ready';
import { useSiteConfig } from '@/features/site/use-site-config';
import { BUILTIN_TEMPLATES, asStructureClass, buildTemplateDocument } from './builtin';
import { TemplatePreview } from './preview';
import { TemplateCard, TemplatePlaceholder } from './template-card';
import { useTemplateCreate } from './use-template-create';
import { templateKeys } from './queries';

const PREVIEW_WIDTH = 232;
const PREVIEW_HEIGHT = 116;

export function TemplatesPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { config } = useSiteConfig();
  const { createFromBuiltin, createFromMine, busy } = useTemplateCreate();

  const [renaming, setRenaming] = useState<TemplateSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);

  const language = i18n.resolvedLanguage ?? i18n.language;
  const previews = useMemo(
    () => BUILTIN_TEMPLATES.map((def) => ({ def, document: buildTemplateDocument(def, t) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language],
  );
  const fonts = useFontsReady(previews[0]?.document ?? emptyDocument);

  const mine = useQuery({
    queryKey: templateKeys.list(),
    queryFn: templateApi.list,
    enabled: config.userTemplateEnabled,
    retry: false,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: templateKeys.root });
  };

  const rename = useMutation({
    mutationFn: (input: { uid: string; name: string }) => templateApi.rename(input.uid, input.name),
    onSuccess: () => {
      toast.success(t('templates.renamed'));
      setRenaming(null);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (uid: string) => templateApi.remove(uid),
    onSuccess: () => {
      toast.success(t('templates.deleted'));
      setDeleting(null);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const items = mine.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title={t('templates.title')} />

      {/* ── 内置模板 ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">{t('templates.section.basic')}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {previews.map(({ def, document }) => (
            <TemplateCard
              key={def.uid}
              title={t(def.nameKey)}
              structure={t(`editor.structures.${def.structure}`)}
              disabled={busy}
              onPick={() => createFromBuiltin({ name: t(def.nameKey), document })}
              preview={
                fonts.ready ? (
                  <TemplatePreview document={document} width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} label={t(def.nameKey)} />
                ) : (
                  <div style={{ height: PREVIEW_HEIGHT }} className="grid place-items-center text-xs text-muted-foreground">
                    <LoadingState small tone="soft" />
                  </div>
                )
              }
            />
          ))}
        </div>
      </section>

      {/* ── 我的模板 ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium">{t('templates.section.mine')}</h2>
          {items.length > 0 ? (
            <span className="text-xs text-muted-foreground">{t('templates.section.mineHint', { count: items.length })}</span>
          ) : null}
        </div>

        {!config.userTemplateEnabled ? (
          <EmptyState
            icon="lock"
            title={t('templates.disabled.title')}
            description={t('templates.disabled.body')}
          />
        ) : mine.isPending ? (
          <LoadingState className="min-h-44" />
        ) : items.length === 0 ? (
          <EmptyState icon="waypoints" title={t('templates.empty.title')} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((item) => (
              <TemplateCard
                key={item.uid}
                title={item.name}
                structure={t(`editor.structures.${asStructureClass(item.structure)}`)}
                disabled={busy}
                onPick={() => createFromMine(item)}
                preview={
                  item.thumbnailUrl ? (
                    <LoadingImage src={item.thumbnailUrl} alt="" containerClassName="w-full" containerStyle={{ height: PREVIEW_HEIGHT }} className="size-full object-contain" />
                  ) : (
                    <TemplatePlaceholder height={PREVIEW_HEIGHT} />
                  )
                }
                actions={
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRenaming(item);
                        setRenameValue(item.name);
                      }}
                    >
                      <Icon name="pencil" className="mr-1.5 size-3.5" />
                      {t('templates.actions.rename')}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleting(item)}>
                      <Icon name="trash" className="mr-1.5 size-3.5" />
                      {t('templates.actions.delete')}
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* ── 改名 ─────────────────────────────────────────────────── */}
      <Modal
        open={renaming !== null}
        title={t('templates.rename.title')}
        onClose={() => setRenaming(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setRenaming(null)} disabled={rename.isPending}>
              {t('common.cancel')}
            </Button>
            <Button loading={rename.isPending}
              onClick={() => {
                if (renaming) rename.mutate({ uid: renaming.uid, name: renameValue });
              }}
              disabled={rename.isPending || renameValue.trim() === ''}
            >
              {rename.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </>
        }
      >
        <TextField
          label={t('templates.rename.label')}
          value={renameValue}
          autoFocus
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && renaming && renameValue.trim() !== '') {
              rename.mutate({ uid: renaming.uid, name: renameValue });
            }
          }}
        />
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title={t('templates.deleteConfirm.title')}
        description={t('templates.deleteConfirm.body')}
        confirmLabel={t('templates.actions.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        pending={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.uid);
        }}
      />
    </div>
  );
}

/** 预览列表为空时的占位文档，只为了让 `useFontsReady` 有个稳定输入。 */
const emptyDocument = createDocument({ title: '' });
