/**
 * 桌面端的「网站设置」：在客户端内嵌加载**服务器自己的**管理界面。
 *
 * 不做一套桌面专用的远程设置表单：服务器已经有一份完整、随版本演进的管理
 * 后台，抄一份到客户端里，两边迟早在字段和校验上分叉。
 *
 * 页面来自本机回环代理（`/desktop/status` 里的 `cloud.remoteUrl`），代理负责
 * 注入令牌、改写 cookie、去掉禁止嵌入的响应头——详见 Go 侧 remoteproxy 包。
 */

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import { fetchDesktopStatus } from '@/lib/desktop';
import { useQuery } from '@tanstack/react-query';

export function RemoteSettingsPage() {
  const { t } = useTranslation();
  const status = useQuery({ queryKey: ['desktop', 'status'], queryFn: fetchDesktopStatus, staleTime: 5_000 });
  const remote = status.data?.cloud.connected ? status.data?.cloud.remoteUrl : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {remote ? (
        <iframe
          key={remote}
          src={`${remote}/admin/settings`}
          title={t('desktop.siteSettings.title')}
          className="size-full flex-1 rounded-lg border border-border bg-background"
        />
      ) : (
        <div className="grid flex-1 place-items-center">
          <LoadingState
            tone="soft"
            className="max-w-sm text-center"
            label={status.isPending ? undefined : t('desktop.siteSettings.unavailable')}
          />
        </div>
      )}
    </div>
  );
}

/** 供菜单使用的「在浏览器打开」兜底按钮（内嵌失败时的出口）。 */
export function OpenSiteSettingsButton({ url }: { url: string }) {
  const { t } = useTranslation();
  return (
    <Button variant="outline" onClick={() => window.open(url, '_blank', 'noopener')}>
      {t('desktop.siteSettings.openExternal')}
    </Button>
  );
}
