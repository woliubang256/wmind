import { useEffect } from 'react';
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

  useEffect(() => {
    document.title = `${config.siteName} · 思维导图`;
    if (config.description) {
      document.querySelector('meta[name="description"]')?.setAttribute('content', config.description);
    }
  }, [config.siteName, config.description]);

  return null;
}
