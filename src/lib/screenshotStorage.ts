import { parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";

const TZ = "Asia/Kolkata";

/**
 * Azure container is already: attendance
 * So object key should NOT include:
 * HRMS/attendance screenshots
 */
export function attendanceScreenshotsBucket(): string {
  const v = (import.meta as any).env?.VITE_SUPABASE_STORAGE_BUCKET;
  return typeof v === "string" && v.trim() ? v.trim() : "attendance";
}

/**
 * Safe folder/file segment.
 */
export function sanitizePathSegment(raw: string, maxLen = 96): string {
  const s = String(raw ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+|\.+$/g, "");

  const out = s.slice(0, maxLen);
  return out || "unnamed";
}

/**
 * Example:
 * workDate 2026-05-01 → May_2026
 */
export function monthYearFolderFromWorkDate(workDateYmd: string): string {
  try {
    const d = parseISO(workDateYmd.trim() + "T12:00:00");
    if (Number.isNaN(d.getTime())) throw new Error("bad date");

    const label = formatInTimeZone(d, TZ, "MMMM yyyy");
    return label.replace(/\s+/g, "_");
  } catch {
    const label = formatInTimeZone(new Date(), TZ, "MMMM yyyy");
    return label.replace(/\s+/g, "_");
  }
}

export type ScreenshotPathLabels = {
  employeeFolder: string;
  employeeSafeName: string;
  employeeIdShort: string;
};

let cache: {
  companyId: string;
  employeeId: string;
  labels: ScreenshotPathLabels;
} | null = null;

/**
 * Final employee folder format:
 * EmployeeName_employeeIdShort
 *
 * Example:
 * Deven_Patel_f68d223f5899
 */
export async function resolveScreenshotPathLabels(
  sb: SupabaseClient,
  companyId: string,
  employeeId: string,
): Promise<ScreenshotPathLabels> {
  if (cache?.companyId === companyId && cache?.employeeId === employeeId) {
    return cache.labels;
  }

  const { data: emp, error } = await sb
    .from("HRMS_employees")
    .select("first_name, last_name, id")
    .eq("id", employeeId)
    .maybeSingle();

  if (error) {
    console.warn("[screenshots] Failed to fetch employee labels:", error.message);
  }

  const fn = sanitizePathSegment(String((emp as any)?.first_name || "Employee"));
  const ln = sanitizePathSegment(String((emp as any)?.last_name || ""));

  const employeeIdShort = sanitizePathSegment(
    String(employeeId).replace(/-/g, "").slice(0, 12),
    20,
  );

  const employeeSafeName = ln ? `${fn}_${ln}` : fn;

  const employeeFolder = `${employeeSafeName}_${employeeIdShort}`;

  const labels: ScreenshotPathLabels = {
    employeeFolder,
    employeeSafeName,
    employeeIdShort,
  };

  cache = { companyId, employeeId, labels };

  return labels;
}

export function clearScreenshotPathLabelCache() {
  cache = null;
}

/**
 * Final Azure object key format:
 *
 * company_id/
 *   May_2026/
 *     2026-05-05/
 *       Deven_Patel_f68d223f5899/
 *         Deven_Patel_10-06-52-AM.jpg
 */
export function buildAttendanceScreenshotObjectKey(args: {
  companyId: string;
  monthYearFolder: string;
  dateFolder: string;
  employeeFolder: string;
  fileName: string;
}): string {
  const { companyId, monthYearFolder, dateFolder, employeeFolder, fileName } = args;

  const companySeg = sanitizePathSegment(companyId.trim().toLowerCase(), 60);

  return `${companySeg}/${monthYearFolder}/${dateFolder}/${employeeFolder}/${fileName}`;
}

/**
 * Rust now returns image/jpeg.
 * PNG fallback kept only for safety.
 */
export function screenshotExtensionFromContentType(contentType?: string): "jpg" | "png" {
  const ct = String(contentType || "").toLowerCase();

  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) {
    return "jpg";
  }

  if (ct.includes("image/png")) {
    return "png";
  }

  return "jpg";
}

/**
 * Builds screenshot file name.
 *
 * Multi-monitor format:
 * EmployeeName_YYYY-MM-DD_HH-mm-ss_screen_{index}_{uuid}.jpg
 */
export function buildAttendanceScreenshotFileName(args: {
  employeeSafeName: string;
  atMs: number;
  contentType?: string;
  screenIndex?: number;
  captureGroupId?: string;
}): string {
  const { employeeSafeName, atMs, contentType, screenIndex, captureGroupId } = args;

  const safeEmployeeName = sanitizePathSegment(employeeSafeName, 60);
  const datePart = formatInTimeZone(new Date(atMs), TZ, "yyyy-MM-dd");
  const timePart = formatInTimeZone(new Date(atMs), TZ, "HH-mm-ss");
  const ext = screenshotExtensionFromContentType(contentType);

  if (screenIndex != null && screenIndex > 0) {
    const groupId = String(captureGroupId || crypto.randomUUID());
    const uuidShort = sanitizePathSegment(groupId.replace(/-/g, "").slice(0, 12), 16);
    return `${safeEmployeeName}_${datePart}_${timePart}_screen_${screenIndex}_${uuidShort}.${ext}`;
  }

  /**
   * Legacy single-monitor filename (5-minute bucket for idempotency).
   */
  const bucketMs = 5 * 60 * 1000;
  const bucketStartMs = Math.floor(Number(atMs) / bucketMs) * bucketMs;
  const stableMs = Number.isFinite(bucketStartMs) && bucketStartMs > 0 ? bucketStartMs : atMs;
  const timeLabel = formatInTimeZone(new Date(stableMs), TZ, "hh-mm-a");
  return `${safeEmployeeName}_${timeLabel}.${ext}`;
}

