import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OBJ, CLUSTERS, RECENT, BUCKET, type StashItem, type Kind } from "./data";
import { canonicalizeUrl } from "./fetchMeta";

declare global {
  var __stashdropDb: DatabaseSync | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  cluster TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL,
  title TEXT NOT NULL,
  domain TEXT NOT NULL,
  kept TEXT NOT NULL,
  bucket TEXT NOT NULL,
  is_text INTEGER NOT NULL DEFAULT 0,
  body TEXT,
  playhead INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  highlights TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  related TEXT NOT NULL DEFAULT '[]',
  context TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  seed_order INTEGER NOT NULL
);

-- A stash is owned either by a single user (personal) or by a better-auth
-- organization (team) — owner_type/owner_id together point at one of
-- those, never both. A workspace can hold several stashes; stashes hold
-- items.
CREATE TABLE IF NOT EXISTS stashes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS item_comments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Folders: the AI clusters (A/B/C/D, seeded per stash) plus any the user
-- creates. items.cluster references clusters.id; seed items keep their
-- original letter keys so no data rewrite is needed.
CREATE TABLE IF NOT EXISTS clusters (
  id TEXT NOT NULL,
  stash_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  x REAL NOT NULL DEFAULT -1,
  y REAL NOT NULL DEFAULT -1,
  PRIMARY KEY (id, stash_id)
);
`;

// columns added after the initial release; ensured present on every boot so
// an existing dev/prod db.sqlite upgrades in place instead of losing data
const MIGRATIONS: [column: string, def: string][] = [
  ["url", "TEXT"],
  ["image", "TEXT"],
  ["embedding", "TEXT"],
  ["deleted_at", "INTEGER"],
  ["enriched_at", "INTEGER"],
  ["stash_id", "TEXT"],
  ["created_by", "TEXT"],
];

interface Row {
  id: string; kind: string; cluster: string; x: number; y: number; w: number;
  title: string; domain: string; kept: string; bucket: string; is_text: number;
  body: string | null; playhead: number; description: string; tags: string;
  highlights: string; note: string; related: string; context: string;
  created_at: number; seed_order: number; url: string | null; image: string | null;
  embedding: string | null; deleted_at: number | null; enriched_at: number | null;
  stash_id: string | null; created_by: string | null; created_by_name: string | null;
}

// Seed items carry curated, fixed narrative dates ("12 Jan", "yesterday")
// that are flavor text, not real timestamps — left as authored. Captured
// items (identified by having a real url) get their "kept X ago" and list
// grouping computed fresh from created_at each read, so they don't stay
// frozen at "just now" / "This week" forever.
function relativeKept(ms: number): string {
  const diff = Date.now() - ms;
  const min = 60_000, hr = 3_600_000, day = 86_400_000;
  if (diff < min) return "just now";
  if (diff < hr) return Math.max(1, Math.round(diff / min)) + "m ago";
  if (diff < day) return Math.max(1, Math.round(diff / hr)) + "h ago";
  const days = Math.round(diff / day);
  if (days === 1) return "yesterday";
  if (days < 7) return days + "d ago";
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function relativeBucket(ms: number): string {
  const week = 7 * 86_400_000;
  if (Date.now() - ms < week) return "This week";
  return new Date(ms).toLocaleDateString(undefined, { month: "long" });
}

function rowToItem(r: Row): StashItem {
  return {
    id: r.id, kind: r.kind as Kind, cluster: r.cluster, x: r.x, y: r.y, w: r.w,
    title: r.title, domain: r.domain, kept: r.url ? relativeKept(r.created_at) : r.kept,
    isText: !!r.is_text, body: r.body ?? undefined, playhead: !!r.playhead,
    description: r.description, tags: JSON.parse(r.tags), highlights: JSON.parse(r.highlights),
    note: r.note, related: JSON.parse(r.related), context: r.context,
    url: r.url ?? undefined, image: r.image ?? undefined,
    createdById: r.created_by ?? undefined, createdByName: r.created_by_name ?? undefined,
  };
}

function ensureColumn(db: DatabaseSync, column: string, def: string) {
  const cols = db.prepare("PRAGMA table_info(items)").all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE items ADD COLUMN ${column} ${def}`);
  }
}

