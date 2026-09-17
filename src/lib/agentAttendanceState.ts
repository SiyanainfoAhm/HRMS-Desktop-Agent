import type { SupabaseClient } from "@supabase/supabase-js";

export type AgentAttendanceStateUpdateResult = {
  ok: boolean;
  stale: boolean;
  error?: string;
};

/**
 * Mark the agent state inactive only while the state row still belongs to
 * this attendance log. A successful stale result is intentionally a no-op.
 */
export async function markAgentAttendanceStateInactiveIfCurrent(
  sb: SupabaseClient,
  args: {
    companyId: string;
    employeeId: string;
    attendanceLogId: string | null;
  },
): Promise<AgentAttendanceStateUpdateResult> {
  const { data: currentState, error: readError } = await sb
    .from("HRMS_attendance_state")
    .select("attendance_log_id")
    .eq("company_id", args.companyId)
    .eq("employee_id", args.employeeId)
    .maybeSingle();

  if (readError) {
    return { ok: false, stale: false, error: readError.message };
  }

  const activeLogId =
    (currentState as { attendance_log_id?: string | null } | null)
      ?.attendance_log_id ?? null;

  if (!currentState || activeLogId !== args.attendanceLogId) {
    return { ok: true, stale: true };
  }

  const nowIso = new Date().toISOString();
  let update = sb
    .from("HRMS_attendance_state")
    .update({
      attendance_log_id: args.attendanceLogId,
      status: "INACTIVE",
      updated_at: nowIso,
    } as any)
    .eq("company_id", args.companyId)
    .eq("employee_id", args.employeeId);

  update = args.attendanceLogId
    ? update.eq("attendance_log_id", args.attendanceLogId)
    : update.is("attendance_log_id", null);

  const { data: updatedState, error: updateError } = await update
    .select("attendance_log_id")
    .maybeSingle();

  if (updateError) {
    return { ok: false, stale: false, error: updateError.message };
  }

  // The conditional write matched no row because the active log changed
  // after the initial read.
  if (!updatedState) {
    return { ok: true, stale: true };
  }

  return { ok: true, stale: false };
}
