"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import {
  MARK,
  TINT,
  bars,
  WHY,
  WHY_RELATED,
  type StashItem,
  type Kind,
} from "@/lib/data";
import { keepUrl, getItem, savePosition, deleteItem, trashItem, restoreItem, emptyTrash, listTrash, updateItemFields, searchItems, addComment, addItemComment, listItemComments, moveItemToStash, keepFile, createFolder, addAsk, askQuestion, saveFolderPosition, renameFolder, deleteFolder, type SearchHit, type KeepResult } from "@/lib/actions";
import { createNewStash, switchStash } from "@/lib/workspace-actions";
import type { ItemComment } from "@/lib/db";
import { Trash2, Sun, Moon, Monitor, Pencil, ChevronDown, Settings as SettingsIcon, Building2, User as UserIcon, Send, Layers, FolderInput, Plus, Check, StickyNote, Sparkles, ImagePlus, FolderPlus, FolderMinus } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import Onboarding from "./Onboarding";
import SettingsModal from "./SettingsModal";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import UserMenu from "./UserMenu";

const DEFAULT_CAMERA = { scale: 1, tx: -133, ty: 3 };
const KIND_OPTIONS: Kind[] = ["article", "video", "image", "pdf", "note", "quote", "repo", "shot"];
// Desk geometry of a folder object (canvas coords) — hit-testing and the
// rendered button share these.
const FOLDER_W = 96;
const FOLDER_H = 92;
type Theme = "light" | "dark" | "system";
const THEME_KEY = "stashdrop-theme";
const GRID_KEY = "stashdrop-grid";

// A flat, single-color folder glyph (macOS Finder style: a small tab
// overlapping a rounded body) — two overlapping rects in one fill so the
// seam disappears. Every folder uses the same color; state (hover/open/drag)
// is shown with a highlight pill behind it instead, never a color change.
function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 20" className={className} aria-hidden="true">
      <rect x="1" y="3" width="10" height="4" rx="1.5" fill="currentColor" />
      <rect x="1" y="5" width="22" height="14" rx="2.5" fill="currentColor" />
    </svg>
  );
}

interface Capture {
  text: string;
  dot: string;
  anim: string;
  where?: string;
}

interface Disc {
  key: "highlights" | "related" | "context" | "comments";
  label: string;
  n: string;
}

// The paste-to-keep flow: pasting a URL opens this "slip" — reading, then a
// preview of what will be kept. Clicking Save promotes it into a "ghost"
// that flies out of the slip and follows the cursor until you click the
// desk to put it down (see startPlacing/placeGhost below).
interface PendingCapture {
  pid: string;
  url: string;
  host: string;
  status: "reading" | "ready" | "error";
  item?: StashItem;
  clusterName?: string;
  errorText?: string;
}
interface GhostCapture extends PendingCapture {
  phase: "flying" | "landing" | "held";
  rect: { left: number; top: number; width: number } | null;
}

interface CanvasProps {
  initialItems: StashItem[];
  initialBucket: Record<string, string>;
  initialRecentOrder: string[];
  user: { id: string; name: string; email: string };
  workspace: { name: string; organizationId: string | null };
  role: string;
  needsOnboarding: boolean;
  // When the user is mid-onboarding for a workspace they just switched to,
  // the "Personal or team" choice is already made — Onboarding skips it and
  // goes straight to naming the first stash under this scope/team.
  onboardingInitialScope?: "user" | "organization";
  onboardingOrganizationId?: string;
  // The active stash and its siblings within the current workspace — null/
  // empty during onboarding, before any stash exists yet.
  stash?: { id: string; name: string; description: string } | null;
  stashes?: { id: string; name: string }[];
  clusters?: { key: string; name: string; x: number; y: number }[];
}

