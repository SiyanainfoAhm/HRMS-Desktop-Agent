import type { SessionUser } from "./session";
import { invoke, isTauri } from "@tauri-apps/api/core";

type LoginPayload = {
  id?: unknown;
  email?: unknown;
  name?: unknown;
  role?: unknown;
  authProvider?: unknown;
  auth_provider?: unknown;
  companyId?: unknown;
  company_id?: unknown;
  user?: LoginPayload;
  data?: LoginPayload;
  error?: unknown;
  message?: unknown;
};

function webBaseUrl(): string {
  const raw = (import.meta as any).env?.VITE_HRMS_WEB_URL as string | undefined;
  const base = raw?.trim().replace(/\/$/, "");
  if (!base) throw new Error("Missing VITE_HRMS_WEB_URL. Set it to the HRMS web app URL.");
  return base;
}

function messageFrom(payload: LoginPayload | null): string | null {
  if (!payload) return null;
  const value = payload.error ?? payload.message;
  return typeof value === "string" && value.trim() ? value : null;
}

function toSessionUser(payload: LoginPayload, submittedEmail: string): SessionUser {
  // The web endpoint may wrap the user in either `user` or `data`.
  const row = payload.user ?? payload.data ?? payload;
  if (!row.id) throw new Error("HRMS web returned an invalid login response.");

  const authProvider = String(row.authProvider ?? row.auth_provider ?? "password");
  if (authProvider !== "password") {
    throw new Error("This account uses Google sign-in. Please continue with Google.");
  }

  return {
    id: String(row.id),
    email: String(row.email ?? submittedEmail),
    role: String(row.role ?? "employee"),
    name: row.name == null ? null : String(row.name),
    authProvider,
    companyId: row.companyId ?? row.company_id ? String(row.companyId ?? row.company_id) : null,
  };
}

async function requestWebLogin(email: string, password: string): Promise<{ status: number; payload: LoginPayload | null }> {
  const baseUrl = webBaseUrl();

  if (isTauri()) {
    const nativeResponse = await invoke<{ status: number; body: string }>("login_with_hrms_web", {
      request: { baseUrl, email, password },
    });
    return {
      status: nativeResponse.status,
      payload: JSON.parse(nativeResponse.body) as LoginPayload,
    };
  }

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return {
    status: response.status,
    payload: (await response.json().catch(() => null)) as LoginPayload | null,
  };
}

/**
 * Uses the HRMS web login API, so the desktop agent uses exactly the same
 * password validation and account rules as HRMS web/mobile. Do not query
 * `HRMS_users` from the client: that would expose password hashes and defeat RLS.
 */
export async function loginWithEmailPassword(email: string, password: string): Promise<SessionUser> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !password) throw new Error("Email and password required");

  let result: { status: number; payload: LoginPayload | null };
  try {
    result = await requestWebLogin(normalized, password);
  } catch {
    throw new Error("Could not reach HRMS web. Check VITE_HRMS_WEB_URL and your connection.");
  }

  const payload = result.payload;
  if (result.status < 200 || result.status >= 300) {
    throw new Error(messageFrom(payload) ?? "Invalid email or password");
  }
  if (!payload) throw new Error("HRMS web returned an invalid login response.");
  return toSessionUser(payload, normalized);
}
