import type { SupabaseClient } from "@supabase/supabase-js";
import { invoke } from "@tauri-apps/api/core";
import {
  canUserMarkAttendanceForUser,
  loadTodayLogForUser,
  workDateIST,
} from "./attendance";
import { markAgentAttendanceStateInactiveIfCurrent } from "./agentAttendanceState";
import {
  AGENT_SETTINGS_POLL_INTERVAL_MS,
  DEFAULT_SCREENSHOT_INTERVAL_SECONDS,
  loadEffectiveScreenshotIntervalSeconds,
} from "./agentSettings";
import {
  clearScreenshotPathLabelCache,
  uploadAttendanceScreenshotViaEdgeFunction,
  type CapturedMonitorScreenshotMeta,
  type UploadAttendanceScreenshotResult,
} from "./screenshotStorage";

const HEARTBEAT_INTERVAL_MS = 20_000;

// Default screenshot interval when DB settings are missing/inactive.
export const SCREENSHOT_INTERVAL_SECONDS = DEFAULT_SCREENSHOT_INTERVAL_SECONDS;
const IDLE_MAX_MS = 5 * 60 * 1000;
const ACTIVITY_SYNC_INTERVAL_MS = 20_000;

// Backup guard only. Realtime should stop lunch/tea immediately.
const ATTENDANCE_GUARD_INTERVAL_MS = 30_000;

type AttendanceStateStatus = "ACTIVE" | "LUNCH" | "BREAK" | "INACTIVE";

type TrackingController = {
  stop: () => void;
};

/**
 * Module-level singleton: React StrictMode / Sync / remount can call
 * `startAgentTracking` twice before the first controller is stored in a
 * ref. Without this guard, both runs keep heartbeat + screenshot timers
 * and insert duplicate screenshot/activity rows.
 */
let activeTrackingUserId: string | null = null;
let activeTrackingController: TrackingController | null = null;
let activeTrackingStartPromise: Promise<TrackingController> | null = null;
let activeTrackingGeneration = 0;

/**
 * Serializes activity-session ensure/create across ALL tracking runs so
 * StrictMode / Sync / remount cannot INSERT two open rows for one log.
 */
let activitySessionEnsureChain: Promise<void> = Promise.resolve();

const ACTIVITY_SESSION_STORAGE_PREFIX = "hrms.activitySessionId.";

function activitySessionStorageKey(attendanceLogId: string): string {
  return `${ACTIVITY_SESSION_STORAGE_PREFIX}${attendanceLogId}`;
}

