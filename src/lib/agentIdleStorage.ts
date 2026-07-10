/** Persist UI idle minutes across app restarts (same as session: localStorage). */

const PREFIX = "hrms.agentIdleMinutes.";

function key(userId: string, workDateYmd: string): string {
  return `${PREFIX}${userId}.${workDateYmd}`;
}

export function loadIdleMinutes(userId: string, workDateYmd: string): number {
  if (!userId || !workDateYmd) return 0;
  try {
    const raw = localStorage.getItem(key(userId, workDateYmd));
    if (raw == null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  } catch {
    return 0;
  }
}

export function saveIdleMinutes(userId: string, workDateYmd: string, minutes: number): void {
  if (!userId || !workDateYmd) return;
  try {
    localStorage.setItem(key(userId, workDateYmd), String(Math.max(0, Math.round(minutes))));
  } catch {
    // quota / private mode
  }
}
