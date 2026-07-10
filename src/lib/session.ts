export type SessionUser = {
  id: string;
  email: string;
  role: string;
  name: string | null;
  authProvider: string;
  companyId: string | null;
};

const KEY = "hrms.sessionUser";

export function loadSessionUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function saveSessionUser(u: SessionUser | null) {
  if (!u) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(u));
}

