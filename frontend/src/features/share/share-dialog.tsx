/**
 * 分享对话框：管理某张导图的全部分享链接。
 *
 * 三个决定：
 *
 * 1. **建完立刻显示链接本身**，而不是只弹一句「创建成功」。用户的下一步
 *    一定是复制，让他再去列表里找一遍是把成功变成一次额外操作。
 * 2. **撤销用二次确认，且不物理删除**。撤销之后链接还在列表里、标成「已撤销」
 *    并保留访问次数——用户要看的往往就是「撤销前有多少人看过」。
 * 3. **表单默认值来自站点设置**（`shareDefaultExpireDays` / `shareDefaultAllowDownload`），
 *    否则后台里那两项设置改了等于没改。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Icon } from '@/components/ui/icon';
import { LoadingState } from '@/components/ui/loading-state';
import { SelectField, TextField } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/panel';
import { Switch } from '@/components/ui/switch';
import { fieldErrorsFrom } from '@/lib/api/errors';
import { resolveShareUrl, shareApi, type ShareLink } from '@/lib/api/shares';
import { useSiteConfig } from '@/features/site/use-site-config';
import { shareKeys } from './queries';

export interface ShareDialogProps {
  open: boolean;
  mapUid: string;
  mapTitle: string;
  onClose: () => void;
}

/** 有效期候选。0 表示永久有效；默认选中站点配置的期限（缺省 7 天）。 */
const EXPIRY_CHOICES = [0, 1, 7, 30, 90, 365] as const;

