/** 头像显示规则：只派生默认值，不能覆盖已保存的手动头像。 */
export interface AvatarUser {
  uid: string;
  username: string;
  nickname?: string;
  email: string;
  avatarUrl?: string;
}

const BACKGROUNDS = ['#5b708d', '#7d6386', '#936653', '#567767', '#8b5d73', '#4b7891', '#826d40', '#5f6e85'];

export function avatarFallback(user: AvatarUser): { initial: string; background: string } {
  const name = user.nickname?.trim() || user.username.trim();
  const key = user.uid || user.email.trim().toLowerCase() || user.username;
  let hash = 0;
  for (const char of key) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0;
  return { initial: Array.from(name)[0]?.toLocaleUpperCase() || '?', background: BACKGROUNDS[hash % BACKGROUNDS.length] };
}

export async function gravatarUrl(email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `https://www.gravatar.com/avatar/${hash}?s=128&d=404&r=g`;
}
