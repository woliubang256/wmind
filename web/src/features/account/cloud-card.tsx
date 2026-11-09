/**
 * 云端连接卡片（仅桌面端）。
 *
 * 本地模式默认不需要服务器；这张卡片是「想连服务器」时的唯一入口。三件事：
 * 填写自托管地址与账号、连接后看到上次同步时间、随时断开。
 *
 * 连接成功后壳会顺手同步一次；这里把结果显示出来，但**不把同步失败当成连接
 * 失败**——离线优先，用户可能只是此刻没网。
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { formatRelative } from '@/lib/format';
import {
  connectCloud,
  disconnectCloud,
  fetchDesktopStatus,
  syncNow,
} from '@/lib/desktop';

export function CloudCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [serverUrl, setServerUrl] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  const status = useQuery({
    queryKey: ['desktop', 'status'],
    queryFn: fetchDesktopStatus,
    staleTime: 5_000,
  });

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['desktop'] });
  };

  const connect = useMutation({
    mutationFn: () => connectCloud({ serverUrl: serverUrl.trim(), identifier: identifier.trim(), password }),
    onSuccess: (result) => {
      toast.success(t('desktop.cloud.connectSuccess'));
      if (result.syncError) toast.error(result.syncError);
      setPassword('');
      refreshAll();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t('desktop.cloud.connectError')),
  });

  const disconnect = useMutation({
    mutationFn: disconnectCloud,
    onSuccess: () => {
      toast.success(t('desktop.cloud.disconnectSuccess'));
      refreshAll();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t('desktop.cloud.connectError')),
  });

  const sync = useMutation({
    mutationFn: syncNow,
    onSuccess: (result) => {
      toast.success(
        t('desktop.sync.done', {
          pulled: result.Pulled,
          pushed: result.Pushed,
          deleted: result.Deleted,
        }),
      );
      refreshAll();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t('desktop.sync.error')),
  });

  const cloud = status.data?.cloud;
  const connected = cloud?.connected === true;

  return (
    <Panel title={t('desktop.cloud.title')} description={t('desktop.cloud.hint')} bodyClassName="p-5 sm:p-6">
      {connected ? (
        <div className="space-y-4">
          <dl className="grid gap-1 text-sm">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('desktop.cloud.server')}</dt>
              <dd className="truncate">{cloud?.serverUrl}</dd>
            </div>
            {cloud?.email ? (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">{t('desktop.cloud.email')}</dt>
                <dd className="truncate">{cloud.email}</dd>
              </div>
            ) : null}
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('desktop.cloud.lastSync')}</dt>
              <dd>{cloud?.lastSyncedAt ? formatRelative(cloud.lastSyncedAt) : t('desktop.cloud.never')}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" loading={sync.isPending} onClick={() => sync.mutate()}>
              {t('desktop.sync.now')}
            </Button>
            <Button variant="outline" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
              {t('desktop.cloud.disconnect')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            connect.mutate();
          }}
        >
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
          <Button
            type="submit"
            loading={connect.isPending}
            disabled={serverUrl.trim() === '' || identifier.trim() === '' || password === ''}
          >
            {connect.isPending ? t('desktop.cloud.connecting') : t('desktop.cloud.connect')}
          </Button>
        </form>
      )}
    </Panel>
  );
}
