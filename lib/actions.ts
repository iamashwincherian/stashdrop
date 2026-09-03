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
  findByUrl,
  updateItem as updateItemDb,
  setEmbedding,
  setRelated,
  getItemsMissingEmbeddings,
  getSearchableItems,
  clusterList,
  type ItemEdits,
} from "./db";
import { CLUSTERS, type StashItem } from "./data";

export type KeepResult = { item: StashItem; clusterName: string } | { error: string } | { duplicate: StashItem };

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
async function linkRelated(id: string, vector: number[]): Promise<string[]> {
  const others = getSearchableItems().filter((r) => r.id !== id && r.embedding);
  const scored = others
    .map((r) => ({ id: r.id, score: cosineSimilarity(vector, JSON.parse(r.embedding!)) }))
    .filter((r) => r.score > RELATED_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, RELATED_LIMIT);
  const ids = scored.map((r) => r.id);
  if (ids.length) setRelated(id, ids);
  return ids;
}

export async function keepUrl(rawUrl: string): Promise<KeepResult> {
  let meta;
  try {
    meta = await fetchPageMeta(rawUrl);
  } catch {
    return { error: "Couldn't read that link." };
  }

  const existing = findByUrl(meta.url);
  if (existing) return { duplicate: existing };

  const kind = detectKind(meta.url, meta.contentType);
  const enrichment = await enrichWithOllama({
    title: meta.title,
    domain: meta.domain,
    description: meta.description,
    textSample: meta.textSample,
    clusters: clusterList,
  });

  const cluster = enrichment?.cluster || "D";
  const description = enrichment?.description || meta.description || "Kept just now.";
  const tags = enrichment?.tags || [];
  const context = enrichment?.context || "Saved just now, not sorted by hand yet.";
  const highlights = enrichment?.highlights || [];

  const { x, y } = nextPositionForCluster(cluster);
  const item: StashItem = {
    id: "n" + randomUUID().slice(0, 8),
    kind, cluster, x, y, w: 196,
    title: meta.title || meta.domain,
    domain: meta.domain,
    kept: "just now",
    description, tags, highlights, note: "", related: [], context,
    url: meta.url, image: meta.image ?? undefined,
  };

  insertItem(item, "This week", Date.now());

  const vector = await embedText(embeddingText(item));
  if (vector) {
    setEmbedding(item.id, vector);
    item.related = await linkRelated(item.id, vector);
  }

  return { item, clusterName: CLUSTERS[cluster]?.name || "Unsorted" };
}

export async function savePosition(id: string, x: number, y: number) {
  savePositionDb(id, x, y);
}

// A freeform sticky note — unlike kept links, it isn't AI-classified or
// filed into a pile (cluster stays empty so it doesn't distort any pile's
// bounding box); it just floats wherever it was dropped.
export async function addComment(text: string, author: string, x: number, y: number): Promise<StashItem> {
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
  insertItem(item, "This week", Date.now());
  const vector = await embedText(`search_document: ${body}`);
  if (vector) setEmbedding(item.id, vector);
  return item;
}

export async function deleteItem(id: string) {
  deleteItemDb(id);
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

  const rows = getSearchableItems();
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