/**
 * 复制到剪贴板。
 *
 * `navigator.clipboard` 只在安全上下文（HTTPS / localhost）可用，自建站点
 * 用 IP 直接访问时它是 undefined。那种情况下退回 `execCommand('copy')`：
 * 虽然已废弃，但它是唯一在没有权限 API 的环境里还能工作的办法。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒也继续走降级路径。
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function ShareDialog({ open, mapUid, mapTitle, onClose }: ShareDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { config } = useSiteConfig();

  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(String(config.shareDefaultExpireDays ?? 7));
  const [allowDownload, setAllowDownload] = useState(config.shareDefaultAllowDownload ?? false);
  const [showNotes, setShowNotes] = useState(false);
  const [created, setCreated] = useState<ShareLink | null>(null);
  const [revoking, setRevoking] = useState<ShareLink | null>(null);
  const [copiedUid, setCopiedUid] = useState<string | null>(null);
  const opened = useRef(false);
  const editedDefaults = useRef({ expiry: false, download: false });

  // 每次打开都按站点默认值重置：上次留在表单里的密码不该被复用。
  useEffect(() => {
    if (!open) {
      opened.current = false;
      editedDefaults.current = { expiry: false, download: false };
      return;
    }
    if (!opened.current) {
      opened.current = true;
      setPassword('');
      setShowNotes(false);
      setCreated(null);
      setRevoking(null);
      setCopiedUid(null);
    }
    // 配置可能比弹窗晚返回；只补齐尚未编辑的默认字段，不能重置用户草稿。
    if (!editedDefaults.current.expiry) setExpiresInDays(String(config.shareDefaultExpireDays ?? 7));
    if (!editedDefaults.current.download) setAllowDownload(config.shareDefaultAllowDownload ?? false);
  }, [open, config.shareDefaultExpireDays, config.shareDefaultAllowDownload]);

  const links = useQuery({
    queryKey: shareKeys.byMap(mapUid),
    queryFn: () => shareApi.listByMap(mapUid),
    enabled: open,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: shareKeys.root });
  };

  const create = useMutation({
    mutationFn: () =>
      shareApi.create(mapUid, {
        password: password.trim(),
        expiresInDays: Number(expiresInDays),
        allowDownload,
        showNotes,
      }),
    onSuccess: (link) => {
      setCreated(link);
      setPassword('');
      invalidate();
    },
    onError: () => {
      // 具体原因由下方 `createError` 渲染在字段旁边；这里不弹 toast，
      // 否则同一个错误会同时以两种形式出现在屏幕上。
    },
  });

  const revoke = useMutation({
    mutationFn: (uid: string) => shareApi.revoke(uid),
    onSuccess: () => {
      setRevoking(null);
      toast.success(t('share.revoked'));
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const createError = create.error ? fieldErrorsFrom(create.error) : {};

  const copy = async (link: ShareLink) => {
    const ok = await copyToClipboard(resolveShareUrl(link.url));
    if (!ok) {
      toast.error(t('share.copyFailed'));
      return;
    }
    setCopiedUid(link.uid);
    toast.success(t('share.copied'));
  };

  const items = useMemo(() => links.data ?? [], [links.data]);
  const expiryOptions = EXPIRY_CHOICES.map((days) => ({
    value: String(days),
    label: days === 0 ? t('share.expiry.forever') : t('share.expiry.days', { count: days }),
  }));

  return (
    <>
      <Modal open={open} title={t('share.title', { title: mapTitle })} size="lg" onClose={onClose}>
        <div className="space-y-6">
          {/* ── 新建 ─────────────────────────────────────────────── */}
          <section className="space-y-4 rounded-2xl border border-border/70 bg-muted/30 p-4">
            <h3 className="text-sm font-medium">{t('share.create.title')}</h3>

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t('share.create.password')}
                type="text"
                value={password}
                placeholder={t('share.create.passwordPlaceholder')}
                hint={t('share.create.passwordHint')}
                error={createError.password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <SelectField
                label={t('share.create.expiry')}
                value={expiresInDays}
                options={expiryOptions}
                error={createError.expiresInDays}
                onChange={(value) => { editedDefaults.current.expiry = true; setExpiresInDays(value); }}
              />
            </div>

            <div className="space-y-3">
              <Switch checked={allowDownload} onCheckedChange={(value) => { editedDefaults.current.download = true; setAllowDownload(value); }} label={t('share.create.allowDownload')} />
              <Switch checked={showNotes} onCheckedChange={setShowNotes} label={t('share.create.showNotes')} />
            </div>

            <div className="flex items-center gap-2">
              <Button loading={create.isPending} size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
                <Icon name="plus" className="mr-1.5 size-4" />
                {create.isPending ? t('share.create.submitting') : t('share.create.submit')}
              </Button>
              {create.error && Object.keys(createError).length === 0 ? (
                <span role="alert" className="text-xs text-destructive">{create.error.message}</span>
              ) : null}
            </div>

            {created ? (
              <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
                <p className="text-xs font-medium text-primary">{t('share.create.done')}</p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg bg-background px-2 py-1.5 text-xs">{resolveShareUrl(created.url)}</code>
                  <Button size="sm" variant="outline" onClick={() => void copy(created)}>
                    <Icon name="copy" className="mr-1.5 size-4" />
                    {copiedUid === created.uid ? t('share.copied') : t('share.copy')}
                  </Button>
                </div>
              </div>
            ) : null}
          </section>

          {/* ── 已有链接 ─────────────────────────────────────────── */}
          <section className="space-y-3">
            <h3 className="text-sm font-medium">{t('share.list.title', { count: items.length })}</h3>
            {links.isPending ? (
              <LoadingState small className="py-6" />
            ) : items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('share.list.empty')}</p>
            ) : (
              <ul className="space-y-2">
                {items.map((link) => (
                  <li key={link.uid} className="rounded-xl border border-border/70 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="min-w-0 flex-1 truncate text-xs">{resolveShareUrl(link.url)}</code>
                      {link.revokedAt ? <Badge>{t('share.badge.revoked')}</Badge> : null}
                      {link.hasPassword ? <Badge tone="primary">{t('share.badge.password')}</Badge> : null}
                      <Badge tone={link.revokedAt ? 'neutral' : 'success'}>
                        {link.expiresAt
                          ? t('share.badge.expires', { time: new Date(link.expiresAt).toLocaleDateString() })
                          : t('share.badge.forever')}
                      </Badge>
                      {!link.allowDownload ? <Badge>{t('share.badge.noDownload')}</Badge> : null}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><Icon name="eye" className="size-3.5" />{t('share.views', { count: link.viewCount })}</span>
                      <span>{t('share.createdAt', { time: new Date(link.createdAt).toLocaleString() })}</span>
                      <span className="flex-1" />
                      {!link.revokedAt ? (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => void copy(link)}>
                            <Icon name="copy" className="mr-1.5 size-3.5" />
                            {copiedUid === link.uid ? t('share.copied') : t('share.copy')}
                          </Button>
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setRevoking(link)}>
                            <Icon name="trash" className="mr-1.5 size-3.5" />
                            {t('share.revoke')}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </Modal>

      <ConfirmDialog
        open={revoking !== null}
        title={t('share.revokeConfirm.title')}
        description={t('share.revokeConfirm.body')}
        confirmLabel={t('share.revoke')}
        cancelLabel={t('common.cancel')}
        destructive
        pending={revoke.isPending}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.uid);
        }}
      />
    </>
  );
}
