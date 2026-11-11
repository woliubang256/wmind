/**
 * 本地 MCP 服务管理（桌面端）。
 *
 * AI 客户端（Claude Desktop 等）通过它读写**本机**导图：数据不出本机，也不
 * 依赖是否登录云端。开关、端口与密钥都存在本地设置里，改完立即生效。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { LoadingState } from '@/components/ui/loading-state';
import { PageHeader } from '@/components/ui/panel';
import { Panel } from '@/components/ui/panel';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/input';
import { fetchMcpStatus, saveMcpSettings, type McpStatus } from '@/lib/desktop';
import { useQuery, useQueryClient } from '@tanstack/react-query';

const mcpKeys = { status: ['desktop', 'mcp'] as const };

export function McpPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: mcpKeys.status, queryFn: fetchMcpStatus });
  const [port, setPort] = useState('');
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (status.data) setPort(String(status.data.port));
  }, [status.data]);

  const apply = async (input: { enabled?: boolean; transport?: 'stdio' | 'http'; port?: number; regenerate?: boolean }) => {
    setSaving(true);
    try {
      const next = await saveMcpSettings(input);
      queryClient.setQueryData(mcpKeys.status, next);
      setRevealed(input.regenerate === true);
      toast.success(t('admin.mcp.saved'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('admin.mcp.saveFailed'));
      void status.refetch();
    } finally {
      setSaving(false);
    }
  };

  if (status.isPending) return <LoadingState className="min-h-64" />;
  if (status.isError || !status.data) {
    return <LoadingState label={t('admin.mcp.loadFailed')} className="min-h-64" />;
  }

  const data: McpStatus = status.data;
  const isStdio = data.transport !== 'http';
  const endpoint = data.url || `http://127.0.0.1:${data.port}/mcp`;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('admin.mcp.copied'));
    } catch {
      toast.error(t('admin.mcp.copyFailed'));
    }
  };

  // MCP 客户端（Claude Desktop 等）要的是一段可粘贴的 JSON 配置。
  // stdio：客户端按 command 拉起子进程；http：给地址与令牌。
  const connectionSnippet = JSON.stringify(
    {
      mcpServers: {
        wmind: isStdio
          // args 为空时省略：配置里只有一条不带空格的路径最不容易粘错。
          ? { command: data.command, ...(data.args.length > 0 ? { args: data.args } : {}) }
          : { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${data.token}` } },
      },
    },
    null,
    2,
  );

  return (
    <div className="space-y-5">
      <PageHeader title={t('admin.mcp.title')} description={t('admin.mcp.description')} />

      <Panel title={t('admin.mcp.serverSection')}>
        <div className="space-y-4">
          <Switch
            checked={data.enabled}
            disabled={saving}
            label={t('admin.mcp.enable')}
            description={t('admin.mcp.enableHint')}
            onCheckedChange={(checked) => void apply({ enabled: checked, port: Number(port) || data.port })}
          />

          <div className="space-y-2">
            <p className="text-sm font-medium">{t('admin.mcp.transport')}</p>
            <div className="flex gap-2">
              {(['stdio', 'http'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={saving}
                  aria-pressed={data.transport === option}
                  onClick={() => void apply({ transport: option, enabled: data.enabled, port: Number(port) || data.port })}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${data.transport === option ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border text-muted-foreground hover:bg-accent'}`}
                >
                  {option === 'stdio' ? t('admin.mcp.transportStdio') : t('admin.mcp.transportHttp')}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{isStdio ? t('admin.mcp.transportStdioHint') : t('admin.mcp.transportHttpHint')}</p>
          </div>

          {isStdio ? null : <div className="flex flex-wrap items-end gap-3">
            <TextField
              label={t('admin.mcp.port')}
              value={port}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPort(event.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              className="w-32"
            />
            <Button
              variant="outline"
              disabled={saving || port === String(data.port)}
              onClick={() => void apply({ port: Number(port), enabled: data.enabled })}
            >
              {t('common.save')}
            </Button>
            <span className="pb-2 text-xs text-muted-foreground">{t('admin.mcp.portHint')}</span>
          </div>}

          {isStdio ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('admin.mcp.endpoint')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
                  {[data.command, ...data.args].join(' ')}
                </code>
                <Button variant="outline" size="sm" onClick={() => void copy([data.command, ...data.args].join(' '))}>
                  <Icon name="copy" className="size-4" />
                  {t('common.copy')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('admin.mcp.stdioNote')}</p>
            </div>
          ) : (
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

          )}

          {isStdio ? null : <div className="space-y-2">
            <p className="text-sm font-medium">{t('admin.mcp.token')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
                {data.token ? (revealed ? data.token : '•'.repeat(Math.min(32, data.token.length))) : t('admin.mcp.tokenEmpty')}
              </code>
              <Button variant="outline" size="sm" disabled={!data.token} onClick={() => setRevealed((value) => !value)}>
                <Icon name={revealed ? 'eye-off' : 'eye'} className="size-4" />
                {revealed ? t('admin.mcp.hide') : t('admin.mcp.show')}
              </Button>
              <Button variant="outline" size="sm" disabled={saving} onClick={() => void apply({ regenerate: true })}>
                {t('admin.mcp.regenerate')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('admin.mcp.tokenHint')}</p>
          </div>}

          <div className="flex flex-wrap gap-2">
            <Button disabled={!data.enabled || (!isStdio && !data.token)} onClick={() => void copy(connectionSnippet)}>
              <Icon name="clipboard-list" className="size-4" />
              {t('admin.mcp.copyConfig')}
            </Button>
          </div>
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
