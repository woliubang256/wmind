/**
 * 「另存为模板」对话框。
 *
 * 只收一个名字：文档与缩略图都由服务端从源导图复制，前端不需要（也不应该）
 * 把整份文档再传一遍——那等于给「客户端提交任意文档当模板」开一个口子。
 */

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { fieldErrorsFrom } from '@/lib/api/errors';
import { templateApi } from '@/lib/api/templates';
import { templateKeys } from './queries';

export interface SaveTemplateDialogProps {
  open: boolean;
  mapUid: string;
  /** 预填名字，通常就是导图标题。 */
  defaultName: string;
  onClose: () => void;
}

export function SaveTemplateDialog({ open, mapUid, defaultName, onClose }: SaveTemplateDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(defaultName);

  // 每次打开都重置：上一次留下的名字不该被复用。
  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);

  const save = useMutation({
    mutationFn: () => templateApi.createFromMap({ name: name.trim(), mapUid }),
    onSuccess: () => {
      toast.success(t('templates.saved'));
      void queryClient.invalidateQueries({ queryKey: templateKeys.root });
      onClose();
    },
    // 具体原因渲染在字段旁边；这里不弹 toast，否则同一个错误出现两次。
  });

  const fieldErrors = save.error ? fieldErrorsFrom(save.error) : {};
  const submit = () => {
    if (name.trim() === '' || save.isPending) return;
    save.mutate();
  };

  return (
    <Modal
      open={open}
      title={t('templates.saveAs')}
      description={t('templates.saveAsHint')}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={save.isPending || name.trim() === ''}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextField
          label={t('templates.rename.label')}
          value={name}
          autoFocus
          error={fieldErrors.name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
        {save.error && Object.keys(fieldErrors).length === 0 ? (
          <p role="alert" className="text-xs text-destructive">
            {save.error.message}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
