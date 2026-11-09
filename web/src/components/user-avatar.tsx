import { useEffect, useState } from 'react';
import { avatarFallback, gravatarUrl, type AvatarUser } from '@/lib/avatar';
import { cn } from '@/lib/utils';
import { LoadingImage } from '@/components/ui/loading-image';

/**
 * `src` 强制指定头像并跳过 gravatar：本地用户没有真实邮箱，去查 gravatar
 * 既无意义又是一次多余的外网请求。
 */
export function UserAvatar({ user, className, src }: { user: AvatarUser; className?: string; src?: string }) {
  const email = user.email.trim().toLowerCase();
  const [gravatar, setGravatar] = useState<{ email: string; url: string | null } | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => {
    if (src) return undefined;
    let current = true;
    void gravatarUrl(email).then((url) => {
      if (current) setGravatar({ email, url });
    }).catch(() => { if (current) setGravatar({ email, url: null }); });
    return () => { current = false; };
  }, [email, src]);
  const fallback = avatarFallback(user);
  const source = [src, user.avatarUrl?.trim(), gravatar?.email === email ? gravatar.url : null]
    .find((url): url is string => !!url && !failed.includes(url));

  return <span aria-hidden="true" data-user-avatar={user.uid}
    className={cn('relative inline-grid size-8 shrink-0 place-items-center overflow-hidden rounded-full align-middle text-sm font-medium text-white ring-1 ring-black/5', className)}
    style={{ backgroundColor: fallback.background }}>
    <span>{fallback.initial}</span>
    {source ? <LoadingImage key={source} src={source} alt="" referrerPolicy="no-referrer" containerClassName="absolute inset-0 size-full bg-muted" className="size-full object-cover"
      onError={() => setFailed((urls) => urls.includes(source) ? urls : [...urls, source])} /> : null}
  </span>;
}
