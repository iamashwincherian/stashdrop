"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  CLUSTERS,
  MARK,
  TINT,
  bars,
  WHY,
  WHY_RELATED,
  type StashItem,
  type Kind,
} from "@/lib/data";
import { keepUrl, savePosition, deleteItem, updateItemFields, searchItems, addComment, type SearchHit } from "@/lib/actions";

const PAPER = "var(--paper)";
const SERIF = "var(--font-serif), serif";
const SANS = "var(--font-sans), system-ui, sans-serif";
const MONO = "var(--font-mono), monospace";

const DEFAULT_CAMERA = { scale: 0.78, tx: -104, ty: 2 };
const KIND_OPTIONS: Kind[] = ["article", "video", "image", "pdf", "note", "quote", "repo", "shot"];
type Theme = "light" | "dark" | "system";
const THEME_KEY = "stashdrop-theme";
const COMMENT_AUTHOR_KEY = "stashdrop-comment-author";

interface Capture {
  text: string;
  dot: string;
  anim: string;
  where?: string;
}

interface Disc {
  key: "highlights" | "related" | "context";
  label: string;
  n: string;
}

interface CanvasProps {
  initialItems: StashItem[];
  initialBucket: Record<string, string>;
  initialRecentOrder: string[];
}

export default function Canvas({ initialItems, initialBucket, initialRecentOrder }: CanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const timeoutsRef = useRef<number[]>([]);

  const [items, setItems] = useState<StashItem[]>(initialItems);
  const [recentOrder, setRecentOrder] = useState<string[]>(initialRecentOrder);
  const [bucket, setBucket] = useState<Record<string, string>>(initialBucket);
  const [pos, setPosState] = useState<Record<string, [number, number]>>(() =>
    Object.fromEntries(initialItems.map((o) => [o.id, [o.x, o.y] as [number, number]]))
  );
  const posRef = useRef(pos);
  // posRef is the source of truth for event handlers (drag end needs the
  // latest value synchronously; effect-based mirrors lag a tick behind).
  const setPos = useCallback((updater: (prev: Record<string, [number, number]>) => Record<string, [number, number]>) => {
    const next = updater(posRef.current);
    posRef.current = next;
    setPosState(next);
  }, []);

  const [view, setView] = useState<"desk" | "list">("desk");
  const [camera, setCameraState] = useState(DEFAULT_CAMERA);
  const [sort, setSort] = useState<"pile" | "recent">("pile");
  const [dragId, setDragIdState] = useState<string | null>(null);
  const [panning, setPanningState] = useState(false);

  // Mirrors of the above, updated synchronously (not via a useEffect) so the
  // window-level pointermove/pointerup handlers — registered once on mount,
  // see below — always see the latest value even when pointerdown and the
  // following pointermove land in the same tick, before React re-renders.
  const liveRef = useRef({ dragId: null as string | null, panning: false, scale: DEFAULT_CAMERA.scale });

  const setCamera = useCallback((updater: typeof DEFAULT_CAMERA | ((s: typeof DEFAULT_CAMERA) => typeof DEFAULT_CAMERA)) => {
    setCameraState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      liveRef.current.scale = next.scale;
      return next;
    });
  }, []);
  // Total pointer movement since the current drag started. A `click` event
  // always reports movementX/Y as 0 (it isn't a move event), so that alone
  // can't tell a real click from a drag-then-release on the same element —
  // this ref is the actual signal the click handler checks.
  const dragDistanceRef = useRef(0);
  const startDrag = useCallback((id: string) => {
    dragDistanceRef.current = 0;
    liveRef.current.dragId = id;
    setDragIdState(id);
  }, []);
  const startPan = useCallback(() => { liveRef.current.panning = true; setPanningState(true); }, []);
  const endDragAndPan = useCallback(() => {
    liveRef.current.dragId = null;
    liveRef.current.panning = false;
    setDragIdState(null);
    setPanningState(false);
  }, []);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [query, setQueryState] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());
  const [disc, setDisc] = useState({ highlights: false, related: false, context: false });
  const [capture, setCapture] = useState<Capture | null>(null);

  const [theme, setThemeState] = useState<Theme>("system");
  useEffect(() => {
    // localStorage is a browser-only API — this component is also
    // server-rendered, so this can't be a lazy useState initializer and has
    // to run post-mount. The inline script in layout.tsx already applied
    // the stored theme to the DOM before paint; this just syncs React state
    // to match so the toggle UI reflects the right selection.
    try {
      const stored = localStorage.getItem(THEME_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored === "light" || stored === "dark") setThemeState(stored);
    } catch { /* localStorage unavailable (private mode, etc.) — stay on system */ }
  }, []);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      if (t === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, t);
    } catch { /* ignore */ }
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  }, []);

  const [composingComment, setComposingComment] = useState(false);
  const [commentAuthor, setCommentAuthor] = useState("");
  const [commentText, setCommentText] = useState("");
  useEffect(() => {
    // Same story as the theme effect above — localStorage only exists
    // client-side, so this has to be a post-mount effect, not render logic.
    try {
      const saved = localStorage.getItem(COMMENT_AUTHOR_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setCommentAuthor(saved);
    } catch { /* ignore */ }
  }, []);

  async function submitComment() {
    const text = commentText.trim();
    if (!text) return;
    try { localStorage.setItem(COMMENT_AUTHOR_KEY, commentAuthor.trim()); } catch { /* ignore */ }
    // drop it at the current viewport center, in canvas space
    const cx = (window.innerWidth / 2 - camera.tx) / camera.scale;
    const cy = (window.innerHeight / 2 - camera.ty) / camera.scale;
    const item = await addComment(text, commentAuthor, cx, cy);
    setItems((prev) => [...prev, item]);
    setBucket((prev) => ({ ...prev, [item.id]: "This week" }));
    setRecentOrder((prev) => [item.id, ...prev]);
    setPos((prev) => ({ ...prev, [item.id]: [item.x, item.y] }));
    setCommentText("");
    setComposingComment(false);
  }

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editKind, setEditKind] = useState<Kind>("article");
  const [editCluster, setEditCluster] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editNote, setEditNote] = useState("");
  const [deleteArmed, setDeleteArmed] = useState(false);

  const searchTimerRef = useRef<number | undefined>(undefined);
  const searchSeqRef = useRef(0);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timeoutsRef.current.push(id);
  }, []);

  const captureTimerRef = useRef<number | undefined>(undefined);
  const showCapture = useCallback((c: Capture, ms = 3200) => {
    if (captureTimerRef.current) window.clearTimeout(captureTimerRef.current);
    setCapture(c);
    captureTimerRef.current = window.setTimeout(() => setCapture(null), ms);
  }, []);

  useEffect(() => () => {
    timeoutsRef.current.forEach(clearTimeout);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
  }, []);

  const zoomAt = useCallback((cx: number, cy: number, k: number) => {
    setCamera((s) => {
      const ns = Math.min(1.6, Math.max(0.32, s.scale * k));
      const f = ns / s.scale;
      return { scale: ns, tx: cx - (cx - s.tx) * f, ty: cy - (cy - s.ty) * f };
    });
  }, [setCamera]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 0.92 : 1.08);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFocusId(null);
        setQueryState("");
        setSearchResults([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset the edit/delete-confirm UI whenever the focused item changes.
  // Adjusted during render (React's documented pattern for this) rather
  // than in an effect, since an effect would cause an extra render pass.
  const [lastFocusId, setLastFocusId] = useState(focusId);
  if (lastFocusId !== focusId) {
    setLastFocusId(focusId);
    setEditing(false);
    setDeleteArmed(false);
    const f = focusId ? items.find((o) => o.id === focusId) : null;
    setEditTitle(f ? f.title : "");
    setEditBody(f?.body || "");
    setEditDescription(f ? f.description : "");
    setEditKind(f ? f.kind : "article");
    setEditCluster(f ? f.cluster : "");
    setEditTags(f ? f.tags.join(", ") : "");
    setEditNote(f ? f.note : "");
  }

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const id = liveRef.current.dragId;
      if (id) {
        dragDistanceRef.current += Math.abs(e.movementX) + Math.abs(e.movementY);
        setPos((prev) => {
          const [x, y] = prev[id];
          return { ...prev, [id]: [x + e.movementX / liveRef.current.scale, y + e.movementY / liveRef.current.scale] };
        });
      } else if (liveRef.current.panning) {
        setCamera((s) => ({ ...s, tx: s.tx + e.movementX, ty: s.ty + e.movementY }));
      }
    };
    const up = () => {
      const id = liveRef.current.dragId;
      if (id) {
        const [x, y] = posRef.current[id];
        void savePosition(id, x, y);
      }
      endDragAndPan();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [setPos, setCamera, endDragAndPan]);

  function paste(): boolean {
    const q = query.trim();
    if (!/^https?:\/\/|^www\./i.test(q)) return false;
    const url = /^https?:\/\//i.test(q) ? q : `https://${q}`;
    setQueryState("");
    setSearchResults([]);
    if (captureTimerRef.current) window.clearTimeout(captureTimerRef.current);
    setCapture({ text: "Reading it…", dot: "var(--text-fainter)", anim: "sd-breathe 1.1s ease-in-out infinite" });
    (async () => {
      const result = await keepUrl(url);
      if ("error" in result) {
        showCapture({ text: result.error, dot: "var(--accent)", anim: "none" });
        return;
      }
      if ("duplicate" in result) {
        setFocusId(result.duplicate.id);
        showCapture({ text: "Already kept", dot: "var(--text-fainter)", anim: "none" });
        return;
      }
      const { item, clusterName } = result;
      setItems((prev) => [...prev, item]);
      setBucket((prev) => ({ ...prev, [item.id]: "This week" }));
      setRecentOrder((prev) => [item.id, ...prev]);
      setPos((prev) => ({ ...prev, [item.id]: [item.x, item.y] }));
      showCapture({ text: `Kept — put next to ${clusterName}`, dot: "#3F5A52", anim: "none", where: "gemma4:e2b, local" });
    })();
    return true;
  }

  function triggerSearch(value: string) {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    const q = value.trim();
    if (!q) { setSearchResults([]); setSearching(false); return; }
    const seq = ++searchSeqRef.current;
    setSearching(true);
    searchTimerRef.current = window.setTimeout(async () => {
      const hits = await searchItems(q);
      if (searchSeqRef.current === seq) {
        setSearchResults(hits);
        setSearching(false);
      }
    }, 300);
  }

  function onChangeQuery(value: string) {
    setQueryState(value);
    if (/^https?:\/\/|^www\./i.test(value.trim())) {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
      setSearchResults([]);
      setSearching(false);
    } else {
      triggerSearch(value);
    }
  }

  function queryKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      if (paste()) return;
      if (searchResults.length) {
        setFocusId(searchResults[0].id);
        setDisc({ highlights: false, related: false, context: false });
      }
    }
  }

  async function saveEdit(id: string) {
    const tags = editTags.split(",").map((t) => t.trim()).filter(Boolean);
    const updated = await updateItemFields(id, {
      title: editTitle.trim(), description: editDescription.trim(), kind: editKind,
      cluster: editCluster, tags, note: editNote, body: editBody.trim(),
    });
    if (!updated) return;
    setItems((prev) => prev.map((o) => (o.id === id ? updated : o)));
    setPos((prev) => ({ ...prev, [id]: [updated.x, updated.y] }));
    setEditing(false);
  }

  async function confirmDelete(id: string) {
    if (!deleteArmed) {
      setDeleteArmed(true);
      later(() => setDeleteArmed(false), 4000);
      return;
    }
    await deleteItem(id);
    setItems((prev) => prev.filter((o) => o.id !== id));
    setPos((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setFocusId(null);
  }

  // ---- derived render values ----
  const isList = view === "list";
  const hits: Record<string, number> | null = searchResults.length
    ? Object.fromEntries(searchResults.map((h) => [h.id, h.score]))
    : null;
  const zoomedOut = camera.scale < 0.6;

  const focused = focusId ? items.find((o) => o.id === focusId) ?? null : null;
  const focusedRelated = focused
    ? focused.related
        .map((rid) => {
          const r = items.find((o) => o.id === rid);
          if (!r) return null;
          return { id: rid, title: r.title, mark: MARK[r.kind], why: WHY_RELATED[rid] || "related" };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
    : [];

  const discs: Disc[] = focused && focused.kind !== "comment"
    ? (
        [
          { key: "highlights" as const, label: "Highlights & notes", n: String(focused.highlights.length + (focused.note ? 1 : 0)) },
          { key: "related" as const, label: "Related", n: String(focused.related.length) },
          { key: "context" as const, label: "Why it is here", n: "" },
        ].filter((d) => d.key !== "highlights" || focused.highlights.length > 0 || !!focused.note)
      )
    : [];

  let listGroups: { name: string; n: string; items: StashItem[] }[] = [];
  if (sort === "pile") {
    listGroups = Object.keys(CLUSTERS)
      .map((k) => {
        const mem = items.filter((o) => o.cluster === k);
        return { name: CLUSTERS[k].name, n: mem.length + " things", items: mem };
      })
      .filter((g) => g.items.length);
  } else {
    const ordered = items.slice().sort((a, b) => {
      const ia = recentOrder.indexOf(a.id), ib = recentOrder.indexOf(b.id);
      return (ia < 0 ? -1 : ia) - (ib < 0 ? -1 : ib);
    });
    const seen: { name: string; items: StashItem[] }[] = [];
    ordered.forEach((o) => {
      const b = bucket[o.id] || "This week";
      let g = seen.find((x) => x.name === b);
      if (!g) { g = { name: b, items: [] }; seen.push(g); }
      g.items.push(o);
    });
    listGroups = seen.map((g) => ({ name: g.name, n: g.items.length + " things", items: g.items }));
  }

  function matchLabel(score: number) {
    return `${Math.round(score * 100)}% match`;
  }

  function rowSub(o: StashItem, hit: number | null, hovered: boolean) {
    if (hit != null) return matchLabel(hit);
    if (hovered) return WHY[o.id] || o.domain;
    return o.domain;
  }

  return (
    <div
      style={{
        height: "100vh", width: "100vw", position: "relative", background: PAPER,
        color: "var(--text-primary)", fontFamily: SANS, fontSize: 14, lineHeight: 1.45,
        WebkitFontSmoothing: "antialiased", overflow: "hidden",
      }}
    >
      <div
        ref={canvasRef}
        onPointerDown={() => { startPan(); setFocusId(null); }}
        style={{
          position: "absolute", inset: 0, cursor: panning ? "grabbing" : "default",
          backgroundImage: "radial-gradient(circle at 1px 1px, rgba(var(--shadow-color),.055) 1px, transparent 0)",
          backgroundSize: `${26 * camera.scale}px ${26 * camera.scale}px`,
          backgroundPosition: `${camera.tx}px ${camera.ty}px`,
        }}
      >
        <div
          style={{
            position: "absolute", left: 0, top: 0,
            transform: `translate3d(${camera.tx}px, ${camera.ty}px, 0) scale(${camera.scale})`,
            transformOrigin: "0 0", willChange: "transform",
          }}
        >
          {/* Board title: lives in canvas space (pans/zooms with everything
              else) but has no pointer handlers at all, so it can't be
              dragged or clicked like the item cards — a fixed landmark. */}
          <div style={{ position: "absolute", left: 750, top: 140, pointerEvents: "none", userSelect: "none" }}>
            <div style={{ fontFamily: SERIF, fontSize: 46, letterSpacing: "-.01em", color: "var(--text-primary)", whiteSpace: "nowrap" }}>Stashdrop</div>
            <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", marginTop: 4 }}>everything you&apos;ve kept, in one place</div>
          </div>

          {items.map((o) => {
            const [x, y] = pos[o.id];
            const hit = hits ? hits[o.id] ?? null : null;
            const hovered = hoverId === o.id;
            const dim = !!(hits && !hit);
            const isText = !!o.isText;
            const previewH = (o.kind === "image" || o.kind === "shot" ? 118 : 96);
            const previewBars = isText ? [] : bars(o.kind === "video" ? "image" : o.kind, o.id.charCodeAt(1) || 3);
            const titleOp = zoomedOut && !hit ? 0.35 : 1;

            const tilt = o.kind === "quote" || o.kind === "note" || o.kind === "comment" ? "-0.5deg" : "0deg";
            const style: CSSProperties = {
              // Positioned via transform, not left/top: left/top changes force
              // a layout+repaint on every pointermove frame, which is what
              // made image-heavy cards visibly stutter/redraw mid-drag.
              // translate3d is compositor-only — no repaint, no jank.
              position: "absolute", left: 0, top: 0, width: o.w,
              transform: `translate3d(${x}px, ${y}px, 0) rotate(${tilt})`,
              willChange: dragId === o.id ? "transform" : undefined,
              background: o.kind === "comment" ? "var(--sticky-bg)" : o.kind === "quote" ? "var(--card-bg-alt)" : "var(--card-bg)",
              border: `1px solid ${hit || hovered ? "var(--text-primary)" : o.kind === "comment" ? "var(--sticky-border)" : "var(--border-default)"}`,
              borderRadius: isText ? 10 : 11,
              boxShadow: dim ? "none" : (hovered || hit || dragId === o.id
                ? "0 12px 30px rgba(var(--shadow-color),.13)"
                : "0 1px 2px rgba(var(--shadow-color),.05), 0 6px 16px rgba(var(--shadow-color),.045)"),
              opacity: dim ? 0.24 : 1,
              cursor: "grab",
              userSelect: "none", overflow: "hidden",
            };

            return (
              <div
                key={o.id}
                onPointerDown={(e) => { e.stopPropagation(); startDrag(o.id); }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (dragDistanceRef.current < 4) { setFocusId(o.id); setDisc({ highlights: false, related: false, context: false }); }
                }}
                onMouseEnter={() => setHoverId(o.id)}
                onMouseLeave={() => setHoverId((h) => (h === o.id ? null : h))}
                style={style}
              >
                {!isText && (
                  <div style={{
                    height: previewH, background: TINT[o.kind] || "var(--tint-article)", borderBottom: `1px solid ${hit || hovered ? "var(--text-primary)" : "var(--border-default)"}`,
                    position: "relative", display: "grid", placeItems: "center", overflow: "hidden",
                  }}>
                    {o.image && !brokenImages.has(o.id) ? (
                      <img
                        src={o.image}
                        alt=""
                        draggable={false}
                        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }}
                        onError={() => setBrokenImages((prev) => new Set(prev).add(o.id))}
                      />
                    ) : (
                      previewBars.map((b, i) => (
                        <div key={i} style={{ position: "absolute", left: b.left, top: b.top, width: b.w, height: b.h, background: b.bg, borderRadius: b.r }} />
                      ))
                    )}
                    {o.playhead && (
                      <div style={{ position: "relative", width: 26, height: 26, borderRadius: "50%", background: "var(--surface)", border: "1px solid rgba(var(--shadow-color),.14)", display: "grid", placeItems: "center" }}>
                        <div style={{ width: 0, height: 0, borderLeft: "7px solid var(--text-secondary)", borderTop: "4.5px solid transparent", borderBottom: "4.5px solid transparent", marginLeft: 2 }} />
                      </div>
                    )}
                  </div>
                )}

                {isText && (
                  <div style={{ padding: "14px 15px 4px" }}>
                    <div style={{ fontFamily: SERIF, fontStyle: o.kind === "quote" ? "italic" : "normal", fontSize: 17, lineHeight: 1.3, color: "var(--text-secondary)", textWrap: "pretty" as CSSProperties["textWrap"] }}>{o.body}</div>
                  </div>
                )}

                <div style={{ padding: isText ? "4px 15px 14px" : "12px 14px 13px" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.3, color: "var(--text-primary)", opacity: titleOp, textWrap: "pretty" as CSSProperties["textWrap"] }}>{o.title}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5, opacity: titleOp }}>
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: MARK[o.kind] || "var(--text-muted)", flex: "none" }} />
                    <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.domain}</span>
                  </div>
                  {hit != null && (
                    <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 13, lineHeight: 1.3, color: "var(--text-muted)", marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border-subtle)", textWrap: "pretty" as CSSProperties["textWrap"] }}>{matchLabel(hit)}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {isList && (
        <div style={{ position: "absolute", inset: 0, background: PAPER, overflowY: "auto", zIndex: 10 }}>
          <div style={{ maxWidth: 900, margin: "0 auto", padding: "92px 32px 90px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 13, borderBottom: "1px solid var(--border-default)" }}>
              <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--text-muted)", flex: 1 }}>{items.length} things kept</div>
              {[{ id: "pile" as const, label: "By pile" }, { id: "recent" as const, label: "Recent" }].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSort(t.id)}
                  className="sd-hover-fg"
                  style={{ border: "none", background: "none", color: sort === t.id ? "var(--text-primary)" : "var(--text-faint)", fontSize: 12.5, fontWeight: sort === t.id ? 600 : 400, cursor: "pointer", padding: "4px 6px" }}
                >{t.label}</button>
              ))}
            </div>

            {listGroups.map((g) => (
              <div key={g.name}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 11, padding: "30px 2px 8px" }}>
                  <div style={{ fontFamily: SERIF, fontSize: 22, letterSpacing: "-.01em", color: "var(--text-secondary)" }}>{g.name}</div>
                  <div style={{ height: 1, flex: 1, background: "var(--border-subtle)" }} />
                  <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-fainter)" }}>{g.n}</div>
                </div>
                {g.items.map((r) => {
                  const hit = hits ? hits[r.id] ?? null : null;
                  const hovered = hoverId === r.id;
                  const n = r.related.length;
                  return (
                    <div
                      key={r.id}
                      onClick={() => { setFocusId(r.id); setDisc({ highlights: false, related: false, context: false }); }}
                      onMouseEnter={() => setHoverId(r.id)}
                      onMouseLeave={() => setHoverId((h) => (h === r.id ? null : h))}
                      style={{
                        display: "flex", alignItems: "center", gap: 15, padding: "12px 12px", borderRadius: 9, cursor: "pointer",
                        opacity: hits && !hit ? 0.3 : 1,
                        background: hovered ? "var(--hover-bg-alt)" : (hit ? "var(--accent-bg)" : "transparent"),
                      }}
                    >
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: MARK[r.kind] || "var(--text-muted)", flex: "none" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
                        <div style={{
                          fontFamily: hit || hovered ? SERIF : MONO,
                          fontStyle: hit || hovered ? "italic" : "normal",
                          fontSize: hit || hovered ? 13.5 : 9.5,
                          color: hit || hovered ? "var(--text-muted)" : "var(--text-faint)",
                          marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>{rowSub(r, hit, hovered)}</div>
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--text-fainter)", flex: "none", width: 58, textAlign: "right" }}>{n ? n + (n === 1 ? " link" : " links") : ""}</div>
                      <div style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--text-faint)", flex: "none", width: 76, textAlign: "right" }}>{r.kept}</div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ position: "absolute", left: 22, top: 20, display: "flex", alignItems: "center", gap: 11, zIndex: 20 }}>
        <div style={{ width: 15, height: 15, borderRadius: 4, background: "var(--text-primary)", position: "relative" }}>
          <div style={{ position: "absolute", right: -4, bottom: -4, width: 9, height: 9, borderRadius: 3, background: PAPER, border: "1px solid var(--text-primary)" }} />
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--text-muted)" }}>Stashdrop</div>
      </div>

      <div style={{ position: "absolute", left: "50%", top: 16, transform: "translateX(-50%)", width: "min(560px, calc(100vw - 260px))", zIndex: 30 }}>
        <div style={{
          background: "var(--surface)", backdropFilter: "blur(12px)",
          border: `1px solid ${query ? "var(--border-strong)" : "var(--border-default)"}`,
          borderRadius: query ? 12 : 10,
          boxShadow: query ? "0 14px 40px rgba(var(--shadow-color),.11)" : "0 2px 10px rgba(var(--shadow-color),.05)",
          overflow: "hidden", transition: "box-shadow .18s ease",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "0 14px" }}>
            <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--text-faint)", flex: "none" }}>/</span>
            <input
              value={query}
              onChange={(e) => onChangeQuery(e.target.value)}
              onKeyDown={queryKey}
              placeholder="Find anything — or paste to keep it"
              style={{ flex: 1, border: "none", outline: "none", background: "none", fontSize: 14.5, color: "var(--text-primary)", padding: "13px 0" }}
            />
            {query && (
              <button
                onClick={() => { setQueryState(""); setSearchResults([]); }}
                className="sd-hover-fg"
                style={{ border: "none", background: "none", color: "var(--text-faint)", fontFamily: MONO, fontSize: 12, cursor: "pointer", padding: 4 }}
              >esc</button>
            )}
          </div>

          {query && !/^https?:\/\/|^www\./i.test(query.trim()) && (
            <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "9px 6px 8px" }}>
              {searching && !searchResults.length && (
                <div style={{ padding: "8px 10px", fontFamily: MONO, fontSize: 11, color: "var(--text-faint)" }}>searching…</div>
              )}
              {!searching && !searchResults.length && (
                <div style={{ padding: "8px 10px", fontFamily: MONO, fontSize: 11, color: "var(--text-faint)" }}>no matches</div>
              )}
              {searchResults.map((hit) => {
                const it = items.find((o) => o.id === hit.id);
                if (!it) return null;
                return (
                  <button
                    key={hit.id}
                    onClick={() => { setFocusId(hit.id); setDisc({ highlights: false, related: false, context: false }); }}
                    className="sd-hover-bg-alt"
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", border: "none", background: "none", borderRadius: 7, padding: "8px 10px", cursor: "pointer" }}
                  >
                    <span style={{ width: 9, height: 9, borderRadius: 2, background: MARK[it.kind] || "var(--text-muted)", flex: "none" }} />
                    <span style={{ flex: 1, fontSize: 13.5, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</span>
                    <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--text-fainter)", flex: "none" }}>{Math.round(hit.score * 100)}%</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{ position: "absolute", right: 22, top: 18, display: "flex", alignItems: "center", gap: 7, zIndex: 20 }}>
        <div style={{ display: "flex", background: "var(--surface)", border: "1px solid var(--border-default)", borderRadius: 8, padding: 2 }}>
          {[{ id: "desk" as const, label: "Desk" }, { id: "list" as const, label: "List" }].map((v) => (
            <button
              key={v.id}
              onClick={() => {
                if (v.id === "list") { setView("list"); setFocusId(null); }
                else { setView("desk"); setCamera(DEFAULT_CAMERA); setFocusId(null); }
              }}
              className="sd-hover-fg"
              style={{ border: "none", background: view === v.id ? "var(--hover-bg)" : "transparent", color: view === v.id ? "var(--text-primary)" : "var(--text-muted)", borderRadius: 6, padding: "6px 13px", fontSize: 12.5, fontWeight: 500, cursor: "pointer" }}
            >{v.label}</button>
          ))}
        </div>
        <div style={{ display: "flex", background: "var(--surface)", border: "1px solid var(--border-default)", borderRadius: 8, padding: 2 }}>
          {([{ id: "system" as const, label: "Auto" }, { id: "light" as const, label: "Light" }, { id: "dark" as const, label: "Dark" }]).map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className="sd-hover-fg"
              title={t.id === "system" ? "Follow system theme" : `${t.label} theme`}
              style={{ border: "none", background: theme === t.id ? "var(--hover-bg)" : "transparent", color: theme === t.id ? "var(--text-primary)" : "var(--text-muted)", borderRadius: 6, padding: "6px 10px", fontSize: 12.5, fontWeight: 500, cursor: "pointer" }}
            >{t.label}</button>
          ))}
        </div>
        <div style={{ width: 26, height: 26, borderRadius: "50%", background: "var(--hover-bg)", border: "1px solid var(--border-strong)", display: "grid", placeItems: "center", fontFamily: MONO, fontSize: 9.5, color: "var(--text-muted)" }}>MR</div>
      </div>

      <div style={{ position: "absolute", left: 22, bottom: 20, display: "flex", alignItems: "center", gap: 6, zIndex: 20, opacity: isList ? 0 : 1, pointerEvents: isList ? "none" : "auto" }}>
        <div style={{ display: "flex", alignItems: "center", background: "var(--surface)", border: "1px solid var(--border-default)", borderRadius: 8, overflow: "hidden" }}>
          <button onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.85)} className="sd-hover-bg" style={{ border: "none", background: "none", color: "var(--text-muted)", width: 30, height: 30, cursor: "pointer", fontFamily: MONO, fontSize: 14 }}>−</button>
          <button onClick={() => setCamera(DEFAULT_CAMERA)} className="sd-hover-bg" style={{ border: "none", background: "none", color: "var(--text-muted)", height: 30, padding: "0 9px", cursor: "pointer", fontFamily: MONO, fontSize: 10, borderLeft: "1px solid var(--border-subtle)", borderRight: "1px solid var(--border-subtle)", minWidth: 52 }}>{Math.round(camera.scale * 100)}%</button>
          <button onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.18)} className="sd-hover-bg" style={{ border: "none", background: "none", color: "var(--text-muted)", width: 30, height: 30, cursor: "pointer", fontFamily: MONO, fontSize: 14 }}>+</button>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--text-fainter)", paddingLeft: 6 }}>drag things around · scroll to zoom</div>
      </div>

      <div style={{ position: "absolute", right: 22, bottom: 20, zIndex: 30 }}>
        {composingComment && (
          <div style={{
            position: "absolute", right: 0, bottom: 44, width: 260,
            background: "var(--card-bg)", border: "1px solid var(--border-default)", borderRadius: 10,
            boxShadow: "0 14px 40px rgba(var(--shadow-color),.16)", padding: 12, display: "flex", flexDirection: "column", gap: 8,
          }}>
            <input
              value={commentAuthor}
              onChange={(e) => setCommentAuthor(e.target.value)}
              placeholder="Your name"
              style={{ border: "1px solid var(--border-default)", borderRadius: 7, padding: "6px 9px", fontSize: 12.5, color: "var(--text-primary)", background: "var(--card-bg)" }}
            />
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Leave a comment on the board…"
              rows={3}
              autoFocus
              style={{ border: "1px solid var(--border-default)", borderRadius: 7, padding: "6px 9px", fontSize: 12.5, color: "var(--text-primary)", background: "var(--card-bg)", resize: "vertical", fontFamily: SANS }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setComposingComment(false)}
                className="sd-hover-border"
                style={{ border: "1px solid var(--border-strong)", background: "none", color: "var(--text-secondary)", borderRadius: 7, padding: "5px 11px", fontSize: 12, cursor: "pointer" }}
              >Cancel</button>
              <button
                onClick={submitComment}
                disabled={!commentText.trim()}
                style={{ border: "1px solid var(--text-primary)", background: "var(--text-primary)", color: "var(--card-bg)", borderRadius: 7, padding: "5px 11px", fontSize: 12, cursor: commentText.trim() ? "pointer" : "not-allowed", opacity: commentText.trim() ? 1 : 0.5 }}
              >Drop it</button>
            </div>
          </div>
        )}
        <button
          onClick={() => setComposingComment((v) => !v)}
          className="sd-hover-bg"
          title="Drop a comment on the board"
          style={{
            display: "flex", alignItems: "center", gap: 7, border: "1px solid var(--border-default)",
            background: "var(--surface)", color: "var(--text-secondary)", borderRadius: 8, padding: "8px 13px",
            fontSize: 12.5, cursor: "pointer", boxShadow: "0 2px 10px rgba(var(--shadow-color),.05)",
          }}
        ><span style={{ width: 9, height: 9, borderRadius: 2, background: MARK.comment, flex: "none" }} />+ Comment</button>
      </div>

      {capture && (
        <div style={{
          position: "absolute", left: "50%", bottom: 26, transform: "translateX(-50%)", zIndex: 40,
          background: "var(--card-bg)", border: "1px solid var(--border-default)", borderRadius: 10, boxShadow: "0 10px 34px rgba(var(--shadow-color),.1)",
          padding: "11px 15px", display: "flex", alignItems: "center", gap: 12, animation: "sd-rise .22s ease both",
        }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: capture.dot, animation: capture.anim }} />
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{capture.text}</div>
          {capture.where && (
            <div style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--text-faint)", borderLeft: "1px solid var(--border-subtle)", paddingLeft: 12 }}>{capture.where}</div>
          )}
        </div>
      )}

      {focused && (
        <div
          onClick={() => setFocusId(null)}
          style={{
            position: "absolute", inset: 0, background: "var(--overlay-bg)", backdropFilter: "blur(2px)", zIndex: 50,
            display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "7vh 24px 24px", overflowY: "auto",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(680px, 100%)", background: "var(--card-bg)", border: "1px solid var(--border-default)", borderRadius: 14,
              boxShadow: "0 24px 70px rgba(var(--shadow-color),.14)", overflow: "hidden", animation: "sd-sheet .24s cubic-bezier(.2,.8,.2,1) both",
            }}
          >
            <div style={{
              height: focused.isText ? 200 : (focused.kind === "image" || focused.kind === "shot" ? 300 : 220),
              background: focused.kind === "comment" ? "var(--sticky-bg)" : TINT[focused.kind] || "var(--tint-article)", borderBottom: "1px solid var(--border-subtle)", position: "relative", display: "grid", placeItems: "center", overflow: "hidden",
            }}>
              {!focused.isText && focused.image && !brokenImages.has(focused.id) ? (
                <img
                  src={focused.image}
                  alt=""
                  draggable={false}
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }}
                  onError={() => setBrokenImages((prev) => new Set(prev).add(focused.id))}
                />
              ) : (
                !focused.isText && bars(focused.kind === "video" ? "image" : focused.kind, (focused.id.charCodeAt(1) || 3) + 1).map((b, i) => (
                  <div key={i} style={{
                    position: "absolute", left: b.left, top: b.top, width: b.w,
                    height: b.h === "3px" ? "5px" : b.h === "7px" ? "11px" : b.h,
                    background: b.bg, borderRadius: b.r,
                  }} />
                ))
              )}
              {focused.isText && (
                <div style={{ padding: "34px 40px", maxWidth: 520 }}>
                  <div style={{ fontFamily: SERIF, fontStyle: focused.kind === "quote" ? "italic" : "normal", fontSize: 26, lineHeight: 1.28, color: "var(--text-primary)", textWrap: "pretty" as CSSProperties["textWrap"] }}>{focused.body}</div>
                </div>
              )}
              {focused.playhead && (
                <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--surface)", border: "1px solid rgba(var(--shadow-color),.14)", display: "grid", placeItems: "center" }}>
                  <div style={{ width: 0, height: 0, borderLeft: "12px solid var(--text-secondary)", borderTop: "7.5px solid transparent", borderBottom: "7.5px solid transparent", marginLeft: 3 }} />
                </div>
              )}
              {focused.url && (
                <a
                  href={focused.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sd-hover-border-fg"
                  style={{ position: "absolute", left: 12, top: 12, height: 26, padding: "0 10px", borderRadius: 7, border: "1px solid var(--border-default)", background: "var(--surface)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: MONO, fontSize: 11, display: "flex", alignItems: "center", gap: 5, textDecoration: "none" }}
                >open ↗</a>
              )}
              <button
                onClick={() => setFocusId(null)}
                className="sd-hover-border-fg"
                style={{ position: "absolute", right: 12, top: 12, width: 26, height: 26, borderRadius: 7, border: "1px solid var(--border-default)", background: "var(--surface)", color: "var(--text-muted)", cursor: "pointer", fontFamily: MONO, fontSize: 11 }}
              >✕</button>
            </div>

            <div style={{ padding: "22px 26px 8px" }}>
              <h2 style={{ fontFamily: SERIF, fontWeight: 400, fontSize: 27, lineHeight: 1.2, margin: "0 0 8px", letterSpacing: "-.01em", textWrap: "pretty" as CSSProperties["textWrap"] }}>{focused.title}</h2>
              <div style={{ display: "flex", alignItems: "center", gap: 9, fontFamily: MONO, fontSize: 10, color: "var(--text-faint)", flexWrap: "wrap" }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: MARK[focused.kind] || "var(--text-muted)" }} />
                <span>{focused.domain}</span><span>·</span><span>kept {focused.kept}</span><span>·</span><span>{(CLUSTERS[focused.cluster] || { name: "Unsorted" }).name}</span>
              </div>
            </div>

            <div style={{ padding: "14px 26px 0" }}>
              <div style={{ fontSize: 14.5, lineHeight: 1.6, color: "var(--text-secondary)", textWrap: "pretty" as CSSProperties["textWrap"] }}>{focused.description}</div>
            </div>

            <div style={{ padding: "18px 26px 6px", display: "flex", flexWrap: "wrap", gap: 6 }}>
              {focused.tags.map((t) => (
                <span key={t} style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--text-muted)", border: "1px solid var(--border-subtle)", borderRadius: 5, padding: "3px 8px" }}>{t}</span>
              ))}
            </div>

            {!editing && (
              <div style={{ padding: "10px 26px 0", display: "flex", gap: 8 }}>
                {focused.url ? (
                  <a
                    href={focused.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="sd-hover-border"
                    style={{ border: "1px solid var(--border-strong)", background: "none", color: "var(--text-secondary)", borderRadius: 7, padding: "5px 11px", fontSize: 12, cursor: "pointer", textDecoration: "none" }}
                  >Open original ↗</a>
                ) : (
                  <span
                    title="This item has no source link — it's original demo content, not something pasted in"
                    style={{ border: "1px solid var(--border-subtle)", color: "var(--text-fainter)", borderRadius: 7, padding: "5px 11px", fontSize: 12, cursor: "not-allowed" }}
                  >Open original ↗</span>
                )}
                <button
                  onClick={() => { setEditing(true); setDeleteArmed(false); }}
                  className="sd-hover-border"
                  style={{ border: "1px solid var(--border-strong)", background: "none", color: "var(--text-secondary)", borderRadius: 7, padding: "5px 11px", fontSize: 12, cursor: "pointer" }}
                >Edit</button>
                <button
                  onClick={() => confirmDelete(focused.id)}
                  style={{
                    border: `1px solid ${deleteArmed ? "var(--danger)" : "var(--border-strong)"}`,
                    background: deleteArmed ? "var(--danger-bg)" : "none",
                    color: deleteArmed ? "var(--danger)" : "var(--text-secondary)",
                    borderRadius: 7, padding: "5px 11px", fontSize: 12, cursor: "pointer",
                  }}
                >{deleteArmed ? "Confirm delete?" : "Delete"}</button>
              </div>
            )}

            {editing && focused.kind === "comment" && (
              <div style={{ padding: "14px 26px 0", display: "flex", flexDirection: "column", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "var(--text-muted)" }}>
                  Name
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    style={{ border: "1px solid var(--border-default)", borderRadius: 7, padding: "7px 9px", fontSize: 13.5, color: "var(--text-primary)" }}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "var(--text-muted)" }}>
                  Comment
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={4}
                    style={{ border: "1px solid var(--border-default)", borderRadius: 7, padding: "7px 9px", fontSize: 13.5, color: "var(--text-primary)", resize: "vertical", fontFamily: SANS }}
                  />
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => saveEdit(focused.id)}
                    style={{ border: "1px solid var(--text-primary)", background: "var(--text-primary)", color: "var(--card-bg)", borderRadius: 7, padding: "6px 13px", fontSize: 12.5, cursor: "pointer" }}
                  >Save</button>
                  <button
                    onClick={() => setEditing(false)}
                    className="sd-hover-border"
                    style={{ border: "1px solid var(--border-strong)", background: "none", color: "var(--text-secondary)", borderRadius: 7, padding: "6px 13px", fontSize: 12.5, cursor: "pointer" }}
                  >Cancel</button>
                </div>
              </div>
            )}

            {editing && focused.kind !== "comment" && (
              <div style={{ padding: "14px 26px 0", display: "flex", flexDirection: "column", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "var(--text-muted)" }}>
                  Title
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    style={{ border: "1px solid var(--border-default)", borderRadius: 7, padding: "7px 9px", fontSize: 13.5, color: "var(--text-primary)" }}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "var(--text-muted)" }}>
                  Description
                  <textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    rows={2}
                    style={{ border: "1px solid var(--border-default)", borderRadius: 7, padding: "7px 9px", fontSize: 13.5, color: "var(--text-primary)", resize: "vertical", fontFamily: SANS }}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "var(--text-muted)" }}>
                  Kind
                  <select
                    value={editKind}
                    onChange={(e) => setEditKind(e.target.value as Kind)}
                    style={{ border: "1px solid var(--border-default)", borderRadius: 7, padding: "7px 9px", fontSize: 13.5, color: "var(--text-primary)", background: "var(--card-bg)" }}
                  >
                    {KIND_OPTIONS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "var(--text-muted)" }}>
                  Pile
                  <select
                    value={editCluster}
                    onChange={(e) => setEditCluster(e.target.value)}
                    style={{ border: "1px solid var(--border-default)", borderRadius: 7, padding: "7px 9px", fontSize: 13.5, color: "var(--text-primary)", background: "var(--card-bg)" }}
                  >
                    {Object.entries(CLUSTERS).map(([key, v]) => (
                      <option key={key} value={key}>{v.name}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "var(--text-muted)" }}>
                  Tags (comma separated)
                  <input
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    style={{ border: "1px solid var(--border-default)", borderRadius: 7, padding: "7px 9px", fontSize: 13.5, color: "var(--text-primary)" }}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: "var(--text-muted)" }}>
                  Your note
                  <textarea
                    value={editNote}
                    onChange={(e) => setEditNote(e.target.value)}
                    rows={3}
                    style={{ border: "1px solid var(--border-default)", borderRadius: 7, padding: "7px 9px", fontSize: 13.5, color: "var(--text-primary)", resize: "vertical", fontFamily: SANS }}
                  />
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => saveEdit(focused.id)}
                    style={{ border: "1px solid var(--text-primary)", background: "var(--text-primary)", color: "var(--card-bg)", borderRadius: 7, padding: "6px 13px", fontSize: 12.5, cursor: "pointer" }}
                  >Save</button>
                  <button
                    onClick={() => setEditing(false)}
                    className="sd-hover-border"
                    style={{ border: "1px solid var(--border-strong)", background: "none", color: "var(--text-secondary)", borderRadius: 7, padding: "6px 13px", fontSize: 12.5, cursor: "pointer" }}
                  >Cancel</button>
                </div>
              </div>
            )}

            <div style={{ padding: "14px 26px 26px" }}>
              {discs.map((d) => {
                const open = disc[d.key];
                return (
                  <div key={d.key} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                    <button
                      onClick={() => setDisc((prev) => ({ ...prev, [d.key]: !prev[d.key] }))}
                      style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", border: "none", background: "none", padding: "13px 2px", cursor: "pointer" }}
                    >
                      <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--text-muted)", flex: 1 }}>{d.label}</span>
                      <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--text-fainter)" }}>{d.n}</span>
                      <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--text-fainter)", width: 12, textAlign: "center" }}>{open ? "−" : "+"}</span>
                    </button>
                    {open && (
                      <div style={{ padding: "0 2px 16px" }}>
                        {d.key === "highlights" && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            {focused.highlights.map((h, i) => (
                              <div key={i} style={{ borderLeft: "2px solid var(--border-strong)", paddingLeft: 13 }}>
                                <div style={{ fontFamily: SERIF, fontSize: 17, lineHeight: 1.42, color: "var(--text-secondary)", textWrap: "pretty" as CSSProperties["textWrap"] }}>{h.text}</div>
                                <div style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--text-faint)", marginTop: 5 }}>{h.at}</div>
                              </div>
                            ))}
                            {focused.note && (
                              <div style={{ background: "var(--accent-bg)", border: "1px solid var(--accent-border)", borderRadius: 9, padding: "12px 14px", fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.55, textWrap: "pretty" as CSSProperties["textWrap"] }}>{focused.note}</div>
                            )}
                          </div>
                        )}
                        {d.key === "related" && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            {focusedRelated.map((r) => (
                              <div
                                key={r.id}
                                onClick={() => { setFocusId(r.id); setDisc({ highlights: false, related: false, context: false }); }}
                                className="sd-hover-bg-alt"
                                style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 8px", borderRadius: 8, cursor: "pointer" }}
                              >
                                <span style={{ width: 9, height: 9, borderRadius: 2, background: r.mark, flex: "none" }} />
                                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                                <span style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 13.5, color: "var(--text-muted)", flex: "none" }}>{r.why}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {d.key === "context" && (
                          <div>
                            <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--text-secondary)", marginBottom: 14, textWrap: "pretty" as CSSProperties["textWrap"] }}>{focused.context}</div>
                            <button
                              onClick={() => { setView(isList ? "desk" : "list"); setFocusId(null); }}
                              className="sd-hover-border"
                              style={{ border: "1px solid var(--border-strong)", background: "none", color: "var(--text-secondary)", borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer" }}
                            >{isList ? "Show it on the desk" : "Find it in the list"}</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
