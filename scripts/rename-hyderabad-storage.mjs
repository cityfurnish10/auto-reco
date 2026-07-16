// Move any guard-register Storage objects from the old HYDRABAD/ folder to the
// corrected HYDERABAD/ folder, so RLS (which compares the folder segment to the
// manager's app_users.city) keeps matching after migration 0006.
//
// Run AFTER applying 0006 (which sets guard_uploads.file_path to HYDERABAD/...).
// For each Hyderabad upload it copies the old object to the new key and deletes
// the old one. A no-op when no Hyderabad registers have been uploaded yet.
//   node scripts/rename-hyderabad-storage.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const e = t.indexOf("=");
  if (e < 0) continue;
  env[t.slice(0, e).trim()] = t.slice(e + 1).trim();
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, KEY);
const BUCKET = "guard-registers";
const H = { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };

async function main() {
  const { data, error } = await db
    .from("guard_uploads")
    .select("id, file_path")
    .eq("city", "HYDERABAD")
    .like("file_path", "HYDERABAD/%");
  if (error) throw new Error(error.message);

  let moved = 0;
  for (const row of data ?? []) {
    const dest = row.file_path; // HYDERABAD/...
    const src = "HYDRABAD/" + dest.slice("HYDERABAD/".length);
    const copy = await fetch(URL_ + "/storage/v1/object/copy", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ bucketId: BUCKET, sourceKey: src, destinationKey: dest }),
    });
    if (copy.ok) {
      await fetch(URL_ + "/storage/v1/object/" + BUCKET + "/" + src, { method: "DELETE", headers: H });
      moved++;
      console.log(`  moved ${src} -> ${dest}`);
    } else if (copy.status === 400 || copy.status === 404) {
      // old object doesn't exist (already at new key, or never uploaded) — fine.
    } else {
      console.log(`  WARN copy ${src}: HTTP ${copy.status} ${(await copy.text()).slice(0, 120)}`);
    }
  }
  console.log(`Done. ${moved} object(s) moved (${(data ?? []).length} Hyderabad upload rows checked).`);
}

main().catch((e) => {
  console.error("STORAGE RENAME FAILED:", e.message);
  process.exit(1);
});