export default function Canvas({ initialItems, initialBucket, initialRecentOrder, user, workspace, role, needsOnboarding, onboardingInitialScope, onboardingOrganizationId, stash = null, stashes = [], clusters = [] }: CanvasProps) {
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const timeoutsRef = useRef<number[]>([]);
  // Whether the context menu's "Edit" should open the card straight into
  // edit mode once it becomes focused — state, not a ref, since it's read
  // back during the render-time focus-change adjustment below (refs can't
  // be read during render).
  const [openInEdit, setOpenInEdit] = useState(false);

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
  const [dragFolder, setDragFolderState] = useState<string | null>(null);
  const [sort, setSort] = useState<"folder" | "recent">("folder");
  const [dragId, setDragIdState] = useState<string | null>(null);
  const [panning, setPanningState] = useState(false);

  // Mirrors of the above, updated synchronously (not via a useEffect) so the
  // window-level pointermove/pointerup handlers — registered once on mount,
  // see below — always see the latest value even when pointerdown and the
  // following pointermove land in the same tick, before React re-renders.
  const liveRef = useRef({
    dragId: null as string | null, panning: false, scale: DEFAULT_CAMERA.scale,
    tx: DEFAULT_CAMERA.tx, ty: DEFAULT_CAMERA.ty,
    aiming: false, lastCursor: [0, 0] as [number, number],
    pending: null as PendingCapture | null, ghost: null as GhostCapture | null,
    placingComment: false, placingAsk: false, dragFolder: null as string | null,
    // placeGhost/placeComment clear their own "is a ghost pending" flag
    // synchronously (before their first await), which happens before the
    // click event that follows the same pointerdown even fires — so a
    // click's own "is a ghost mid-drop" check always sees false and can't
    // tell a drop-click from an open-this-card click. This flag is set at
    // the moment a drop is committed and consumed by the very next click.
    suppressClick: false,
  });

  const setCamera = useCallback((updater: typeof DEFAULT_CAMERA | ((s: typeof DEFAULT_CAMERA) => typeof DEFAULT_CAMERA)) => {
    setCameraState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      liveRef.current.scale = next.scale;
      liveRef.current.tx = next.tx;
      liveRef.current.ty = next.ty;
      return next;
    });
  }, []);
  // Total pointer movement since the current drag started. A `click` event
  // always reports movementX/Y as 0 (it isn't a move event), so that alone
  // can't tell a real click from a drag-then-release on the same element —
  // this ref is the actual signal the click handler checks.
  const dragDistanceRef = useRef(0);
  const folderDragDistanceRef = useRef(0);
  const startDrag = useCallback((id: string) => {
    dragDistanceRef.current = 0;
    liveRef.current.dragId = id;
    setDragIdState(id);
  }, []);
  const startFolderDrag = useCallback((key: string) => {
    folderDragDistanceRef.current = 0;
    liveRef.current.dragFolder = key;
    setDragFolderState(key);
  }, []);
  const startPan = useCallback(() => { liveRef.current.panning = true; setPanningState(true); }, []);
  const endDragAndPan = useCallback(() => {
    liveRef.current.dragId = null;
    liveRef.current.panning = false;
    liveRef.current.dragFolder = null;
    setDragIdState(null);
    setPanningState(false);
    setDragFolderState(null);
  }, []);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [query, setQueryState] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());
  const [disc, setDisc] = useState({ highlights: false, related: false, context: false, comments: false });
  const [comments, setComments] = useState<ItemComment[]>([]);
  const [commentsItemId, setCommentsItemId] = useState<string | null>(null);
  const [newComment, setNewComment] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);

  const [pendingState, setPendingState] = useState<PendingCapture | null>(null);
  const setPending = useCallback((updater: PendingCapture | null | ((prev: PendingCapture | null) => PendingCapture | null)) => {
    setPendingState((prev) => {
      const next = typeof updater === "function" ? (updater as (p: PendingCapture | null) => PendingCapture | null)(prev) : updater;
      liveRef.current.pending = next;
      return next;
    });
  }, []);
  const [ghostState, setGhostState] = useState<GhostCapture | null>(null);
  const setGhost = useCallback((updater: GhostCapture | null | ((prev: GhostCapture | null) => GhostCapture | null)) => {
    setGhostState((prev) => {
      const next = typeof updater === "function" ? (updater as (p: GhostCapture | null) => GhostCapture | null)(prev) : updater;
      liveRef.current.ghost = next;
      return next;
    });
  }, []);
  const [cursor, setCursor] = useState<[number, number]>([0, 0]);
  const [landedId, setLandedId] = useState<string | null>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const cancelledPidsRef = useRef<Set<string>>(new Set());

  // Mirror of items for the window-level pointer handlers, which are
  // registered once and would otherwise close over a stale copy.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // Folders (clusters) for this stash — dynamic now, seeded from the server
  // and appended to when the user creates one from the toolbar. Positions
  // live separately in folderPos below.
  const [clusterList, setClusterList] = useState<{ key: string; name: string }[]>(clusters);
  const clusterNames = Object.fromEntries(clusterList.map((c) => [c.key, c.name]));
  const clusterListRef = useRef(clusterList);
  useEffect(() => { clusterListRef.current = clusterList; }, [clusterList]);

  // Folders are draggable desk objects now, so they own a position map like
  // the items do. Seeded from the server (x/y = -1 means "never moved yet"
  // → fall back to the deterministic default row), mirrored in a ref so the
  // window-level drag handlers always see the latest value.
  const [folderPos, setFolderPosState] = useState<Record<string, { x: number; y: number }>>(() =>
    Object.fromEntries(clusters.map((c, i) => [
      c.key,
      c.x >= 0 ? { x: c.x, y: c.y } : { x: 750 + i * (FOLDER_W + 26), y: 300 },
    ]))
  );
  const folderPosRef = useRef(folderPos);
  const setFolderPos = useCallback((updater: (prev: Record<string, { x: number; y: number }>) => Record<string, { x: number; y: number }>) => {
    const next = updater(folderPosRef.current);
    folderPosRef.current = next;
    setFolderPosState(next);
  }, []);
  // Desk rects of every folder (computed below, per render) so the drag
  // handlers can hit-test drops without re-reading the DOM.
  const folderRectsRef = useRef<Record<string, { x: number; y: number; w: number; h: number }>>({});
  // Which folder the dragged card is currently over (drop highlight), which
  // folder is being dragged, and which folder is open (contents spilling out
  // below it).
  const [dragOverCluster, setDragOverCluster] = useState<string | null>(null);
  const [openFolder, setOpenFolder] = useState<Set<string>>(new Set());
  const openFolderRef = useRef<Set<string>>(new Set());
  useEffect(() => { openFolderRef.current = openFolder; }, [openFolder]);
  // Which folder got a flash ("something was filed in here") — cleared after
  // the animation, so rapid successive drops restart it via state churn.
  const [flashedFolder, setFlashedFolder] = useState<string | null>(null);
  // Folder right-click menu, its rename modal, and the (non-dismissable)
  // delete confirmation.
  const [folderMenu, setFolderMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [folderRenameKey, setFolderRenameKey] = useState<string | null>(null);
  const [folderRename, setFolderRename] = useState("");
  const [deleteFolderKey, setDeleteFolderKey] = useState<string | null>(null);

  // Multi-select (shift-drag rubber band on the background, shift-click a
  // card) + the marquee rectangle being drawn right now (canvas coords).
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const marqueeRef = useRef<{ startX: number; startY: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  // "Ask anything" card — same place-then-type flow as comments.
  const [placingAsk, setPlacingAskState] = useState(false);
  const [autoFocusAskId, setAutoFocusAskId] = useState<string | null>(null);
  const askContextRef = useRef<string[]>([]);
  const [askingIds, setAskingIds] = useState<string[]>([]);

  // Right toolbar: hidden file input for dropping/importing images, and
  // the inline "new folder" prompt.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchBarRef = useRef<HTMLDivElement>(null);
  const flipFromRef = useRef<DOMRect | null>(null);
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);
  const [folderName, setFolderName] = useState("");

  // Undo toast for trashed items.
  const [toast, setToast] = useState<{ text: string; items: StashItem[] } | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const showUndoToast = useCallback((text: string, items: StashItem[]) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ text, items });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current); }, []);

  // "light" is the true default (matches layout.tsx's before-paint script) —
  // "system" is only ever active once a user explicitly picks Auto.
  const [theme, setThemeState] = useState<Theme>("light");
  useEffect(() => {
    // localStorage is a browser-only API — this component is also
    // server-rendered, so this can't be a lazy useState initializer and has
    // to run post-mount. The inline script in layout.tsx already applied
    // the stored theme to the DOM before paint; this just syncs React state
    // to match so the toggle UI reflects the right selection.
    try {
      const stored = localStorage.getItem(THEME_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored === "light" || stored === "dark" || stored === "system") setThemeState(stored);
    } catch { /* localStorage unavailable (private mode, etc.) — stay on light */ }
  }, []);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch { /* ignore */ }
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  }, []);

  // Purely cosmetic per-browser preference — same localStorage pattern as
  // theme, no reason to round-trip it through the stash's own settings.
  const [paperGrid, setPaperGridState] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(GRID_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored === "off") setPaperGridState(false);
    } catch { /* localStorage unavailable — stay on */ }
  }, []);
  const setPaperGrid = useCallback((on: boolean) => {
    setPaperGridState(on);
    try { localStorage.setItem(GRID_KEY, on ? "on" : "off"); } catch { /* ignore */ }
  }, []);

  // Surfaces a just-received team invite as the workspace switcher, once
  // per browser session per invite (onboarding handles invites on its own
  // for brand-new accounts, so this only matters for already-onboarded
  // users who get invited later).
  useEffect(() => {
    if (needsOnboarding) return;
    void authClient.organization.listUserInvitations().then(({ data }) => {
      const pending = (data || []).filter((i) => i.status === "pending");
      if (!pending.length) return;
      const key = "stashdrop-invites-seen";
      let seen: string[] = [];
      try { seen = JSON.parse(sessionStorage.getItem(key) || "[]"); } catch { /* private mode etc. */ }
      if (pending.every((i) => seen.includes(i.id))) return;
      try { sessionStorage.setItem(key, JSON.stringify(pending.map((i) => i.id))); } catch { /* ignore */ }
      setWorkspaceSwitcherOpen(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dropping a comment works like the paste-to-keep ghost: click "+
  // Comment", a blank sticky note follows the cursor, click the desk to
  // place it — then it's immediately live for typing, no name prompt (the
  // author is whoever's signed in).
  const [placingComment, setPlacingCommentState] = useState(false);
  const [autoFocusCommentId, setAutoFocusCommentId] = useState<string | null>(null);
  function setPlacingComment(v: boolean) {
    liveRef.current.placingComment = v;
    setPlacingCommentState(v);
  }

  const beginPlacingComment = useCallback(() => {
    if (liveRef.current.placingComment) { setPlacingComment(false); liveRef.current.aiming = false; return; }
    const target = liveRef.current.lastCursor[0] || liveRef.current.lastCursor[1]
      ? liveRef.current.lastCursor
      : ([window.innerWidth / 2 - 100, window.innerHeight / 2 - 60] as [number, number]);
    setCursor(target);
    liveRef.current.aiming = true;
    setPlacingComment(true);
  }, []);

  async function placeComment(clientX: number, clientY: number) {
    setPlacingComment(false);
    liveRef.current.aiming = false;
    const x = (clientX - camera.tx) / camera.scale - 100;
    const y = (clientY - camera.ty) / camera.scale - 60;
    const item = await addComment(x, y);
    setItems((prev) => [...prev, item]);
    setBucket((prev) => ({ ...prev, [item.id]: "This week" }));
    setRecentOrder((prev) => [item.id, ...prev]);
    setPos((prev) => ({ ...prev, [item.id]: [item.x, item.y] }));
    setLandedId(item.id);
    later(() => setLandedId((prev) => (prev === item.id ? null : prev)), 700);
    setAutoFocusCommentId(item.id); // the title input focuses itself once rendered, see the card map below
  }

  async function commitCommentTitle(id: string, title: string) {
    const trimmed = title.trim();
    const current = items.find((o) => o.id === id);
    if (!current || current.title === trimmed) return;
    const updated = await updateItemFields(id, { title: trimmed });
    if (updated) setItems((prev) => prev.map((o) => (o.id === id ? updated : o)));
  }

  // A freshly created item lands in the desk state the same way whether it
  // was a comment, an ask card, a dropped file, or a ghost drop.
  const addItemToDesk = useCallback((item: StashItem) => {
    setItems((prev) => [...prev, item]);
    setBucket((prev) => ({ ...prev, [item.id]: "This week" }));
    setRecentOrder((prev) => [item.id, ...prev]);
    setPos((prev) => ({ ...prev, [item.id]: [item.x, item.y] }));
    setLandedId(item.id);
    window.setTimeout(() => setLandedId((prev) => (prev === item.id ? null : prev)), 700);
  }, [setItems, setBucket, setRecentOrder, setPos]);

  function setPlacingAsk(v: boolean) {
    liveRef.current.placingAsk = v;
    setPlacingAskState(v);
  }

  function beginPlacingAsk(withContext?: string[]) {
    if (placingAsk) { setPlacingAsk(false); liveRef.current.aiming = false; return; }
    askContextRef.current = withContext ?? selectedIds;
    const target = liveRef.current.lastCursor[0] || liveRef.current.lastCursor[1]
      ? liveRef.current.lastCursor
      : ([window.innerWidth / 2 - 100, window.innerHeight / 2 - 60] as [number, number]);
    setCursor(target);
    liveRef.current.aiming = true;
    setPlacingAsk(true);
  }

  async function placeAsk(clientX: number, clientY: number) {
    setPlacingAsk(false);
    liveRef.current.aiming = false;
    const x = (clientX - camera.tx) / camera.scale - 105;
    const y = (clientY - camera.ty) / camera.scale - 60;
    const item = await addAsk(x, y);
    addItemToDesk(item);
    setAutoFocusAskId(item.id);
  }

  async function submitAsk(id: string, question: string) {
    const q = question.trim();
    if (!q || askingIds.includes(id)) return;
    const current = items.find((o) => o.id === id);
    if (!current) return;
    setAskingIds((prev) => [...prev, id]);
    setItems((prev) => prev.map((o) => (o.id === id ? { ...o, title: q } : o)));
    try {
      const updated = await askQuestion(id, q, askContextRef.current);
      if (updated) setItems((prev) => prev.map((o) => (o.id === id ? updated : o)));
    } finally {
      setAskingIds((prev) => prev.filter((i) => i !== id));
    }
    askContextRef.current = [];
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  const captureTimerRef = useRef<number | undefined>(undefined);
  const showCapture = useCallback((c: Capture, ms = 3200) => {
    if (captureTimerRef.current) window.clearTimeout(captureTimerRef.current);
    setCapture(c);
    captureTimerRef.current = window.setTimeout(() => setCapture(null), ms);
  }, []);

  // AI enrichment (tags/description/context/highlights) lands after the
  // item is already captured, not before — see keepUrl's comment. This
  // polls for that background pass and patches the item wherever it
  // currently is: a pending preview, a held/flying ghost, or an
  // already-placed desk card. Stops on its own once the item is gone
  // (discarded) or enrichment lands; gives up after ~45s either way.
  // Used by URL captures and, for PDFs, by the drop/paste flow below.
  const applyEnrichment = useCallback((id: string, patch: Partial<StashItem>) => {
    setPending((prev) => (prev && prev.item && prev.item.id === id ? { ...prev, item: { ...prev.item, ...patch } } : prev));
    setGhost((prev) => (prev && prev.item && prev.item.id === id ? { ...prev, item: { ...prev.item, ...patch } } : prev));
    setItems((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }, [setPending, setGhost, setItems]);

  const pollEnrichment = useCallback(async (id: string) => {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await getItem(id);
      if (!res) return; // discarded before enrichment landed
      if (res.enrichedAt) {
        applyEnrichment(id, {
          tags: res.item.tags, description: res.item.description,
          context: res.item.context, highlights: res.item.highlights,
          related: res.item.related,
        });
        return;
      }
    }
  }, [applyEnrichment]);

  const keepFileItem = useCallback(async (name: string, dataUrl: string, type: string, clientX?: number, clientY?: number) => {
    const { scale, tx, ty } = liveRef.current;
    const [lcx, lcy] = liveRef.current.lastCursor;
    const cx = clientX ?? lcx;
    const cy = clientY ?? lcy;
    const has = (cx || cy);
    const x = has ? (cx - tx) / scale - 100 : 700;
    const y = has ? (cy - ty) / scale - 60 : 500;
    try {
      const item = await keepFile(name, dataUrl, x, y);
      addItemToDesk(item);
      if (item.kind === "pdf") void pollEnrichment(item.id);
    } catch {
      showCapture({ text: "Couldn't keep that file", dot: "var(--danger)", anim: "none" });
    }
  }, [addItemToDesk, showCapture, pollEnrichment]);

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    await keepFileItem(file.name, dataUrl, file.type);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    await keepFileItem(file.name, dataUrl, file.type, e.clientX, e.clientY);
  }

  // Paste-to-keep for clipboard images (URLs still go through the search
  // bar, which handles text paste on its own).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (!files || !files.length) return;
      const file = files[0];
      if (!file.type.startsWith("image/")) return;
      e.preventDefault();
      void (async () => {
        const dataUrl = await readFileAsDataUrl(file);
        const [lx, ly] = liveRef.current.lastCursor;
        await keepFileItem(file.name, dataUrl, file.type, lx, ly);
      })();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [keepFileItem]);

  async function handleCreateFolder() {
    const name = folderName.trim();
    if (!name) return;
    try {
      const folder = await createFolder(name);
      setClusterList((prev) => [...prev, folder]);
      // New folders land at the end of the default row until dragged away.
      setFolderPos((prev) => ({
        ...prev,
        [folder.key]: { x: 750 + clusterListRef.current.length * (FOLDER_W + 26), y: 300 },
      }));
      setFolderName("");
      setFolderCreateOpen(false);
      showCapture({ text: `Folder "${folder.name}" created`, dot: "var(--text-muted)", anim: "none" });
    } catch {
      showCapture({ text: "Couldn't create that folder", dot: "var(--danger)", anim: "none" });
    }
  }

  async function undoTrash() {
    if (!toast) return;
    const itemsToRestore = toast.items;
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast(null);
    for (const item of itemsToRestore) {
      try { await restoreItem(item.id); } catch { continue; }
    }
    setItems((prev) => [...prev, ...itemsToRestore]);
    setPos((prev) => Object.fromEntries([...Object.entries(prev), ...itemsToRestore.map((o) => [o.id, [o.x, o.y] as [number, number]])]));
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  }

  async function bulkTrashSelected() {
    const doomed = selectedIds.map((id) => items.find((o) => o.id === id)).filter((o): o is StashItem => !!o);
    for (const item of doomed) {
      try { await trashItem(item.id); } catch { continue; }
    }
    setItems((prev) => prev.filter((o) => !selectedIds.includes(o.id)));
    setPos((prev) => { const next = { ...prev }; selectedIds.forEach((id) => delete next[id]); return next; });
    setSelectedIds([]);
    if (doomed.length) showUndoToast(`Deleted ${doomed.length} thing${doomed.length === 1 ? "" : "s"}`, doomed);
  }

  async function bulkMoveSelected(cluster: string) {
    const targets = selectedIds.filter((id) => items.find((o) => o.id === id)?.cluster !== cluster);
    for (const id of targets) {
      const updated = await updateItemFields(id, { cluster });
      if (updated) setItems((prev) => prev.map((o) => (o.id === id ? updated : o)));
    }
    setSelectedIds([]);
  }

  // Opening a folder spills its contents out below it (a fanned cascade),
  // so you can see and drag them; closing tucks them back inside. Items stay
  // filed (cluster unchanged) while spilled — the only way to unlink one is
  // the context menu's "Remove from folder".
  function toggleFolder(key: string) {
    if (openFolderRef.current.has(key)) {
      setOpenFolder((prev) => { const next = new Set(prev); next.delete(key); return next; });
      return;
    }
    setOpenFolder((prev) => new Set(prev).add(key));
    const r = folderPosRef.current[key] ?? { x: 750, y: 300 };
    const members = itemsRef.current.filter((o) => o.cluster === key);
    members.forEach((o, i) => {
      const nx = r.x + 16 + i * 30;
      const ny = r.y + FOLDER_H + 40 + i * 36;
      setPos((prev) => ({ ...prev, [o.id]: [nx, ny] }));
      void savePosition(o.id, nx, ny);
    });
  }

  // Unlinks a card from its folder (cluster → ""), leaving it exactly where
  // it is — no repositioning. Called only from the context menu.
  function removeFromFolder(id: string) {
    const it = itemsRef.current.find((o) => o.id === id);
    if (!it?.cluster) return;
    void updateItemFields(id, { cluster: "" }).then((updated) => {
      if (!updated) return;
      setItems((prev) => prev.map((o) => (o.id === id ? updated : o)));
    });
  }

  async function saveFolderRename() {
    if (!folderRenameKey) return;
    const res = await renameFolder(folderRenameKey, folderRename);
    if (res) {
      setClusterList((prev) => prev.map((c) => (c.key === res.key ? { ...c, name: res.name } : c)));
      setFolderRenameKey(null);
    }
  }

  // Delete the folder, then reconcile local state with what the server did:
  // "keep" unlinks the contents back to the desk, "delete" removes them.
  async function handleDeleteFolder(mode: "keep" | "delete") {
    if (!deleteFolderKey) return;
    const key = deleteFolderKey;
    const doomed = items.filter((o) => o.cluster === key);
    await deleteFolder(key, mode);
    setClusterList((prev) => prev.filter((c) => c.key !== key));
    setFolderPos((prev) => { const next = { ...prev }; delete next[key]; return next; });
    setOpenFolder((prev) => { const next = new Set(prev); next.delete(key); return next; });
    if (mode === "keep") {
      setItems((prev) => prev.map((o) => (o.cluster === key ? { ...o, cluster: "" } : o)));
    } else {
      setItems((prev) => prev.filter((o) => o.cluster !== key));
      setPos((prev) => { const next = { ...prev }; doomed.forEach((o) => delete next[o.id]); return next; });
    }
    setDeleteFolderKey(null);
    setFolderMenu(null);
    showCapture({
      text: mode === "keep" ? "Folder deleted — items kept on the desk" : `Deleted folder and ${doomed.length} item${doomed.length === 1 ? "" : "s"}`,
      dot: "var(--text-muted)", anim: "none",
    });
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
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashItems, setTrashItems] = useState<(StashItem & { deletedAt: number })[]>([]);
  const [emptyArmed, setEmptyArmed] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [stashMenuOpen, setStashMenuOpen] = useState(false);
  const [newStashName, setNewStashName] = useState("");
  const [stashBusy, setStashBusy] = useState(false);

  // The move submenu is only meaningful for whichever card's context menu
  // is currently open — every place that opens or closes contextMenu below
  // also collapses this, so it never survives onto a different card or an
  // already-closed menu.
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setMoveMenuOpen(false);
  }, []);

  const searchTimerRef = useRef<number | undefined>(undefined);
  const searchSeqRef = useRef(0);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timeoutsRef.current.push(id);
  }, []);

  // Re-triggers the "filed in here" pulse on a folder (sd-land outline).
  const flashFolder = useCallback((key: string) => {
    setFlashedFolder(null);
    window.setTimeout(() => setFlashedFolder(key), 20);
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
    // Inlined rather than calling cancelPending() (declared further below,
    // after this effect in source order — referencing it here would throw
    // on first render, before that const is initialized). setPending/
    // setGhost are already stable by this point, so this stays safe.
    const onKey = (e: KeyboardEvent) => {
      // ⌘/Ctrl+K focuses the search bar; "/" drops a comment — but never
      // steal typing from an input/textarea/select that's already focused.
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        flipFromRef.current = searchBarRef.current?.getBoundingClientRect() ?? null;
        setSearchOpen(true);
        return;
      }
      if (e.key === "/" && !inField) {
        e.preventDefault();
        beginPlacingComment();
        return;
      }
      if (e.key === "Escape") {
        const p = liveRef.current.pending || liveRef.current.ghost;
        if (p) {
          cancelledPidsRef.current.add(p.pid);
          if (p.item) void deleteItem(p.item.id);
        }
        liveRef.current.aiming = false;
        liveRef.current.placingComment = false;
        liveRef.current.placingAsk = false;
        setPending(null);
        setGhost(null);
        setPlacingCommentState(false);
        setPlacingAskState(false);
        setFocusId(null);
        setTrashOpen(false);
        setSelectedIds([]);
        setMarquee(null);
        marqueeRef.current = null;
        setFolderCreateOpen(false);
        closeContextMenu();
        setThemeMenuOpen(false);
        setStashMenuOpen(false);
        setSearchOpen(false);
        setOpenFolder(new Set());
        setFolderMenu(null);
        setFolderRenameKey(null);
        setQueryState("");
        setSearchResults([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPending, setGhost, closeContextMenu, beginPlacingComment]);

  // ⌘K "pop-out" — FLIP the search bar from its inline spot (top-center)
  // to the center of the screen when the palette opens. Measure the old
  // rect in the keydown handler (before the re-render), then after this
  // layout commits, animate the new rect back from the old one so the bar
  // appears to glide out, grow, and settle — the same trick Linear/cmdk
  // use for their command palettes.
  useLayoutEffect(() => {
    const el = searchBarRef.current;
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    if (!el || !flipFromRef.current) return;
    const first = flipFromRef.current;
    flipFromRef.current = null;
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    const sx = first.width / last.width;
    const sy = first.height / last.height;
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: "top left" },
        { transform: "none", transformOrigin: "top left" },
      ],
      { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  }, [searchOpen]);

  // Reset the edit/delete-confirm UI whenever the focused item changes.
  // Adjusted during render (React's documented pattern for this) rather
  // than in an effect, since an effect would cause an extra render pass.
  const [lastFocusId, setLastFocusId] = useState(focusId);
  if (lastFocusId !== focusId) {
    setLastFocusId(focusId);
    setEditing(openInEdit);
    setOpenInEdit(false);
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
    // Which folder a card at (x, y) would land in if dropped there right
    // now. Used live during drag (for the "over" highlight) and again at
    // drop — the same rect check for both, so the folder that lights up
    // while dragging is always the one the card actually files into.
    const folderHit = (x: number, y: number, item: StashItem | undefined): string | null => {
      const h = item?.isText ? 115 : (item?.kind === "image" || item?.kind === "shot" ? 205 : 180);
      const cx = x + (item?.w ?? 196) / 2, cy = y + h / 2;
      const found = Object.entries(folderRectsRef.current).find(([, r]) =>
        cx > r.x - 24 && cx < r.x + r.w + 24 && cy > r.y - 24 && cy < r.y + r.h + 24
      );
      return found ? found[0] : null;
    };
    const move = (e: PointerEvent) => {
      liveRef.current.lastCursor = [e.clientX, e.clientY];
      if (liveRef.current.aiming) setCursor(liveRef.current.lastCursor);
      const id = liveRef.current.dragId;
      const fk = liveRef.current.dragFolder;
      if (fk) {
        folderDragDistanceRef.current += Math.abs(e.movementX) + Math.abs(e.movementY);
        const dx = e.movementX / liveRef.current.scale, dy = e.movementY / liveRef.current.scale;
        setFolderPos((prev) => {
          const p = prev[fk] ?? { x: 750, y: 300 };
          return { ...prev, [fk]: { x: p.x + dx, y: p.y + dy } };
        });
        // An open folder drags its spilled contents along with it.
        if (openFolderRef.current.has(fk)) {
          setPos((prev) => {
            let next = prev;
            for (const o of itemsRef.current) {
              if (o.cluster !== fk) continue;
              const [ox, oy] = next[o.id] ?? [o.x, o.y];
              next = { ...next, [o.id]: [ox + dx, oy + dy] };
            }
            return next;
          });
        }
      } else if (id) {
        dragDistanceRef.current += Math.abs(e.movementX) + Math.abs(e.movementY);
        setPos((prev) => {
          const [x, y] = prev[id];
          return { ...prev, [id]: [x + e.movementX / liveRef.current.scale, y + e.movementY / liveRef.current.scale] };
        });
        const [nx, ny] = posRef.current[id];
        const draggedItem = itemsRef.current.find((o) => o.id === id);
        setDragOverCluster((prev) => {
          const next = folderHit(nx, ny, draggedItem);
          return prev === next ? prev : next;
        });
      } else if (liveRef.current.panning) {
        setCamera((s) => ({ ...s, tx: s.tx + e.movementX, ty: s.ty + e.movementY }));
      } else if (marqueeRef.current) {
        const { startX, startY } = marqueeRef.current;
        const { scale, tx, ty } = liveRef.current;
        const cx = (e.clientX - tx) / scale, cy = (e.clientY - ty) / scale;
        setMarquee({ x0: Math.min(startX, cx), y0: Math.min(startY, cy), x1: Math.max(startX, cx), y1: Math.max(startY, cy) });
      }
    };
    const up = (e: PointerEvent) => {
      const id = liveRef.current.dragId;
      const fk = liveRef.current.dragFolder;
      if (fk) {
        const p = folderPosRef.current[fk];
        if (p) void saveFolderPosition(fk, p.x, p.y);
      } else if (id) {
        const [x, y] = posRef.current[id];
        const item = itemsRef.current.find((o) => o.id === id);
        // Dropping a card onto a folder files it inside — the folder hides
        // the card from the desk until it's spilled back out. Same rect
        // check that drove the "over" highlight during the drag, so the
        // folder that was lit up is always the one it actually lands in.
        const hitKey = item ? folderHit(x, y, item) : null;
        if (item && hitKey) {
          if (hitKey === item.cluster) {
            // Dropped back on its own (open) folder — stays filed.
            void savePosition(id, x, y);
          } else {
            const name = clusterListRef.current.find((c) => c.key === hitKey)?.name || "folder";
            showCapture({ text: `Moved into "${name}"`, dot: "var(--text-muted)", anim: "none" });
            flashFolder(hitKey);
            void updateItemFields(id, { cluster: hitKey }).then((updated) => {
              if (!updated) return;
              setItems((prev) => prev.map((o) => (o.id === id ? updated : o)));
              // If the target folder is open, the card stays visible — so
              // tuck it onto the end of the spill cascade instead of leaving
              // it sitting on top of the folder icon.
              if (openFolderRef.current.has(hitKey)) {
                const r = folderRectsRef.current[hitKey];
                const n = itemsRef.current.filter((o) => o.cluster === hitKey).length;
                const nx = r.x + 16 + n * 30;
                const ny = r.y + FOLDER_H + 40 + n * 36;
                setPos((prev) => ({ ...prev, [id]: [nx, ny] }));
                void savePosition(id, nx, ny);
              }
            });
          }
        } else {
          // Dropped on the desk — a spilled card keeps its folder; removing
          // it from a folder is deliberate (context menu → "Remove from
          // folder"), not a side effect of where you let go.
          void savePosition(id, x, y);
        }
      } else if (marqueeRef.current) {
        const { startX, startY } = marqueeRef.current;
        const { scale, tx, ty } = liveRef.current;
        const cx = (e.clientX - tx) / scale, cy = (e.clientY - ty) / scale;
        const x0 = Math.min(startX, cx), y0 = Math.min(startY, cy), x1 = Math.max(startX, cx), y1 = Math.max(startY, cy);
        const sel = itemsRef.current
          .filter((o) => {
            const [x, y] = posRef.current[o.id] || [o.x, o.y];
            const h = o.isText ? 115 : (o.kind === "image" || o.kind === "shot" ? 205 : 180);
            const w = o.w * 1.15;
            return x < x1 && x + w > x0 && y < y1 && y + h > y0;
          })
          .map((o) => o.id);
        setSelectedIds(sel);
        marqueeRef.current = null;
        setMarquee(null);
      }
      endDragAndPan();
      setDragOverCluster(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [setPos, setFolderPos, setCamera, endDragAndPan, showCapture, flashFolder]);

  const isUrl = (v: string) => /^https?:\/\/|^www\./i.test(v.trim());

  // Cancel whatever's in flight: if the item was already created (keepUrl
  // resolved before the user backed out), delete it so it doesn't sit
  // orphaned in the DB, invisible, forever. If keepUrl hasn't resolved yet,
  // mark the pid so beginCapture cleans up as soon as it does.
  const cancelPending = useCallback(() => {
    liveRef.current.aiming = false;
    const p = liveRef.current.pending || liveRef.current.ghost;
    if (p) {
      cancelledPidsRef.current.add(p.pid);
      if (p.item) void deleteItem(p.item.id);
    }
    setPending(null);
    setGhost(null);
    setQueryState("");
    setSearchResults([]);
  }, [setPending, setGhost]);

  async function beginCapture(rawUrl: string) {
    const full = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    let host = full;
    try { host = new URL(full).hostname.replace(/^www\./, ""); } catch { /* keep raw as fallback */ }
    // beginCapture only ever runs from onChangeQuery, itself only wired to
    // the search input's onChange — never during render — so this is safe
    // despite the lint rule's conservative (can't prove it here) flag.
    // eslint-disable-next-line react-hooks/purity
    const pid = "p" + Date.now().toString(36) + Math.round(Math.random() * 100);

    setSearchResults([]);
    setSearching(false);
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    setPending({ pid, url: full, host, status: "reading" });

    let result: KeepResult;
    try {
      result = await keepUrl(full);
    } catch {
      // keepUrl itself only throws on something unexpected (DB write
      // failure, etc) — a merely-unreachable page is already handled
      // inside it by falling back to a bare-URL item.
      setPending((prev) => (prev?.pid === pid ? { ...prev, status: "error", errorText: "Something went wrong." } : prev));
      later(() => setPending((prev) => (prev?.pid === pid ? null : prev)), 2600);
      return;
    }

    if (cancelledPidsRef.current.has(pid)) {
      cancelledPidsRef.current.delete(pid);
      if (!("duplicate" in result)) void deleteItem(result.item.id);
      return;
    }
    if ("duplicate" in result) {
      setPending((prev) => (prev?.pid === pid ? null : prev));
      setQueryState("");
      setFocusId(result.duplicate.id);
      showCapture({ text: "Already kept", dot: "var(--text-fainter)", anim: "none" });
      return;
    }
    setPending((prev) => (prev?.pid === pid ? { ...prev, status: "ready", item: result.item, clusterName: result.clusterName } : prev));
    pollEnrichment(result.item.id);
  }

  // AI enrichment (tags/description/context/highlights) now happens after
  // the item is already captured, not before — see keepUrl's comment. This
  // polls for that background pass to land and patches the item wherever
  // it currently is: still the pending preview, a held/flying ghost, or
  // already placed on the desk. Stops on its own once the item is gone
  // (discarded) or enrichment lands; gives up after ~45s either way.
  // Browsers refuse to navigate a tab to a data: URL (blank page), so a
  // stored PDF opens via a same-origin blob URL instead — the PDF viewer
  // renders those fine.
  async function openPdf(dataUrl: string) {
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch {
      showCapture({ text: "Couldn't open that PDF", dot: "var(--danger)", anim: "none" });
    }
  }

  // Save doesn't file the card — it hands it to you. The slip's thumbnail
  // flies out and becomes a "ghost" that follows the cursor until you click
  // the desk to put it down (placeGhost).
  function startPlacing() {
    const p = pendingState;
    if (!p || p.status !== "ready") return;
    const el = thumbRef.current;
    const r = el ? el.getBoundingClientRect() : null;
    const rect = r ? { left: r.left, top: r.top, width: r.width } : null;
    const target = liveRef.current.lastCursor[0] || liveRef.current.lastCursor[1]
      ? liveRef.current.lastCursor
      : ([window.innerWidth / 2 - 110, window.innerHeight / 2 - 70] as [number, number]);
    setPending(null);
    setQueryState("");
    setCursor(target);
    setGhost({ ...p, phase: rect ? "flying" : "held", rect });
    if (!rect) { liveRef.current.aiming = true; return; }
    const pid = p.pid;
    const land = () => setGhost((prev) => (prev && prev.pid === pid && prev.phase === "flying" ? { ...prev, phase: "landing" } : prev));
    const hold = () => {
      liveRef.current.aiming = true;
      setGhost((prev) => (prev && prev.pid === pid && prev.phase !== "held" ? { ...prev, phase: "held" } : prev));
    };
    requestAnimationFrame(() => requestAnimationFrame(land));
    later(land, 60);
    later(hold, 500);
  }

  function placeGhost(clientX: number, clientY: number) {
    const g = liveRef.current.ghost;
    if (!g || !g.item) return;
    liveRef.current.aiming = false;
    const x = (clientX - camera.tx) / camera.scale - 98;
    const y = (clientY - camera.ty) / camera.scale - 60;
    const item = g.item;
    const clusterName = g.clusterName || "Unsorted";
    setGhost(null);
    void savePosition(item.id, x, y);
    setItems((prev) => [...prev, { ...item, x, y }]);
    setBucket((prev) => ({ ...prev, [item.id]: "This week" }));
    setRecentOrder((prev) => [item.id, ...prev]);
    setPos((prev) => ({ ...prev, [item.id]: [x, y] }));
    setLandedId(item.id);
    later(() => setLandedId((prev) => (prev === item.id ? null : prev)), 700);
    showCapture({ text: `Kept — you put it in ${clusterName}`, dot: "#3F5A52", anim: "none", where: "placed by hand" });
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
    if (isUrl(value)) {
      if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
      setSearchResults([]);
      setSearching(false);
      void beginCapture(value.trim());
    } else {
      triggerSearch(value);
    }
  }

  function queryKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      if (pendingState?.status === "ready") { startPlacing(); return; }
      if (searchResults.length) {
        setFocusId(searchResults[0].id);
        setSearchOpen(false);
        setDisc({ highlights: false, related: false, context: false, comments: false });
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
    const doomed = items.find((o) => o.id === id);
    try {
      await trashItem(id);
    } catch { setDeleteArmed(false); return; }
    setItems((prev) => prev.filter((o) => o.id !== id));
    setPos((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setFocusId(null);
    setDeleteArmed(false);
    if (doomed) showUndoToast("Deleted", [doomed]);
  }

  async function quickTrash(id: string) {
    closeContextMenu();
    const doomed = items.find((o) => o.id === id);
    try {
      await trashItem(id);
    } catch { return; }
    setItems((prev) => prev.filter((o) => o.id !== id));
    setPos((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setFocusId((f) => (f === id ? null : f));
    if (doomed) showUndoToast("Deleted", [doomed]);
  }

  async function moveToStash(id: string, targetStashId: string, targetName: string) {
    closeContextMenu();
    try {
      await moveItemToStash(id, targetStashId);
    } catch {
      showCapture({ text: "Couldn't move that", dot: "var(--danger)", anim: "none" });
      return;
    }
    setItems((prev) => prev.filter((o) => o.id !== id));
    setPos((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setFocusId((f) => (f === id ? null : f));
    showCapture({ text: `Moved to ${targetName}`, dot: "var(--text-fainter)", anim: "none" });
  }

  async function handleSwitchStash(id: string) {
    if (id === stash?.id) { setStashMenuOpen(false); return; }
    setStashBusy(true);
    try {
      await switchStash(id);
      setStashMenuOpen(false);
      router.refresh();
    } finally {
      setStashBusy(false);
    }
  }

  async function handleCreateStash() {
    const name = newStashName.trim();
    if (!name) return;
    setStashBusy(true);
    try {
      await createNewStash(name);
      setNewStashName("");
      setStashMenuOpen(false);
      router.refresh();
    } finally {
      setStashBusy(false);
    }
  }

  async function postComment(itemId: string) {
    const body = newComment.trim();
    if (!body) return;
    setPostingComment(true);
    try {
      const comment = await addItemComment(itemId, body);
      setComments((prev) => [...prev, comment]);
      setNewComment("");
    } finally {
      setPostingComment(false);
    }
  }

  async function openTrash() {
    setTrashOpen(true);
    setEmptyArmed(false);
    setTrashItems(await listTrash());
  }

  async function handleRestore(item: StashItem) {
    await restoreItem(item.id);
    setTrashItems((prev) => prev.filter((o) => o.id !== item.id));
    setItems((prev) => [...prev, item]);
    setPos((prev) => ({ ...prev, [item.id]: [item.x, item.y] }));
  }

  async function handleEmptyTrash() {
    if (!emptyArmed) {
      setEmptyArmed(true);
      later(() => setEmptyArmed(false), 4000);
      return;
    }
    await emptyTrash();
    setTrashItems([]);
    setEmptyArmed(false);
  }

  // ---- derived render values ----
  const isList = view === "list";
  const hits: Record<string, number> | null = searchResults.length
    ? Object.fromEntries(searchResults.map((h) => [h.id, h.score]))
    : null;
  const zoomedOut = camera.scale < 0.6;
  const barOpen = !!query || !!pendingState || !!ghostState;

  // Folders are draggable desk objects — their desk rects track folderPos,
  // mirrored into a ref so the drag handlers can hit-test drops. The ??
  // fallback covers a folder whose position isn't known yet (e.g. React Fast
  // Refresh preserved clusterList state across an edit that introduced
  // folderPos), so rendering never crashes on a missing entry.
  const folderRects: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const key of clusterList.map((c) => c.key)) {
    const p = folderPos[key] ?? { x: 750, y: 300 };
    folderRects[key] = { x: p.x, y: p.y, w: FOLDER_W, h: FOLDER_H };
  }
  useEffect(() => { folderRectsRef.current = folderRects; });

  const contextMenuItem = contextMenu ? items.find((o) => o.id === contextMenu.id) ?? null : null;
  const focusedTrashed = !!focusId && !items.some((o) => o.id === focusId);
  const focused = focusId ? items.find((o) => o.id === focusId) ?? trashItems.find((o) => o.id === focusId) ?? null : null;
  const focusedRelated = focused
    ? focused.related
      .map((rid) => {
        const r = items.find((o) => o.id === rid);
        if (!r) return null;
        return { id: rid, title: r.title, mark: MARK[r.kind], why: WHY_RELATED[rid] || WHY_RELATED[rid.replace(/^demo-/, "")] || "related" };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
    : [];

  const discs: Disc[] = focused && focused.kind !== "comment"
    ? (
      [
        { key: "highlights" as const, label: "Highlights & notes", n: String(focused.highlights.length + (focused.note ? 1 : 0)) },
        { key: "related" as const, label: "Related", n: String(focused.related.length) },
        { key: "context" as const, label: "Why it is here", n: "" },
        { key: "comments" as const, label: "Comments", n: commentsItemId === focused.id ? String(comments.length) : "" },
      ].filter((d) => d.key !== "highlights" || focused.highlights.length > 0 || !!focused.note)
    )
    : [];

  const canDeleteItem = useCallback((item: StashItem) => {
    if (item.createdById && item.createdById === user.id) return true;
    return role === "owner" || role === "admin";
  }, [role, user.id]);

  let listGroups: { name: string; n: string; items: StashItem[] }[] = [];
  if (sort === "folder") {
    listGroups = clusterList
      .map(({ key, name }) => {
        const mem = items.filter((o) => o.cluster === key);
        return { name, n: mem.length + " things", items: mem };
      });
    const unsorted = items.filter((o) => !clusterNames[o.cluster]);
    if (unsorted.length) listGroups.push({ name: "Unsorted", n: unsorted.length + " things", items: unsorted });
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
    if (hovered) return WHY[o.id] || WHY[o.id.replace(/^demo-/, "")] || o.domain;
    return o.domain;
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-paper antialiased font-sans text-sm leading-[1.45] text-primary">
      <div
        ref={canvasRef}
        onPointerDown={(e) => {
          if (liveRef.current.ghost) { placeGhost(e.clientX, e.clientY); return; }
          if (liveRef.current.placingComment) { void placeComment(e.clientX, e.clientY); return; }
          if (liveRef.current.placingAsk) { void placeAsk(e.clientX, e.clientY); return; }
          if (e.shiftKey) {
            const { scale, tx, ty } = liveRef.current;
            marqueeRef.current = { startX: (e.clientX - tx) / scale, startY: (e.clientY - ty) / scale };
            setMarquee({ x0: marqueeRef.current.startX, y0: marqueeRef.current.startY, x1: marqueeRef.current.startX, y1: marqueeRef.current.startY });
            return;
          }
          setSelectedIds([]);
          startPan(); setFocusId(null);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => void handleDrop(e)}
        className={`absolute inset-0 ${panning ? "cursor-grabbing" : "cursor-default"} ${paperGrid ? "bg-[radial-gradient(circle_at_1px_1px,rgba(var(--shadow-color),.055)_1px,transparent_0)]" : "bg-none"} [background-position:var(--sd-gp)] [background-size:var(--sd-gs)]`}
        style={{
          ["--sd-gp" as string]: `${camera.tx}px ${camera.ty}px`,
          ["--sd-gs" as string]: `${26 * camera.scale}px ${26 * camera.scale}px`,
        } as CSSProperties}
      >
        <div
          className="absolute left-0 top-0 origin-top-left will-change-transform [transform:var(--sd-cam)]"
          style={{ ["--sd-cam" as string]: `translate3d(${camera.tx}px, ${camera.ty}px, 0) scale(${camera.scale})` } as CSSProperties}
        >
          {/* Board title: lives in canvas space (pans/zooms with everything
              else) but has no pointer handlers at all, so it can't be
              dragged or clicked like the item cards — a fixed landmark. */}
          <div className="pointer-events-none absolute left-[750px] top-[140px] select-none">
            <div className="whitespace-nowrap font-serif text-[46px] tracking-[-.01em] text-primary">{stash?.name || "Stashdrop"}</div>
            <div className="mt-1 font-mono text-[11px] uppercase tracking-[.08em] text-faint">{stash?.description || "everything you've kept, in one place"}</div>
          </div>

          {/* Folders: draggable desk objects. Filed cards hide inside; click
              to spill them out below the folder, click again to tuck them
              back in. */}
          {clusterList.map(({ key, name }) => {
            const r = folderRects[key];
            const count = items.filter((o) => o.cluster === key).length;
            const over = dragOverCluster === key;
            const open = openFolder.has(key);
            const dragging = dragFolder === key;
            const flash = flashedFolder === key;
            return (
              <div
                key={key}
                className={`absolute left-0 top-0 will-change-transform ${dragging ? "" : "[transition:transform_.18s_cubic-bezier(.2,.8,.2,1)]"} [transform:translate3d(var(--sd-x),var(--sd-y),0)]`}
                style={{ ["--sd-x" as string]: `${r.x}px`, ["--sd-y" as string]: `${r.y}px` } as CSSProperties}
              >
                <button
                  onPointerDown={(e) => { e.stopPropagation(); startFolderDrag(key); }}
                  onClick={(e) => { e.stopPropagation(); if (folderDragDistanceRef.current < 4) toggleFolder(key); }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setFolderMenu({ key, x: e.clientX, y: e.clientY });
                  }}
                  title={open ? "Click to tuck it all back inside" : "Click to spill it open — drag it to move it"}
                  className={`relative flex w-[96px] cursor-grab flex-col items-center gap-1 rounded-[12px] border border-transparent px-2 pt-2 pb-1.5 text-center transition-colors active:cursor-grabbing ${flash ? "animate-land" : ""} ${over || open ? "border-accent-border bg-accent-bg" : "hover:bg-hover"}`}
                >
                  <FolderGlyph className="h-[54px] w-[68px] text-sticky-border" />
                  {count > 0 && (
                    <span className="absolute right-1.5 top-0.5 flex-none rounded-full border border-default bg-card px-1.5 py-px font-mono text-[9.5px] text-faint">{count}</span>
                  )}
                  <span className="max-w-full truncate text-[12.5px] font-medium text-primary">{name}</span>
                </button>
              </div>
            );
          })}

          {items.filter((o) => !clusterNames[o.cluster] || openFolder.has(o.cluster)).map((o) => {
            const [x, y] = pos[o.id];
            const hit = hits ? hits[o.id] ?? null : null;
            const hovered = hoverId === o.id;
            const dim = !!(hits && !hit);
            const isText = !!o.isText;
            const previewH = (o.kind === "image" || o.kind === "shot" ? 135 : 110);
            const previewBars = isText ? [] : bars(o.kind === "video" ? "image" : o.kind, o.id.charCodeAt(1) || 3);
            const titleOp = zoomedOut && !hit ? 0.35 : 1;
            const titleDim = titleOp === 0.35;

            const isMenuTarget = contextMenu?.id === o.id;
            const isMenuBackground = !!contextMenu && !isMenuTarget;
            const isSelected = selectedIds.includes(o.id);
            // Positioned via transform, not left/top: left/top changes force
            // a layout+repaint on every pointermove frame, which is what
            // made image-heavy cards visibly stutter/redraw mid-drag.
            // translate3d is compositor-only — no repaint, no jank. Shadow
            // is drop-shadow, not box-shadow: box-shadow changes force a
            // repaint (CPU re-rasterize) of the whole layer, and inside
            // this card's scaled ancestor that repaint redraws text at a
            // shifting subpixel offset — the hover "shiver". filter is
            // compositor-only, so the already-rasterized text just gets
            // re-composited, never redrawn.
            const cardClass = [
              "absolute left-0 top-0 cursor-grab overflow-hidden select-none will-change-transform backface-hidden [width:var(--sd-w)] [transform:translate3d(var(--sd-x),var(--sd-y),0)_scale(var(--sd-s))]",
              o.kind === "comment" ? "bg-sticky" : o.kind === "quote" ? "bg-card-alt" : "bg-card",
              isSelected ? "border border-primary" : hit || hovered ? "border border-border-hover" : o.kind === "comment" ? "border border-sticky-border" : "border border-default",
              isText ? "rounded-[10px]" : "rounded-[11px]",
              isMenuBackground ? "opacity-50" : dim ? "opacity-24" : "",
              "filter",
              isMenuBackground ? "blur-[5px]" : "",
              isMenuTarget
                ? "drop-shadow-[0_24px_60px_rgba(var(--shadow-color),.28)]"
                : dim ? "" : (hovered || hit || dragId === o.id)
                  ? "drop-shadow-[0_12px_30px_rgba(var(--shadow-color),.13)]"
                  : "drop-shadow-[0_1px_2px_rgba(var(--shadow-color),.05)] drop-shadow-[0_6px_16px_rgba(var(--shadow-color),.045)]",
              landedId === o.id ? "animate-land" : "",
              dragId === o.id ? "" : "[transition:transform_.18s_cubic-bezier(.2,.8,.2,1),filter_.18s_ease,opacity_.18s_ease]",
              isMenuTarget ? "z-62" : "",
              isMenuBackground ? "pointer-events-none" : "",
            ].filter(Boolean).join(" ");
            const cardVars = {
              ["--sd-x" as string]: `${x}px`,
              ["--sd-y" as string]: `${y}px`,
              ["--sd-s" as string]: isMenuTarget ? 1.06 : 1,
              ["--sd-w" as string]: `${o.w * 1.15}px`,
            } as CSSProperties;

            return (
              <div
                key={o.id}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (liveRef.current.ghost) { liveRef.current.suppressClick = true; placeGhost(e.clientX, e.clientY); return; }
                  if (liveRef.current.placingComment) { liveRef.current.suppressClick = true; void placeComment(e.clientX, e.clientY); return; }
                  if (liveRef.current.placingAsk) { liveRef.current.suppressClick = true; void placeAsk(e.clientX, e.clientY); return; }
                  if (e.shiftKey) return;
                  startDrag(o.id);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (liveRef.current.suppressClick) { liveRef.current.suppressClick = false; return; }
                  if (e.shiftKey) { toggleSelect(o.id); return; }
                  if (dragDistanceRef.current < 4) { setFocusId(o.id); setDisc({ highlights: false, related: false, context: false, comments: false }); }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMoveMenuOpen(false);
                  setContextMenu({ id: o.id, x: e.clientX, y: e.clientY });
                }}
                onMouseEnter={() => setHoverId(o.id)}
                onMouseLeave={() => setHoverId((h) => (h === o.id ? null : h))}
                className={cardClass}
                style={cardVars}
              >
                {o.cluster && (
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px] bg-accent" />
                )}
                {!isText && (
                  <div className={`relative grid place-items-center overflow-hidden border-b ${TINT[o.kind] || "bg-tint-article"} ${hit || hovered ? "border-border-hover" : "border-default"} ${previewH === 135 ? "h-[135px]" : "h-[110px]"}`}>
                    {o.image && !brokenImages.has(o.id) && !o.image.startsWith("data:application/") ? (
                      <img
                        src={o.image}
                        alt=""
                        draggable={false}
                        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                        onError={() => setBrokenImages((prev) => new Set(prev).add(o.id))}
                      />
                    ) : (
                      previewBars.map((b, i) => (
                        <div
                          key={i}
                          className="absolute [left:var(--sd-l)] [top:var(--sd-t)] [width:var(--sd-w)] [height:var(--sd-h)] [border-radius:var(--sd-r)] [background:var(--sd-b)]"
                          style={{ ["--sd-l" as string]: b.left, ["--sd-t" as string]: b.top, ["--sd-w" as string]: b.w, ["--sd-h" as string]: b.h, ["--sd-r" as string]: b.r, ["--sd-b" as string]: b.bg } as CSSProperties}
                        />
                      ))
                    )}
                    {o.kind === "pdf" && o.image && (
                      <div className="absolute inset-0 grid place-items-center">
                        <span className="rounded-md border border-strong bg-surface px-[9px] py-[5px] font-mono text-[9.5px] uppercase tracking-[.1em] text-muted">PDF</span>
                      </div>
                    )}
                    {o.playhead && (
                      <div className="relative grid size-[30px] place-items-center rounded-full border border-[rgba(var(--shadow-color),.14)] bg-surface">
                        <div className="ml-0.5 h-0 w-0 border-b-[5px] border-l-8 border-t-[5px] border-b-transparent border-l-secondary border-t-transparent" />
                      </div>
                    )}
                  </div>
                )}

                {isText && (
                  <div className="px-[17px] pb-[5px] pt-4">
                    {o.kind === "comment" ? (
                      autoFocusCommentId === o.id ? (
                        // A native <input>, scaled down with the rest of the
                        // canvas (camera.scale below 100%), renders its text
                        // as a blurry rasterized replaced-element — unlike
                        // plain text, which stays crisp under a CSS
                        // transform. So the input only exists while this
                        // card is actively being typed into; once it blurs,
                        // the text below takes over for crisp display, and
                        // clicking it re-enters edit mode.
                        <input
                          defaultValue={o.title}
                          placeholder="Write a comment…"
                          ref={(el) => { if (el) el.focus(); }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                          onBlur={(e) => { void commitCommentTitle(o.id, e.target.value); setAutoFocusCommentId(null); }}
                          className="w-full border-none bg-transparent font-serif text-[19px] leading-[1.3] text-secondary outline-none"
                        />
                      ) : (
                        <div
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); setAutoFocusCommentId(o.id); }}
                          className={`min-h-[1.3em] cursor-text font-serif text-[19px] leading-[1.3] text-pretty ${o.title ? "text-secondary" : "text-faint"}`}
                        >{o.title || "Write a comment…"}</div>
                      )
                    ) : o.kind === "ask" ? (
                      autoFocusAskId === o.id ? (
                        <input
                          defaultValue={o.title}
                          placeholder="Ask anything…"
                          disabled={askingIds.includes(o.id)}
                          ref={(el) => { if (el) el.focus(); }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                          onBlur={(e) => { const q = e.target.value.trim(); setAutoFocusAskId(null); if (q && q !== o.title) void submitAsk(o.id, q); }}
                          className="w-full border-none bg-transparent font-serif text-[19px] leading-[1.3] text-secondary outline-none"
                        />
                      ) : o.title ? (
                        <div>
                          <div
                            onClick={(e) => { e.stopPropagation(); if (dragDistanceRef.current < 4) setAutoFocusAskId(o.id); }}
                            className="cursor-text font-serif text-[19px] leading-[1.3] text-pretty text-secondary"
                          >{o.title}</div>
                          {askingIds.includes(o.id) && (
                            <div className="mt-2 font-mono text-[10px] text-faint">asking…</div>
                          )}
                          {o.body && (
                            <div className="mt-2 text-pretty whitespace-pre-wrap text-[13px] leading-[1.55] text-muted">{o.body}</div>
                          )}
                        </div>
                      ) : (
                        <div
                          onClick={(e) => { e.stopPropagation(); if (dragDistanceRef.current < 4) setAutoFocusAskId(o.id); }}
                          className="cursor-text font-serif text-[19px] leading-[1.3] text-faint"
                        >{selectedIds.length ? `Ask about ${selectedIds.length} thing${selectedIds.length === 1 ? "" : "s"}…` : "Ask anything…"}</div>
                      )
                    ) : (
                      <div className={`font-serif text-[19px] leading-[1.3] text-pretty text-secondary ${o.kind === "quote" ? "italic" : ""}`}>{o.body}</div>
                    )}
                  </div>
                )}

                <div className={isText ? "px-[17px] pb-4 pt-[5px]" : "px-4 pb-[15px] pt-3.5"}>
                  {o.kind !== "comment" && o.kind !== "ask" && (
                    <div className={`text-pretty text-sm font-medium leading-[1.3] text-primary ${titleDim ? "opacity-35" : ""}`}>{o.title}</div>
                  )}
                  <div className={`flex items-center gap-[7px] ${o.kind === "comment" ? "" : "mt-1.5"} ${titleDim ? "opacity-35" : ""}`}>
                    <span className="flex-none rounded size-[10px] [background:var(--sd-mark)]" style={{ ["--sd-mark" as string]: MARK[o.kind] || "var(--text-muted)" } as CSSProperties} />
                    <span className="truncate font-mono text-[10.5px] text-faint">{o.domain}</span>
                  </div>
                  {hit != null && (
                    <div className="mt-[9px] border-t border-subtle pt-[9px] font-serif text-[14.5px] italic leading-[1.3] text-pretty text-muted">{matchLabel(hit)}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {isList && (
        <div className="absolute inset-0 z-10 overflow-y-auto bg-paper">
          <div className="mx-auto max-w-[900px] px-8 pb-[90px] pt-[92px]">
            <div className="flex items-center gap-2.5 border-b border-default pb-[13px]">
              <div className="flex-1 font-mono text-[10px] uppercase tracking-[.16em] text-muted">{items.length} things kept</div>
              {[{ id: "folder" as const, label: "By folder" }, { id: "recent" as const, label: "Recent" }].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSort(t.id)}
                  className={`cursor-pointer border-none bg-transparent px-1.5 py-1 text-[12.5px] hover:text-primary ${sort === t.id ? "font-semibold text-primary" : "font-normal text-faint"}`}
                >{t.label}</button>
              ))}
            </div>

            {listGroups.map((g) => (
              <div key={g.name}>
                <div className="flex items-baseline gap-[11px] px-0.5 pb-2 pt-[30px]">
                  <div className="font-serif text-[22px] tracking-[-.01em] text-secondary">{g.name}</div>
                  <div className="h-px flex-1 bg-subtle" />
                  <div className="font-mono text-[10px] text-fainter">{g.n}</div>
                </div>
                {g.items.map((r) => {
                  const hit = hits ? hits[r.id] ?? null : null;
                  const hovered = hoverId === r.id;
                  const n = r.related.length;
                  return (
                    <div
                      key={r.id}
                      onClick={() => { setFocusId(r.id); setDisc({ highlights: false, related: false, context: false, comments: false }); }}
                      onMouseEnter={() => setHoverId(r.id)}
                      onMouseLeave={() => setHoverId((h) => (h === r.id ? null : h))}
                      className={`flex cursor-pointer items-center gap-[15px] rounded-[9px] px-3 py-3 ${hits && !hit ? "opacity-30" : ""} ${hovered ? "bg-hover-alt" : hit ? "bg-accent-bg" : "bg-transparent"}`}
                    >
                      <span className="flex-none rounded size-[9px] [background:var(--sd-mark)]" style={{ ["--sd-mark" as string]: MARK[r.kind] || "var(--text-muted)" } as CSSProperties} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium text-primary">{r.title}</div>
                        <div className={`mt-[3px] truncate ${hit || hovered ? "font-serif text-[13.5px] italic text-muted" : "font-mono text-[9.5px] text-faint"}`}>{rowSub(r, hit, hovered)}</div>
                      </div>
                      <div className="w-[58px] flex-none text-right font-mono text-[9.5px] text-fainter">{n ? n + (n === 1 ? " link" : " links") : ""}</div>
                      <div className="w-[76px] flex-none text-right font-mono text-[9.5px] text-faint">{r.kept}</div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Glass strip the top bar's controls sit on — blurs whatever's
          scrolled underneath rather than each button floating on its own
          hard-edged pill. Masked to fade out at the bottom instead of
          ending in a hard line. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-15 h-[92px] backdrop-blur-[10px] [background:linear-gradient(to_bottom,rgba(var(--shadow-color),.05),rgba(var(--shadow-color),0))] [mask-image:linear-gradient(to_bottom,black_0%,black_55%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,black_0%,black_55%,transparent_100%)]" />

      <div className="absolute left-[22px] top-5 z-20 flex items-center gap-[11px]">
        <div className="relative size-[15px] rounded bg-primary">
          <div className="absolute -right-1 -bottom-1 size-[9px] rounded-[3px] border border-primary bg-paper" />
        </div>
        <div className="font-mono text-[10.5px] uppercase tracking-[.2em] text-muted">Stashdrop</div>
        <div className="ml-1.5 flex rounded-lg border border-default bg-surface p-0.5">
          {[{ id: "desk" as const, label: "Desk" }, { id: "list" as const, label: "List" }].map((v) => (
            <button
              key={v.id}
              onClick={() => {
                if (v.id === "list") { setView("list"); setFocusId(null); }
                else { setView("desk"); setCamera(DEFAULT_CAMERA); setFocusId(null); }
              }}
              className={`cursor-pointer rounded-md border-none px-[13px] py-1.5 text-[12.5px] font-medium hover:text-primary ${view === v.id ? "bg-hover text-primary" : "bg-transparent text-muted"}`}
            >{v.label}</button>
          ))}
        </div>
      </div>

      {searchOpen && (
        <div onClick={() => setSearchOpen(false)} className="fixed inset-0 z-60 animate-fade bg-overlay backdrop-blur-[4px]" />
      )}

      <div
        ref={searchBarRef}
        className={`${searchOpen
          ? "fixed left-1/2 top-[42%] z-70 w-[min(680px,calc(100vw_-_40px))] -translate-x-1/2 -translate-y-1/2"
          : "absolute left-1/2 top-4 z-30 w-[min(560px,calc(100vw_-_540px))] -translate-x-1/2"}`}
      >
        <div className={`overflow-hidden bg-surface backdrop-blur-[12px] ${searchOpen ? "rounded-[16px] border border-strong shadow-[0_28px_90px_rgba(var(--shadow-color),.2)]" : barOpen ? "rounded-[12px] border border-strong shadow-[0_14px_40px_rgba(var(--shadow-color),.11)]" : "rounded-[10px] border border-default shadow-[0_2px_10px_rgba(var(--shadow-color),.05)]"} [transition:box-shadow_.18s_ease]`}>
          <div className={`flex items-center gap-[11px] ${searchOpen ? "px-4" : "px-3.5"}`}>
            <span className={`flex-none font-mono ${searchOpen ? "text-sm" : "text-xs"} text-faint`}>/</span>
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => onChangeQuery(e.target.value)}
              onKeyDown={queryKey}
              readOnly={!!pendingState}
              placeholder="Search anything — or paste to keep it"
              className={`flex-1 border-none bg-transparent text-primary outline-none ${searchOpen ? "py-[17px] text-[17px]" : "py-[13px] text-[14.5px]"} ${pendingState ? "cursor-default" : "cursor-text"}`}
            />
            {query && (
              <button
                onClick={() => { if (pendingState) { cancelPending(); } else { setQueryState(""); setSearchResults([]); } }}
                className="cursor-pointer border-none bg-transparent p-1 font-mono text-xs text-faint hover:text-primary"
              >esc</button>
            )}
          </div>

          {query && !isUrl(query) && (
            <div className="border-t border-subtle px-1.5 pb-2 pt-[9px]">
              {searching && !searchResults.length && (
                <div className="px-2.5 py-2 font-mono text-[11px] text-faint">searching…</div>
              )}
              {!searching && !searchResults.length && (
                <div className="px-2.5 py-2 font-mono text-[11px] text-faint">no matches</div>
              )}
              {searchResults.map((hit) => {
                const it = items.find((o) => o.id === hit.id);
                if (!it) return null;
                return (
                  <button
                    key={hit.id}
                    onClick={() => { setFocusId(hit.id); setSearchOpen(false); setDisc({ highlights: false, related: false, context: false, comments: false }); }}
                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-[7px] border-none bg-transparent px-2.5 py-2 text-left hover:bg-hover-alt"
                  >
                    <span className="flex-none rounded size-[9px] [background:var(--sd-mark)]" style={{ ["--sd-mark" as string]: MARK[it.kind] || "var(--text-muted)" } as CSSProperties} />
                    <span className="flex-1 truncate text-[13.5px] text-secondary">{it.title}</span>
                    <span className="flex-none font-mono text-[9.5px] text-fainter">{Math.round(hit.score * 100)}%</span>
                  </button>
                );
              })}
            </div>
          )}

          {pendingState && (
            <div className="animate-slip border-t border-subtle px-3.5 pb-3 pt-[13px]">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex-none rounded size-[9px] [background:var(--sd-mark)]" style={{ ["--sd-mark" as string]: pendingState.item ? MARK[pendingState.item.kind] : "var(--text-muted)" } as CSSProperties} />
                <span className="font-mono text-[10px] tracking-[.05em] text-muted">{pendingState.host}</span>
                <div className="flex-1" />
                <span className={`font-mono text-[9.5px] uppercase tracking-[.06em] ${pendingState.status === "reading" ? "animate-breathe text-faint" : "text-muted"}`}>
                  {pendingState.status === "reading" ? "reading the page…" : pendingState.status === "error" ? "couldn't read it" : pendingState.item?.kind}
                </span>
              </div>
              <div className="flex items-start gap-[13px]">
                <div
                  ref={thumbRef}
                  className={`relative h-[74px] w-[104px] flex-none overflow-hidden rounded-lg border border-default ${pendingState.status === "ready" && pendingState.item ? (TINT[pendingState.item.kind] || "bg-tint-article") : "bg-hover"}`}
                >
                  {pendingState.status === "ready" && pendingState.item?.image && !brokenImages.has(pendingState.item.id) ? (
                    <img
                      src={pendingState.item.image}
                      alt=""
                      draggable={false}
                      className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                      onError={() => setBrokenImages((prev) => new Set(prev).add(pendingState.item!.id))}
                    />
                  ) : (
                    bars(pendingState.status === "ready" && pendingState.item ? (pendingState.item.kind === "video" ? "image" : pendingState.item.kind) : "article", 7).map((b, i) => (
                      <div
                        key={i}
                        className={`absolute animate-shimmer [left:var(--sd-l)] [top:var(--sd-t)] [width:var(--sd-w)] [height:var(--sd-h)] [border-radius:var(--sd-r)] [background:var(--sd-b)] [animation-delay:var(--sd-d)] ${pendingState.status === "reading" ? "opacity-45" : ""}`}
                        style={{ ["--sd-l" as string]: b.left, ["--sd-t" as string]: b.top, ["--sd-w" as string]: b.w, ["--sd-h" as string]: b.h, ["--sd-r" as string]: b.r, ["--sd-b" as string]: b.bg, ["--sd-d" as string]: `${i * 0.08}s` } as CSSProperties}
                      />
                    ))
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  {pendingState.status === "reading" && (
                    <div className="flex flex-col gap-[7px] pt-[3px]">
                      <div className="animate-shimmer h-[9px] w-[72%] rounded-[3px] [background:rgba(var(--ink-rgb),.13)]" />
                      <div className="animate-shimmer h-[6px] w-[94%] rounded-[3px] [background:rgba(var(--ink-rgb),.08)] [animation-delay:.15s]" />
                      <div className="animate-shimmer h-[6px] w-[60%] rounded-[3px] [background:rgba(var(--ink-rgb),.08)] [animation-delay:.3s]" />
                    </div>
                  )}
                  {pendingState.status === "error" && (
                    <div className="text-[13px] text-danger">{pendingState.errorText}</div>
                  )}
                  {pendingState.status === "ready" && pendingState.item && (
                    <div>
                      <div className="text-pretty text-sm font-medium leading-[1.3] text-primary">{pendingState.item.title}</div>
                      <div className="mt-[5px] line-clamp-3 text-pretty text-[12.5px] leading-[1.5] text-muted">{pendingState.item.description}</div>
                      <div className="mt-[9px] flex flex-wrap gap-[5px]">
                        {pendingState.item.tags.map((t) => (
                          <span key={t} className="rounded-[5px] border border-subtle px-[7px] py-[3px] font-mono text-[9.5px] text-muted">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-3.5 flex items-center gap-[9px] border-t border-subtle pt-3">
                <div className={`font-serif text-[13px] italic ${pendingState.status === "reading" ? "text-fainter" : "text-muted"}`}>
                  {pendingState.status === "reading" ? "fetching page details" : pendingState.status === "ready" ? `lands next to ${pendingState.clusterName}` : ""}
                </div>
                <div className="flex-1" />
                <button
                  onClick={cancelPending}
                  className="cursor-pointer rounded-[7px] border border-strong bg-transparent px-[11px] py-1.5 text-xs text-muted hover:border-primary"
                >Discard</button>
                <button
                  onClick={startPlacing}
                  disabled={pendingState.status !== "ready"}
                  className={`rounded-[7px] border border-primary bg-primary px-[13px] py-1.5 text-xs font-medium text-card ${pendingState.status === "ready" ? "cursor-pointer" : "cursor-not-allowed opacity-45"}`}
                >Save</button>
              </div>
            </div>
          )}

          {ghostState && (
            <div className="flex animate-slip items-center gap-[9px] border-t border-subtle px-3.5 py-[11px]">
              <span className="flex-none rounded size-[9px] [background:var(--sd-mark)]" style={{ ["--sd-mark" as string]: (ghostState.item && MARK[ghostState.item.kind]) || "var(--text-muted)" } as CSSProperties} />
              <div className="flex-1 text-[12.5px] text-secondary">
                {ghostState.phase === "held" ? "Click the desk to put it down" : "Picking it up…"}
              </div>
              <button
                onClick={cancelPending}
                className="cursor-pointer border-none bg-transparent p-1 font-mono text-[11px] text-faint hover:text-primary"
              >esc</button>
            </div>
          )}
        </div>
      </div>

      {ghostState && (() => {
        const g = ghostState;
        const flying = g.phase === "flying" && !!g.rect;
        const anchored = !!g.rect;
        const ease = "cubic-bezier(.2,.8,.2,1)";
        const dx = anchored ? cursor[0] + 16 - g.rect!.left : 0;
        const dy = anchored ? cursor[1] + 14 - g.rect!.top : 0;
        const ghostT = flying
          ? `translate3d(0,0,0) scale(${g.rect!.width / 196})`
          : `translate3d(${dx}px,${dy}px,0) scale(${camera.scale}) rotate(-1.5deg)`;
        const ghostBars = bars(g.item ? (g.item.kind === "video" ? "image" : g.item.kind) : "article", 7);
        return (
          <div
            className={`pointer-events-none fixed z-45 w-[196px] origin-top-left overflow-hidden rounded-[11px] border border-primary bg-card ${flying ? "opacity-80" : "opacity-[.94]"} [left:var(--sd-l)] [top:var(--sd-t)] [transform:var(--sd-tf)] [transition:var(--sd-tr)] [box-shadow:var(--sd-sh)]`}
            style={{
              ["--sd-l" as string]: `${anchored ? g.rect!.left : cursor[0] + 16}px`,
              ["--sd-t" as string]: `${anchored ? g.rect!.top : cursor[1] + 14}px`,
              ["--sd-tf" as string]: ghostT,
              ["--sd-tr" as string]: g.phase === "landing" ? `transform .42s ${ease}, opacity .42s ${ease}` : "none",
              ["--sd-sh" as string]: flying ? "0 8px 20px rgba(var(--shadow-color),.14)" : "0 22px 48px rgba(var(--shadow-color),.22)",
            } as CSSProperties}
          >
            <div className={`relative grid h-24 place-items-center overflow-hidden border-b border-default ${g.item ? (TINT[g.item.kind] || "bg-tint-article") : "bg-hover"}`}>
              {g.item?.image && !brokenImages.has(g.item.id) ? (
                <img
                  src={g.item.image}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                  onError={() => setBrokenImages((prev) => new Set(prev).add(g.item!.id))}
                />
              ) : (
                ghostBars.map((b, i) => (
                  <div key={i} className="absolute [left:var(--sd-l)] [top:var(--sd-t)] [width:var(--sd-w)] [height:var(--sd-h)] [border-radius:var(--sd-r)] [background:var(--sd-b)]" style={{ ["--sd-l" as string]: b.left, ["--sd-t" as string]: b.top, ["--sd-w" as string]: b.w, ["--sd-h" as string]: b.h, ["--sd-r" as string]: b.r, ["--sd-b" as string]: b.bg } as CSSProperties} />
                ))
              )}
            </div>
            <div className="px-[13px] pb-3 pt-[11px]">
              <div className="text-pretty text-[12.5px] font-medium leading-[1.3] text-primary">{g.item?.title}</div>
              <div className="mt-[5px] flex items-center gap-1.5">
                <span className="flex-none rounded size-[9px] [background:var(--sd-mark)]" style={{ ["--sd-mark" as string]: (g.item && MARK[g.item.kind]) || "var(--text-muted)" } as CSSProperties} />
                <span className="font-mono text-[9.5px] text-faint">{g.host}</span>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="absolute right-[22px] top-[18px] z-20 flex items-center gap-[7px]">
        {stash && (
          <div className="relative">
            <button
              onClick={() => setStashMenuOpen((v) => !v)}
              title="Switch or create a stash"
              aria-label="Switch or create a stash"
              className="flex max-w-[200px] cursor-pointer items-center gap-1.5 rounded-lg border border-default bg-surface px-2.5 py-2 text-[12.5px] text-muted hover:border-primary hover:text-primary"
            >
              <Layers size={14} />
              <span className="truncate">{stash.name}</span>
              <ChevronDown size={12} />
            </button>
            {stashMenuOpen && (
              <>
                <div onClick={() => setStashMenuOpen(false)} className="fixed inset-0 z-60" />
                <div className="absolute right-0 top-[calc(100%+6px)] z-61 w-[236px] rounded-[10px] border border-default bg-card p-1.5 shadow-[0_14px_40px_rgba(var(--shadow-color),.16)]">
                  <div className="px-[9px] pb-[5px] pt-[7px] font-mono text-[9.5px] uppercase tracking-[.14em] text-fainter">Stashes in {workspace.name}</div>
                  <div className="max-h-[220px] overflow-y-auto">
                    {stashes.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => void handleSwitchStash(s.id)}
                        disabled={stashBusy}
                        className={`flex w-full items-center gap-2 rounded-md px-[9px] py-2 text-left text-[13px] hover:bg-hover-alt ${s.id === stash.id ? "cursor-default bg-hover text-primary" : "cursor-pointer bg-transparent text-secondary"}`}
                      >
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        {s.id === stash.id && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1.5 flex gap-1.5 border-t border-subtle pt-2">
                    <input
                      value={newStashName}
                      onChange={(e) => setNewStashName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void handleCreateStash(); }}
                      placeholder="New stash name"
                      className="min-w-0 flex-1 rounded-[7px] border border-default bg-hover-alt px-[9px] py-[7px] text-[12.5px] font-sans text-primary outline-none"
                    />
                    <button
                      onClick={() => void handleCreateStash()}
                      disabled={stashBusy || !newStashName.trim()}
                      title="Create stash"
                      aria-label="Create stash"
                      className={`flex items-center rounded-[7px] border border-primary bg-primary px-2.5 text-card ${stashBusy || !newStashName.trim() ? "cursor-default opacity-50" : "cursor-pointer"}`}
                    ><Plus size={14} /></button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
        <button
          onClick={() => setWorkspaceSwitcherOpen(true)}
          title="Switch workspace"
          aria-label="Switch workspace"
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-default bg-surface px-2.5 py-2 text-[12.5px] text-muted hover:border-primary hover:text-primary"
        >{workspace.organizationId ? <Building2 size={14} /> : <UserIcon size={14} />} {workspace.name}</button>
        <button
          onClick={() => setSettingsOpen(true)}
          title="Workspace settings"
          aria-label="Workspace settings"
          className="flex cursor-pointer items-center rounded-lg border border-default bg-surface px-2.5 py-2 text-muted hover:border-primary hover:text-primary"
        ><SettingsIcon size={14} /></button>
        <div className="relative">
          <button
            onClick={() => setThemeMenuOpen((v) => !v)}
            title="Theme"
            aria-label="Theme"
            className="flex cursor-pointer items-center gap-1 rounded-lg border border-default bg-surface px-2.5 py-2 text-muted hover:border-primary hover:text-primary"
          >
            {theme === "light" ? <Sun size={14} /> : theme === "dark" ? <Moon size={14} /> : <Monitor size={14} />}
            <ChevronDown size={12} />
          </button>
          {themeMenuOpen && (
            <>
              <div onClick={() => setThemeMenuOpen(false)} className="fixed inset-0 z-60" />
              <div className="absolute right-0 top-[calc(100%+6px)] z-61 min-w-[140px] overflow-hidden rounded-[10px] border border-default bg-card p-1 shadow-[0_10px_34px_rgba(var(--shadow-color),.16)]">
                {([{ id: "system" as const, label: "Auto", Icon: Monitor }, { id: "light" as const, label: "Light", Icon: Sun }, { id: "dark" as const, label: "Dark", Icon: Moon }]).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => { setTheme(t.id); setThemeMenuOpen(false); }}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[12.5px] hover:bg-hover hover:text-primary ${theme === t.id ? "bg-hover text-primary" : "bg-transparent text-secondary"}`}
                  ><t.Icon size={13} /> {t.label}</button>
                ))}
              </div>
            </>
          )}
        </div>
        <UserMenu user={user} onSwitchWorkspace={() => setWorkspaceSwitcherOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />
      </div>

      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} user={user} paperGrid={paperGrid} onSetPaperGrid={setPaperGrid} />
      )}
      {workspaceSwitcherOpen && <WorkspaceSwitcher currentOrganizationId={workspace.organizationId} onClose={() => setWorkspaceSwitcherOpen(false)} />}
      {needsOnboarding && <Onboarding onComplete={() => router.refresh()} initialScope={onboardingInitialScope} organizationId={onboardingOrganizationId} />}

      <div className={`absolute bottom-5 left-[22px] z-20 flex items-center gap-1.5 ${isList ? "pointer-events-none opacity-0" : ""}`}>
        <div className="flex items-center overflow-hidden rounded-lg border border-default bg-surface">
          <button onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.85)} className="size-[30px] cursor-pointer border-none bg-transparent font-mono text-sm text-muted hover:bg-hover hover:text-primary">−</button>
          <button onClick={() => setCamera(DEFAULT_CAMERA)} className="h-[30px] min-w-[52px] cursor-pointer border-x border-subtle bg-transparent px-[9px] font-mono text-[10px] text-muted hover:bg-hover hover:text-primary">{Math.round(camera.scale * 100)}%</button>
          <button onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.18)} className="size-[30px] cursor-pointer border-none bg-transparent font-mono text-sm text-muted hover:bg-hover hover:text-primary">+</button>
        </div>
        <div className="pl-1.5 font-mono text-[9.5px] text-fainter">drag things around · scroll to zoom</div>
      </div>

      {/* Right-edge toolbar: drag-out tools. Click one to pick it up — a
          ghost follows the cursor until you click the desk to drop it. */}
      <div className={`absolute right-3.5 top-1/2 z-30 flex -translate-y-1/2 flex-col gap-2 ${isList ? "pointer-events-none opacity-0" : ""}`}>
        <button
          onClick={() => fileInputRef.current?.click()}
          title="Add an image from your computer"
          aria-label="Add an image"
          className="flex size-[34px] cursor-pointer items-center justify-center rounded-[9px] border border-default bg-surface text-muted shadow-[0_2px_10px_rgba(var(--shadow-color),.05)] hover:border-primary hover:text-primary"
        ><ImagePlus size={16} /></button>
        <button
          onClick={beginPlacingComment}
          title={placingComment ? "Click the desk to drop it (Esc to cancel)" : "Drop a comment on the board"}
          aria-label="Drop a comment"
          className={`flex size-[34px] cursor-pointer items-center justify-center rounded-[9px] text-muted shadow-[0_2px_10px_rgba(var(--shadow-color),.05)] hover:border-primary hover:text-primary ${placingComment ? "border border-primary bg-hover" : "border border-default bg-surface"}`}
        ><StickyNote size={16} /></button>
        <div className="relative">
          <button
            onClick={() => setFolderCreateOpen((v) => !v)}
            title="Make a folder"
            aria-label="Make a folder"
            className={`flex size-[34px] cursor-pointer items-center justify-center rounded-[9px] text-muted shadow-[0_2px_10px_rgba(var(--shadow-color),.05)] hover:border-primary hover:text-primary ${folderCreateOpen ? "border border-primary bg-hover" : "border border-default bg-surface"}`}
          ><FolderPlus size={16} /></button>
          {folderCreateOpen && (
            <div className="absolute right-[calc(100%+8px)] top-0 z-31 flex w-[190px] flex-col gap-2 rounded-[10px] border border-default bg-card p-2.5 shadow-[0_14px_40px_rgba(var(--shadow-color),.16)]">
              <div className="font-mono text-[9.5px] uppercase tracking-[.14em] text-fainter">New folder</div>
              <input
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handleCreateFolder(); }}
                placeholder="Folder name"
                autoFocus
                className="rounded-[7px] border border-default bg-hover-alt px-[9px] py-[7px] text-[12.5px] font-sans text-primary outline-none"
              />
              <button
                onClick={() => void handleCreateFolder()}
                disabled={!folderName.trim()}
                className={`rounded-[7px] border border-primary bg-primary py-1.5 text-xs font-medium text-card ${folderName.trim() ? "cursor-pointer" : "cursor-not-allowed opacity-45"}`}
              >Create</button>
            </div>
          )}
        </div>
        <button
          onClick={() => beginPlacingAsk()}
          title={placingAsk ? "Click the desk to ask it (Esc to cancel)" : "Ask anything — a question card answered on the desk"}
          aria-label="Ask anything"
          className={`flex size-[34px] cursor-pointer items-center justify-center rounded-[9px] text-muted shadow-[0_2px_10px_rgba(var(--shadow-color),.05)] hover:border-primary hover:text-primary ${placingAsk ? "border border-primary bg-hover" : "border border-default bg-surface"}`}
        ><Sparkles size={16} /></button>
        <button
          onClick={openTrash}
          title="Trash"
          aria-label="Trash"
          className="flex size-[34px] cursor-pointer items-center justify-center rounded-[9px] border border-default bg-surface text-muted shadow-[0_2px_10px_rgba(var(--shadow-color),.05)] hover:border-primary hover:text-primary"
        ><Trash2 size={16} /></button>
      </div>

      <input ref={fileInputRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => void handleFilePick(e)} />

      {placingComment && (
        <div
          className="pointer-events-none fixed z-45 w-[200px] origin-top-left overflow-hidden rounded-[11px] border border-sticky-border bg-sticky opacity-[.94] shadow-[0_22px_48px_rgba(var(--shadow-color),.22)] [left:var(--sd-l)] [top:var(--sd-t)] [transform:var(--sd-tf)]"
          style={{ ["--sd-l" as string]: `${cursor[0] + 16}px`, ["--sd-t" as string]: `${cursor[1] + 14}px`, ["--sd-tf" as string]: `scale(${camera.scale}) rotate(-1.5deg)` } as CSSProperties}
        >
          <div className="px-[17px] pb-[5px] pt-4">
            <div className="font-serif text-[19px] text-faint">Write a comment…</div>
          </div>
          <div className="flex items-center gap-[7px] px-[17px] pb-4 pt-[5px]">
            <span className="flex-none rounded size-[10px] bg-[#B5860B]" />
            <span className="font-mono text-[10.5px] text-faint">{user.name}</span>
          </div>
        </div>
      )}

      {placingAsk && (
        <div
          className="pointer-events-none fixed z-45 w-[220px] origin-top-left overflow-hidden rounded-[11px] border border-primary bg-card opacity-[.94] shadow-[0_22px_48px_rgba(var(--shadow-color),.22)] [left:var(--sd-l)] [top:var(--sd-t)] [transform:var(--sd-tf)]"
          style={{ ["--sd-l" as string]: `${cursor[0] + 16}px`, ["--sd-t" as string]: `${cursor[1] + 14}px`, ["--sd-tf" as string]: `scale(${camera.scale}) rotate(-1deg)` } as CSSProperties}
        >
          <div className="px-[17px] py-[15px]">
            <div className="font-serif text-[19px] text-faint">
              {selectedIds.length ? `Ask about ${selectedIds.length} thing${selectedIds.length === 1 ? "" : "s"}…` : "Ask anything…"}
            </div>
            <div className="mt-[7px] font-mono text-[10px] text-fainter">answered on the desk by your local model</div>
          </div>
        </div>
      )}

      {capture && (
        <div className="absolute bottom-[26px] left-1/2 z-40 flex -translate-x-1/2 animate-rise items-center gap-3 rounded-[10px] border border-default bg-card px-[15px] py-[11px] shadow-[0_10px_34px_rgba(var(--shadow-color),.1)]">
          <div className="size-[7px] rounded-full [background:var(--sd-dot)]" style={{ ["--sd-dot" as string]: capture.dot } as CSSProperties} />
          <div className="text-[13px] text-secondary">{capture.text}</div>
          {capture.where && (
            <div className="border-l border-subtle pl-3 font-mono text-[9.5px] text-faint">{capture.where}</div>
          )}
        </div>
      )}

      {marquee && (
        <div
          className="pointer-events-none fixed z-44 rounded border border-muted bg-[rgba(var(--shadow-color),.05)] [left:var(--sd-l)] [top:var(--sd-t)] [width:var(--sd-w)] [height:var(--sd-h)]"
          style={{
            ["--sd-l" as string]: `${marquee.x0 * camera.scale + camera.tx}px`,
            ["--sd-t" as string]: `${marquee.y0 * camera.scale + camera.ty}px`,
            ["--sd-w" as string]: `${(marquee.x1 - marquee.x0) * camera.scale}px`,
            ["--sd-h" as string]: `${(marquee.y1 - marquee.y0) * camera.scale}px`,
          } as CSSProperties}
        />
      )}

      {selectedIds.length > 0 && !isList && (
        <div className="absolute left-1/2 top-[104px] z-40 flex -translate-x-1/2 items-center gap-2 rounded-[10px] border border-default bg-card px-2 py-1.5 shadow-[0_12px_36px_rgba(var(--shadow-color),.14)]">
          <span className="px-1 font-mono text-[10px] text-faint">{selectedIds.length} selected</span>
          <span className="h-4 w-px bg-subtle" />
          <button
            onClick={() => beginPlacingAsk(selectedIds)}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border-none bg-transparent px-[9px] py-1.5 text-[12.5px] text-secondary hover:bg-hover hover:text-primary"
          ><Sparkles size={13} /> Ask</button>
          <button
            className="flex cursor-pointer items-center gap-1.5 rounded-md border-none bg-transparent px-[9px] py-1.5 text-[12.5px] text-secondary hover:bg-hover hover:text-primary"
          ><FolderInput size={13} />
            <select
              value=""
              onChange={(e) => { if (e.target.value) void bulkMoveSelected(e.target.value); }}
              onClick={(e) => e.stopPropagation()}
              className="cursor-pointer border-none bg-transparent font-sans text-[12.5px] text-secondary outline-none"
            >
              <option value="">Move to folder…</option>
              {clusterList.map(({ key, name }) => <option key={key} value={key}>{name}</option>)}
            </select>
          </button>
          <button
            onClick={() => void bulkTrashSelected()}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border-none bg-transparent px-[9px] py-1.5 text-[12.5px] text-danger hover:bg-hover hover:text-primary"
          ><Trash2 size={13} /> Delete</button>
          <button
            onClick={() => setSelectedIds([])}
            title="Clear selection"
            className="cursor-pointer rounded-md border-none bg-transparent px-[7px] py-1.5 font-mono text-[11px] text-faint hover:bg-hover hover:text-primary"
          >esc</button>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-[62px] left-1/2 z-46 flex -translate-x-1/2 animate-rise items-center gap-3 rounded-[10px] border border-default bg-card px-3.5 py-2.5 shadow-[0_10px_34px_rgba(var(--shadow-color),.14)]">
          <div className="text-[13px] text-secondary">{toast.text}</div>
          <button
            onClick={() => void undoTrash()}
            className="cursor-pointer rounded-[7px] border border-primary bg-primary px-[11px] py-[5px] text-xs font-medium text-card"
          >Undo</button>
        </div>
      )}

      {contextMenu && contextMenuItem && (
        <>
          <div
            onClick={closeContextMenu}
            onContextMenu={(e) => { e.preventDefault(); closeContextMenu(); }}
            className="fixed inset-0 z-60 animate-fade bg-[rgba(0,0,0,.18)]"
          />
          <div
            className="fixed z-63 min-w-[180px] max-w-[260px] overflow-hidden rounded-[10px] border border-default bg-card p-1 shadow-[0_10px_34px_rgba(var(--shadow-color),.16)] [left:var(--sd-l)] [top:var(--sd-t)]"
            style={{ ["--sd-l" as string]: `${contextMenu.x}px`, ["--sd-t" as string]: `${contextMenu.y}px` } as CSSProperties}
          >
            <div className="mb-1 truncate border-b border-subtle px-2.5 py-[7px] text-xs font-medium text-primary">{contextMenuItem.title}</div>
            <button
              onClick={() => { setOpenInEdit(true); setFocusId(contextMenuItem.id); closeContextMenu(); }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2.5 py-[7px] text-left text-[12.5px] text-secondary hover:bg-hover hover:text-primary"
            ><Pencil size={13} /> Edit</button>
            {contextMenuItem.cluster && (
              <button
                onClick={() => { removeFromFolder(contextMenuItem.id); closeContextMenu(); }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2.5 py-[7px] text-left text-[12.5px] text-secondary hover:bg-hover hover:text-primary"
              ><FolderMinus size={13} /> Remove from folder</button>
            )}
            {stashes.length > 1 && (
              <>
                <button
                  onClick={() => setMoveMenuOpen((v) => !v)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2.5 py-[7px] text-left text-[12.5px] text-secondary hover:bg-hover hover:text-primary"
                ><FolderInput size={13} /> Move to<span className="flex-1" /><ChevronDown size={11} className={`${moveMenuOpen ? "rotate-180" : ""}`} /></button>
                {moveMenuOpen && (
                  <div className="my-0.5 max-h-[180px] overflow-y-auto border-y border-subtle py-0.5">
                    {stashes.filter((s) => s.id !== stash?.id).map((s) => (
                      <button
                        key={s.id}
                        onClick={() => void moveToStash(contextMenuItem.id, s.id, s.name)}
                        className="flex w-full cursor-pointer items-center truncate rounded-md border-none bg-transparent py-[7px] pl-[22px] pr-2.5 text-left text-[12.5px] text-secondary hover:bg-hover hover:text-primary"
                      >{s.name}</button>
                    ))}
                  </div>
                )}
              </>
            )}
            {canDeleteItem(contextMenuItem) && (
              <button
                onClick={() => void quickTrash(contextMenuItem.id)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2.5 py-[7px] text-left text-[12.5px] text-danger hover:bg-hover hover:text-primary"
              ><Trash2 size={13} /> Delete</button>
            )}
          </div>
        </>
      )}

      {folderMenu && (
        <>
          <div
            onClick={() => setFolderMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setFolderMenu(null); }}
            className="fixed inset-0 z-60 animate-fade bg-[rgba(0,0,0,.18)]"
          />
          <div
            className="fixed z-63 min-w-[180px] max-w-[260px] overflow-hidden rounded-[10px] border border-default bg-card p-1 shadow-[0_10px_34px_rgba(var(--shadow-color),.16)] [left:var(--sd-l)] [top:var(--sd-t)]"
            style={{ ["--sd-l" as string]: `${folderMenu.x}px`, ["--sd-t" as string]: `${folderMenu.y}px` } as CSSProperties}
          >
            <div className="mb-1 truncate border-b border-subtle px-2.5 py-[7px] text-xs font-medium text-primary">{clusterNames[folderMenu.key] || "Folder"}</div>
            <button
              onClick={() => { setFolderRenameKey(folderMenu.key); setFolderRename(clusterNames[folderMenu.key] || ""); setFolderMenu(null); }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2.5 py-[7px] text-left text-[12.5px] text-secondary hover:bg-hover hover:text-primary"
            ><Pencil size={13} /> Edit</button>
            <button
              onClick={() => { setDeleteFolderKey(folderMenu.key); setFolderMenu(null); }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-2.5 py-[7px] text-left text-[12.5px] text-danger hover:bg-hover hover:text-primary"
            ><Trash2 size={13} /> Delete</button>
          </div>
        </>
      )}

      {folderRenameKey && (
        <div onClick={() => setFolderRenameKey(null)} className="fixed inset-0 z-70 grid place-items-center bg-overlay px-6 backdrop-blur-[2px]">
          <div onClick={(e) => e.stopPropagation()} className="w-[min(360px,100%)] animate-sheet overflow-hidden rounded-[14px] border border-default bg-card p-5 shadow-[0_24px_70px_rgba(var(--shadow-color),.16)]">
            <div className="font-serif text-[19px] text-primary">Rename folder</div>
            <input
              value={folderRename}
              onChange={(e) => setFolderRename(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveFolderRename(); }}
              placeholder="Folder name"
              autoFocus
              className="mt-4 w-full rounded-[7px] border border-default bg-hover-alt px-[10px] py-[8px] text-[13px] text-primary outline-none"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setFolderRenameKey(null)}
                className="cursor-pointer rounded-[7px] border border-strong bg-transparent px-[13px] py-1.5 text-[12.5px] text-secondary hover:border-primary"
              >Cancel</button>
              <button
                onClick={() => void saveFolderRename()}
                disabled={!folderRename.trim()}
                className={`rounded-[7px] border border-primary bg-primary px-[13px] py-1.5 text-[12.5px] text-card ${folderRename.trim() ? "cursor-pointer" : "cursor-not-allowed opacity-45"}`}
              >Save</button>
            </div>
          </div>
        </div>
      )}

      {deleteFolderKey && (
        <div className="fixed inset-0 z-75 grid place-items-center bg-overlay px-6">
          <div className="w-[min(400px,100%)] animate-sheet overflow-hidden rounded-[14px] border border-default bg-card p-5 shadow-[0_24px_70px_rgba(var(--shadow-color),.2)]">
            <div className="font-serif text-[20px] text-primary">Delete “{clusterNames[deleteFolderKey] || "folder"}”?</div>
            <div className="mt-1.5 text-[13px] leading-[1.5] text-muted">
              {(() => { const n = items.filter((o) => o.cluster === deleteFolderKey).length; return n ? `It holds ${n} item${n === 1 ? "" : "s"}. What should happen to them?` : "It's empty — just remove the folder?"; })()}
            </div>
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => setDeleteFolderKey(null)}
                className="cursor-pointer rounded-[9px] border border-strong bg-transparent px-[13px] py-2 text-[13px] text-secondary hover:border-primary"
              >Cancel</button>
              <button
                onClick={() => void handleDeleteFolder("keep")}
                className="cursor-pointer rounded-[9px] border border-primary bg-primary px-[13px] py-2 text-[13px] text-card"
              >Keep the items</button>
              <button
                onClick={() => void handleDeleteFolder("delete")}
                className="cursor-pointer rounded-[9px] border border-danger bg-danger-bg px-[13px] py-2 text-[13px] text-danger"
              >Delete the folder and all {items.filter((o) => o.cluster === deleteFolderKey).length} items</button>
            </div>
          </div>
        </div>
      )}

      {trashOpen && (
        <div
          onClick={() => setTrashOpen(false)}
          className="absolute inset-0 z-50 flex items-start justify-center overflow-y-auto bg-overlay px-6 pb-6 pt-[7vh] backdrop-blur-[2px]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[min(520px,100%)] animate-sheet overflow-hidden rounded-[14px] border border-default bg-card shadow-[0_24px_70px_rgba(var(--shadow-color),.14)] [animation-duration:.24s]"
          >
            <div className="flex items-center gap-2.5 border-b border-subtle px-[22px] py-[18px]">
              <div className="flex-1 font-serif text-[19px] text-primary">Trash</div>
              {trashItems.length > 0 && (
                <button
                  onClick={handleEmptyTrash}
                  className={`cursor-pointer rounded-[7px] border px-[11px] py-[5px] text-xs ${emptyArmed ? "border-danger bg-danger-bg text-danger" : "border-strong bg-transparent text-secondary"}`}
                >{emptyArmed ? "Confirm empty?" : "Empty trash"}</button>
              )}
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-2.5 py-1.5">
              {trashItems.length === 0 ? (
                <div className="px-3 py-7 text-center text-[13px] text-faint">Nothing in the trash.</div>
              ) : (
                trashItems.map((t) => (
                  <div
                    key={t.id}
                    onClick={() => { setFocusId(t.id); setDisc({ highlights: false, related: false, context: false, comments: false }); setTrashOpen(false); }}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-hover-alt"
                  >
                    <span className="flex-none rounded size-[9px] [background:var(--sd-mark)]" style={{ ["--sd-mark" as string]: MARK[t.kind] || "var(--text-muted)" } as CSSProperties} />
                    <div className="min-w-0 flex-1 truncate text-[13.5px] text-primary">{t.title}</div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRestore(t); }}
                      className="cursor-pointer flex-none rounded-[7px] border border-strong bg-transparent px-2.5 py-1 text-xs text-secondary hover:border-primary"
                    >Restore</button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {focused && (
        <div
          onClick={() => setFocusId(null)}
          className="absolute inset-0 z-50 flex items-start justify-center overflow-y-auto bg-overlay px-6 pb-6 pt-[7vh] backdrop-blur-[2px]"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[min(680px,100%)] animate-sheet overflow-hidden rounded-[14px] border border-default bg-card shadow-[0_24px_70px_rgba(var(--shadow-color),.14)] [animation-duration:.24s]"
          >
            <div className={`relative grid place-items-center overflow-hidden border-b border-subtle ${focused.kind === "comment" ? "h-[60px] bg-sticky" : `${focused.isText ? "h-[200px]" : focused.kind === "image" || focused.kind === "shot" ? "h-[300px]" : "h-[220px]"} ${TINT[focused.kind] || "bg-tint-article"}`}`}>
              {!focused.isText && focused.image && !brokenImages.has(focused.id) && !focused.image.startsWith("data:application/") ? (
                <img
                  src={focused.image}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                  onError={() => setBrokenImages((prev) => new Set(prev).add(focused.id))}
                />
              ) : (
                !focused.isText && bars(focused.kind === "video" ? "image" : focused.kind, (focused.id.charCodeAt(1) || 3) + 1).map((b, i) => (
                  <div
                    key={i}
                    className="absolute [left:var(--sd-l)] [top:var(--sd-t)] [width:var(--sd-w)] [height:var(--sd-h)] [border-radius:var(--sd-r)] [background:var(--sd-b)]"
                    style={{ ["--sd-l" as string]: b.left, ["--sd-t" as string]: b.top, ["--sd-w" as string]: b.w, ["--sd-h" as string]: b.h === "3px" ? "5px" : b.h === "7px" ? "11px" : b.h, ["--sd-r" as string]: b.r, ["--sd-b" as string]: b.bg } as CSSProperties}
                  />
                ))
              )}
              {focused.isText && focused.kind !== "comment" && (
                <div className="max-w-[520px] px-10 py-[34px]">
                  <div className={`text-pretty font-serif text-[26px] leading-[1.28] text-primary ${focused.kind === "quote" ? "italic" : ""}`}>{focused.body}</div>
                </div>
              )}
              {focused.playhead && (
                <div className="grid size-11 place-items-center rounded-full border border-[rgba(var(--shadow-color),.14)] bg-surface">
                  <div className="ml-[3px] h-0 w-0 border-b-[7.5px] border-l-[12px] border-t-[7.5px] border-b-transparent border-l-secondary border-t-transparent" />
                </div>
              )}
              {focused.url && (
                <a
                  href={focused.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="absolute left-3 top-3 flex h-[26px] cursor-pointer items-center gap-[5px] rounded-[7px] border border-default bg-surface px-2.5 font-mono text-[11px] text-secondary no-underline hover:border-primary hover:text-primary"
                >open ↗</a>
              )}
              <button
                onClick={() => setFocusId(null)}
                className="absolute right-3 top-3 size-[26px] cursor-pointer rounded-[7px] border border-default bg-surface font-mono text-[11px] text-muted hover:border-primary hover:text-primary"
              >✕</button>
            </div>

            <div className="px-[26px] pb-2 pt-[22px]">
              <h2 className="m-0 mb-2 text-pretty font-serif text-[27px] font-normal leading-[1.2] tracking-[-.01em]">{focused.title}</h2>
              <div className="flex flex-wrap items-center gap-[9px] font-mono text-[10px] text-faint">
                <span className="rounded size-[9px] [background:var(--sd-mark)]" style={{ ["--sd-mark" as string]: MARK[focused.kind] || "var(--text-muted)" } as CSSProperties} />
                <span>{focused.domain}</span><span>·</span><span>kept {focused.kept}</span><span>·</span><span>{clusterNames[focused.cluster] || "Unsorted"}</span>
                {focused.createdByName && <><span>·</span><span>added by {focused.createdByName}</span></>}
              </div>
            </div>

            <div className="px-[26px] pt-3.5">
              <div className="text-pretty text-[14.5px] leading-[1.6] text-secondary">{focused.description}</div>
            </div>

            <div className="flex flex-wrap gap-1.5 px-[26px] pb-1.5 pt-[18px]">
              {focused.tags.map((t) => (
                <span key={t} className="rounded-[5px] border border-subtle px-2 py-[3px] font-mono text-[9.5px] text-muted">{t}</span>
              ))}
            </div>

            {!editing && (
              <div className="flex gap-2 px-[26px] pt-2.5">
                {focused.url ? (
                  <a
                    href={focused.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="cursor-pointer rounded-[7px] border border-strong bg-transparent px-[11px] py-[5px] text-xs text-secondary no-underline hover:border-primary"
                  >Open original ↗</a>
                ) : focused.kind === "pdf" && focused.image ? (
                  <button
                    onClick={() => openPdf(focused.image!)}
                    className="cursor-pointer rounded-[7px] border border-strong bg-transparent px-[11px] py-[5px] text-xs text-secondary hover:border-primary"
                  >Open PDF ↗</button>
                ) : (
                  <span
                    title="This item has no source link — it's original demo content, not something pasted in"
                    className="cursor-not-allowed rounded-[7px] border border-subtle px-[11px] py-[5px] text-xs text-fainter"
                  >Open original ↗</span>
                )}
                {focusedTrashed ? (
                  <button
                    onClick={() => { void handleRestore(focused); setFocusId(null); }}
                    className="cursor-pointer rounded-[7px] border border-strong bg-transparent px-[11px] py-[5px] text-xs text-secondary hover:border-primary"
                  >Restore</button>
                ) : (
                  <>
                    <button
                      onClick={() => { setEditing(true); setDeleteArmed(false); }}
                      className="cursor-pointer rounded-[7px] border border-strong bg-transparent px-[11px] py-[5px] text-xs text-secondary hover:border-primary"
                    >Edit</button>
                    {canDeleteItem(focused) && (
                      <button
                        onClick={() => confirmDelete(focused.id)}
                        className={`cursor-pointer rounded-[7px] border px-[11px] py-[5px] text-xs ${deleteArmed ? "border-danger bg-danger-bg text-danger" : "border-strong bg-transparent text-secondary"}`}
                      >{deleteArmed ? "Confirm delete?" : "Delete"}</button>
                    )}
                  </>
                )}
              </div>
            )}

            {editing && focused.kind === "comment" && (
              <div className="flex flex-col gap-2.5 px-[26px] pt-3.5">
                <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                  Title
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="rounded-[7px] border border-default px-[9px] py-[7px] text-[13.5px] text-primary"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                  Description
                  <textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    rows={4}
                    placeholder="Room for the whole paragraph, if the title isn't enough."
                    className="resize-y rounded-[7px] border border-default px-[9px] py-[7px] text-[13.5px] font-sans text-primary"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => saveEdit(focused.id)}
                    className="cursor-pointer rounded-[7px] border border-primary bg-primary px-[13px] py-1.5 text-[12.5px] text-card"
                  >Save</button>
                  <button
                    onClick={() => setEditing(false)}
                    className="cursor-pointer rounded-[7px] border border-strong bg-transparent px-[13px] py-1.5 text-[12.5px] text-secondary hover:border-primary"
                  >Cancel</button>
                </div>
              </div>
            )}

            {editing && focused.kind !== "comment" && (
              <div className="flex flex-col gap-2.5 px-[26px] pt-3.5">
                <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                  Title
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="rounded-[7px] border border-default px-[9px] py-[7px] text-[13.5px] text-primary"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                  Description
                  <textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    rows={2}
                    className="resize-y rounded-[7px] border border-default px-[9px] py-[7px] text-[13.5px] font-sans text-primary"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                  Kind
                  <select
                    value={editKind}
                    onChange={(e) => setEditKind(e.target.value as Kind)}
                    className="rounded-[7px] border border-default bg-card px-[9px] py-[7px] text-[13.5px] text-primary"
                  >
                    {KIND_OPTIONS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                  Folder
                  <select
                    value={editCluster}
                    onChange={(e) => setEditCluster(e.target.value)}
                    className="rounded-[7px] border border-default bg-card px-[9px] py-[7px] text-[13.5px] text-primary"
                  >
                    {clusterList.map(({ key, name }) => (
                      <option key={key} value={key}>{name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                  Tags (comma separated)
                  <input
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    className="rounded-[7px] border border-default px-[9px] py-[7px] text-[13.5px] text-primary"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                  Your note
                  <textarea
                    value={editNote}
                    onChange={(e) => setEditNote(e.target.value)}
                    rows={3}
                    className="resize-y rounded-[7px] border border-default px-[9px] py-[7px] text-[13.5px] font-sans text-primary"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => saveEdit(focused.id)}
                    className="cursor-pointer rounded-[7px] border border-primary bg-primary px-[13px] py-1.5 text-[12.5px] text-card"
                  >Save</button>
                  <button
                    onClick={() => setEditing(false)}
                    className="cursor-pointer rounded-[7px] border border-strong bg-transparent px-[13px] py-1.5 text-[12.5px] text-secondary hover:border-primary"
                  >Cancel</button>
                </div>
              </div>
            )}

            <div className="px-[26px] pb-[26px] pt-3.5">
              {discs.map((d) => {
                const open = disc[d.key];
                return (
                  <div key={d.key} className="border-t border-subtle">
                    <button
                      onClick={() => {
                        setDisc((prev) => ({ ...prev, [d.key]: !prev[d.key] }));
                        if (d.key === "comments" && commentsItemId !== focused.id) {
                          setCommentsItemId(focused.id);
                          void listItemComments(focused.id).then(setComments);
                        }
                      }}
                      className="flex w-full cursor-pointer items-center gap-2.5 border-none bg-transparent px-0.5 py-[13px] text-left"
                    >
                      <span className="flex-1 font-mono text-[9.5px] uppercase tracking-[.14em] text-muted">{d.label}</span>
                      <span className="font-mono text-[9.5px] text-fainter">{d.n}</span>
                      <span className="w-3 text-center font-mono text-[11px] text-fainter">{open ? "−" : "+"}</span>
                    </button>
                    {open && (
                      <div className="px-0.5 pb-4">
                        {d.key === "highlights" && (
                          <div className="flex flex-col gap-3">
                            {focused.highlights.map((h, i) => (
                              <div key={i} className="border-l-2 border-strong pl-[13px]">
                                <div className="text-pretty font-serif text-[17px] leading-[1.42] text-secondary">{h.text}</div>
                                <div className="mt-[5px] font-mono text-[9.5px] text-faint">{h.at}</div>
                              </div>
                            ))}
                            {focused.note && (
                              <div className="text-pretty rounded-[9px] border border-accent-border bg-accent-bg px-3.5 py-3 text-[13.5px] leading-[1.55] text-secondary">{focused.note}</div>
                            )}
                          </div>
                        )}
                        {d.key === "related" && (
                          <div className="flex flex-col gap-0.5">
                            {focusedRelated.map((r) => (
                              <div
                                key={r.id}
                                onClick={() => { setFocusId(r.id); setDisc({ highlights: false, related: false, context: false, comments: false }); }}
                                className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-hover-alt"
                              >
                                <span className="flex-none rounded size-[9px] [background:var(--sd-mark)]" style={{ ["--sd-mark" as string]: r.mark } as CSSProperties} />
                                <span className="min-w-0 flex-1 truncate text-[13.5px] text-primary">{r.title}</span>
                                <span className="flex-none font-serif text-[13.5px] italic text-muted">{r.why}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {d.key === "context" && (
                          <div>
                            <div className="text-pretty mb-3.5 text-[13.5px] leading-[1.6] text-secondary">{focused.context}</div>
                            <button
                              onClick={() => { setView(isList ? "desk" : "list"); setFocusId(null); }}
                              className="cursor-pointer rounded-lg border border-strong bg-transparent px-3.5 py-2 text-[13px] text-secondary hover:border-primary"
                            >{isList ? "Show it on the desk" : "Find it in the list"}</button>
                          </div>
                        )}
                        {d.key === "comments" && (
                          <div className="flex flex-col gap-3">
                            {comments.map((c) => (
                              <div key={c.id}>
                                <div className="flex items-baseline gap-2">
                                  <span className="text-[12.5px] font-medium text-primary">{c.userName}</span>
                                  <span className="font-mono text-[9.5px] text-faint">{new Date(c.createdAt).toLocaleString()}</span>
                                </div>
                                <div className="text-pretty mt-[3px] text-[13.5px] leading-[1.5] text-secondary">{c.body}</div>
                              </div>
                            ))}
                            {comments.length === 0 && <div className="text-[12.5px] text-faint">No comments yet.</div>}
                            <div className="mt-1 flex gap-2">
                              <input
                                value={newComment}
                                onChange={(e) => setNewComment(e.target.value)}
                                placeholder="Add a comment…"
                                onKeyDown={(e) => { if (e.key === "Enter") postComment(focused.id); }}
                                className="flex-1 rounded-[7px] border border-default bg-card px-[9px] py-[7px] text-[13px] text-primary"
                              />
                              <button
                                onClick={() => postComment(focused.id)}
                                disabled={postingComment || !newComment.trim()}
                                className={`flex items-center rounded-[7px] border border-strong bg-transparent px-[11px] text-secondary ${!newComment.trim() ? "opacity-50" : "cursor-pointer"}`}
                              ><Send size={13} /></button>
                            </div>
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
