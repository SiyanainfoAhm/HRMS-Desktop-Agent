import { isTauri } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

const OPT_OUT_KEY = "hrms.autostartOptOut";

export function getAutostartOptOut(): boolean {
  return localStorage.getItem(OPT_OUT_KEY) === "1";
}

function setAutostartOptOut(optOut: boolean): void {
  if (optOut) localStorage.setItem(OPT_OUT_KEY, "1");
  else localStorage.removeItem(OPT_OUT_KEY);
}

/**
 * Registers the app to launch at OS login (Windows / macOS / Linux), unless the
 * user turned it off in this app (opt-out in localStorage).
 */
export async function ensureAutostartUnlessOptOut(): Promise<void> {
  if (!isTauri()) return;
  if (getAutostartOptOut()) return;
  try {
    await enable();
  } catch (e) {
    console.warn("[Autostart] enable failed:", e);
  }
}

export async function getLaunchAtLoginEnabled(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await isEnabled();
  } catch {
    return false;
  }
}

export async function setLaunchAtLoginEnabled(next: boolean): Promise<void> {
  if (!isTauri()) return;
  if (next) {
    await enable();
    setAutostartOptOut(false);
  } else {
    await disable();
    setAutostartOptOut(true);
  }
}

export { isTauri };
