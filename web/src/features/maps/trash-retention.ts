const DAY_MS = 24 * 60 * 60 * 1000;

/** null means the server did not supply a valid expiry; zero is already due. */
export function trashDaysRemaining(expiresAt: string | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return null;
  return Math.max(0, Math.ceil((expiry - now) / DAY_MS));
}
