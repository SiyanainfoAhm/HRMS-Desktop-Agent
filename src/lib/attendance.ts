import { formatInTimeZone } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";

const TZ = "Asia/Kolkata";

export type AttendanceLogRow = {
  id: string;
  company_id: string;
  employee_id: string;
  work_date: string;
  check_in_at: string | null;
  check_out_at: string | null;
  lunch_break_minutes: number | null;
  tea_break_minutes: number | null;
  lunch_break_started_at: string | null;
  tea_break_started_at: string | null;
  lunch_check_out_at: string | null;
  lunch_check_in_at: string | null;
  tea_check_out_at: string | null;
  tea_check_in_at: string | null;
  status: string | null;
  in_office: boolean | null;
  check_in_lat: number | null;
  check_in_lng: number | null;
  check_out_lat: number | null;
  check_out_lng: number | null;
  notes: string | null;
  /** Cumulative desktop idle minutes (agent); stored in DB for reload. */
  agent_idle_minutes?: number | null;
};

export type AttendanceGate = {
  ok: boolean;
  companyId?: string;
  employeeId?: string; // HRMS_attendance employee mirror id
  error?: string;
};

export function workDateIST(d = new Date()): string {
  return formatInTimeZone(d, TZ, "yyyy-MM-dd");
}

function clampMinutes(n: number): number {
  return Math.min(24 * 60, Math.max(0, Math.round(n)));
}

function addAccumulatedMinutes(accumMin: number, startedAtIso: string | null | undefined, nowIso: string): number {
  const base = clampMinutes(Number(accumMin) || 0);
  if (!startedAtIso) return base;
  const s = new Date(String(startedAtIso)).getTime();
  const n = new Date(nowIso).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(n) || n <= s) return base;
  return clampMinutes(base + Math.round((n - s) / 60000));
}

