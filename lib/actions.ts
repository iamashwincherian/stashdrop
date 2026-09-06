"use server";

import { randomUUID } from "node:crypto";
import { fetchPageMeta, detectKind } from "./fetchMeta";
import { enrichWithOllama, askWithOllama } from "./ollama";
import { embedText, cosineSimilarity } from "./embeddings";
import { PDFParse } from "pdf-parse";
import {
  getDb,
  insertItem,
  nextPositionForCluster,
  savePosition as savePositionDb,
  deleteItem as deleteItemDb,
  trashItem as trashItemDb,
  restoreItem as restoreItemDb,
  emptyTrash as emptyTrashDb,
  getTrashedItems,
  findByUrl,
  updateItem as updateItemDb,
  setEmbedding,
  setRelated,
  getItemsMissingEmbeddings,
  getSearchableItems,
  getItemWithMeta,
  getItemOwner,
  getStash,
  getClusters,
  createCluster,
  renameCluster,
  deleteCluster,
  unclusterItems,
  trashItemsInCluster,
  saveClusterPosition,
  getStashTextForAsk,
  backfillStarterCards,
  moveItemToStash as moveItemToStashDb,
  markEnriched,
  addItemComment as addItemCommentDb,
  listItemComments as listItemCommentsDb,
  type ItemEdits,
  type ItemComment,
} from "./db";
import { CLUSTERS, type StashItem } from "./data";
import { requireStashId, requireSession, requireRole } from "./session";

// Every action that touches an existing item funnels through here first —
// the single place that enforces "this item belongs to the workspace I'm
// currently in." requireStashId() already re-verifies the caller is still
// a member of their active organization on every call (see
// resolveActiveOrg in db.ts), so a removed member's stash resolves back to
// their personal one — this then makes sure the specific item they're
// trying to touch is actually inside that resolved stash, not some other
// workspace's. Without it, an item id alone would be enough to reach
// across workspaces, membership check or not.
async function requireItemInCurrentStash(id: string): Promise<{ createdBy: string | null; stashId: string }> {
  const stashId = await requireStashId();
  const owner = getItemOwner(id);
  if (!owner || owner.stashId !== stashId) throw new Error("Not found");
  return owner;
}

// A "user" may only remove what they created; admin/owner may remove
// anything in the workspace. Items with no known creator (seed data,
// anything captured before this existed) are admin/owner-only.
async function requireCanDelete(id: string) {
  const owner = await requireItemInCurrentStash(id);
  const session = await requireSession();
  if (owner.createdBy === session.user.id) return;
  const role = await requireRole();
  if (role === "owner" || role === "admin") return;
  throw new Error("You can only delete bookmarks you added");
}

export type KeepResult = { item: StashItem; clusterName: string } | { duplicate: StashItem };

function embeddingText(fields: { title: string; description: string; tags: string[]; note?: string; body?: string; highlights?: { text: string }[] }) {
  const highlightText = (fields.highlights || []).map((h) => h.text).join("\n");
  return [`search_document: ${fields.title}`, fields.description, fields.body, fields.tags.join(", "), fields.note, highlightText]
    .filter(Boolean)
    .join("\n");
}

const RELATED_THRESHOLD = 0.55;
const RELATED_LIMIT = 3;

// Finds the closest existing items by embedding similarity and links this
// item to them (one-directional — doesn't rewrite the neighbors' own
// `related` lists, to keep this cheap and avoid runaway fan-out as the
// stash grows).
async function linkRelated(id: string, vector: number[], stashId: string): Promise<string[]> {
  const others = getSearchableItems(stashId).filter((r) => r.id !== id && r.embedding);
  const scored = others
    .map((r) => ({ id: r.id, score: cosineSimilarity(vector, JSON.parse(r.embedding!)) }))
    .filter((r) => r.score > RELATED_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, RELATED_LIMIT);
  const ids = scored.map((r) => r.id);
  if (ids.length) setRelated(id, ids);
  return ids;
}

