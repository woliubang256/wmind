/**
 * 站点级 MCP 设置（网站设置 → MCP）。
 *
 * 与桌面端的本地 MCP 不同：这里开启的是**服务器**上的 MCP 端点，AI 客户端
 * 用密钥访问 `https://站点/mcp`，操作范围限定在「开启它的那个管理员」自己的
 * 导图。密钥存在站点设置里，管理员可随时查看、复制与轮换。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Panel } from '@/components/ui/panel';
import { Switch } from '@/components/ui/switch';
import { adminKeys } from './queries';
import { adminApi } from '@/lib/api/endpoints';
import type { SettingsMap } from '@/lib/api/types';
import { useCurrentUser } from '@/app/auth';

/** 生成 32 字节随机令牌（与服务端一致：十六进制 64 位）。 */
function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function McpSettingsSection({ base, serverOrigin }: { base?: string; serverOrigin: string }) {
  const { t } = useTranslation();
  const { data: user } = useCurrentUser();
  const settings = useQuery({
    queryKey: [...adminKeys.settings, base ?? 'local'],
    queryFn: () => adminApi.getSettings(base),
  });
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [token, setToken] = useState('');

  useEffect(() => {
    const value = settings.data?.['mcp.token'];
    setToken(typeof value === 'string' ? value : '');
  }, [settings.data]);

  const enabled = settings.data?.['mcp.enabled'] === true;
  const endpoint = `${serverOrigin.replace(/\/$/, '')}/mcp`;

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      await adminApi.updateSettings(patch as SettingsMap, base);
      await settings.refetch();
      toast.success(t('admin.mcp.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('admin.mcp.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('admin.mcp.copied'));
    } catch {
      toast.error(t('admin.mcp.copyFailed'));
    }
  };

  const toggle = (checked: boolean) => {
    // 开启时若还没有密钥就顺手生成一个，并把操作身份记成当前管理员——
    // 工具以他的权限执行，只能看到他自己的导图。
    if (checked) {
      const next = token || newToken();
      setToken(next);
      void save({ 'mcp.enabled': true, 'mcp.token': next, 'mcp.owner_uid': user?.uid ?? '' });
      return;
    }
    void save({ 'mcp.enabled': false });
  };

  const regenerate = () => {
    const next = newToken();
    setToken(next);
    setRevealed(true);
    void save({ 'mcp.token': next, 'mcp.owner_uid': user?.uid ?? '' });
  };

  const snippet = JSON.stringify(
    { mcpServers: { wmind: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );

  return (
    <div className="space-y-4">
      <Panel title={t('admin.mcp.serverSection')}>
        <div className="space-y-4">
          <Switch
            checked={enabled}
            disabled={saving || !settings.data}
            label={t('admin.mcp.enable')}
            description={t('admin.mcp.remoteEnableHint')}
            onCheckedChange={toggle}
          />

          <div className="space-y-2">
            <p className="text-sm font-medium">{t('admin.mcp.endpoint')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">{endpoint}</code>
              <Button variant="outline" size="sm" onClick={() => void copy(endpoint)}>
                <Icon name="copy" className="size-4" />
                {t('common.copy')}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t('admin.mcp.token')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
                {token ? (revealed ? token : '•'.repeat(Math.min(32, token.length))) : t('admin.mcp.tokenEmpty')}
              </code>
              <Button variant="outline" size="sm" disabled={!token} onClick={() => setRevealed((value) => !value)}>
                <Icon name={revealed ? 'eye-off' : 'eye'} className="size-4" />
                {revealed ? t('admin.mcp.hide') : t('admin.mcp.show')}
              </Button>
              <Button variant="outline" size="sm" disabled={saving} onClick={regenerate}>
                {t('admin.mcp.regenerate')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('admin.mcp.remoteTokenHint')}</p>
          </div>

          <Button disabled={!enabled || !token} onClick={() => void copy(snippet)}>
            <Icon name="clipboard-list" className="size-4" />
            {t('admin.mcp.copyConfig')}
          </Button>
        </div>
      </Panel>

      <Panel title={t('admin.mcp.toolsSection')}>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          {['list_maps', 'get_map', 'create_map', 'update_map_title', 'add_topic', 'update_topic', 'delete_topic'].map((tool) => (
            <li key={tool} className="flex gap-2">
              <code className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 text-xs text-foreground">{tool}</code>
              <span className="min-w-0">{t(`admin.mcp.tool.${tool}`)}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