function ensureStashColumn(db: DatabaseSync, column: string, def: string) {
  const cols = db.prepare("PRAGMA table_info(stashes)").all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE stashes ADD COLUMN ${column} ${def}`);
  }
}

// Folders (clusters) keep their own desk position now that they're draggable
// desk objects, not labels riding their cards. -1 = "never moved yet", so
// the client falls back to a deterministic default spot.
function ensureClusterColumn(db: DatabaseSync, column: string, def: string) {
  const cols = db.prepare("PRAGMA table_info(clusters)").all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE clusters ADD COLUMN ${column} ${def}`);
  }
}

// The pre-merger schema kept a `projects` table and pointed each stash at
// it via project_id; workspaces could have several stashes but only one
// project. This merges them — the stash itself now carries the owner and
// description that used to live on the project, and the projects table is
// dropped. No-op on a fresh database (SCHEMA already created the new-shape
// stashes table).
function mergeProjectsIntoStashes(db: DatabaseSync) {
  const cols = db.prepare("PRAGMA table_info(stashes)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "owner_type")) {
    db.exec(`
      ALTER TABLE stashes ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE stashes ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE stashes ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
      UPDATE stashes SET
        owner_type = (SELECT p.owner_type FROM projects p WHERE p.id = stashes.project_id),
        owner_id = (SELECT p.owner_id FROM projects p WHERE p.id = stashes.project_id),
        description = (SELECT p.description FROM projects p WHERE p.id = stashes.project_id);
      DROP TABLE projects;
    `);
  }
}

// Pre-fix databases have clusters.id as a lone (global) primary key, so the
// default folder ids "A"/"B"/"C"/"D" collide across every stash — whichever
// stash seeds them first wins, and INSERT OR IGNORE silently drops the
// default folders for every other stash, leaving their items' cluster field
// pointing at nothing. Rebuild with a composite (id, stash_id) key so each
// stash gets its own row.
function fixClustersPrimaryKey(db: DatabaseSync) {
  const cols = db.prepare("PRAGMA table_info(clusters)").all() as { name: string; pk: number }[];
  const soleIdKey = cols.filter((c) => c.pk > 0).length === 1 && cols.some((c) => c.pk === 1 && c.name === "id");
  if (!soleIdKey) return;
  db.exec(`
    CREATE TABLE clusters_new (
      id TEXT NOT NULL,
      stash_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (id, stash_id)
    );
    INSERT INTO clusters_new SELECT id, stash_id, name, created_at FROM clusters;
    DROP TABLE clusters;
    ALTER TABLE clusters_new RENAME TO clusters;
  `);
}

export function getDb(): DatabaseSync {
  if (!globalThis.__stashdropDb) {
    const db = new DatabaseSync(path.join(process.cwd(), "stashdrop.db"));
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    MIGRATIONS.forEach(([column, def]) => ensureColumn(db, column, def));
    mergeProjectsIntoStashes(db);
    fixClustersPrimaryKey(db);
    ensureStashColumn(db, "starter_seeded", "INTEGER");
    ensureClusterColumn(db, "x", "REAL NOT NULL DEFAULT -1");
    ensureClusterColumn(db, "y", "REAL NOT NULL DEFAULT -1");
    globalThis.__stashdropDb = db;
  }
  return globalThis.__stashdropDb;
}

export const DEMO_EMAIL = "ashwincherian.spam+demo@gmail.com";
export const DEMO_PASSWORD = "demo1234";

