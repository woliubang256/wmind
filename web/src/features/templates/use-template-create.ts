/**
 * 「从模板建导图」的唯一实现。
 *
 * 选择对话框与模板页都要做这件事，而它有三处容易分叉的细节：归一化文档、
 * 改写标题与时间戳、建完跳转。放在一个钩子里，两处调用点只负责传模板。
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { mapApi } from '@/lib/api/maps';
import { templateApi, type TemplateSummary } from '@/lib/api/templates';
import { parseDocument } from '@/editor/model/validate';
import type { WmindDocument } from '@/editor/model/types';

/**
 * 从一份模板文档建一张新导图。
 *
 * 提交前走一遍归一化：内置模板刚由 `createDocument` 构造，本来就是规范的；
 * 用户模板的文档可能来自更早的版本，归一化把它升级到当前格式，而不是让
 * 服务端去拒绝一份「当时合法」的文档。
 *
 * 标题与 `meta` 时间戳都改写成「现在」：文档里的 title 还是源导图的标题，
 * 不改的话导出文件名会莫名其妙地叫成源导图。
 */
async function createMapFrom(name: string, raw: WmindDocument) {
  const normalized = parseDocument(raw).document;
  const now = new Date().toISOString();
  return mapApi.create({
    title: name,
    document: { ...normalized, title: name, meta: { ...normalized.meta, createdAt: now, updatedAt: now } },
  });
}

export interface UseTemplateCreateOptions {
  /** 建好之后先跑它（比如关掉对话框），再跳转。 */
  beforeNavigate?: () => void;
}

export function useTemplateCreate({ beforeNavigate }: UseTemplateCreateOptions = {}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const builtin = useMutation({
    mutationFn: (input: { name: string; document: WmindDocument }) => createMapFrom(input.name, input.document),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['maps'] });
      beforeNavigate?.();
      navigate(`/maps/${created.uid}`);
    },
    onError: (error: Error) => toast.error(error.message || t('templates.error')),
  });

  /** 用用户模板建图：先取完整文档（列表里刻意没有），再建。 */
  const mine = useMutation({
    mutationFn: async (item: TemplateSummary) => {
      const detail = await templateApi.get(item.uid);
      return builtin.mutateAsync({ name: detail.name, document: detail.document });
    },
    onError: (error: Error) => toast.error(error.message || t('templates.error')),
  });

  return {
    createFromBuiltin: builtin.mutate,
    createFromMine: mine.mutate,
    busy: builtin.isPending || mine.isPending,
  };
}
