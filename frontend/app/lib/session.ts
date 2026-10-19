export type SessionUser = { id: number; name: string; email: string; role: "rider" | "driver" };

const TOKEN_KEY = "zoomo_token";
const USER_KEY = "zoomo_user";

function migrateValue(key: string, legacyKey: string): string | null {
  const current = localStorage.getItem(key);
  const legacy = localStorage.getItem(legacyKey);
  if (!current && legacy) localStorage.setItem(key, legacy);
  localStorage.removeItem(legacyKey);
  return current || legacy;
}

export function readSessionToken(): string | null {
  return migrateValue(TOKEN_KEY, "cabby_token");
}

export function readSessionUser(): SessionUser | null {
  const cached = migrateValue(USER_KEY, "cabby_user");
  if (!cached) return null;
  try { return JSON.parse(cached) as SessionUser; } catch {
    localStorage.removeItem(USER_KEY);
    return null;
  }
}

export function saveSession(token: string, user: SessionUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem("cabby_token");
  localStorage.removeItem("cabby_user");
}
