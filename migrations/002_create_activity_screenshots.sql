-- HRMS Attendance Agent: screenshot metadata only (no image binary in DB)

create table if not exists "HRMS_activity_screenshots" (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employee_id uuid not null,
  attendance_log_id uuid null,
  captured_at timestamptz not null,
  trigger_type text not null,
  file_path text null,
  file_url text null,
  created_at timestamptz not null default now()
);

create index if not exists hrms_activity_screenshots_company_employee_at_idx
  on "HRMS_activity_screenshots"(company_id, employee_id, captured_at desc);

