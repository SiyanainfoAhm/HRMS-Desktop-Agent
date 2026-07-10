import bcrypt from "bcryptjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "./session";

type UserRow = {
  id: string;
  email: string;
  password_hash: string | null;
  name: string | null;
  role: string;
  auth_provider: string | null;
  company_id: string | null;
};

/**
 * Password login aligned with hrms-web `src/app/api/auth/login` and `src/lib/users.ts`:
 * lookup by normalized email, Google-only accounts rejected, bcrypt password check.
 */
export async function loginWithEmailPassword(
  sb: SupabaseClient,
  email: string,
  password: string
): Promise<SessionUser> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !password) {
    throw new Error("Email and password required");
  }

  const { data, error } = await sb
    .from("HRMS_users")
    .select("id, email, password_hash, name, role, auth_provider, company_id")
    .eq("email", normalized)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Login failed");
  }
  if (!data) {
    throw new Error("Invalid email or password");
  }

  const row = data as UserRow;
  const authProvider = row.auth_provider ?? "password";
  if (authProvider !== "password") {
    throw new Error("This account uses Google sign-in. Please continue with Google.");
  }

  if (!row.password_hash || !(await bcrypt.compare(password, row.password_hash))) {
    throw new Error("Invalid email or password");
  }

  return {
    id: String(row.id),
    email: String(row.email || ""),
    role: String(row.role || "employee"),
    name: row.name != null ? String(row.name) : null,
    authProvider: "password",
    companyId: row.company_id ? String(row.company_id) : null,
  };
}
