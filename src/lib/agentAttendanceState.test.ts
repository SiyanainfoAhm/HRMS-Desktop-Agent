import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { markAgentAttendanceStateInactiveIfCurrent } from "./agentAttendanceState";

type AttendanceState = {
  company_id: string;
  employee_id: string;
  attendance_log_id: string | null;
  status: string;
  updated_at?: string;
};

function createAttendanceStateClient(state: AttendanceState): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "HRMS_attendance_state") {
        throw new Error(`Unexpected table: ${table}`);
      }

      const filters = new Map<string, unknown>();
      let updateValues: Partial<AttendanceState> | null = null;

      const query = {
        select() {
          return query;
        },
        update(values: Partial<AttendanceState>) {
          updateValues = values;
          return query;
        },
        eq(column: string, value: unknown) {
          filters.set(column, value);
          return query;
        },
        is(column: string, value: unknown) {
          filters.set(column, value);
          return query;
        },
        async maybeSingle() {
          const matches = [...filters].every(
            ([column, value]) =>
              state[column as keyof AttendanceState] === value,
          );

          if (!matches) {
            return { data: null, error: null };
          }

          if (updateValues) {
            Object.assign(state, updateValues);
          }

          return {
            data: { attendance_log_id: state.attendance_log_id },
            error: null,
          };
        },
      };

      return query;
    },
  } as unknown as SupabaseClient;
}

describe("markAgentAttendanceStateInactiveIfCurrent", () => {
  it("ignores yesterday's open agent session after today's punch-in", async () => {
    const yesterdayLog = { id: "attendance-yesterday", work_date: "2026-09-16" };
    const yesterdaySession = {
      id: "session-yesterday",
      attendance_log_id: yesterdayLog.id,
      ended_at: null,
    };
    const todayLog = { id: "attendance-today", work_date: "2026-09-17" };
    const attendanceState: AttendanceState = {
      company_id: "company-1",
      employee_id: "employee-1",
      attendance_log_id: todayLog.id,
      status: "ACTIVE",
    };

    const result = await markAgentAttendanceStateInactiveIfCurrent(
      createAttendanceStateClient(attendanceState),
      {
        companyId: attendanceState.company_id,
        employeeId: attendanceState.employee_id,
        attendanceLogId: yesterdaySession.attendance_log_id,
      },
    );

    expect(result).toEqual({ ok: true, stale: true });
    expect(attendanceState.attendance_log_id).toBe(todayLog.id);
    expect(attendanceState.status).toBe("ACTIVE");
  });

  it("marks the matching current attendance log inactive", async () => {
    const attendanceState: AttendanceState = {
      company_id: "company-1",
      employee_id: "employee-1",
      attendance_log_id: "attendance-today",
      status: "ACTIVE",
    };

    const result = await markAgentAttendanceStateInactiveIfCurrent(
      createAttendanceStateClient(attendanceState),
      {
        companyId: attendanceState.company_id,
        employeeId: attendanceState.employee_id,
        attendanceLogId: attendanceState.attendance_log_id,
      },
    );

    expect(result).toEqual({ ok: true, stale: false });
    expect(attendanceState.status).toBe("INACTIVE");
  });
});
