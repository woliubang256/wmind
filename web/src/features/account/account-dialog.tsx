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
import { mapKeys } from '@/features/maps/queries';
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
  verifyCloudTwoFactor,
} from '@/lib/desktop';

export function AccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverUrl, setServerUrl] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  // 两步验证：密码通过后进入这一步，提交动态码或恢复码。
  const [twoFactor, setTwoFactor] = useState(false);
  const [code, setCode] = useState('');

  const status = useQuery({
    queryKey: ['desktop', 'status'],
    queryFn: fetchDesktopStatus,
    enabled: open,
    staleTime: 2_000,
  });

  // 关闭时清掉密码与动态码：弹窗反复开关不该留着明文。
  useEffect(() => {
    if (open) return;
    setPassword('');
    setCode('');
    setTwoFactor(false);
  }, [open]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['desktop'] });
  };

  /**
   * 连接成功后的首次同步。
   *
   * 放在**前端异步触发**而不是登录响应里：首次同步要拉全部导图，几秒到几十
   * 秒，放在登录里会让按钮一直转（两步验证时尤其明显）。这里弹窗先关掉，
   * 同步完成后刷列表并给提示。
   */
  const syncAfterConnect = () => {
    void syncNow()
      .then((result) => {
        toast.success(t('desktop.sync.done', { pulled: result.Pulled, pushed: result.Pushed, deleted: result.Deleted }));
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t('desktop.sync.error'));
      })
      .finally(() => {
        void queryClient.invalidateQueries({ queryKey: mapKeys.lists() });
        void queryClient.invalidateQueries({ queryKey: ['desktop', 'map-sources'] });
        refresh();
      });
  };

  const connect = useMutation({
    mutationFn: () => connectCloud({ serverUrl: serverUrl.trim(), identifier: identifier.trim(), password }),
    onSuccess: (result) => {
      if (result.twoFactorRequired) {
        // 密码对了，但账号开了两步验证：切到动态码步骤，密码先留着用于
        // 验证通过后保存凭据（关掉弹窗会清掉）。
        setTwoFactor(true);
        return;
      }
      toast.success(t('desktop.cloud.connectSuccess'));
      setPassword('');
      onClose();
      refresh();
      syncAfterConnect();
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

  const verify = useMutation({
    mutationFn: () => verifyCloudTwoFactor(code.trim()),
    onSuccess: () => {
      toast.success(t('desktop.cloud.connectSuccess'));
      setCode('');
      setPassword('');
      setTwoFactor(false);
      onClose();
      refresh();
      syncAfterConnect();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t('desktop.account.twoFactorFailed')),
  });



  // 连接状态下「立即同步」：同步完成后必须刷导图列表，否则用户要切个页面才看得到。
  const sync = useMutation({
    mutationFn: syncNow,
    onSuccess: (result) => {
      toast.success(t('desktop.sync.done', { pulled: result.Pulled, pushed: result.Pushed, deleted: result.Deleted }));
      void queryClient.invalidateQueries({ queryKey: mapKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: ['desktop', 'map-sources'] });
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t('desktop.sync.error')),
  });

  const cloud = status.data?.cloud;
  const connected = cloud?.connected === true;

  // 登出后仍记住上次的服务器与账号：打开表单就预填，省得重敲。
  // 只在用户还没输入时填，避免覆盖正在编辑的内容。
  useEffect(() => {
    if (!open || connected) return;
    if (serverUrl === '' && cloud?.lastServerUrl) setServerUrl(cloud.lastServerUrl);
    if (identifier === '' && cloud?.lastIdentifier) setIdentifier(cloud.lastIdentifier);
  }, [open, connected, cloud?.lastServerUrl, cloud?.lastIdentifier, serverUrl, identifier]);

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
            {twoFactor ? (
              <Button
                type="submit"
                form="account-two-factor-form"
                loading={verify.isPending}
                disabled={code.trim() === ''}
              >
                {verify.isPending ? t('desktop.account.verifying') : t('desktop.account.verify')}
              </Button>
            ) : (
              <Button
                type="submit"
                form="account-connect-form"
                loading={connect.isPending}
                disabled={serverUrl.trim() === '' || identifier.trim() === '' || password === ''}
              >
                {connect.isPending ? t('desktop.cloud.connecting') : t('desktop.account.signIn')}
              </Button>
            )}
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
      ) : twoFactor ? (
        <form
          id="account-two-factor-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            verify.mutate();
          }}
        >
          <p className="text-sm text-muted-foreground">{t('desktop.account.twoFactorHint')}</p>
          <TextField
            label={t('desktop.account.twoFactorCode')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
          />
        </form>
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
