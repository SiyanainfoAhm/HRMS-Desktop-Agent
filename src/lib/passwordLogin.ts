import type { SessionUser } from "./session";
import { getSupabase } from "./supabase";

type LoginPayload = {
  id?: unknown;
  email?: unknown;
  name?: unknown;
  role?: unknown;
  authProvider?: unknown;
  auth_provider?: unknown;
  companyId?: unknown;
  company_id?: unknown;
  agentToken?: unknown;
  agent_token?: unknown;
  user?: LoginPayload;
  data?: LoginPayload;
  error?: unknown;
  message?: unknown;
};

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
    agentToken: typeof payload.agentToken === "string"
      ? payload.agentToken
      : typeof payload.agent_token === "string"
        ? payload.agent_token
        : null,
  };
}

/**
 * Authenticates directly with the Supabase Edge Function. Password hash lookup
 * and verification happen only inside the function, never in the desktop app.
 */
export async function loginWithEmailPassword(email: string, password: string): Promise<SessionUser> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !password) throw new Error("Email and password required");

  const { data, error } = await getSupabase().functions.invoke("desktop-agent-auth", {
    body: {
      action: "login",
      email: normalized,
      password,
      deviceName: navigator.platform || null,
      appVersion: (import.meta as any).env?.VITE_APP_VERSION ?? null,
    },
  });
  if (error) throw new Error("Could not reach the HRMS desktop authentication service. Please try again.");

  const payload = data as LoginPayload | null;
  const serverMessage = messageFrom(payload);
  if (serverMessage) throw new Error(serverMessage);
  if (!payload) throw new Error("HRMS web returned an invalid login response.");
  return toSessionUser(payload, normalized);
}
