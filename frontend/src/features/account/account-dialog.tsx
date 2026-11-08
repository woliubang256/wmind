/**
 * 账户弹窗（仅桌面端）。
 *
 * 桌面端没有登录页：点顶栏的账户头像就该直接弹出这里。两种状态：
 *
 * - **未连接**：填自托管地址 + 账号 + 密码，连上后本地导图可以上传云端。
 * - **已连接**：显示登录的账号与上次同步时间，可以立即同步，或退出登录回到
 *   本地用户（本地数据不受影响，只是断开云端）。
 *
 * 为什么不做注册 / 忘记密码 / 二次验证：这些都属于服务器侧的账号体系，
 * 桌面端连的是用户自己的自托管实例，直接在浏览器里管理账号更合适；本地模式
 * 本来就没有密码（本地用户是自动创建的）。
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { formatRelative } from '@/lib/format';
import {
  connectCloud,
  disconnectCloud,
  fetchDesktopStatus,
  syncNow,
} from '@/lib/desktop';

export function AccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverUrl, setServerUrl] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  const status = useQuery({
    queryKey: ['desktop', 'status'],
    queryFn: fetchDesktopStatus,
    enabled: open,
    staleTime: 2_000,
  });

  // 打开时清掉上一次的密码：弹窗反复开关不该留着明文。
  useEffect(() => {
    if (!open) setPassword('');
  }, [open]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['desktop'] });
  };

  const connect = useMutation({
    mutationFn: () => connectCloud({ serverUrl: serverUrl.trim(), identifier: identifier.trim(), password }),
    onSuccess: (result) => {
      toast.success(t('desktop.cloud.connectSuccess'));
      if (result.syncError) toast.error(result.syncError);
      setPassword('');
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t('desktop.cloud.connectError')),
  });

  const disconnect = useMutation({
    mutationFn: disconnectCloud,
    onSuccess: () => {
      toast.success(t('desktop.cloud.disconnectSuccess'));
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t('desktop.cloud.connectError')),
  });

  const sync = useMutation({
    mutationFn: syncNow,
    onSuccess: (result) => {
      toast.success(t('desktop.sync.done', { pulled: result.Pulled, pushed: result.Pushed, deleted: result.Deleted }));
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t('desktop.sync.error')),
  });

  const cloud = status.data?.cloud;
  const connected = cloud?.connected === true;

  return (
    <Modal
      open={open}
      title={t('desktop.account.title')}
      onClose={onClose}
      footer={
        connected ? (
          <>
            <Button variant="outline" loading={sync.isPending} onClick={() => sync.mutate()}>
              {t('desktop.sync.now')}
            </Button>
            <Button variant="outline" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
              {t('desktop.account.signOut')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              form="account-connect-form"
              loading={connect.isPending}
              disabled={serverUrl.trim() === '' || identifier.trim() === '' || password === ''}
            >
              {connect.isPending ? t('desktop.cloud.connecting') : t('desktop.account.signIn')}
            </Button>
          </>
        )
      }
    >
      {connected ? (
        <dl className="grid gap-2 text-sm">
          <div className="flex gap-2">
            <dt className="shrink-0 text-muted-foreground">{t('desktop.cloud.email')}</dt>
            <dd className="truncate font-medium">{cloud?.email || '—'}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-muted-foreground">{t('desktop.cloud.server')}</dt>
            <dd className="truncate">{cloud?.serverUrl}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-muted-foreground">{t('desktop.cloud.lastSync')}</dt>
            <dd>{cloud?.lastSyncedAt ? formatRelative(cloud.lastSyncedAt) : t('desktop.cloud.never')}</dd>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('desktop.account.signedInHint')}</p>
        </dl>
      ) : (
        <form
          id="account-connect-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            connect.mutate();
          }}
        >
          <p className="text-sm text-muted-foreground">{t('desktop.account.hint')}</p>
          <TextField
            label={t('desktop.cloud.server')}
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder={t('desktop.cloud.serverPlaceholder')}
            autoComplete="url"
            required
          />
          <TextField
            label={t('desktop.cloud.identifier')}
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder={t('desktop.cloud.identifierPlaceholder')}
            autoComplete="username"
            required
          />
          <TextField
            label={t('desktop.cloud.password')}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </form>
      )}
    </Modal>
  );
}
