import { useEffect, useMemo, useRef, useState } from "react";
import { LogIn, RefreshCw } from "lucide-react";
import "./App.css";
import { getSupabase } from "./lib/supabase";
import { loginWithEmailPassword } from "./lib/passwordLogin";
import { loadTodayLogForUser, type AttendanceLogRow } from "./lib/attendance";
import { PasswordField } from "./components/PasswordField";
import { loadSessionUser, saveSessionUser, type SessionUser } from "./lib/session";
import { startAgentTracking } from "./lib/agentTracking";
import { ensureAutostartUnlessOptOut } from "./lib/autostart";

type SyncState = "ready" | "syncing" | "offline" | "error";

type TrackingController = {
  stop: () => void;
};

export default function App() {
  const sb = useMemo(() => getSupabase(), []);

  const [sessionUser, setSessionUser] = useState<SessionUser | null>(() =>
    loadSessionUser(),
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [, setLog] = useState<AttendanceLogRow | null>(null);
  const [workDate, setWorkDate] = useState<string>("");
  const [syncState, setSyncState] = useState<SyncState>("ready");
  const [err, setErr] = useState<string | null>(null);

  const trackingControllerRef = useRef<TrackingController | null>(null);
  const trackingUserRef = useRef<string | null>(null);
  const trackingStartingRef = useRef(false);

  function stopTrackingController() {
    try {
      trackingControllerRef.current?.stop();
    } catch {
      // ignore
    }

    trackingControllerRef.current = null;
    trackingUserRef.current = null;
    trackingStartingRef.current = false;
  }

  async function startTrackingForUser(userId: string, force = false) {
    if (!userId) return;

    if (
      !force &&
      trackingControllerRef.current &&
      trackingUserRef.current === userId
    ) {
      console.log("[Agent] Tracking already running for user:", userId);
      return;
    }

    if (trackingStartingRef.current && !force) {
      console.log("[Agent] Tracking already starting, skipping duplicate init");
      return;
    }

    trackingStartingRef.current = true;

    try {
      if (force || trackingUserRef.current !== userId) {
        stopTrackingController();
      }

      const controller = await startAgentTracking(sb, userId, { force });

      trackingControllerRef.current = controller;
      trackingUserRef.current = userId;

      console.log("[Agent] Tracking started from App.tsx", {
        userId,
      });
    } catch (e: any) {
      console.warn("[Agent] Tracking init failed:", e);
      setErr(e?.message || "Tracking init failed");
    } finally {
      trackingStartingRef.current = false;
    }
  }

  async function refresh() {
    setErr(null);
    setSyncState("syncing");

    try {
      const uid = sessionUser?.id || "";
      const data = await loadTodayLogForUser(sb, uid);

      setWorkDate(String(data.workDate || ""));
      setLog(data.log);
      setSyncState("ready");
    } catch (e: any) {
      setSyncState("error");
      setErr(e?.message || "Failed to sync");
    }
  }

  async function handleSync() {
    setErr(null);

    try {
      await refresh();

      if (sessionUser?.id) {
        await startTrackingForUser(sessionUser.id, true);
      }
    } catch (e: any) {
      setErr(e?.message || "Sync failed");
    }
  }

  useEffect(() => {
    if (!sessionUser?.id) {
      stopTrackingController();
    } else {
      void startTrackingForUser(sessionUser.id);
    }

    return () => {
      stopTrackingController();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUser?.id]);

  useEffect(() => {
    if (!sessionUser?.id) return;

    let cancelled = false;

    (async () => {
      await ensureAutostartUnlessOptOut();
      if (cancelled) return;
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionUser?.id]);

  useEffect(() => {
    if (!sessionUser) return;

    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUser]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="title">HRMS Attendance Agent</div>
          <div className="subtitle">
            Work date: {workDate || "—"} · Sync:{" "}
            {syncState === "ready"
              ? "Ready"
              : syncState === "syncing"
                ? "Updating…"
                : syncState === "offline"
                  ? "Offline"
                  : "Error"}
          </div>
        </div>

        <div className="top-actions">
          <button
            className="btn btn-outline"
            onClick={() => void handleSync()}
            title="Sync now"
          >
            <RefreshCw size={16} /> Sync
          </button>
        </div>
      </header>

      <div className="grid grid-single">
        <section className="card">
          {!sessionUser ? (
            <>
              <div className="card-head">
                <div className="card-title">Sign in</div>
              </div>

              <div className="cfg">
                <div style={{ textAlign: "center", marginTop: 2 }}>
                  <div
                    style={{
                      fontSize: 26,
                      fontWeight: 900,
                      letterSpacing: "-0.02em",
                    }}
                  >
                    HRMS
                  </div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    Attendance agent
                  </div>
                </div>

                <div className="cfg-row">
                  <label>Email</label>
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                  />
                </div>

                <div className="cfg-row">
                  <PasswordField
                    label="Password"
                    value={password}
                    onChange={setPassword}
                    placeholder="Password"
                  />
                </div>

                <div className="actions">
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      setErr(null);

                      try {
                        const nextUser = await loginWithEmailPassword(
                          sb,
                          email,
                          password,
                        );

                        setSessionUser(nextUser);
                        saveSessionUser(nextUser);
                        setPassword("");

                        await startTrackingForUser(nextUser.id, true);
                      } catch (e: any) {
                        setErr(e?.message || "Login failed");
                      }
                    }}
                  >
                    <LogIn size={16} /> Sign in
                  </button>
                </div>

                <div className="hint">
                  Use the same email/password as HRMS web/mobile.
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="card-head">
                <div className="card-title">Signed in</div>
              </div>

              <p className="hint" style={{ marginTop: 0 }}>
                <strong>{sessionUser.email}</strong>
              </p>

              <p className="hint">
                Punch, breaks, and times are managed in{" "}
                <strong>HRMS Web</strong>. Leave this app running in the
                background so your session stays synced.
              </p>
            </>
          )}

          {err && <div className="alert">{err}</div>}

          {sessionUser && (
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="btn btn-outline"
                onClick={() => {
                  stopTrackingController();

                  setSessionUser(null);
                  saveSessionUser(null);
                  setLog(null);
                  setWorkDate("");
                  setErr(null);
                  setSyncState("ready");
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}