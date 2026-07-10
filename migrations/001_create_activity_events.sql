-- HRMS Attendance Agent: activity transitions only (no raw input counts)
-- Safe to apply in Supabase / Postgres

create table if not exists "HRMS_activity_events" (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  attendance_log_id uuid null,
  event_type text not null,
  event_at timestamptz not null,
  metadata jsonb null,
  created_at timestamptz not null default now()
);

create index if not exists hrms_activity_events_company_employee_at_idx
  on "HRMS_activity_events"(company_id, employee_id, event_at desc);

