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

-- A project is owned either by a single user (personal) or by a
-- better-auth organization (team) — owner_type/owner_id together point at
-- one of those, never both. Projects hold stashes; stashes hold items.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stashes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
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
];

interface Row {
  id: string; kind: string; cluster: string; x: number; y: number; w: number;
  title: string; domain: string; kept: string; bucket: string; is_text: number;
  body: string | null; playhead: number; description: string; tags: string;
  highlights: string; note: string; related: string; context: string;
  created_at: number; seed_order: number; url: string | null; image: string | null;
  embedding: string | null; deleted_at: number | null; enriched_at: number | null;
  stash_id: string | null;
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
  };
}

function ensureColumn(db: DatabaseSync, column: string, def: string) {
  const cols = db.prepare("PRAGMA table_info(items)").all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE items ADD COLUMN ${column} ${def}`);
  }
}

function seedIfEmpty(db: DatabaseSync) {
  const { n } = db.prepare("SELECT COUNT(*) as n FROM items").get() as { n: number };
  if (n > 0) return;
  const insert = db.prepare(`
    INSERT INTO items (id,kind,cluster,x,y,w,title,domain,kept,bucket,is_text,body,playhead,description,tags,highlights,note,related,context,created_at,seed_order)
    VALUES (@id,@kind,@cluster,@x,@y,@w,@title,@domain,@kept,@bucket,@is_text,@body,@playhead,@description,@tags,@highlights,@note,@related,@context,@created_at,@seed_order)
  `);
  const now = Date.now();
  OBJ.forEach((o, i) => {
    insert.run({
      id: o.id, kind: o.kind, cluster: o.cluster, x: o.x, y: o.y, w: o.w,
      title: o.title, domain: o.domain, kept: o.kept, bucket: BUCKET[o.id] || "This week",
      is_text: o.isText ? 1 : 0, body: o.body ?? null, playhead: o.playhead ? 1 : 0,
      description: o.description, tags: JSON.stringify(o.tags), highlights: JSON.stringify(o.highlights),
      note: o.note, related: JSON.stringify(o.related), context: o.context,
      created_at: now - (RECENT.indexOf(o.id) < 0 ? RECENT.length : RECENT.indexOf(o.id)) * 3_600_000,
      seed_order: i,
    });
  });
}

export function getDb(): DatabaseSync {
  if (!globalThis.__stashdropDb) {
    const db = new DatabaseSync(path.join(process.cwd(), "stashdrop.db"));
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    MIGRATIONS.forEach(([column, def]) => ensureColumn(db, column, def));
    seedIfEmpty(db);
    globalThis.__stashdropDb = db;
  }
  return globalThis.__stashdropDb;
}

export function getAllItemsWithMeta(stashId: string) {
  const db = getDb();
  const items = (db.prepare("SELECT * FROM items WHERE stash_id = ? AND deleted_at IS NULL ORDER BY seed_order ASC").all(stashId) as unknown as Row[]).map(rowToItem);
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

  return rowToItem(db.prepare("SELECT * FROM items WHERE id = ?").get(id) as unknown as Row);
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

export function insertItem(item: StashItem, bucket: string, createdAt: number, stashId: string) {
  const db = getDb();
  const { n } = db.prepare("SELECT COALESCE(MAX(seed_order), 0) + 1 as n FROM items").get() as { n: number };
  db.prepare(`
    INSERT INTO items (id,kind,cluster,x,y,w,title,domain,kept,bucket,is_text,body,playhead,description,tags,highlights,note,related,context,created_at,seed_order,url,image,stash_id)
    VALUES (@id,@kind,@cluster,@x,@y,@w,@title,@domain,@kept,@bucket,@is_text,@body,@playhead,@description,@tags,@highlights,@note,@related,@context,@created_at,@seed_order,@url,@image,@stash_id)
  `).run({
    id: item.id, kind: item.kind, cluster: item.cluster, x: item.x, y: item.y, w: item.w,
    title: item.title, domain: item.domain, kept: item.kept, bucket,
    is_text: item.isText ? 1 : 0, body: item.body ?? null, playhead: item.playhead ? 1 : 0,
    description: item.description, tags: JSON.stringify(item.tags), highlights: JSON.stringify(item.highlights),
    note: item.note, related: JSON.stringify(item.related), context: item.context,
    created_at: createdAt, seed_order: n,
    url: item.url ?? null, image: item.image ?? null, stash_id: stashId,
  } satisfies Record<string, unknown>);
}

export const clusterList = Object.entries(CLUSTERS).map(([key, v]) => ({ key, name: v.name }));

export interface Project { id: string; name: string; description: string; ownerType: string; ownerId: string; createdAt: number }
export interface Stash { id: string; projectId: string; name: string; createdAt: number }

interface ProjectRow { id: string; name: string; description: string; owner_type: string; owner_id: string; created_at: number }
interface StashRow { id: string; project_id: string; name: string; created_at: number }

function rowToProject(r: ProjectRow): Project {
  return { id: r.id, name: r.name, description: r.description, ownerType: r.owner_type, ownerId: r.owner_id, createdAt: r.created_at };
}
function rowToStash(r: StashRow): Stash {
  return { id: r.id, projectId: r.project_id, name: r.name, createdAt: r.created_at };
}

export function createProject(name: string, description: string, ownerType: "user" | "organization", ownerId: string): Project {
  const id = randomUUID();
  const createdAt = Date.now();
  getDb().prepare("INSERT INTO projects (id, name, description, owner_type, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, name, description, ownerType, ownerId, createdAt);
  return { id, name, description, ownerType, ownerId, createdAt };
}

export function getProject(id: string): Project | null {
  const row = getDb().prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export function updateProject(id: string, edits: { name?: string; description?: string }): Project | null {
  const db = getDb();
  const current = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow | undefined;
  if (!current) return null;
  const name = edits.name ?? current.name;
  const description = edits.description ?? current.description;
  db.prepare("UPDATE projects SET name = ?, description = ? WHERE id = ?").run(name, description, id);
  return rowToProject({ ...current, name, description });
}

export function createStash(projectId: string, name: string): Stash {
  const db = getDb();
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare("INSERT INTO stashes (id, project_id, name, created_at) VALUES (?, ?, ?, ?)").run(id, projectId, name, createdAt);

  // ponytail: the very first stash this install ever creates claims all
  // pre-auth demo items (stash_id still NULL) so the first person to sign
  // up doesn't land on an empty canvas. Every stash after that starts empty
  // — a real "duplicate/import a stash" flow would replace this.
  const { n } = db.prepare("SELECT COUNT(*) as n FROM stashes").get() as { n: number };
  if (n === 1) db.prepare("UPDATE items SET stash_id = ? WHERE stash_id IS NULL").run(id);

  return { id, projectId, name, createdAt };
}

export function getStash(id: string): Stash | null {
  const row = getDb().prepare("SELECT * FROM stashes WHERE id = ?").get(id) as unknown as StashRow | undefined;
  return row ? rowToStash(row) : null;
}
