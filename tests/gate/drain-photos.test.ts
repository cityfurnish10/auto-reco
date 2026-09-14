// A hand entry's photo must survive a failed upload, and two sends must never
// overlap.
//
// Found on Delhi's first live days (13–14 Sep 2026): four hand-entry photos
// lost, every one on an item sent in overlapping batches. The second batch got
// "duplicate" and deleted the queued image while the first was still uploading
// it; and a failed upload was never retried, because the entry was cleared
// regardless.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Item = { clientId: string; kind: string; payload: Record<string, unknown>; attempts: number; rejected?: string };
const store = { items: new Map<string, Item>(), blobs: new Map<string, Blob>() };

vi.mock("../../lib/gate/client/outbox", () => ({
  pending: async () => [...store.items.values()].filter((i) => !i.rejected),
  remove: async (id: string) => { store.items.delete(id); store.blobs.delete(id); },
  markRejected: async (id: string, reason: string) => { const i = store.items.get(id); if (i) i.rejected = reason; },
  bumpAttempts: async (ids: string[]) => { for (const id of ids) { const i = store.items.get(id); if (i) i.attempts++; } },
  getBlob: async (id: string) => store.blobs.get(id),
  getMeta: async () => "token", setMeta: async () => {}, deleteMeta: async () => {},
}));

let uploadOk = true;
const uploads: string[] = [];
vi.mock("../../lib/supabase/client", () => ({
  getSupabaseClient: () => ({ storage: { from: () => ({
    uploadToSignedUrl: async (path: string) => { uploads.push(path); return { error: uploadOk ? null : { message: "network" } }; },
  }) } }),
}));

import { drain } from "../../lib/gate/client/api";

/** The server, replying the way lib/gate/sync.ts does: stored the first time,
 *  duplicate after, and an upload link for any scan that has a photo. */
const seen = new Set<string>();
let inflightPosts = 0, maxConcurrentPosts = 0, posts = 0;
function server() {
  return vi.fn(async (_url: string, init: { body: string }) => {
    posts++; inflightPosts++; maxConcurrentPosts = Math.max(maxConcurrentPosts, inflightPosts);
    await new Promise((r) => setTimeout(r, 20));
    const body = JSON.parse(init.body);
    const scans = (body.scans ?? []).map((sc: { clientScanId: string; hasPhoto?: boolean }) => {
      const status = seen.has(sc.clientScanId) ? "duplicate" : "stored";
      seen.add(sc.clientScanId);
      return { clientId: sc.clientScanId, status, ...(sc.hasPhoto ? { photoUploadPath: `DELHI/d/${sc.clientScanId}.jpg` } : {}) };
    });
    const photos = scans.filter((x: { photoUploadPath?: string }) => x.photoUploadPath)
      .map((x: { clientId: string; photoUploadPath: string }) => ({ clientId: x.clientId, path: x.photoUploadPath, token: "t" }));
    inflightPosts--;
    return { ok: true, json: async () => ({ scans, photos, selfies: [], bucket: "gate-evidence", selfieBucket: "gate-attendance" }) };
  });
}

const handEntry = (id: string) => {
  store.items.set(id, { clientId: id, kind: "scan", attempts: 0,
    payload: { clientScanId: id, entryMethod: "manual", hasPhoto: true } });
  store.blobs.set(id, new Blob(["jpeg"]));
};

beforeEach(() => {
  store.items.clear(); store.blobs.clear(); seen.clear(); uploads.length = 0;
  uploadOk = true; inflightPosts = 0; maxConcurrentPosts = 0; posts = 0;
  vi.stubGlobal("localStorage", { getItem: () => "token", setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("window", {});
  vi.stubGlobal("fetch", server());
});

describe("a hand entry's photo", () => {
  it("is uploaded, then the entry clears", async () => {
    handEntry("m1");
    await drain();
    expect(uploads).toEqual(["DELHI/d/m1.jpg"]);
    expect(store.items.has("m1")).toBe(false);
  });

  it("SURVIVES A FAILED UPLOAD: kept with its image, and sent again on the next drain", async () => {
    handEntry("m1");
    uploadOk = false;
    await drain();
    expect(store.items.get("m1")?.attempts).toBe(1);
    expect(store.blobs.has("m1")).toBe(true);

    // Next drain: the server says duplicate and hands the link back.
    uploadOk = true;
    await drain();
    expect(uploads).toEqual(["DELHI/d/m1.jpg", "DELHI/d/m1.jpg"]);
    expect(store.items.has("m1")).toBe(false);
  });

  it("is eventually given up, so a queue can always empty — the record is already stored", async () => {
    handEntry("m1");
    uploadOk = false;
    for (let i = 0; i < 30; i++) await drain();
    expect(store.items.has("m1")).toBe(false);
  });
});

describe("sends never overlap", () => {
  it("THE DELHI CASE: a burst of triggers posts one batch at a time and loses no photo", async () => {
    handEntry("m1"); handEntry("m2");
    // Timer, return-to-app, reconnect and a fresh scan all firing together.
    await Promise.all([drain(), drain(), drain(), drain()]);
    expect(maxConcurrentPosts).toBe(1);
    expect([...new Set(uploads)].sort()).toEqual(["DELHI/d/m1.jpg", "DELHI/d/m2.jpg"]);
    expect(store.items.size).toBe(0);
  });

  it("work queued mid-send still goes out in a follow-up pass, not twenty seconds later", async () => {
    handEntry("m1");
    const first = drain();
    handEntry("m2");
    void drain();
    await first;
    expect(store.items.size).toBe(0);
    expect(posts).toBe(2);
  });
});