// Keeping a link used to mean: fetch the page, THEN wait on a local LLM to
// classify/tag/describe it, THEN write the row — the user stared at a
// shimmer the whole time. Now it only waits on the fast part (the page
// fetch) and inserts immediately with a plain fallback (undated folder,
// domain-derived description, no tags yet); enrichWithOllama runs after
// this function has already returned, and patches the row in place
// whenever it finishes. getItem/markEnriched below are how the client
// notices that patch and applies it wherever the item currently lives.
export async function keepUrl(rawUrl: string): Promise<KeepResult> {
  const stashId = await requireStashId();
  const session = await requireSession();

  let meta: Awaited<ReturnType<typeof fetchPageMeta>>;
  try {
    meta = await fetchPageMeta(rawUrl);
  } catch {
    // Couldn't fetch it at all (network error, blocked host, timeout) —
    // still keep it. Worst case the card just shows the raw URL.
    let domain = rawUrl;
    try { domain = new URL(rawUrl).hostname.replace(/^www\./, ""); } catch { /* keep raw url as fallback */ }
    meta = { url: rawUrl, title: rawUrl, domain, description: "", textSample: "", contentType: "", image: null };
  }

  const existing = findByUrl(meta.url, stashId);
  if (existing) return { duplicate: existing };

  let kind: StashItem["kind"] = "article";
  try { kind = detectKind(meta.url, meta.contentType); } catch { /* malformed url fallback stays "article" */ }

  // New keeps land on the desk unsorted — folders are now real desk objects
  // you drag things into, so auto-filing a fresh keep into folder "D" would
  // make it vanish into a folder the moment it lands.
  const cluster = "";
  const { x, y } = nextPositionForCluster(cluster, stashId);
  const item: StashItem = {
    id: "n" + randomUUID().slice(0, 8),
    kind, cluster, x, y, w: 196,
    title: meta.title || rawUrl,
    domain: meta.domain || rawUrl,
    kept: "just now",
    description: meta.description, tags: [], highlights: [], note: "", related: [],
    context: "Saved just now, not sorted by hand yet.",
    url: meta.url, image: meta.image ?? undefined,
    createdById: session.user.id, createdByName: session.user.name,
  };

  insertItem(item, "This week", Date.now(), stashId, session.user.id);
  void enrichItemInBackground(item.id, meta, stashId);

  return { item, clusterName: CLUSTERS[cluster]?.name || "Unsorted" };
}

// Fired without being awaited by keepUrl — runs on its own time in this
// (long-lived, non-serverless) dev/prod Node process. Deliberately never
// touches cluster/x/y: reassigning the folder after the card has already
// landed (or is being held as a ghost) would yank it out from under the
// user, which is worse than leaving it in Unsorted.
async function enrichItemInBackground(id: string, meta: { title: string; domain: string; description: string; textSample: string }, stashId: string) {
  try {
    const enrichment = await enrichWithOllama({
      title: meta.title, domain: meta.domain, description: meta.description, textSample: meta.textSample,
      clusters: getClusters(stashId),
    });
    if (!enrichment) return;

    const updated = updateItemDb(id, {
      tags: enrichment.tags,
      description: enrichment.description || meta.description || undefined,
      context: enrichment.context,
      highlights: enrichment.highlights,
    });
    if (!updated) return;

    const vector = await embedText(embeddingText(updated));
    if (vector) {
      setEmbedding(id, vector);
      await linkRelated(id, vector, stashId);
    }
  } finally {
    markEnriched(id);
  }
}

// Polled by the client after a capture, to notice enrichItemInBackground
// landing and patch whatever's currently showing this item — pending
// panel, held ghost, or already-placed card.
export async function getItem(id: string): Promise<{ item: StashItem; enrichedAt: number | null } | null> {
  await requireItemInCurrentStash(id);
  return getItemWithMeta(id);
}

export async function savePosition(id: string, x: number, y: number) {
  await requireItemInCurrentStash(id);
  savePositionDb(id, x, y);
}

// A freeform sticky note — unlike kept links, it isn't AI-classified or
// filed into a folder (cluster stays empty so it doesn't distort any
// folder's bounding box); it just floats wherever it was dropped.
// Dropped blank — the ghost-comment flow places it first and lets the
// user type the title straight into the card; the author is whoever's
// signed in, not a name they type themselves.
export async function addComment(x: number, y: number): Promise<StashItem> {
  const stashId = await requireStashId();
  const session = await requireSession();
  const item: StashItem = {
    id: "c" + randomUUID().slice(0, 8),
    kind: "comment", cluster: "", x, y, w: 200,
    title: "",
    domain: session.user.name || "Anonymous",
    kept: "just now",
    isText: true, body: "",
    description: "", tags: [], highlights: [], note: "", related: [], context: "",
    createdById: session.user.id, createdByName: session.user.name,
  };
  insertItem(item, "This week", Date.now(), stashId, session.user.id);
  return item;
}

