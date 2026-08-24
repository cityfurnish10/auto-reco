// What is actually true in the live database right now.
//
// Written because "is it done?" kept being answered from memory of what was
// written, which is not the same question. Everything here is a fact read from
// production, not a claim about a commit.
//
// Read-only.  node scripts/gate-status.mjs

import { connectReadonly } from "./db-connect.mjs";

const c = await connectReadonly();
const line = (label, value) => console.log(`  ${String(label).padEnd(40)} ${value}`);

async function one(sql, params = []) {
  try { return (await c.query(sql, params)).rows; }
  catch (e) { return [{ error: e.message.slice(0, 90) }]; }
}

try {
  console.log("\nMIGRATIONS — checked by what they created, not by a filename");
  const checks = [
    ["0023 gate_movement_log", "SELECT to_regclass('public.gate_scans') IS NOT NULL AS ok"],
    ["0024 guard_attendance", "SELECT to_regclass('public.guard_face_checks') IS NOT NULL AS ok"],
    ["0025 guard_uniqueness",
     "SELECT count(*) > 0 AS ok FROM pg_indexes WHERE indexname IN ('uq_guard_employee_code','uq_guard_phone')"],
    ["0026 gate_sites", "SELECT count(*) > 0 AS ok FROM gate_sites"],
    ["0027 gate_sign_ins", "SELECT to_regclass('public.gate_sign_ins') IS NOT NULL AS ok"],
    ["0028 gate_schedules",
     "SELECT count(*) > 0 AS ok FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app_cron' AND p.proname='gate_expected'"],
    ["0029 trip_agent_required",
     "SELECT count(*) > 0 AS ok FROM pg_constraint WHERE conname = 'gate_trips_agent_named'"],
  ];
  for (const [name, sql] of checks) {
    const r = await one(sql);
    line(name, r[0]?.error ? `? ${r[0].error}` : (r[0]?.ok ? "applied" : "NOT APPLIED"));
  }

  console.log("\nWHAT THE GATE HAS RECORDED");
  for (const [label, sql] of [
    ["trips", "SELECT count(*) n FROM gate_trips"],
    ["scans recorded", "SELECT count(*) n FROM gate_scans WHERE status='recorded'"],
    ["scans voided", "SELECT count(*) n FROM gate_scans WHERE status='void'"],
    ["shifts", "SELECT count(*) n FROM guard_shifts"],
    ["face checks", "SELECT count(*) n FROM guard_face_checks"],
    ["face checks WITH a score", "SELECT count(*) n FROM guard_face_checks WHERE match_score IS NOT NULL"],
    ["sign-in attempts", "SELECT count(*) n FROM gate_sign_ins"],
    ["expected items cached", "SELECT count(*) n FROM gate_expected_items"],
    ["guards enrolled", "SELECT count(*) n FROM guard_profiles WHERE reference_descriptor IS NOT NULL"],
    ["devices paired", "SELECT count(*) n FROM gate_devices WHERE status='active'"],
  ]) {
    const r = await one(sql);
    line(label, r[0]?.error ? `? ${r[0].error}` : r[0].n);
  }

  console.log("\nTHE SWITCH — which cities read the app rather than the paper register");
  line("GATE_APP_CITIES", process.env.GATE_APP_CITIES || "(unset — every city still on paper)");

  console.log("\nSCHEDULED JOBS — last run");
  const jobs = await one(
    `SELECT j.jobname, r.status, to_char(r.start_time,'DD Mon HH24:MI') AS at
     FROM cron.job j LEFT JOIN cron.job_run_details r ON r.jobid = j.jobid
     WHERE j.jobname IN ('gate-expected','gate-media')
     ORDER BY r.start_time DESC NULLS LAST LIMIT 6`);
  if (!jobs.length) console.log("  (never run)");
  for (const j of jobs) line(j.jobname ?? "?", j.error ?? `${j.status ?? "never run"} ${j.at ?? ""}`);
} finally {
  await c.end();
}
console.log("");
