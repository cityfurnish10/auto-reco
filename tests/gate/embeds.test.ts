// A regression test for the bug that made a saved guard vanish.
//
// guard_profiles, gate_scans, gate_trips, guard_shifts and guard_face_checks
// each carry SEVERAL foreign keys to app_users -- guard_id plus created_by,
// linked_by, voided_by, reviewed_by. PostgREST cannot guess which one an
// embed means, so `app_users(name)` is rejected outright and the caller sees
// an error, not rows.
//
// It is invisible in every check we can run locally: it type-checks, it lints,
// it builds, and a mocked database happily returns whatever the stub says. It
// only appears against real PostgREST. So the rule is pinned in the source
// instead: every embed of app_users must name its foreign key.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("PostgREST embeds", () => {
  it("always names the foreign key when embedding app_users", () => {
    const offenders: string[] = [];
    for (const file of [...walk("lib/gate"), ...walk("app/api/gate")]) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        // `app_users(` or `app_users!inner(` with no column between the bang
        // and the bracket is the ambiguous form.
        if (/app_users(!inner)?\s*\(/.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "Ambiguous app_users embed. These tables have several foreign keys to " +
        "app_users, so PostgREST refuses the query and the screen renders an " +
        "empty list. Write app_users!guard_id(...) — name the key.\n\n" +
        offenders.join("\n")
    ).toEqual([]);
  });
});