// Seeds a real, signed-in-able demo account (personal workspace, one
// stash, the same sample bookmarks the app used to seed as
// unowned rows) — runs once, after better-auth's own tables exist (see
// the call site in auth.ts), guarded by the demo user already existing so
// it never re-seeds or duplicates on later boots.
export async function seedDemoWorkspace() {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM user WHERE email = ?").get(DEMO_EMAIL) as { id: string } | undefined;
  if (existing) return;

  const { hashPassword } = await import("better-auth/crypto");
  const hashedPassword = await hashPassword(DEMO_PASSWORD);
  const userId = randomUUID();
  const now = new Date().toISOString();

  // Transactional so a failure partway (e.g. an id collision) never leaves
  // a half-seeded demo user stuck behind the "already exists" guard above
  // with no stash to show for it — either the whole thing lands, or none
  // of it does and the next boot retries cleanly.
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)")
      .run(userId, "Demo", DEMO_EMAIL, now, now);
    db.prepare("INSERT INTO account (id, issuer, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, 'credential', ?, ?, ?, ?)")
      .run(randomUUID(), "local:credential", userId, userId, hashedPassword, now, now);

    const stash = createStash("Demo stash", "", "user", userId);

    // Prefixed so these ids can never collide with a real captured item's
    // id (or, on an install that upgraded from the old unowned-seed-rows
    // scheme, with leftover rows already sitting in someone's real stash)
    // — items.id is a global primary key, not scoped per stash.
    // WHY/WHY_RELATED in lib/data.ts are still keyed by the bare original
    // id, so Canvas.tsx strips this prefix back off before looking those up.
    const createdAt = Date.now();
    OBJ.forEach((o) => {
      const item: StashItem = {
        id: "demo-" + o.id, kind: o.kind, cluster: o.cluster, x: o.x, y: o.y, w: o.w,
        title: o.title, domain: o.domain, kept: o.kept, isText: o.isText, body: o.body,
        playhead: o.playhead, description: o.description, tags: o.tags, highlights: o.highlights,
        note: o.note, related: o.related.map((r) => "demo-" + r), context: o.context,
      };
      insertItem(item, BUCKET[o.id] || "This week", createdAt - (RECENT.indexOf(o.id) < 0 ? RECENT.length : RECENT.indexOf(o.id)) * 3_600_000, stash.id, userId);
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getAllItemsWithMeta(stashId: string) {
  const db = getDb();
  const items = (db.prepare(
    "SELECT items.*, user.name AS created_by_name FROM items LEFT JOIN user ON user.id = items.created_by WHERE items.stash_id = ? AND items.deleted_at IS NULL ORDER BY items.seed_order ASC"
  ).all(stashId) as unknown as Row[]).map(rowToItem);
  const bucket: Record<string, string> = {};
  (db.prepare("SELECT id, bucket, url, created_at FROM items WHERE stash_id = ? AND deleted_at IS NULL").all(stashId) as { id: string; bucket: string; url: string | null; created_at: number }[]).forEach((r) => {
    bucket[r.id] = r.url ? relativeBucket(r.created_at) : r.bucket;
  });
  const recentOrder = (db.prepare("SELECT id FROM items WHERE stash_id = ? AND deleted_at IS NULL ORDER BY created_at DESC").all(stashId) as { id: string }[]).map((r) => r.id);
  return { items, bucket, recentOrder };
}

export function savePosition(id: string, x: number, y: number) {
  getDb().prepare("UPDATE items SET x = ?, y = ? WHERE id = ?").run(x, y, id);
}

export function deleteItem(id: string) {
  getDb().prepare("DELETE FROM items WHERE id = ?").run(id);
}

export function trashItem(id: string) {
  getDb().prepare("UPDATE items SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
}

export function restoreItem(id: string) {
  getDb().prepare("UPDATE items SET deleted_at = NULL WHERE id = ?").run(id);
}

export function emptyTrash(stashId: string) {
  getDb().prepare("DELETE FROM items WHERE stash_id = ? AND deleted_at IS NOT NULL").run(stashId);
}

export function getTrashedItems(stashId: string): (StashItem & { deletedAt: number })[] {
  const rows = getDb().prepare("SELECT * FROM items WHERE stash_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC").all(stashId) as unknown as Row[];
  return rows.map((r) => ({ ...rowToItem(r), deletedAt: r.deleted_at! }));
}

export function findByUrl(url: string, stashId: string): StashItem | null {
  const target = canonicalizeUrl(url);
  const rows = getDb().prepare("SELECT * FROM items WHERE stash_id = ? AND url IS NOT NULL AND deleted_at IS NULL").all(stashId) as unknown as Row[];
  const match = rows.find((r) => canonicalizeUrl(r.url!) === target);
  return match ? rowToItem(match) : null;
}

// Lets the client poll a just-captured item for the background AI pass
// (see markEnriched) without caring whether it's still sitting in the
// pending panel, being held as a ghost, or already placed on the desk.
export function getItemWithMeta(id: string): { item: StashItem; enrichedAt: number | null } | null {
  const row = getDb().prepare("SELECT * FROM items WHERE id = ? AND deleted_at IS NULL").get(id) as unknown as Row | undefined;
  return row ? { item: rowToItem(row), enrichedAt: row.enriched_at } : null;
}

export function markEnriched(id: string) {
  getDb().prepare("UPDATE items SET enriched_at = ? WHERE id = ?").run(Date.now(), id);
}

export interface ItemEdits {
  cluster?: string;
  tags?: string[];
  note?: string;
  description?: string;
  title?: string;
  kind?: Kind;
  body?: string;
  context?: string;
  highlights?: { text: string; at: string }[];
}

export function updateItem(id: string, edits: ItemEdits): StashItem | null {
  const db = getDb();
  const current = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as unknown as Row | undefined;
  if (!current) return null;

  const next = {
    cluster: edits.cluster ?? current.cluster,
    tags: edits.tags ? JSON.stringify(edits.tags) : current.tags,
    note: edits.note ?? current.note,
    description: edits.description ?? current.description,
    title: edits.title ?? current.title,
    kind: edits.kind ?? current.kind,
    body: edits.body ?? current.body,
    context: edits.context ?? current.context,
    highlights: edits.highlights ? JSON.stringify(edits.highlights) : current.highlights,
  };
  db.prepare("UPDATE items SET cluster = @cluster, tags = @tags, note = @note, description = @description, title = @title, kind = @kind, body = @body, context = @context, highlights = @highlights WHERE id = @id")
    .run({ ...next, id });

  if (edits.cluster && edits.cluster !== current.cluster) {
    const { x, y } = nextPositionForCluster(edits.cluster, current.stash_id!);
    db.prepare("UPDATE items SET x = ?, y = ? WHERE id = ?").run(x, y, id);
  }

  return rowToItem(db.prepare(
    "SELECT items.*, user.name AS created_by_name FROM items LEFT JOIN user ON user.id = items.created_by WHERE items.id = ?"
  ).get(id) as unknown as Row);
}

export function setEmbedding(id: string, embedding: number[]) {
  getDb().prepare("UPDATE items SET embedding = ? WHERE id = ?").run(JSON.stringify(embedding), id);
}

export function setRelated(id: string, related: string[]) {
  getDb().prepare("UPDATE items SET related = ? WHERE id = ?").run(JSON.stringify(related), id);
}

export function getItemsMissingEmbeddings(): { id: string; title: string; description: string; tags: string; note: string; highlights: string; body: string | null }[] {
  return getDb().prepare("SELECT id, title, description, tags, note, highlights, body FROM items WHERE embedding IS NULL AND deleted_at IS NULL").all() as {
    id: string; title: string; description: string; tags: string; note: string; highlights: string; body: string | null;
  }[];
}

export function getSearchableItems(stashId: string): { id: string; title: string; description: string; tags: string; embedding: string | null }[] {
  return getDb().prepare("SELECT id, title, description, tags, embedding FROM items WHERE stash_id = ? AND deleted_at IS NULL").all(stashId) as {
    id: string; title: string; description: string; tags: string; embedding: string | null;
  }[];
}

interface PlacementRow { cluster: string; x: number; y: number; w: number; is_text: number }

function itemHeight(r: { is_text: number }) {
  return r.is_text ? 130 : 210;
}

export function nextPositionForCluster(cluster: string, stashId: string): { x: number; y: number } {
  const all = getDb().prepare("SELECT cluster, x, y, w, is_text FROM items WHERE stash_id = ? AND deleted_at IS NULL").all(stashId) as unknown as PlacementRow[];
  const mine = all.filter((r) => r.cluster === cluster);
  if (!mine.length) return { x: 400, y: 400 };

  const left = Math.min(...mine.map((r) => r.x));
  let y = Math.max(...mine.map((r) => r.y + itemHeight(r))) + 40;
  const w = 196;
  const h = 210;

  const otherClusters = new Map<string, PlacementRow[]>();
  all.filter((r) => r.cluster !== cluster).forEach((r) => {
    if (!otherClusters.has(r.cluster)) otherClusters.set(r.cluster, []);
    otherClusters.get(r.cluster)!.push(r);
  });
  const otherBoxes = [...otherClusters.values()].map((rows) => ({
    x0: Math.min(...rows.map((r) => r.x)) - 40,
    y0: Math.min(...rows.map((r) => r.y)) - 82,
    x1: Math.max(...rows.map((r) => r.x + r.w)) + 40,
    y1: Math.max(...rows.map((r) => r.y + itemHeight(r))) + 40,
  }));

  const overlapsAny = (candidateY: number) =>
    otherBoxes.some((b) => left < b.x1 && left + w > b.x0 && candidateY < b.y1 && candidateY + h > b.y0);

  let guard = 0;
  while (overlapsAny(y) && guard < 20) {
    y += 60;
    guard++;
  }

  return { x: left, y };
}

export function insertItem(item: StashItem, bucket: string, createdAt: number, stashId: string, createdBy: string) {
  const db = getDb();
  const { n } = db.prepare("SELECT COALESCE(MAX(seed_order), 0) + 1 as n FROM items").get() as { n: number };
  db.prepare(`
    INSERT INTO items (id,kind,cluster,x,y,w,title,domain,kept,bucket,is_text,body,playhead,description,tags,highlights,note,related,context,created_at,seed_order,url,image,stash_id,created_by)
    VALUES (@id,@kind,@cluster,@x,@y,@w,@title,@domain,@kept,@bucket,@is_text,@body,@playhead,@description,@tags,@highlights,@note,@related,@context,@created_at,@seed_order,@url,@image,@stash_id,@created_by)
  `).run({
    id: item.id, kind: item.kind, cluster: item.cluster, x: item.x, y: item.y, w: item.w,
    title: item.title, domain: item.domain, kept: item.kept, bucket,
    is_text: item.isText ? 1 : 0, body: item.body ?? null, playhead: item.playhead ? 1 : 0,
    description: item.description, tags: JSON.stringify(item.tags), highlights: JSON.stringify(item.highlights),
    note: item.note, related: JSON.stringify(item.related), context: item.context,
    created_at: createdAt, seed_order: n,
    url: item.url ?? null, image: item.image ?? null, stash_id: stashId, created_by: createdBy,
  } satisfies Record<string, unknown>);
}

// The default folders every stash gets (also the keys seed items carry).
// Seeded on first read so pre-existing stashes upgrade in place; a stash
// that has any clusters at all is left alone.
const DEFAULT_CLUSTERS = ["A", "B", "C", "D"];

function ensureDefaultClusters(db: DatabaseSync, stashId: string) {
  const has = db.prepare("SELECT 1 FROM clusters WHERE stash_id = ? LIMIT 1").get(stashId);
  if (has) return;
  const now = Date.now();
  const insert = db.prepare("INSERT OR IGNORE INTO clusters (id, stash_id, name, created_at) VALUES (?, ?, ?, ?)");
  DEFAULT_CLUSTERS.forEach((key, i) => insert.run(key, stashId, CLUSTERS[key]?.name || key, now + i));
}

export function getClusters(stashId: string): { key: string; name: string; x: number; y: number }[] {
  const db = getDb();
  ensureDefaultClusters(db, stashId);
  const rows = db.prepare("SELECT id, name, x, y FROM clusters WHERE stash_id = ? ORDER BY created_at ASC").all(stashId) as { id: string; name: string; x: number; y: number }[];
  return rows.map((r) => ({ key: r.id, name: r.name, x: r.x, y: r.y }));
}

export function saveClusterPosition(stashId: string, key: string, x: number, y: number) {
  getDb().prepare("UPDATE clusters SET x = ?, y = ? WHERE id = ? AND stash_id = ?").run(x, y, key, stashId);
}

export function getClusterNames(stashId: string): Record<string, string> {
  return Object.fromEntries(getClusters(stashId).map((c) => [c.key, c.name]));
}

export function createCluster(stashId: string, name: string): { key: string; name: string } {
  const key = "u" + randomUUID().slice(0, 8);
  getDb().prepare("INSERT INTO clusters (id, stash_id, name, created_at) VALUES (?, ?, ?, ?)").run(key, stashId, name, Date.now());
  return { key, name };
}

export function renameCluster(stashId: string, key: string, name: string) {
  getDb().prepare("UPDATE clusters SET name = ? WHERE id = ? AND stash_id = ?").run(name, key, stashId);
}

export function deleteCluster(stashId: string, key: string) {
  getDb().prepare("DELETE FROM clusters WHERE id = ? AND stash_id = ?").run(key, stashId);
}

// Removing a folder's contents back to the desk (cluster → "") or to the
// trash. Both run before the folder row is deleted.
export function unclusterItems(stashId: string, key: string) {
  getDb().prepare("UPDATE items SET cluster = '' WHERE stash_id = ? AND cluster = ?").run(stashId, key);
}

export function trashItemsInCluster(stashId: string, key: string) {
  getDb().prepare("UPDATE items SET deleted_at = ? WHERE stash_id = ? AND cluster = ?").run(Date.now(), stashId, key);
}

// The text the "ask anything" card feeds the local model — the selected
// items if any were chosen, otherwise the whole stash (capped).
export function getStashTextForAsk(stashId: string, ids?: string[]): string {
  const rows = getDb().prepare(
    "SELECT id, title, description, tags, note, body FROM items WHERE stash_id = ? AND deleted_at IS NULL"
  ).all(stashId) as { id: string; title: string; description: string; tags: string; note: string; body: string | null }[];
  const picked = ids && ids.length ? rows.filter((r) => ids.includes(r.id)) : rows;
  return picked.slice(0, 20).map((r) => {
    const parts = [r.title];
    if (r.description) parts.push(r.description.slice(0, 200));
    const tags = JSON.parse(r.tags) as string[];
    if (tags.length) parts.push("tags: " + tags.join(", "));
    if (r.note) parts.push("note: " + r.note.slice(0, 200));
    if (r.body) parts.push(r.body.slice(0, 200));
    return "- " + parts.join(" | ");
  }).join("\n");
}

export interface Stash { id: string; name: string; description: string; ownerType: "user" | "organization"; ownerId: string; createdAt: number }

interface StashRow { id: string; name: string; description: string; owner_type: string; owner_id: string; created_at: number }

function rowToStash(r: StashRow): Stash {
  return { id: r.id, name: r.name, description: r.description, ownerType: r.owner_type as "user" | "organization", ownerId: r.owner_id, createdAt: r.created_at };
}

export function createStash(name: string, description: string, ownerType: "user" | "organization", ownerId: string): Stash {
  const id = randomUUID();
  const createdAt = Date.now();
  getDb().prepare("INSERT INTO stashes (id, name, description, owner_type, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, description, ownerType, ownerId, createdAt);
  return { id, name, description, ownerType, ownerId, createdAt };
}

export function getStash(id: string): Stash | null {
  const row = getDb().prepare("SELECT * FROM stashes WHERE id = ?").get(id) as unknown as StashRow | undefined;
  return row ? rowToStash(row) : null;
}

export function updateStash(id: string, edits: { name?: string; description?: string }): Stash | null {
  const db = getDb();
  const current = db.prepare("SELECT * FROM stashes WHERE id = ?").get(id) as unknown as StashRow | undefined;
  if (!current) return null;
  const name = edits.name ?? current.name;
  const description = edits.description ?? current.description;
  db.prepare("UPDATE stashes SET name = ?, description = ? WHERE id = ?").run(name, description, id);
  return rowToStash({ ...current, name, description });
}

export function listStashesForOwner(ownerType: "user" | "organization", ownerId: string): Stash[] {
  const rows = getDb().prepare("SELECT * FROM stashes WHERE owner_type = ? AND owner_id = ? ORDER BY created_at ASC").all(ownerType, ownerId) as unknown as StashRow[];
  return rows.map(rowToStash);
}

// Two welcome cards dropped on a brand-new user's very first stash, so the
// empty desk explains itself. Plain note items — read them, drag them, or
// delete them like anything else. Ids are globally unique and only ever
// seeded once (guarded by the caller's "first stash" check), so they can't
// collide. Marks the stash as seeded so the boot-time backfill never
// re-seeds into an intentionally-emptied first stash.
export function seedStarterCards(stashId: string, createdBy: string) {
  const now = Date.now();
  const cards: StashItem[] = [
    {
      id: "welcome-1", kind: "note", cluster: "", x: 420, y: 200, w: 200,
      title: "Welcome to Stashdrop", domain: "stashdrop", kept: "just now",
      isText: true, body: "Everything you keep lands on this desk. Drag cards to arrange them, drop things into folders, and scroll to zoom out over it all.",
      description: "", tags: [], highlights: [], note: "", related: [], context: "",
      url: undefined, image: undefined,
    },
    {
      id: "welcome-2", kind: "note", cluster: "", x: 420, y: 430, w: 200,
      title: "Things to try", domain: "stashdrop", kept: "just now",
      isText: true, body: "Paste a link in the search bar to keep it. Drop an image or PDF straight onto the desk. Ask anything with the sparkle tool. Shift-drag to select a group, then ask about it. Press ⌘K to search.",
      description: "", tags: [], highlights: [], note: "", related: [], context: "",
      url: undefined, image: undefined,
    },
  ];
  cards.forEach((item, i) => insertItem(item, "This week", now + i, stashId, createdBy));
  getDb().prepare("UPDATE stashes SET starter_seeded = 1 WHERE id = ?").run(stashId);
}

// Heals stashes that missed the welcome cards — the onboarding bug where
// the "first stash" check ran after createStash, or pre-feature first
// stashes. Targets only a stash that is its owner's earliest AND empty AND
// not yet flagged; once seeded it's flagged, so an intentionally-emptied
// first stash never gets them again.
export function backfillStarterCards() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.id
    FROM stashes s
    WHERE s.starter_seeded IS NULL
      AND NOT EXISTS (SELECT 1 FROM items i WHERE i.stash_id = s.id)
      AND NOT EXISTS (
        SELECT 1 FROM stashes s2
        WHERE s2.owner_type = s.owner_type AND s2.owner_id = s.owner_id
          AND s2.created_at < s.created_at
      )
  `).all() as { id: string }[];
  for (const row of rows) {
    seedStarterCards(row.id, "system");
  }
}

// Relocates an item into a different stash — the item keeps its own
// position/cluster, so it lands in the target stash's desk wherever those
// coordinates happen to fall (same as a plain drag once it's there).
export function moveItemToStash(id: string, stashId: string): void {
  getDb().prepare("UPDATE items SET stash_id = ? WHERE id = ?").run(stashId, id);
}

// The "current stash" for a signed-in user, resolved fresh from the DB
// every time — never trust a client-held id for this (a cookie set by one
// account and left in the browser would silently hand its data to whoever
// logs in next). `activeOrganizationId` is better-auth's own pointer for
// which workspace a session currently has selected (see session.ts) — null
// means the user's personal workspace. A non-null value is only ever
// trusted after re-checking membership right here: setActiveOrganization
// verified it at the time it was set, but that pointer sits in a
// long-lived session and membership can be revoked afterward (removed from
// a team) — every caller of this function is, in effect, re-running that
// check on every request, which is what actually keeps a removed member
// from still reading (or writing to) a team's stash. A workspace can hold
// several stashes — preferredStashId (the caller's last-picked one, read
// from a cookie) wins as long as it actually belongs to that workspace;
// otherwise this falls back to the earliest-created one, same as before
// that selection existed.
export function getStashForWorkspace(userId: string, activeOrganizationId: string | null, preferredStashId?: string | null): Stash | null {
  const db = getDb();
  const orgId = resolveActiveOrg(userId, activeOrganizationId);
  const ownerType = orgId ? "organization" : "user";
  const ownerId = orgId ?? userId;

  if (preferredStashId) {
    const preferred = db.prepare("SELECT * FROM stashes WHERE id = ? AND owner_type = ? AND owner_id = ?").get(preferredStashId, ownerType, ownerId) as unknown as StashRow | undefined;
    if (preferred) return rowToStash(preferred);
  }

  const row = db.prepare("SELECT * FROM stashes WHERE owner_type = ? AND owner_id = ? ORDER BY created_at ASC LIMIT 1").get(ownerType, ownerId) as unknown as StashRow | undefined;
  return row ? rowToStash(row) : null;
}

// A workspace's owner/admin/member role for permission checks (deleting
// someone else's bookmark, deleting the stash, managing members) —
// queried straight from better-auth's own `member` table, same pattern the
// org join above used to use. Null for a personal workspace (no `member`
// row exists there — the caller is always its sole, full owner).
export function getOrgRole(organizationId: string, userId: string): string | null {
  const row = getDb().prepare("SELECT role FROM member WHERE organizationId = ? AND userId = ?").get(organizationId, userId) as { role: string } | undefined;
  return row?.role ?? null;
}

export function getOrgName(organizationId: string): string | null {
  const row = getDb().prepare("SELECT name FROM organization WHERE id = ?").get(organizationId) as { name: string } | undefined;
  return row?.name ?? null;
}

// The single choke point every route/action resolves a session's active
// organization through — a session's activeOrganizationId is only trusted
// if the user is still, right now, a member of that org. Anywhere this
// returns null is treated exactly like the personal workspace was active
// all along, which is what actually stops a removed member from still
// reading (or writing to) a team's stash after the fact.
export function resolveActiveOrg(userId: string, activeOrganizationId: string | null): string | null {
  return activeOrganizationId && getOrgRole(activeOrganizationId, userId) ? activeOrganizationId : null;
}

// True when the user already has at least one workspace anywhere (a personal
// stash, or membership in an org that has a stash). Tells a brand-new
// sign-up — who still needs the full "Personal or team" onboarding choice —
// apart from an existing user switching into a workspace that has no stash
// yet, where the workspace is already decided and only the stash name is
// needed.
export function hasAnyWorkspace(userId: string): boolean {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM stashes WHERE owner_type = 'user' AND owner_id = ? LIMIT 1").get(userId)) return true;
  return !!db.prepare(
    "SELECT 1 FROM stashes s JOIN member m ON m.organizationId = s.owner_id WHERE s.owner_type = 'organization' AND m.userId = ? LIMIT 1"
  ).get(userId);
}

export function getFirstStashForOrg(organizationId: string): Stash | null {
  const row = getDb().prepare(
    "SELECT * FROM stashes WHERE owner_type = 'organization' AND owner_id = ? ORDER BY created_at ASC LIMIT 1"
  ).get(organizationId) as unknown as StashRow | undefined;
  return row ? rowToStash(row) : null;
}

export function getItemOwner(id: string): { createdBy: string | null; stashId: string } | null {
  const row = getDb().prepare("SELECT created_by, stash_id FROM items WHERE id = ?").get(id) as { created_by: string | null; stash_id: string } | undefined;
  return row ? { createdBy: row.created_by, stashId: row.stash_id } : null;
}

// Deletes one stash and everything in it — used when an owner deletes the
// current stash from settings. If it was the workspace's last stash, the
// next page load resolves no active stash and onboarding invites the user
// to make a fresh one.
export function deleteStash(stashId: string) {
  const db = getDb();
  db.prepare("DELETE FROM item_comments WHERE item_id IN (SELECT id FROM items WHERE stash_id = ?)").run(stashId);
  db.prepare("DELETE FROM items WHERE stash_id = ?").run(stashId);
  db.prepare("DELETE FROM stashes WHERE id = ?").run(stashId);
}

export interface ItemComment { id: string; itemId: string; userId: string; userName: string; body: string; createdAt: number }

export function addItemComment(itemId: string, userId: string, body: string): ItemComment {
  const id = randomUUID();
  const createdAt = Date.now();
  getDb().prepare("INSERT INTO item_comments (id, item_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)").run(id, itemId, userId, body, createdAt);
  const user = getDb().prepare("SELECT name FROM user WHERE id = ?").get(userId) as { name: string } | undefined;
  return { id, itemId, userId, userName: user?.name ?? "Someone", body, createdAt };
}

export function listItemComments(itemId: string): ItemComment[] {
  const rows = getDb().prepare(`
    SELECT item_comments.id, item_comments.item_id, item_comments.user_id, item_comments.body, item_comments.created_at, user.name AS user_name
    FROM item_comments JOIN user ON user.id = item_comments.user_id
    WHERE item_comments.item_id = ? ORDER BY item_comments.created_at ASC
  `).all(itemId) as { id: string; item_id: string; user_id: string; body: string; created_at: number; user_name: string }[];
  return rows.map((r) => ({ id: r.id, itemId: r.item_id, userId: r.user_id, userName: r.user_name, body: r.body, createdAt: r.created_at }));
}