/**
 * Response from Rust Tauri command:
 *
 * {
 *   at_ms,
 *   trigger,
 *   bytes_b64,
 *   content_type: "image/jpeg"
 * }
 */
export type CapturedScreenshotMeta = {
  at_ms: number;
  trigger: string;
  bytes_b64: string;
  content_type: string;
};

export type CapturedMonitorScreenshotMeta = CapturedScreenshotMeta & {
  capture_group_id: string;
  screen_index: number;
  screen_name: string;
  screen_width: number;
  screen_height: number;
  is_primary_screen: boolean;
};

export type UploadAttendanceScreenshotArgs = {
  sb: SupabaseClient;
  companyId: string;
  employeeId: string;
  workDateYmd: string;
  screenshot: CapturedScreenshotMeta | CapturedMonitorScreenshotMeta;
};

export type UploadAttendanceScreenshotResult = {
  objectKey: string;
  contentType: string;
  fileName: string;
  employeeFolder: string;
  edgeFunctionResponse?: unknown;
};

/**
 * Upload screenshot through Supabase Edge Function.
 *
 * Azure container should be handled inside the Edge Function.
 * Object key should be only:
 *
 * company_id/Month_Year/Date/EmployeeName_id/EmployeeName_currentTime.jpg
 */
export async function uploadAttendanceScreenshotViaEdgeFunction(
  args: UploadAttendanceScreenshotArgs,
): Promise<UploadAttendanceScreenshotResult> {
  const { sb, companyId, employeeId, workDateYmd, screenshot } = args;

  if (!companyId) {
    throw new Error("companyId is required for screenshot upload");
  }

  if (!employeeId) {
    throw new Error("employeeId is required for screenshot upload");
  }

  if (!workDateYmd) {
    throw new Error("workDateYmd is required for screenshot upload");
  }

  if (!screenshot?.bytes_b64) {
    throw new Error("Screenshot base64 data is missing");
  }

  const labels = await resolveScreenshotPathLabels(sb, companyId, employeeId);

  const monthYearFolder = monthYearFolderFromWorkDate(workDateYmd);
  const dateFolder = sanitizePathSegment(workDateYmd, 32);

  const contentType = screenshot.content_type || "image/jpeg";
  const monitorMeta = screenshot as CapturedMonitorScreenshotMeta;
  const screenIndex =
    typeof monitorMeta.screen_index === "number" ? monitorMeta.screen_index : undefined;
  const captureGroupId =
    typeof monitorMeta.capture_group_id === "string" ? monitorMeta.capture_group_id : undefined;

  const fileName = buildAttendanceScreenshotFileName({
    employeeSafeName: labels.employeeSafeName,
    atMs: screenshot.at_ms,
    contentType,
    screenIndex,
    captureGroupId,
  });

  const objectKey = buildAttendanceScreenshotObjectKey({
    companyId,
    monthYearFolder,
    dateFolder,
    employeeFolder: labels.employeeFolder,
    fileName,
  });

  const { data, error } = await sb.functions.invoke("upload-attendance-screenshot-azure", {
    body: {
      // Required main fields
      companyId,
      employeeId,
      workDateYmd,
  
      // Blob path
      objectKey,
      blobName: objectKey,
  
      // Keep these also, no issue
      bytesBase64: screenshot.bytes_b64,
      contentType,
  
      // Required by your current Edge Function
      screenshot: {
        bytes_b64: screenshot.bytes_b64,
        content_type: contentType,
        at_ms: screenshot.at_ms,
        trigger: screenshot.trigger || "interval",
      },
  
      // Extra metadata
      metadata: {
        companyId,
        employeeId,
        employeeFolder: labels.employeeFolder,
        employeeName: labels.employeeSafeName,
        employeeIdShort: labels.employeeIdShort,
        workDate: workDateYmd,
        workDateYmd,
        trigger: screenshot.trigger,
        capturedAtMs: screenshot.at_ms,
        screenIndex: screenIndex ?? null,
        captureGroupId: captureGroupId ?? null,
      },
    },
  });

  if (error) {
    throw new Error(error.message || "Failed to upload attendance screenshot");
  }

  if ((data as any)?.error) {
    throw new Error(String((data as any).error));
  }

  return {
    objectKey,
    contentType,
    fileName,
    employeeFolder: labels.employeeFolder,
    edgeFunctionResponse: data,
  };
}