function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const sLat1 = toRad(aLat);
  const sLat2 = toRad(bLat);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(sLat1) * Math.cos(sLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

export async function canUserMarkAttendanceForUser(sb: SupabaseClient, userId: string): Promise<AttendanceGate> {
  if (!userId) return { ok: false, error: "Not logged in." };

  const { data: userRow, error: uErr } = await sb
    .from("HRMS_users")
    .select("id, company_id, employment_status")
    .eq("id", userId)
    .maybeSingle();
  if (uErr) return { ok: false, error: uErr.message };
  if (!userRow?.company_id) return { ok: false, error: "User not linked to company." };
  if (String((userRow as any).employment_status || "") !== "current") {
    return { ok: false, error: "Attendance is available only for current employees. Ask HR to activate your status." };
  }

  const { data: emp, error: eErr } = await sb
    .from("HRMS_employees")
    .select("id, is_active")
    .eq("company_id", userRow.company_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (eErr) return { ok: false, error: eErr.message };
  if (!emp?.id || (emp as any).is_active === false) {
    return { ok: false, error: "Employee record not active. Ask HR to activate your employee profile." };
  }

  return { ok: true, companyId: userRow.company_id, employeeId: emp.id };
}

export async function loadTodayLogForUser(
  sb: SupabaseClient,
  userId: string
): Promise<{ gate: AttendanceGate; workDate: string; log: AttendanceLogRow | null }> {
  const gate = await canUserMarkAttendanceForUser(sb, userId);
  const wd = workDateIST();
  if (!gate.ok) return { gate, workDate: wd, log: null };

  const { data: log, error } = await sb
    .from("HRMS_attendance_logs")
    .select(
      "id, company_id, employee_id, work_date, check_in_at, check_out_at, total_hours, lunch_break_minutes, tea_break_minutes, lunch_break_started_at, tea_break_started_at, lunch_check_out_at, lunch_check_in_at, tea_check_out_at, tea_check_in_at, status, in_office, check_in_lat, check_in_lng, check_out_lat, check_out_lng, notes, agent_idle_minutes"
    )
    .eq("company_id", gate.companyId!)
    .eq("employee_id", gate.employeeId!)
    .eq("work_date", wd)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { gate, workDate: wd, log: (log as any) ?? null };
}

const MAX_AGENT_IDLE_MINUTES = 24 * 60;

/** Upsert cumulative idle minutes on today's attendance log (RLS must allow employee update). */
export async function updateAgentIdleMinutes(
  sb: SupabaseClient,
  args: { logId: string; companyId: string; employeeId: string; minutes: number }
): Promise<{ ok: boolean; error?: string }> {
  const m = Math.max(0, Math.min(MAX_AGENT_IDLE_MINUTES, Math.round(args.minutes)));
  const nowIso = new Date().toISOString();
  const { error } = await sb
    .from("HRMS_attendance_logs")
    .update({
      agent_idle_minutes: m,
      updated_at: nowIso,
    })
    .eq("id", args.logId)
    .eq("company_id", args.companyId)
    .eq("employee_id", args.employeeId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function punchInForUser(
  sb: SupabaseClient,
  userId: string,
  args: { lat: number; lng: number; accuracyM?: number } | null
) {
  const { gate, workDate: wd, log: existing } = await loadTodayLogForUser(sb, userId);
  if (!gate.ok) throw new Error(gate.error || "Not allowed");
  if (existing?.check_in_at && existing?.check_out_at) throw new Error("Today's attendance is already complete.");
  if (existing?.check_in_at && !existing?.check_out_at) throw new Error("You are already punched in.");

  const { data: company, error: compErr } = await sb
    .from("HRMS_companies")
    .select("latitude, longitude, office_radius_m")
    .eq("id", gate.companyId!)
    .maybeSingle();
  if (compErr) throw new Error(compErr.message);

  const officeLat = company?.latitude != null ? Number(company.latitude) : null;
  const officeLng = company?.longitude != null ? Number(company.longitude) : null;
  const radiusM = company?.office_radius_m != null ? Math.max(10, Number(company.office_radius_m)) : 150;
  if (officeLat == null || officeLng == null) throw new Error("Company office location not configured. Ask Super Admin.");
  if (!args || !Number.isFinite(args.lat) || !Number.isFinite(args.lng)) throw new Error("Location permission is required to punch in.");

  const dist = haversineMeters(args.lat, args.lng, officeLat, officeLng);
  const inOffice = dist <= radiusM;
  const nowIso = new Date().toISOString();

  const { data: inserted, error } = await sb
    .from("HRMS_attendance_logs")
    .insert([
      {
        company_id: gate.companyId,
        employee_id: gate.employeeId,
        work_date: wd,
        check_in_at: nowIso,
        check_out_at: null,
        lunch_break_minutes: 0,
        tea_break_minutes: 0,
        lunch_break_started_at: null,
        tea_break_started_at: null,
        lunch_check_out_at: null,
        lunch_check_in_at: null,
        tea_check_out_at: null,
        tea_check_in_at: null,
        total_hours: null,
        status: "present",
        check_in_lat: args.lat,
        check_in_lng: args.lng,
        check_in_accuracy_m: args.accuracyM ?? null,
        in_office: inOffice,
        check_in_in_office: inOffice,
        office_note: !inOffice ? "Punched in from outside office." : null,
        notes: `Punch in: ${inOffice ? "Inside office." : "Outside office."}`,
        updated_at: nowIso,
      },
    ])
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return inserted as AttendanceLogRow;
}

export async function toggleBreakForUser(sb: SupabaseClient, userId: string, kind: "tea" | "lunch") {
  const { gate, log: existing } = await loadTodayLogForUser(sb, userId);
  if (!gate.ok) throw new Error(gate.error || "Not allowed");
  if (!existing?.check_in_at) throw new Error("Punch in first before starting breaks.");
  if (existing?.check_out_at) throw new Error("Attendance already completed for today.");

  const nowIso = new Date().toISOString();
  const lunchStarted = existing.lunch_break_started_at ?? null;
  const teaStarted = existing.tea_break_started_at ?? null;

  const lunchMinBase = clampMinutes(Number(existing.lunch_break_minutes) || 0);
  const teaMinBase = clampMinutes(Number(existing.tea_break_minutes) || 0);

  const isRunning = kind === "lunch" ? !!lunchStarted : !!teaStarted;
  let nextLunchStarted: string | null = lunchStarted;
  let nextTeaStarted: string | null = teaStarted;
  let nextLunchMin = lunchMinBase;
  let nextTeaMin = teaMinBase;

  let nextLunchOutAt: string | null = existing.lunch_check_out_at ?? null;
  let nextLunchInAt: string | null = existing.lunch_check_in_at ?? null;
  let nextTeaOutAt: string | null = existing.tea_check_out_at ?? null;
  let nextTeaInAt: string | null = existing.tea_check_in_at ?? null;

  if (isRunning) {
    if (kind === "lunch") {
      nextLunchMin = addAccumulatedMinutes(lunchMinBase, lunchStarted, nowIso);
      nextLunchStarted = null;
      nextLunchInAt = nowIso;
    } else {
      nextTeaMin = addAccumulatedMinutes(teaMinBase, teaStarted, nowIso);
      nextTeaStarted = null;
      nextTeaInAt = nowIso;
    }
  } else {
    // stop other break if running
    if (kind === "lunch" && teaStarted) {
      nextTeaMin = addAccumulatedMinutes(teaMinBase, teaStarted, nowIso);
      nextTeaStarted = null;
      nextTeaInAt = nowIso;
    }
    if (kind === "tea" && lunchStarted) {
      nextLunchMin = addAccumulatedMinutes(lunchMinBase, lunchStarted, nowIso);
      nextLunchStarted = null;
      nextLunchInAt = nowIso;
    }

    // start this break
    if (kind === "lunch") {
      nextLunchStarted = nowIso;
      if (!nextLunchOutAt) nextLunchOutAt = nowIso;
    } else {
      nextTeaStarted = nowIso;
      if (!nextTeaOutAt) nextTeaOutAt = nowIso;
    }
  }

  const { data: updated, error } = await sb
    .from("HRMS_attendance_logs")
    .update({
      lunch_break_minutes: nextLunchMin,
      tea_break_minutes: nextTeaMin,
      lunch_break_started_at: nextLunchStarted,
      tea_break_started_at: nextTeaStarted,
      lunch_check_out_at: nextLunchOutAt,
      lunch_check_in_at: nextLunchInAt,
      tea_check_out_at: nextTeaOutAt,
      tea_check_in_at: nextTeaInAt,
      updated_at: nowIso,
    })
    .eq("id", existing.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return updated as AttendanceLogRow;
}

export async function punchOutForUser(
  sb: SupabaseClient,
  userId: string,
  args: { lat: number; lng: number; accuracyM?: number } | null
) {
  const { gate, log: existing } = await loadTodayLogForUser(sb, userId);
  if (!gate.ok) throw new Error(gate.error || "Not allowed");
  if (!existing?.check_in_at) throw new Error("Punch in first before punching out.");
  if (existing.check_out_at) throw new Error("Already punched out for today.");
  if (existing.lunch_break_started_at) throw new Error("End lunch before final check out.");
  if (existing.tea_break_started_at) throw new Error("End tea break before final check out.");
  if (!args || !Number.isFinite(args.lat) || !Number.isFinite(args.lng)) throw new Error("Location permission is required to punch out.");

  const nowIso = new Date().toISOString();
  const inMs = new Date(String(existing.check_in_at)).getTime();
  const outMs = new Date(nowIso).getTime();
  if (!Number.isFinite(inMs) || outMs <= inMs) throw new Error("Invalid punch out time.");

  const grossMinutes = Math.round((outMs - inMs) / 60000);
  const totalHours = Math.round((grossMinutes / 60) * 100) / 100;

  const { data: company } = await sb
    .from("HRMS_companies")
    .select("latitude, longitude, office_radius_m")
    .eq("id", gate.companyId!)
    .maybeSingle();
  const officeLat = company?.latitude != null ? Number(company.latitude) : null;
  const officeLng = company?.longitude != null ? Number(company.longitude) : null;
  const radiusM = company?.office_radius_m != null ? Math.max(10, Number(company.office_radius_m)) : 150;
  const dist = officeLat != null && officeLng != null ? haversineMeters(args.lat, args.lng, officeLat, officeLng) : null;
  const outInOffice = dist != null ? dist <= radiusM : null;

  const finalLunchMin = addAccumulatedMinutes(Number(existing.lunch_break_minutes) || 0, existing.lunch_break_started_at ?? null, nowIso);
  const finalTeaMin = addAccumulatedMinutes(Number(existing.tea_break_minutes) || 0, existing.tea_break_started_at ?? null, nowIso);

  const { data: updated, error } = await sb
    .from("HRMS_attendance_logs")
    .update({
      check_out_at: nowIso,
      lunch_break_minutes: finalLunchMin,
      tea_break_minutes: finalTeaMin,
      lunch_break_started_at: null,
      tea_break_started_at: null,
      total_hours: totalHours,
      status: "present",
      check_out_lat: args.lat,
      check_out_lng: args.lng,
      check_out_accuracy_m: args.accuracyM ?? null,
      check_out_in_office: outInOffice,
      in_office: Boolean((existing as any)?.check_in_in_office ?? existing.in_office) && outInOffice !== false,
      notes: `${existing.notes ? String(existing.notes) + " " : ""}Punch out: ${
        outInOffice === false ? "Outside office." : outInOffice === true ? "Inside office." : "Unknown."
      }`,
      updated_at: nowIso,
    })
    .eq("id", existing.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return updated as AttendanceLogRow;
}

