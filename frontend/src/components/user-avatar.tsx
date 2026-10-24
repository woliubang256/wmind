import { useEffect, useState } from 'react';
import { avatarFallback, gravatarUrl, type AvatarUser } from '@/lib/avatar';
import { cn } from '@/lib/utils';
import { LoadingImage } from '@/components/ui/loading-image';

export function UserAvatar({ user, className }: { user: AvatarUser; className?: string }) {
  const email = user.email.trim().toLowerCase();
  const [gravatar, setGravatar] = useState<{ email: string; url: string | null } | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    void gravatarUrl(email).then((url) => {
      if (current) setGravatar({ email, url });
    }).catch(() => { if (current) setGravatar({ email, url: null }); });
    return () => { current = false; };
  }, [email]);
  const fallback = avatarFallback(user);
  const source = [user.avatarUrl?.trim(), gravatar?.email === email ? gravatar.url : null]
    .find((url): url is string => !!url && !failed.includes(url));

  return <span aria-hidden="true" data-user-avatar={user.uid}
    className={cn('relative inline-grid size-8 shrink-0 place-items-center overflow-hidden rounded-full align-middle text-sm font-medium text-white ring-1 ring-black/5', className)}
    style={{ backgroundColor: fallback.background }}>
    <span>{fallback.initial}</span>
    {source ? <LoadingImage key={source} src={source} alt="" referrerPolicy="no-referrer" containerClassName="absolute inset-0 size-full bg-muted" className="size-full object-cover"
      onError={() => setFailed((urls) => urls.includes(source) ? urls : [...urls, source])} /> : null}
  </span>;
}
