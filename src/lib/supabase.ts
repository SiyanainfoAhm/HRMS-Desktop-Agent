import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requiredEnv(name: string): string {
  const v = (import.meta as any).env?.[name] as string | undefined;
  if (!v) throw new Error(`Missing env ${name}. Create a .env file (see .env.example).`);
  return v;
}

export function getSupabase(): SupabaseClient {
  const url = requiredEnv("VITE_SUPABASE_URL");
  const anonKey = requiredEnv("VITE_SUPABASE_ANON_KEY");
  return createClient(url, anonKey, {
    auth: {
      // HRMS mobile/web uses custom HRMS auth (RPC), not Supabase Auth session.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