// A file dropped or pasted straight onto the desk — image files are kept
// in full as a data URL (the local SQLite can hold them fine); PDFs are
// kept the same way, in the same `image` payload column, so the original
// file is never lost and can be opened right from the card. A PDF also
// gets an AI summary written into its description in the background, at
// upload time (see summarizePdfInBackground).
export async function keepFile(name: string, dataUrl: string, x: number, y: number): Promise<StashItem> {
  const stashId = await requireStashId();
  const session = await requireSession();
  if (dataUrl.length > 25_000_000) throw new Error("That file is too big to keep");
  const isImage = dataUrl.startsWith("data:image/");
  const item: StashItem = {
    id: "f" + randomUUID().slice(0, 8),
    kind: isImage ? "image" : "pdf", cluster: "", x, y, w: 196,
    title: name.replace(/\.[^.]+$/, "") || (isImage ? "Dropped image" : "Dropped file"),
    domain: isImage ? "dropped image" : "dropped file",
    kept: "just now",
    isText: false, body: "",
    description: "", tags: [], highlights: [], note: "", related: [], context: "Dropped straight onto the desk.",
    image: dataUrl,
    url: undefined,
    createdById: session.user.id, createdByName: session.user.name,
  };
  insertItem(item, "This week", Date.now(), stashId, session.user.id);
  if (!isImage) void summarizePdfInBackground(item.id);
  return item;
}

// Extracts the plain text out of a stored PDF data URL (pdf-parse / pdf.js).
async function extractPdfText(dataUrl: string): Promise<string> {
  const base64 = dataUrl.split(",")[1];
  if (!base64) return "";
  const parse = new PDFParse({ data: Buffer.from(base64, "base64") });
  try {
    const result = await parse.getText();
    return (result.text || "").trim().slice(0, 8000);
  } finally {
    await parse.destroy();
  }
}

// Fired without being awaited by keepFile: reads the stored PDF back out,
// summarizes it with the local model, and writes the summary into the
// item's description (which the card modal shows). markEnriched stops the
// client's enrichment poll whether or not it succeeded.
async function summarizePdfInBackground(itemId: string) {
  try {
    const row = getItemWithMeta(itemId);
    if (!row?.item.image) return;
    const text = await extractPdfText(row.item.image);
    if (!text) {
      updateItemDb(itemId, { description: "Couldn't extract text from this PDF, so there's nothing to summarize." });
      return;
    }
    const summary = await askWithOllama("Summarize this document in two or three sentences.", text);
    if (summary) updateItemDb(itemId, { description: summary.slice(0, 500) });
  } catch {
    // keep the row as-is; the client poll just stops
  } finally {
    markEnriched(itemId);
  }
}

// A user-created folder — a named region the AI can file new saves into and
// the user can move cards into by hand.
export async function createFolder(name: string): Promise<{ key: string; name: string }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Folder needs a name");
  const stashId = await requireStashId();
  return createCluster(stashId, trimmed);
}

export async function saveFolderPosition(key: string, x: number, y: number): Promise<void> {
  const stashId = await requireStashId();
  saveClusterPosition(stashId, key, x, y);
}

export async function renameFolder(key: string, name: string): Promise<{ key: string; name: string } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const stashId = await requireStashId();
  renameCluster(stashId, key, trimmed);
  return { key, name: trimmed };
}

// Deleting a folder — first decide what happens to the items inside:
// "keep" unlinks them back onto the desk, "delete" moves them to the trash.
// Either way the folder row itself is removed afterwards.
export async function deleteFolder(key: string, mode: "keep" | "delete"): Promise<void> {
  const stashId = await requireStashId();
  if (mode === "keep") unclusterItems(stashId, key);
  else trashItemsInCluster(stashId, key);
  deleteCluster(stashId, key);
}

// The "ask anything" card — a blank question that follows the cursor,
// placed like a comment, then typed into and answered by the local model.
export async function addAsk(x: number, y: number): Promise<StashItem> {
  const stashId = await requireStashId();
  const session = await requireSession();
  const item: StashItem = {
    id: "q" + randomUUID().slice(0, 8),
    kind: "ask", cluster: "", x, y, w: 210,
    title: "",
    domain: session.user.name || "Ask",
    kept: "just now",
    isText: true, body: "",
    description: "", tags: [], highlights: [], note: "", related: [], context: "",
    createdById: session.user.id, createdByName: session.user.name,
  };
  insertItem(item, "This week", Date.now(), stashId, session.user.id);
  return item;
}

