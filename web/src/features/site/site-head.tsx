import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSiteConfig } from './use-site-config';

/**
 * 把站点名写进浏览器标题与 description。
 *
 * 放在应用根部而不是各个页面里：每个页面都写一遍 <title> 的话，
 * 一旦某个页面忘了写，标签页就会退回 index.html 里那个写死的 "wmind"，
 * 自托管实例的站点名就白设了。
 */
export function SiteHead() {
  const { config } = useSiteConfig();
  const { t, i18n } = useTranslation();

  // 语言进依赖：切语言后标题里的「思维导图」要跟着换，否则标签页会一直停在
  // 切换前的那一种。`config.siteName` 是用户数据，不翻译。
  useEffect(() => {
    document.title = `${config.siteName} · ${t('site.titleSuffix')}`;
    if (config.description) {
      document.querySelector('meta[name="description"]')?.setAttribute('content', config.description);
    }
  }, [config.siteName, config.description, t, i18n.language]);

  return null;
}
