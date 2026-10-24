/**
 * 模板选择对话框。
 *
 * 三件事：
 *
 * 1. **内置模板实时预览**。文档在包里，所以预览是「打开就有」，不是「等一个
 *    请求回来再画」。字体没就绪时整片网格一起等，而不是每张卡各自等——测量
 *    缓存里没有「字体到没到」这一维，先用回退字体量出来的宽度会被永久缓存。
 * 2. **选中即建图并进入编辑器**。中间不再插一步「确认创建」：模板是起点，
 *    建错了删掉重来比多点一次确认便宜。
 * 3. **我的模板只显示缩略图**。它们的文档在服务端（可能到 8 MiB），列表接口
 *    刻意不带；点下去时才单独取一次完整文档。
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { LoadingState } from '@/components/ui/loading-state';
import { LoadingImage } from '@/components/ui/loading-image';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { templateApi } from '@/lib/api/templates';
import { createDocument } from '@/editor/model/create';
import { useFontsReady } from '@/features/editor/use-fonts-ready';
import { useSiteConfig } from '@/features/site/use-site-config';
import { BUILTIN_TEMPLATES, asStructureClass, buildTemplateDocument } from './builtin';
import { TemplatePreview } from './preview';
import { TemplateCard, TemplatePlaceholder } from './template-card';
import { useTemplateCreate } from './use-template-create';
import { templateKeys } from './queries';

export interface TemplatePickerProps {
  open: boolean;
  onClose: () => void;
  /**
   * 直接建一张空白导图。
   *
   * 留着这个出口是必要的：模板是「起点」，但有人就是要一张空图。让他在
   * 「思维导图」模板里删掉四个分支，比多一个按钮更烦人。
   */
  onCreateBlank?: () => void;
}

type Tab = 'all' | 'basic' | 'user';

/** 预览框尺寸。布局按这个尺寸算缩放比，所以必须是确定的数字。 */
const PREVIEW_WIDTH = 232;
const PREVIEW_HEIGHT = 116;

export function TemplatePicker({ open, onClose, onCreateBlank }: TemplatePickerProps) {
  const { t, i18n } = useTranslation();
  const { config } = useSiteConfig();

  const [tab, setTab] = useState<Tab>('all');
  const [keyword, setKeyword] = useState('');

  useEffect(() => {
    if (!open) return;
    setTab('all');
    setKeyword('');
  }, [open]);

  // 语言变了要重建：模板名与示例文案都走 i18n。
  const language = i18n.resolvedLanguage ?? i18n.language;

  /**
   * 预览用文档。
   *
   * 依赖里放 language 而不是 t：t 的引用在每次渲染都可能变，放它会让 8 份
   * 文档每次渲染都重建一遍。
   */
  const previews = useMemo(
    () => BUILTIN_TEMPLATES.map((def) => ({ def, document: buildTemplateDocument(def, t) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language],
  );

  const fonts = useFontsReady(previews[0]?.document ?? emptyDocument);

  const mine = useQuery({
    queryKey: templateKeys.list(),
    queryFn: templateApi.list,
    enabled: open && config.userTemplateEnabled,
    // 关掉用户模板时接口会 403，重试没有意义。
    retry: false,
  });

  const { createFromBuiltin, createFromMine, busy } = useTemplateCreate({ beforeNavigate: onClose });

  const query = keyword.trim().toLowerCase();

  const filteredBuiltin = useMemo(() => {
    if (tab === 'user') return [];
    return previews.filter(({ def }) => query === '' || t(def.nameKey).toLowerCase().includes(query));
  }, [previews, query, tab, t]);

  const filteredMine = useMemo(() => {
    if (tab === 'basic') return [];
    const items = mine.data ?? [];
    return query === '' ? items : items.filter((item) => item.name.toLowerCase().includes(query));
  }, [mine.data, query, tab]);

  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'all', label: t('templates.tab.all') },
    { value: 'basic', label: t('templates.tab.basic'), count: BUILTIN_TEMPLATES.length },
    { value: 'user', label: t('templates.tab.user'), count: mine.data?.length },
  ];

  return (
    <Modal
      open={open}
      title={t('templates.picker.title')}
      size="lg"
      onClose={onClose}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border border-border/70 p-1" role="tablist" aria-label={t('templates.picker.category')}>
            {tabs.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={tab === item.value}
                onClick={() => setTab(item.value)}
                className={
                  tab === item.value
                    ? 'rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground'
                    : 'rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground'
                }
              >
                {item.label}
                {item.count === undefined ? '' : ` ${item.count}`}
              </button>
            ))}
          </div>
          <div className="relative min-w-0 flex-1 sm:max-w-56">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder={t('templates.picker.search')}
              aria-label={t('templates.picker.search')}
              className="h-9 pl-9"
            />
          </div>
        </div>

        {!config.userTemplateEnabled && tab === 'user' ? (
          <p className="rounded-xl border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
            {t('templates.picker.disabled')}
          </p>
        ) : null}

        {config.userTemplateEnabled && tab === 'user' && mine.isPending ? (
          <LoadingState small className="min-h-44" />
        ) : filteredBuiltin.length > 0 || filteredMine.length > 0 ? (
          <div className="grid max-h-[52vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
            {filteredBuiltin.map(({ def, document }) => (
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

            {filteredMine.map((item) => (
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
              />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-border/70 p-8 text-center">
            <Icon name="waypoints" className="mx-auto size-8 text-muted-foreground/60" />
            <p className="mt-3 text-sm font-medium">
              {query === '' ? t('templates.picker.emptyMine') : t('templates.picker.noMatch')}
            </p>
            {query === '' && tab !== 'basic' ? (
              <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
                {t('templates.picker.emptyMineHint')}
              </p>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
          <p className="text-xs text-muted-foreground">{t('templates.picker.hint')}</p>
          <div className="flex items-center gap-2">
            {/*
              「直接建空白导图」曾经是 ghost 按钮，紧挨着「取消」，结果和次要
              操作长得一模一样——用户扫一眼只看到「取消」，以为这一页只能从
              模板开始。它是**第二条主路径**（不是逃生口），所以给它实心样式，
              并把「取消」降级为 ghost：一主一次，视线自然落在主操作上。
            */}
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            {onCreateBlank ? (
              <Button size="sm" onClick={onCreateBlank} disabled={busy}>
                <Icon name="file-plus" className="size-4" />
                {t('templates.picker.blank')}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** 预览列表为空时的占位文档，只为了让 `useFontsReady` 有个稳定输入。 */
const emptyDocument = createDocument({ title: '' });