// Runs the ask card's question through the local model, grounded in the
// selected items (or the whole stash), and stores question + answer on
// the card itself.
export async function askQuestion(itemId: string, question: string, itemIds: string[]): Promise<StashItem | null> {
  await requireItemInCurrentStash(itemId);
  const stashId = await requireStashId();
  const context = getStashTextForAsk(stashId, itemIds);
  const answer = await askWithOllama(question.trim(), context);
  return updateItemDb(itemId, {
    title: question.trim(),
    body: answer ?? "The local model didn't respond — check that Ollama is running.",
  });
}

export async function deleteItem(id: string) {
  await requireCanDelete(id);
  deleteItemDb(id);
}

export async function trashItem(id: string) {
  await requireCanDelete(id);
  trashItemDb(id);
}

export async function restoreItem(id: string) {
  await requireItemInCurrentStash(id);
  restoreItemDb(id);
}

export async function emptyTrash() {
  emptyTrashDb(await requireStashId());
}

export async function listTrash(): Promise<(StashItem & { deletedAt: number })[]> {
  return getTrashedItems(await requireStashId());
}

// Relocates an item into a different stash in the same workspace — same
// access rule as editing a bookmark's fields (any member who can see it
// may move it), not the stricter creator-or-admin rule delete uses, since
// nothing is lost, just refiled.
export async function moveItemToStash(id: string, targetStashId: string): Promise<void> {
  const { stashId: currentId } = await requireItemInCurrentStash(id);
  const current = getStash(currentId);
  const target = getStash(targetStashId);
  if (!current || !target || target.ownerId !== current.ownerId || target.ownerType !== current.ownerType) throw new Error("Stash not found");
  moveItemToStashDb(id, targetStashId);
}

export async function updateItemFields(id: string, edits: ItemEdits): Promise<StashItem | null> {
  await requireItemInCurrentStash(id);
  const updated = updateItemDb(id, edits);
  if (!updated) return null;
  const vector = await embedText(embeddingText(updated));
  if (vector) setEmbedding(id, vector);
  return updated;
}

export interface SearchHit {
  id: string;
  score: number;
}

export async function searchItems(query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];

  const rows = getSearchableItems(await requireStashId());
  const qVector = await embedText(`search_query: ${q}`);

  if (qVector) {
    const scored = rows
      .filter((r) => r.embedding)
      .map((r) => ({ id: r.id, score: cosineSimilarity(qVector, JSON.parse(r.embedding!)) }))
      .filter((r) => r.score > 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    if (scored.length) return scored;
  }

  // fallback (Ollama down, or nothing embedded/similar enough): match if
  // every query word appears somewhere in the item's text — a literal
  // multi-word phrase match is too strict for natural-language queries
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  return rows
    .map((r) => {
      const text = `${r.title} ${r.description} ${r.tags}`.toLowerCase();
      const hitCount = words.filter((w) => text.includes(w)).length;
      return { id: r.id, score: hitCount / words.length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

// Discussion thread on a bookmark — distinct from the "comment" item kind
// above (a sticky note on the canvas). Any workspace member can post; no
// delete/edit yet, this is discussion, not a moderated log.
export async function addItemComment(itemId: string, body: string): Promise<ItemComment> {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Comment can't be empty");
  await requireItemInCurrentStash(itemId);
  const session = await requireSession();
  return addItemCommentDb(itemId, session.user.id, trimmed);
}

export async function listItemComments(itemId: string): Promise<ItemComment[]> {
  await requireItemInCurrentStash(itemId);
  return listItemCommentsDb(itemId);
}

async function backfillEmbeddings() {
  const missing = getItemsMissingEmbeddings();
  for (const row of missing) {
    const vector = await embedText(embeddingText({
      title: row.title, description: row.description, tags: JSON.parse(row.tags),
      note: row.note, body: row.body || undefined, highlights: JSON.parse(row.highlights),
    }));
    if (vector) setEmbedding(row.id, vector);
  }
}

// Self-heals PDFs whose summary never landed (older drops before the
// feature existed, or a failed background pass) — retried every boot until
// a description shows up. markEnriched runs either way, so a PDF that
// genuinely has no text settles on the fallback note and stops retrying.
async function backfillPdfSummaries() {
  const rows = getDb().prepare(
    "SELECT id FROM items WHERE kind = 'pdf' AND image IS NOT NULL AND description = ''"
  ).all() as { id: string }[];
  for (const row of rows) {
    await summarizePdfInBackground(row.id);
  }
}

// touch getDb so the module (and its seed step) initializes even if no
// mutation has happened yet on this server instance, then backfill any
// items (seed data, or rows written before embeddings existed) missing one
void getDb();
void backfillEmbeddings();
void backfillPdfSummaries();
void backfillStarterCards();
