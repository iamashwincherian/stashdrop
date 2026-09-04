"use server";

import { randomUUID } from "node:crypto";
import { fetchPageMeta, detectKind } from "./fetchMeta";
import { enrichWithOllama } from "./ollama";
import { embedText, cosineSimilarity } from "./embeddings";
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
  markEnriched,
  clusterList,
  type ItemEdits,
} from "./db";
import { CLUSTERS, type StashItem } from "./data";
import { requireStashId } from "./session";

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
// fetch) and inserts immediately with a plain fallback (undated pile,
// domain-derived description, no tags yet); enrichWithOllama runs after
// this function has already returned, and patches the row in place
// whenever it finishes. getItem/markEnriched below are how the client
// notices that patch and applies it wherever the item currently lives.
export async function keepUrl(rawUrl: string): Promise<KeepResult> {
  const stashId = await requireStashId();

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

  const cluster = "D";
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
  };

  insertItem(item, "This week", Date.now(), stashId);
  void enrichItemInBackground(item.id, meta, stashId);

  return { item, clusterName: CLUSTERS[cluster]?.name || "Unsorted" };
}

// Fired without being awaited by keepUrl — runs on its own time in this
// (long-lived, non-serverless) dev/prod Node process. Deliberately never
// touches cluster/x/y: reassigning the pile after the card has already
// landed (or is being held as a ghost) would yank it out from under the
// user, which is worse than leaving it in Unsorted.
async function enrichItemInBackground(id: string, meta: { title: string; domain: string; description: string; textSample: string }, stashId: string) {
  try {
    const enrichment = await enrichWithOllama({
      title: meta.title, domain: meta.domain, description: meta.description, textSample: meta.textSample,
      clusters: clusterList,
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
  return getItemWithMeta(id);
}

export async function savePosition(id: string, x: number, y: number) {
  savePositionDb(id, x, y);
}

// A freeform sticky note — unlike kept links, it isn't AI-classified or
// filed into a pile (cluster stays empty so it doesn't distort any pile's
// bounding box); it just floats wherever it was dropped.
export async function addComment(text: string, author: string, x: number, y: number): Promise<StashItem> {
  const stashId = await requireStashId();
  const body = text.trim().slice(0, 500);
  const item: StashItem = {
    id: "c" + randomUUID().slice(0, 8),
    kind: "comment", cluster: "", x, y, w: 200,
    title: author.trim().slice(0, 60) || "Anonymous",
    domain: "comment",
    kept: "just now",
    isText: true, body,
    description: "", tags: [], highlights: [], note: "", related: [], context: "",
  };
  insertItem(item, "This week", Date.now(), stashId);
  const vector = await embedText(`search_document: ${body}`);
  if (vector) setEmbedding(item.id, vector);
  return item;
}

export async function deleteItem(id: string) {
  deleteItemDb(id);
}

export async function trashItem(id: string) {
  trashItemDb(id);
}

export async function restoreItem(id: string) {
  restoreItemDb(id);
}

export async function emptyTrash() {
  emptyTrashDb(await requireStashId());
}

export async function listTrash(): Promise<(StashItem & { deletedAt: number })[]> {
  return getTrashedItems(await requireStashId());
}

export async function updateItemFields(id: string, edits: ItemEdits): Promise<StashItem | null> {
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

// touch getDb so the module (and its seed step) initializes even if no
// mutation has happened yet on this server instance, then backfill any
// items (seed data, or rows written before embeddings existed) missing one
void getDb();
void backfillEmbeddings();
