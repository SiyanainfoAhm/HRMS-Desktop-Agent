import type { SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_SCREENSHOT_INTERVAL_SECONDS = 300;
export const AGENT_SETTINGS_POLL_INTERVAL_MS = 60_000;

const ALLOWED_SCREENSHOT_INTERVALS = new Set([300, 180, 60, 30]);
const ALLOWED_MIN_INTERVALS = new Set([60, 30]);

export type AgentSettingsRow = {
  screenshot_interval_seconds: number;
  min_allowed_interval_seconds: number;
  is_active: boolean;
};

export type ResolvedAgentScreenshotSettings = {
  effectiveIntervalSeconds: number;
  source: "default" | "db" | "inactive";
};

export function resolveEffectiveScreenshotIntervalSeconds(
  row: AgentSettingsRow | null,
): ResolvedAgentScreenshotSettings {
  if (!row) {
    console.log("[Agent] Missing setting, using default 300 seconds");
    return { effectiveIntervalSeconds: DEFAULT_SCREENSHOT_INTERVAL_SECONDS, source: "default" };
  }

  if (!row.is_active) {
    console.log("[Agent] Agent settings inactive, using default 300 seconds");
    return { effectiveIntervalSeconds: DEFAULT_SCREENSHOT_INTERVAL_SECONDS, source: "inactive" };
  }

  const screenshot = Number(row.screenshot_interval_seconds);
  const minAllowed = Number(row.min_allowed_interval_seconds);

  if (!ALLOWED_SCREENSHOT_INTERVALS.has(screenshot)) {
    console.warn("[Agent] Invalid setting, using fallback 300 seconds", {
      screenshot_interval_seconds: row.screenshot_interval_seconds,
    });
    return { effectiveIntervalSeconds: DEFAULT_SCREENSHOT_INTERVAL_SECONDS, source: "default" };
  }

  const min =
    ALLOWED_MIN_INTERVALS.has(minAllowed) && minAllowed === 30
      ? 30
      : ALLOWED_MIN_INTERVALS.has(minAllowed)
        ? minAllowed
        : 60;

  const effectiveIntervalSeconds = Math.max(screenshot, min);

  return { effectiveIntervalSeconds, source: "db" };
}

export async function fetchCompanyAgentSettings(
  sb: SupabaseClient,
  companyId: string,
): Promise<AgentSettingsRow | null> {
  if (!companyId) {
    console.warn("[Agent] Cannot load agent settings without company_id");
    return null;
  }

  const { data, error } = await sb
    .from("HRMS_agent_settings")
    .select("screenshot_interval_seconds, min_allowed_interval_seconds, is_active")
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    console.warn("[Agent] Failed to load HRMS_agent_settings:", error.message);
    return null;
  }

  return (data as AgentSettingsRow | null) ?? null;
}

export async function loadEffectiveScreenshotIntervalSeconds(
  sb: SupabaseClient,
  companyId: string,
): Promise<ResolvedAgentScreenshotSettings> {
  const row = await fetchCompanyAgentSettings(sb, companyId);
  return resolveEffectiveScreenshotIntervalSeconds(row);
}