function loadPersistedActivitySessionId(attendanceLogId: string): string | null {
  try {
    const id = localStorage.getItem(activitySessionStorageKey(attendanceLogId));
    return id && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

function persistActivitySessionId(attendanceLogId: string, sessionId: string): void {
  try {
    localStorage.setItem(activitySessionStorageKey(attendanceLogId), sessionId);
  } catch {
    // ignore
  }
}

function clearPersistedActivitySessionId(attendanceLogId: string | null): void {
  if (!attendanceLogId) return;
  try {
    localStorage.removeItem(activitySessionStorageKey(attendanceLogId));
  } catch {
    // ignore
  }
}

function extractAzureBlobUrl(uploadResult: UploadAttendanceScreenshotResult): string {
  const response = ((uploadResult as any).edgeFunctionResponse || uploadResult || {}) as any;

  const url =
    response.url ||
    response.blobUrl ||
    response.blob_url ||
    response.azureBlobUrl ||
    response.azure_blob_url ||
    response.publicUrl ||
    response.public_url ||
    response.data?.url ||
    response.data?.blobUrl ||
    response.data?.azureBlobUrl;

  if (!url || typeof url !== "string") {
    console.error("[Agent] Edge Function response:", response);

    throw new Error(
      "Azure upload succeeded, but no Azure Blob URL was returned. " +
      "Edge Function must return blobUrl or url.",
    );
  }

  return url;
}

function extractAzureContainer(uploadResult: UploadAttendanceScreenshotResult): string {
  const response = ((uploadResult as any).edgeFunctionResponse || uploadResult || {}) as any;

  return String(
    response.container ||
    response.azureContainer ||
    response.azure_container ||
    response.bucket ||
    "attendance",
  );
}

export async function startAgentTracking(
  sb: SupabaseClient,
  userId: string,
  opts?: { force?: boolean },
): Promise<TrackingController> {
  if (!userId) {
    return { stop: () => undefined };
  }

  const force = Boolean(opts?.force);

  if (
    !force &&
    activeTrackingController &&
    activeTrackingUserId === userId &&
    !activeTrackingStartPromise
  ) {
    console.debug(
      "[Agent] Tracking already active for this user. Skipping duplicate start.",
    );
    return activeTrackingController;
  }

  if (!force && activeTrackingStartPromise && activeTrackingUserId === userId) {
    console.debug(
      "[Agent] Tracking start already in flight for this user. Reusing promise.",
    );
    return activeTrackingStartPromise;
  }

  if (activeTrackingController) {
    console.debug("[Agent] Stopping previous tracking before starting a new run.");
    try {
      activeTrackingController.stop();
    } catch {
      // ignore
    }
    activeTrackingController = null;
    activeTrackingUserId = null;
  }

  // Drop a stale in-flight start when force-restarting.
  activeTrackingStartPromise = null;

  const generation = ++activeTrackingGeneration;
  activeTrackingUserId = userId;
  activeTrackingStartPromise = startAgentTrackingInner(sb, userId)
    .then((controller) => {
      if (generation !== activeTrackingGeneration) {
        console.debug("[Agent] Discarding superseded tracking start.");
        try {
          controller.stop();
        } catch {
          // ignore
        }
        return {
          stop: () => undefined,
        };
      }

      const wrapped: TrackingController = {
        stop: () => {
          try {
            controller.stop();
          } finally {
            if (activeTrackingController === wrapped) {
              activeTrackingController = null;
              activeTrackingUserId = null;
            }
          }
        },
      };
      activeTrackingController = wrapped;
      return wrapped;
    })
    .finally(() => {
      if (generation === activeTrackingGeneration) {
        activeTrackingStartPromise = null;
      }
    });

  return activeTrackingStartPromise;
}

async function startAgentTrackingInner(
  sb: SupabaseClient,
  userId: string,
): Promise<TrackingController> {
  let stopped = false;

  // Presence heartbeat should keep agent "connected" while app is running,
  // not only while the attendance state is ACTIVE.
  let presenceTimer: number | null = null;
  let presenceGate: { companyId: string; employeeId: string } | null = null;
  let heartbeatAttendanceLogId: string | null = null;
  let screenshotTimer: number | null = null;
  let agentSettingsPollTimer: number | null = null;
  let activityTimer: number | null = null;
  let attendanceGuardTimer: number | null = null;

  let channel: any = null;

  let currentSessionId: string | null = null;
  let currentSessionLogId: string | null = null;
  let lastActivitySyncAtMs = Date.now();
  /** True once ACTIVE activity sync timer has been wired for this run. */
  let trackingStarted = false;

  /**
   * Screenshot dedupe:
   * - Prevent concurrent uploads (slow network can overlap intervals)
   * - Prevent duplicate intervals if tracking is started twice
   */
  let screenshotInFlight = false;
  let lastScreenshotStoredAtMs = 0;
  let heartbeatInFlight = false;

  /**
   * Run guard:
   * Prevents old ACTIVE async flows from restarting timers after
   * LUNCH / BREAK / INACTIVE has already arrived.
   */
  let trackingRunId = 0;
  let desiredStatus: AttendanceStateStatus = "INACTIVE";
  let stateReconcileInFlight = false;

  let currentScreenshotIntervalSeconds = DEFAULT_SCREENSHOT_INTERVAL_SECONDS;

  type ScreenshotTimerContext = {
    runId: number;
    companyId: string;
    employeeId: string;
    attendanceLogId: string;
    workDate: string;
  };

  let screenshotTimerContext: ScreenshotTimerContext | null = null;

  function getScreenshotIntervalMs(): number {
    return currentScreenshotIntervalSeconds * 1000;
  }

  function clearScreenshotTimerOnly() {
    if (screenshotTimer != null) window.clearInterval(screenshotTimer);
    screenshotTimer = null;
  }

  function startScreenshotTimer() {
    clearScreenshotTimerOnly();
    const ctx = screenshotTimerContext;
    if (!ctx || !isCurrentActiveRun(ctx.runId)) return;

    const intervalMs = getScreenshotIntervalMs();
    screenshotTimer = window.setInterval(() => {
      if (!isCurrentActiveRun(ctx.runId)) return;

      void captureAllScreenshotsForInterval({
        runId: ctx.runId,
        companyId: ctx.companyId,
        employeeId: ctx.employeeId,
        attendanceLogId: ctx.attendanceLogId,
        workDate: ctx.workDate,
      }).catch((e) => {
        console.warn("[Agent] Screenshot upload failed:", e);
      });
    }, intervalMs);
  }

  async function refreshScreenshotIntervalFromDb(companyId: string, runId: number, isInitialLoad = false) {
    if (!companyId) {
      console.warn("[Agent] Cannot load agent settings without company_id");
      return;
    }

    const prev = currentScreenshotIntervalSeconds;
    const resolved = await loadEffectiveScreenshotIntervalSeconds(sb, companyId);
    const next = resolved.effectiveIntervalSeconds;

    if (isInitialLoad) {
      console.log(`[Agent] Loaded screenshot interval: ${next} seconds`);
    } else if (prev !== next) {
      console.log(`[Agent] Screenshot interval changed from ${prev} to ${next} seconds`);
    }

    currentScreenshotIntervalSeconds = next;

    if (prev !== next && isCurrentActiveRun(runId) && screenshotTimerContext) {
      startScreenshotTimer();
    }
  }

  function isCurrentActiveRun(runId: number): boolean {
    return !stopped && trackingRunId === runId && desiredStatus === "ACTIVE";
  }

  function clearTimers() {
    if (agentSettingsPollTimer != null) window.clearInterval(agentSettingsPollTimer);
    clearScreenshotTimerOnly();
    if (activityTimer != null) window.clearInterval(activityTimer);
    if (attendanceGuardTimer != null) window.clearInterval(attendanceGuardTimer);

    agentSettingsPollTimer = null;
    activityTimer = null;
    attendanceGuardTimer = null;
    screenshotTimerContext = null;

    screenshotInFlight = false;
    trackingStarted = false;
  }

  /**
   * Re-read HRMS_attendance_state and apply if the agent missed the initial row,
   * Realtime was not enabled on the table, or an update arrived before subscribe.
   */
  async function reconcileAttendanceStateIfStale(reason: string) {
    if (stopped || !presenceGate || stateReconcileInFlight) return;

    stateReconcileInFlight = true;

    try {
      const { data, error } = await sb
        .from("HRMS_attendance_state")
        .select("status")
        .eq("company_id", presenceGate.companyId)
        .eq("employee_id", presenceGate.employeeId)
        .maybeSingle();

      if (error) {
        console.warn("[Agent] Could not re-read HRMS_attendance_state:", error.message);
        return;
      }

      const raw = String((data as any)?.status ?? "").trim().toUpperCase();
      if (!raw) return;

      const st = raw as AttendanceStateStatus;
      if (!["ACTIVE", "LUNCH", "BREAK", "INACTIVE"].includes(st)) return;

      if (st === desiredStatus) return;

      console.log(
        `[Agent] HRMS_attendance_state out of sync (${reason}); applying "${st}" (agent had "${desiredStatus}").`,
      );

      await applyStatus(st);
    } finally {
      stateReconcileInFlight = false;
    }
  }

  async function sendHeartbeat(args: {
    companyId: string;
    employeeId: string;
    attendanceLogId: string | null;
  }) {
    if (heartbeatInFlight) {
      return;
    }

    heartbeatInFlight = true;

    try {
      const nowIso = new Date().toISOString();

      const deviceName = navigator.platform || null;

      const appVersion = (import.meta as any).env?.VITE_APP_VERSION
        ? String((import.meta as any).env.VITE_APP_VERSION)
        : null;

      console.log("[Agent] Sending heartbeat", {
        companyId: args.companyId,
        employeeId: args.employeeId,
        attendanceLogId: args.attendanceLogId,
        at: nowIso,
      });

      const { error } = await sb.from("HRMS_agent_heartbeat").upsert(
        {
          company_id: args.companyId,
          employee_id: args.employeeId,
          attendance_log_id: args.attendanceLogId,
          status: "ONLINE",
          last_seen_at: nowIso,
          app_version: appVersion,
          device_name: deviceName,
        } as any,
        {
          onConflict: "company_id,employee_id",
        },
      );

      if (error) {
        console.error("[Agent] Heartbeat failed:", error);
        return;
      }

      console.log("[Agent] Heartbeat sent", {
        companyId: args.companyId,
        employeeId: args.employeeId,
        attendanceLogId: args.attendanceLogId,
        at: nowIso,
      });

      if (currentSessionId) {
        const { error: sessionErr } = await sb
          .from("HRMS_activity_sessions")
          .update({
            last_heartbeat_at: nowIso,
          } as any)
          .eq("id", currentSessionId);

        if (sessionErr) {
          console.warn(
            "[Agent] Failed to update activity session heartbeat:",
            sessionErr.message,
          );
        }
      }
    } finally {
      heartbeatInFlight = false;

      if (!stopped && presenceGate) {
        void reconcileAttendanceStateIfStale("heartbeat");
      }
    }
  }

  async function isAttendanceLogStillOpen(attendanceLogId: string): Promise<boolean> {
    const { data, error } = await sb
      .from("HRMS_attendance_logs")
      .select("id, check_out_at")
      .eq("id", attendanceLogId)
      .maybeSingle();

    if (error) {
      console.warn("[Agent] Attendance log check failed:", error.message);
      return true;
    }

    if (!data) {
      console.warn("[Agent] Attendance log not found. Stopping monitoring.");
      return false;
    }

    const checkOutAt = (data as any).check_out_at;

    if (checkOutAt) {
      console.log("[Agent] Punch-out detected from HRMS_attendance_logs.check_out_at", {
        attendanceLogId,
        checkOutAt,
      });

      return false;
    }

    return true;
  }

  async function markAttendanceStateInactive(args: {
    companyId: string;
    employeeId: string;
    attendanceLogId: string | null;
  }) {
    const result = await markAgentAttendanceStateInactiveIfCurrent(sb, args);

    if (!result.ok) {
      console.warn("[Agent] Failed to mark attendance state INACTIVE:", result.error);
    }
  }

  async function stopMonitoringBecausePunchedOut(args: {
    companyId: string;
    employeeId: string;
    attendanceLogId: string;
  }) {
    desiredStatus = "INACTIVE";
    trackingRunId += 1;

    console.log("[Agent] User is punched out. Stopping monitoring completely.");

    clearTimers();

    await closeActivitySession();

    await markAttendanceStateInactive({
      companyId: args.companyId,
      employeeId: args.employeeId,
      attendanceLogId: args.attendanceLogId,
    });
  }

  async function stopMonitoringBecauseNoOpenAttendance(args: {
    companyId: string;
    employeeId: string;
  }) {
    desiredStatus = "INACTIVE";
    trackingRunId += 1;

    console.log("[Agent] No open attendance log found. Stopping monitoring completely.");

    clearTimers();

    await closeActivitySession();

    await markAttendanceStateInactive({
      companyId: args.companyId,
      employeeId: args.employeeId,
      attendanceLogId: null,
    });
  }

  async function captureAllScreenshotsForInterval(args: {
    runId: number;
    companyId: string;
    employeeId: string;
    attendanceLogId: string;
    workDate: string;
  }) {
    if (!isCurrentActiveRun(args.runId)) {
      console.log("[Agent] Screenshot skipped because tracking is not ACTIVE.");
      return;
    }

    if (screenshotInFlight) {
      console.log("[Agent] Screenshot skipped because previous upload is still running.");
      return;
    }

    const nowMs = Date.now();
    const cooldownMs = Math.max(0, getScreenshotIntervalMs() - 5_000);

    if (lastScreenshotStoredAtMs > 0 && nowMs - lastScreenshotStoredAtMs < cooldownMs) {
      console.log("[Agent] Screenshot skipped because interval cooldown is active.");
      return;
    }

    screenshotInFlight = true;

    try {
      try {
        const { data: lastRow, error: lastErr } = await sb
          .from("HRMS_activity_screenshots")
          .select("captured_at")
          .eq("company_id", args.companyId)
          .eq("employee_id", args.employeeId)
          .eq("attendance_log_id", args.attendanceLogId)
          .order("captured_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!lastErr && lastRow?.captured_at) {
          const lastMs = new Date(String((lastRow as any).captured_at)).getTime();
          if (Number.isFinite(lastMs) && nowMs - lastMs < cooldownMs) {
            lastScreenshotStoredAtMs = lastMs;
            console.log("[Agent] Screenshot skipped because DB shows a recent screenshot.", {
              secondsSinceLast: Math.round((nowMs - lastMs) / 1000),
            });
            return;
          }
        }
      } catch (e) {
        console.warn("[Agent] Failed to check last screenshot from DB:", e);
      }

      const stillOpen = await isAttendanceLogStillOpen(args.attendanceLogId);

      if (!isCurrentActiveRun(args.runId)) return;

      if (!stillOpen) {
        await stopMonitoringBecausePunchedOut({
          companyId: args.companyId,
          employeeId: args.employeeId,
          attendanceLogId: args.attendanceLogId,
        });

        return;
      }

      const lastActivityMs = (await invoke("get_last_activity_ms")) as number;

      if (!isCurrentActiveRun(args.runId)) return;

      const idleMs = Math.max(0, Date.now() - (Number(lastActivityMs) || 0));

      if (idleMs > IDLE_MAX_MS) {
        console.log("[Agent] Screenshot skipped because user is idle");
        return;
      }

      const shots = (await invoke("capture_all_screenshots", {
        trigger: "interval",
      })) as CapturedMonitorScreenshotMeta[];

      if (!isCurrentActiveRun(args.runId)) return;

      if (!Array.isArray(shots) || shots.length === 0) {
        console.warn("[Agent] Screenshot skipped: no monitor captures returned");
        return;
      }

      const firstShot = shots[0];
      const ts = typeof firstShot.at_ms === "number" ? firstShot.at_ms : Date.now();
      const capturedAtIso = new Date(ts).toISOString();
      const captureGroupId = firstShot.capture_group_id || crypto.randomUUID();

      console.log("[Agent] Screenshots captured", {
        monitorCount: shots.length,
        captureGroupId,
        capturedAt: capturedAtIso,
      });

      let storedCount = 0;

      for (const meta of shots) {
        if (!isCurrentActiveRun(args.runId)) return;

        if (!meta?.bytes_b64) {
          console.warn("[Agent] Skipping monitor with empty screenshot data", {
            screenIndex: meta?.screen_index,
          });
          continue;
        }

        try {
          const uploadResult = await uploadAttendanceScreenshotViaEdgeFunction({
            sb,
            companyId: args.companyId,
            employeeId: args.employeeId,
            workDateYmd: args.workDate,
            screenshot: {
              ...meta,
              at_ms: ts,
              content_type: meta.content_type || "image/jpeg",
            },
          });

          if (!isCurrentActiveRun(args.runId)) return;

          const azureBlobUrl = extractAzureBlobUrl(uploadResult);
          const azureContainer = extractAzureContainer(uploadResult);

          console.log("[Agent] Screenshot uploaded to Azure Blob", {
            screenIndex: meta.screen_index,
            screenName: meta.screen_name,
            container: azureContainer,
            url: azureBlobUrl,
          });

          /**
           * Preferred write shape:
           * - storage_path = Azure object key
           * - file_url = full Azure blob URL
           *
           * Fallback when `file_url` column is missing: store the full URL in
           * `storage_path` (what current Company Attendance already supports).
           */
          const objectKey =
            typeof (uploadResult as any)?.objectKey === "string" &&
            String((uploadResult as any).objectKey).trim()
              ? String((uploadResult as any).objectKey).trim()
              : null;

          const insertRow: Record<string, unknown> = {
            company_id: args.companyId,
            employee_id: args.employeeId,
            attendance_log_id: args.attendanceLogId,
            captured_at: capturedAtIso,
            created_at: capturedAtIso,
            trigger_type: meta.trigger || "interval",
            storage_bucket: azureContainer,
            storage_path: objectKey || azureBlobUrl,
            file_url: azureBlobUrl,
            idle_seconds: Math.round(idleMs / 1000),
            capture_group_id: meta.capture_group_id || captureGroupId,
            screen_index: meta.screen_index,
            screen_name: meta.screen_name,
            screen_width: meta.screen_width,
            screen_height: meta.screen_height,
            is_primary_screen: meta.is_primary_screen,
          };

          let { error: insErr } = await sb.from("HRMS_activity_screenshots").insert(insertRow as any);

          if (insErr && /file_url|column/i.test(String(insErr.message || ""))) {
            const legacyRow = {
              ...insertRow,
              storage_path: azureBlobUrl,
            };
            delete (legacyRow as any).file_url;
            const retry = await sb.from("HRMS_activity_screenshots").insert(legacyRow as any);
            insErr = retry.error;
          }

          if (insErr) {
            throw new Error(insErr.message);
          }

          storedCount += 1;
          console.log("[Agent] Screenshot record inserted", {
            screenIndex: meta.screen_index,
            captureGroupId: insertRow.capture_group_id,
          });
        } catch (e) {
          console.warn("[Agent] Monitor screenshot upload/insert failed:", {
            screenIndex: meta.screen_index,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (storedCount > 0) {
        lastScreenshotStoredAtMs = ts;
        console.log("[Agent] Screenshot interval complete", {
          storedCount,
          monitorCount: shots.length,
          captureGroupId,
        });
      } else {
        console.warn("[Agent] Screenshot interval produced no stored rows");
      }
    } finally {
      screenshotInFlight = false;
    }
  }

  async function startActivitySession(args: {
    companyId: string;
    employeeId: string;
    attendanceLogId: string;
  }) {
    const run = async () => {
      if (currentSessionId && currentSessionLogId === args.attendanceLogId) {
        await invoke("start_input_monitoring").catch(() => null);
        console.log("[Activity] Existing session reused", { id: currentSessionId });
        return;
      }

      if (currentSessionId && currentSessionLogId !== args.attendanceLogId) {
        console.warn("[Agent] Closing stale activity session before starting new one", {
          currentSessionId,
          currentSessionLogId,
          newAttendanceLogId: args.attendanceLogId,
        });
        await closeActivitySession().catch((e) => {
          console.warn("[Agent] Failed to close stale activity session:", e);
        });
      }

      lastActivitySyncAtMs = Date.now();
      await invoke("start_input_monitoring").catch(() => null);

      // 1) Persisted id from a prior agent run for this attendance log
      const persistedId = loadPersistedActivitySessionId(args.attendanceLogId);
      if (persistedId) {
        const { data: persistedRow } = await sb
          .from("HRMS_activity_sessions")
          .select("id, ended_at, attendance_log_id")
          .eq("id", persistedId)
          .maybeSingle();

        if (
          persistedRow?.id &&
          String((persistedRow as any).attendance_log_id) === args.attendanceLogId &&
          (persistedRow as any).ended_at == null
        ) {
          currentSessionId = String((persistedRow as any).id);
          currentSessionLogId = args.attendanceLogId;
          await sb
            .from("HRMS_activity_sessions")
            .update({ last_heartbeat_at: new Date().toISOString() } as any)
            .eq("id", currentSessionId);
          console.log("[Activity] Existing session reused", { id: currentSessionId });
          return;
        }

        clearPersistedActivitySessionId(args.attendanceLogId);
      }

      // 2) DB: any open row for this attendance_log_id
      const { data: existingOpenRows, error: existingErr } = await sb
        .from("HRMS_activity_sessions")
        .select("id")
        .eq("attendance_log_id", args.attendanceLogId)
        .is("ended_at", null)
        .order("started_at", { ascending: true })
        .limit(1);

      if (existingErr) {
        console.warn(
          "[Activity] Failed to look up existing open session:",
          existingErr.message,
        );
      }

      const existingOpen = Array.isArray(existingOpenRows) ? existingOpenRows[0] : null;
      if (existingOpen?.id) {
        currentSessionId = String((existingOpen as any).id);
        currentSessionLogId = args.attendanceLogId;
        persistActivitySessionId(args.attendanceLogId, currentSessionId);
        await sb
          .from("HRMS_activity_sessions")
          .update({ last_heartbeat_at: new Date().toISOString() } as any)
          .eq("id", currentSessionId);
        console.log("[Activity] Existing session reused", { id: currentSessionId });
        return;
      }

      // 3) Create exactly one row
      const nowIso = new Date().toISOString();
      const { data, error } = await sb
        .from("HRMS_activity_sessions")
        .insert({
          company_id: args.companyId,
          employee_id: args.employeeId,
          attendance_log_id: args.attendanceLogId,
          started_at: nowIso,
          active_seconds: 0,
          idle_seconds: 0,
          disconnected_seconds: 0,
          last_heartbeat_at: nowIso,
          source: "desktop_agent",
        } as any)
        .select("id")
        .single();

      if (error) {
        const { data: racedRows } = await sb
          .from("HRMS_activity_sessions")
          .select("id")
          .eq("attendance_log_id", args.attendanceLogId)
          .is("ended_at", null)
          .order("started_at", { ascending: true })
          .limit(1);

        const raced = Array.isArray(racedRows) ? racedRows[0] : null;
        if (raced?.id) {
          currentSessionId = String((raced as any).id);
          currentSessionLogId = args.attendanceLogId;
          persistActivitySessionId(args.attendanceLogId, currentSessionId);
          console.log("[Activity] Existing session reused", { id: currentSessionId });
          return;
        }

        console.error("[Activity] Session create failed:", error);
        throw new Error(error.message);
      }

      currentSessionId = String((data as any).id);
      currentSessionLogId = args.attendanceLogId;
      persistActivitySessionId(args.attendanceLogId, currentSessionId);
      console.log("[Activity] Session created", { id: currentSessionId });
    };

    // Module-level queue: only one ensure/create runs at a time process-wide.
    const waitFor = activitySessionEnsureChain;
    let release!: () => void;
    activitySessionEnsureChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await waitFor;
    try {
      await run();
    } finally {
      release();
    }
  }

  async function syncActivityCounters() {
    if (!currentSessionId) return;

    const now = Date.now();

    const deltaSeconds = Math.max(
      0,
      Math.round((now - lastActivitySyncAtMs) / 1000),
    );

    lastActivitySyncAtMs = now;

    if (deltaSeconds <= 0) return;

    const lastActivityMs = (await invoke("get_last_activity_ms")) as number;

    const idleMs = Math.max(0, now - (Number(lastActivityMs) || 0));
    const isIdle = idleMs >= IDLE_MAX_MS;

    const { data: current, error: readErr } = await sb
      .from("HRMS_activity_sessions")
      .select("active_seconds,idle_seconds")
      .eq("id", currentSessionId)
      .single();

    if (readErr) {
      console.warn("[Agent] Activity session read failed:", readErr.message);
      return;
    }

    const nextActive =
      Number((current as any)?.active_seconds ?? 0) +
      (isIdle ? 0 : deltaSeconds);

    const nextIdle =
      Number((current as any)?.idle_seconds ?? 0) +
      (isIdle ? deltaSeconds : 0);

    const { error: updateErr } = await sb
      .from("HRMS_activity_sessions")
      .update({
        active_seconds: nextActive,
        idle_seconds: nextIdle,
        last_heartbeat_at: new Date().toISOString(),
      } as any)
      .eq("id", currentSessionId);

    if (updateErr) {
      console.warn("[Agent] Activity session update failed:", updateErr.message);
      return;
    }

    console.log("[Activity] Session updated", {
      id: currentSessionId,
      deltaSeconds,
      mode: isIdle ? "idle" : "active",
      active_seconds: nextActive,
      idle_seconds: nextIdle,
    });
  }

  /**
   * Pause tracking for LUNCH / BREAK without ending the session row.
   * One attendance_log_id keeps a single open HRMS_activity_sessions row.
   */
  async function pauseActivityTracking() {
    if (currentSessionId) {
      await syncActivityCounters().catch(() => null);
    }
    await invoke("stop_input_monitoring").catch(() => null);
    trackingStarted = false;
  }

  async function closeActivitySession() {
    trackingStarted = false;
    const logIdToClear = currentSessionLogId;

    if (!currentSessionId) {
      await invoke("stop_input_monitoring").catch(() => null);
      currentSessionLogId = null;
      return;
    }

    await syncActivityCounters().catch(() => null);

    const { error } = await sb
      .from("HRMS_activity_sessions")
      .update({
        ended_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
      } as any)
      .eq("id", currentSessionId);

    if (error) {
      console.warn("[Agent] Activity session close failed:", error.message);
    } else {
      console.log("[Activity] Session closed", { id: currentSessionId });
    }

    await invoke("stop_input_monitoring").catch(() => null);

    clearPersistedActivitySessionId(logIdToClear);
    currentSessionId = null;
    currentSessionLogId = null;
  }

  async function applyStatus(nextStatus: AttendanceStateStatus) {
    if (stopped) return;

    const runId = ++trackingRunId;
    desiredStatus = nextStatus;

    console.log(`[Agent] Current state: ${nextStatus}`);

    clearTimers();
    // Keep heartbeat going even when not ACTIVE.
    heartbeatAttendanceLogId = null;

    /**
     * LUNCH / BREAK: pause timers + input monitoring, keep the same
     * open activity session row (do not INSERT again on resume).
     * INACTIVE: punch-out / not punched in — end the session.
     */
    if (nextStatus === "LUNCH" || nextStatus === "BREAK") {
      await pauseActivityTracking();
      console.log(`[Agent] Tracking paused: ${nextStatus}`);
      return;
    }

    if (nextStatus !== "ACTIVE") {
      await closeActivitySession();

      console.log(
        `[Agent] Tracking ${nextStatus === "INACTIVE" ? "stopped" : "paused"
        }: ${nextStatus}`,
      );

      return;
    }

    const gate = await canUserMarkAttendanceForUser(sb, userId);

    if (!gate.ok || !isCurrentActiveRun(runId)) return;

    const today = await loadTodayLogForUser(sb, userId);

    if (!isCurrentActiveRun(runId)) return;

    const attendanceLogId = today.log?.id ? String(today.log.id) : null;
    const todayLogCheckOutAt = (today.log as any)?.check_out_at || null;

    if (!attendanceLogId) {
      await stopMonitoringBecauseNoOpenAttendance({
        companyId: gate.companyId!,
        employeeId: gate.employeeId!,
      });

      return;
    }

    if (todayLogCheckOutAt) {
      await stopMonitoringBecausePunchedOut({
        companyId: gate.companyId!,
        employeeId: gate.employeeId!,
        attendanceLogId,
      });

      return;
    }

    const stillOpen = await isAttendanceLogStillOpen(attendanceLogId);

    if (!isCurrentActiveRun(runId)) return;

    if (!stillOpen) {
      await stopMonitoringBecausePunchedOut({
        companyId: gate.companyId!,
        employeeId: gate.employeeId!,
        attendanceLogId,
      });

      return;
    }

    console.log("[Agent] Tracking started");

    /**
     * While ACTIVE, attach the attendance log id to the heartbeat
     * (presence heartbeat itself is handled globally).
     */
    heartbeatAttendanceLogId = attendanceLogId;

    /**
     * Start input monitoring/activity session only while ACTIVE.
     * Reuses the single open HRMS_activity_sessions row for this log.
     */
    try {
      await startActivitySession({
        companyId: gate.companyId!,
        employeeId: gate.employeeId!,
        attendanceLogId,
      });

      if (!isCurrentActiveRun(runId)) {
        await pauseActivityTracking();
        return;
      }

      // Exactly one activity sync timer per ACTIVE run (trackingStarted guard).
      if (!trackingStarted) {
        if (activityTimer != null) window.clearInterval(activityTimer);
        activityTimer = window.setInterval(() => {
          if (!isCurrentActiveRun(runId)) return;
          void syncActivityCounters();
        }, ACTIVITY_SYNC_INTERVAL_MS);
        trackingStarted = true;
      } else {
        console.log("[Agent] trackingStarted=true; skipping duplicate activity setInterval");
      }
    } catch (e) {
      console.error("[Agent] Failed to start activity session:", e);
    }

    /**
     * Backup guard:
     * If realtime misses punch-out, stop once check_out_at appears.
     */
    attendanceGuardTimer = window.setInterval(() => {
      if (!isCurrentActiveRun(runId)) return;

      void isAttendanceLogStillOpen(attendanceLogId)
        .then(async (stillOpen) => {
          if (!stillOpen && isCurrentActiveRun(runId)) {
            await stopMonitoringBecausePunchedOut({
              companyId: gate.companyId!,
              employeeId: gate.employeeId!,
              attendanceLogId,
            });
          }
        })
        .catch((e) => {
          console.warn("[Agent] Attendance guard failed:", e);
        });
    }, ATTENDANCE_GUARD_INTERVAL_MS);

    /**
     * Screenshots on DB-controlled interval, only while ACTIVE.
     * No screenshots during LUNCH / BREAK / INACTIVE.
     */
    const workDate = today.workDate || workDateIST();
    screenshotTimerContext = {
      runId,
      companyId: gate.companyId!,
      employeeId: gate.employeeId!,
      attendanceLogId,
      workDate,
    };

    await refreshScreenshotIntervalFromDb(gate.companyId!, runId, true);
    startScreenshotTimer();

    agentSettingsPollTimer = window.setInterval(() => {
      if (!isCurrentActiveRun(runId)) return;
      void refreshScreenshotIntervalFromDb(gate.companyId!, runId);
    }, AGENT_SETTINGS_POLL_INTERVAL_MS);
  }

  console.log("[Agent] Connected to Supabase");

  const gate = await canUserMarkAttendanceForUser(sb, userId);

  if (stopped) {
    return {
      stop: () => {
        // Superseded (e.g. Strict Mode remount) before timers were wired.
      },
    };
  }

  if (gate.ok) {
    presenceGate = { companyId: gate.companyId!, employeeId: gate.employeeId! };

    // Send a presence heartbeat immediately, then keep it alive while app is running.
    void sendHeartbeat({
      companyId: presenceGate.companyId,
      employeeId: presenceGate.employeeId,
      attendanceLogId: heartbeatAttendanceLogId,
    });

    if (presenceTimer != null) window.clearInterval(presenceTimer);
    presenceTimer = window.setInterval(() => {
      if (stopped || !presenceGate) return;
      void sendHeartbeat({
        companyId: presenceGate.companyId,
        employeeId: presenceGate.employeeId,
        attendanceLogId: heartbeatAttendanceLogId,
      });
    }, HEARTBEAT_INTERVAL_MS);

    const topic = `agent_state:${gate.employeeId}`;

    /**
     * Clean old duplicated channels for this employee.
     * This prevents duplicate bootstrap / Sync clicks from leaving stale realtime channels.
     */
    try {
      const existingChannels = sb.getChannels();

      await Promise.all(
        existingChannels
          .filter((ch: any) => {
            const chTopic = String(ch?.topic || "");
            return chTopic === topic || chTopic === `realtime:${topic}`;
          })
          .map((ch) => sb.removeChannel(ch)),
      );
    } catch (e) {
      console.warn("[Agent] Failed to clean existing realtime channels:", e);
    }

    /**
     * IMPORTANT:
     * Add postgres_changes listener BEFORE subscribe().
     */
    channel = sb.channel(topic);

    channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "HRMS_attendance_state",
        filter: `employee_id=eq.${gate.employeeId}`,
      },
      (payload: any) => {
        const row = payload?.new ?? payload?.record ?? payload?.payload?.new;
        const raw = String(row?.status ?? "").trim().toUpperCase();
        if (!raw) {
          if (payload?.eventType === "DELETE") return;
          console.warn("[Agent] Realtime attendance_state event without status:", payload?.eventType);
          return;
        }

        const s = raw as AttendanceStateStatus;
        if (!["ACTIVE", "LUNCH", "BREAK", "INACTIVE"].includes(s)) return;

        if (s === desiredStatus) return;

        console.log("[Agent] Realtime attendance state received:", s);

        void applyStatus(s);
      },
    );

    channel.subscribe((status: string, err?: Error) => {
      console.log("[Agent] Realtime subscription status:", status);

      if (err) {
        console.error("[Agent] Realtime subscription error:", err);
      }

      if (status === "SUBSCRIBED") {
        void reconcileAttendanceStateIfStale("realtime-subscribed");
      }
    });

    console.log(
      "[Agent] Heartbeat is always on. `HRMS_activity_sessions` + screenshot traffic only after HRMS Web shows attendance ACTIVE (then activity sync every 20s, screenshot interval from HRMS_agent_settings, polled every 60s).",
    );

    /**
     * Load current state after subscription is registered.
     */
    const { data, error } = await sb
      .from("HRMS_attendance_state")
      .select("status")
      .eq("company_id", gate.companyId!)
      .eq("employee_id", gate.employeeId!)
      .maybeSingle();

    if (error) {
      console.error("[Agent] Failed to load attendance state:", error);
    }

    const raw = String((data as any)?.status ?? "").trim().toUpperCase();
    const st = (
      raw && ["ACTIVE", "LUNCH", "BREAK", "INACTIVE"].includes(raw)
        ? raw
        : null
    ) as AttendanceStateStatus | null;

    if (!data && !error) {
      console.warn(
        "[Agent] No HRMS_attendance_state row returned (check RLS policies or that punch-in ran on HRMS Web).",
      );
    }

    await applyStatus((st ?? "INACTIVE") as AttendanceStateStatus);

    void reconcileAttendanceStateIfStale("post-initial-apply");
    window.setTimeout(() => {
      if (!stopped) void reconcileAttendanceStateIfStale("delayed-1s");
    }, 1000);
  }
  return {
    stop: () => {
      stopped = true;
      desiredStatus = "INACTIVE";
      trackingRunId += 1;

      clearTimers();
      if (presenceTimer != null) window.clearInterval(presenceTimer);
      presenceTimer = null;
      presenceGate = null;
      heartbeatAttendanceLogId = null;

      void closeActivitySession();

      clearScreenshotPathLabelCache();

      try {
        if (channel) {
          void sb.removeChannel(channel);
        }
      } catch {
        // ignore
      }
    },
  };
}