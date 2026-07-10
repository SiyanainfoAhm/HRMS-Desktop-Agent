# HRMS Attendance Agent (Desktop)

Cross‑platform (Windows/macOS) desktop attendance companion for HRMS.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [Rust Analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Features (MVP implemented)

- Punch In / Punch Out (uses Supabase Auth + writes to `HRMS_attendance_logs` with the same semantics as `hrms-web` `/api/attendance`)
- Start/End Tea Break
- Start/End Lunch Break
- Idle/Active detection (**5 minutes inactivity**, checked every ~7s)
- Visible status in UI: Active / Idle / Tea / Lunch / Punched out
- Productivity summary:
  - net work = punched minutes − breaks
  - productivity% = active / net work
- Screenshot capture architecture:
  - manual capture
  - periodic capture (interval minutes)
  - capture on idle start (optional)
  - stores files locally and returns metadata (no DB binaries)

## Idle detection flow

- When punched in and not on tea/lunch:
  - Rust listens for global input events (mouse move/click, keyboard press)
  - updates a single `lastActivityAt` timestamp
  - UI checks every 5–10 seconds:
    - if \(now - lastActivityAt \ge 5\) minutes → status becomes `Idle`
    - on first idle transition optionally triggers a screenshot
    - on any activity again → status returns to `Active`
- While on tea/lunch or punched out → idle is suppressed and break/out status is shown

## Database migrations (optional)

See `migrations/` for minimal tables if HRMS backend needs:

- `HRMS_activity_events` (transitions only)
- `HRMS_activity_screenshots` (metadata only)

## Setup / Running

1. Create `.env` from `.env.example` and set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
2. Run:
   - `npm install`
   - `npm run tauri dev`

If you see `cargo metadata ... program not found`, install Rust:
- Install Rustup, then restart terminal so `cargo` is on PATH.
# HRMS-Desktop-Agent
