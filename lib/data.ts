export type Kind = "article" | "video" | "image" | "pdf" | "note" | "quote" | "repo" | "shot" | "comment";

export interface StashItem {
  id: string;
  kind: Kind;
  cluster: string;
  x: number;
  y: number;
  w: number;
  title: string;
  domain: string;
  kept: string;
  isText?: boolean;
  body?: string;
  playhead?: boolean;
  description: string;
  tags: string[];
  highlights: { text: string; at: string }[];
  note: string;
  related: string[];
  context: string;
  url?: string;
  image?: string;
}

export interface Bar {
  left: string;
  top: string;
  w: string;
  h: string;
  bg: string;
  r: string;
}

export const MARK: Record<string, string> = {
  article: "#8A5A3B",
  video: "#3F5A52",
  image: "#9A6E7A",
  pdf: "#7A6B3F",
  note: "#6A6558",
  quote: "#4A5568",
  repo: "#4C5A4A",
  shot: "#8A7A5A",
  comment: "#B5860B",
};

export const TINT: Record<string, string> = {
  article: "var(--tint-article)",
  video: "var(--tint-video)",
  image: "var(--tint-image)",
  pdf: "var(--tint-pdf)",
  repo: "var(--tint-repo)",
  shot: "var(--tint-shot)",
};

export function bars(kind: string, seed: number): Bar[] {
  const r = (n: number) => {
    const x = Math.sin(seed * 9301 + n * 49297) * 233280;
    return x - Math.floor(x);
  };
  const out: Bar[] = [];
  if (kind === "article" || kind === "pdf") {
    out.push({ left: "14px", top: "14px", w: "42%", h: "7px", bg: "rgba(var(--ink-rgb),.16)", r: "2px" });
    for (let i = 0; i < 5; i++)
      out.push({ left: "14px", top: 32 + i * 9 + "px", w: 46 + r(i) * 40 + "%", h: "3px", bg: "rgba(var(--ink-rgb),.085)", r: "2px" });
  } else if (kind === "image") {
    for (let i = 0; i < 4; i++)
      out.push({
        left: 8 + (i % 2) * 46 + "%",
        top: 10 + Math.floor(i / 2) * 44 + "%",
        w: "38%",
        h: "38%",
        bg: `rgba(120,96,86,${0.09 + r(i) * 0.13})`,
        r: "3px",
      });
  } else if (kind === "repo") {
    for (let i = 0; i < 7; i++)
      out.push({ left: 12 + r(i) * 8 + "px", top: 14 + i * 9 + "px", w: 18 + r(i + 3) * 46 + "%", h: "3px", bg: "rgba(var(--ink-rgb),.1)", r: "2px" });
  } else if (kind === "shot") {
    out.push({ left: "12px", top: "12px", w: "calc(100% - 24px)", h: "11px", bg: "rgba(var(--ink-rgb),.1)", r: "3px" });
    out.push({ left: "12px", top: "31px", w: "54%", h: "calc(100% - 44px)", bg: "rgba(var(--ink-rgb),.06)", r: "3px" });
    out.push({ left: "calc(58% + 6px)", top: "31px", w: "32%", h: "26px", bg: "rgba(var(--ink-rgb),.08)", r: "3px" });
  }
  return out;
}

export const OBJ: StashItem[] = [
  {
    id: "l1", kind: "article", cluster: "A", x: 250, y: 230, w: 198, title: "Local-first software: you own your data", domain: "inkandswitch.com", kept: "12 Jan",
    description: "The essay that named the pattern. Seven ideals for software that keeps working without a server, and an honest account of where the trade-offs bite.",
    tags: ["local-first", "sync", "architecture"],
    highlights: [{ text: "The network is an optimization, not a requirement.", at: "§ 3, Ideal 4" }, { text: "Cloud apps rent you your own data back.", at: "§ 1" }],
    note: "This is the piece I keep sending people. Ideal 4 is the one that actually changes how you build.",
    related: ["l2", "l3", "u1"], context: "The anchor of the local-first pile. Two of the four things next to it were saved within an hour of reading it, and the automerge repo came from its references.",
  },
  {
    id: "l2", kind: "article", cluster: "A", x: 478, y: 186, w: 190, title: "CRDTs are hard, but not that hard", domain: "jlongster.com", kept: "14 Jan",
    description: "A working engineer's account of shipping a CRDT-backed app: what the papers leave out, and which parts you can skip.",
    tags: ["CRDT", "sync", "local-first"],
    highlights: [{ text: "You will spend more time on the merge UI than the merge algorithm.", at: "mid-post" }],
    note: "", related: ["l1", "l3"], context: "Saved two days after the Ink & Switch essay, and it argues with it in places — mostly about how much of the theory you actually need.",
  },
  {
    id: "l3", kind: "repo", cluster: "A", x: 262, y: 432, w: 186, title: "automerge/automerge", domain: "github.com", kept: "14 Jan",
    description: "The CRDT library both of the local-first pieces point at. Rust core, JS bindings, a document model that survives being edited offline on two machines.",
    tags: ["CRDT", "library", "rust"], highlights: [], note: "Worth reading the docs on save format before committing to it.",
    related: ["l1", "l2"], context: "Arrived from the references of the Ink & Switch essay. It is the only thing in this pile that is code rather than argument.",
  },
  {
    id: "l4", kind: "note", cluster: "A", x: 492, y: 404, w: 200, isText: true, body: "Sync is a product decision, not a backend one. Pick the merge behaviour you can explain to a user, then find the algorithm.", domain: "note", kept: "16 Jan",
    title: "Written after the CRDT post", description: "A note to myself, written while reading the CRDT piece.", tags: ["note", "sync"],
    highlights: [], note: "", related: ["l2", "l1"], context: "The only thing in this space that is mine rather than collected. It sits between the two articles it came out of.",
  },
  {
    id: "l5", kind: "quote", cluster: "A", x: 706, y: 300, w: 176, isText: true, body: "“Software that outlives the company that made it.”", domain: "clipped quote", kept: "12 Jan",
    title: "Clipped from the local-first essay", description: "A line I pulled out of the Ink & Switch essay and kept separately, because it is the whole argument in nine words.",
    tags: ["local-first"], highlights: [], note: "", related: ["l1"], context: "Clipped from the essay it sits beside, kept as its own object because it gets reused more than the essay does.",
  },
  {
    id: "c1", kind: "video", cluster: "B", x: 1148, y: 214, w: 210, title: "Why creator footage outperforms studio work", domain: "youtube.com · 18:42", kept: "21 Aug", playhead: true,
    description: "Teardown of 40 brand accounts. Handheld, creator-shot footage held attention far longer than produced spots; brand intros were the biggest cause of drop-off.",
    tags: ["video", "creator", "retention"],
    highlights: [{ text: "The first 1.2 seconds decide retention.", at: "02:40" }, { text: "Produced spots read as advertising and get skipped.", at: "04:12" }],
    note: "The 1.2 second claim matches our own Q3 numbers almost exactly.",
    related: ["c3", "c2", "c4"], context: "The centre of the video pile. The Q3 review was pulled up to sit next to it because the two agree, and the reference grid followed a day later.",
  },
  {
    id: "c2", kind: "image", cluster: "B", x: 1396, y: 396, w: 186, title: "Reference grid — product in hand", domain: "uploaded · 2400×3000", kept: "23 Aug",
    description: "Nine frames, one hard light source, product held rather than staged. No flatlays anywhere in the set.",
    tags: ["reference", "photography"], highlights: [], note: "Every frame that works has a hand in it. That rules out the flatlay direction.",
    related: ["c1", "t1"], context: "Sits between the video pile and the print pile — it belongs to both, which is why it is on the edge rather than inside either.",
  },
  {
    id: "c3", kind: "pdf", cluster: "B", x: 1150, y: 426, w: 194, title: "Q3 social performance review", domain: "internal · 24pp", kept: "19 Aug",
    description: "Our own numbers. Creator-style cuts completed at 46%, produced assets at 19%. Carousel reach down 31% quarter over quarter.",
    tags: ["data", "internal", "retention"],
    highlights: [{ text: "46% completion on creator-style cuts vs 19% produced.", at: "p.14" }],
    note: "", related: ["c1", "c4"], context: "The internal evidence for the argument the video makes externally. Kept next to it deliberately.",
  },
  {
    id: "c4", kind: "shot", cluster: "B", x: 1404, y: 196, w: 180, title: "Thread on vertical framing", domain: "x.com · screenshot", kept: "25 Aug",
    description: "Screenshot of a thread on shooting vertical: lock exposure, shoot wider than the crop, leave the lower third clear.",
    tags: ["craft", "video"], highlights: [], note: "Practical companion to the teardown.", related: ["c1"], context: "A screenshot rather than a link, because the thread will probably be deleted.",
  },
  {
    id: "t1", kind: "image", cluster: "C", x: 300, y: 790, w: 200, title: "Swiss print spreads, 1968–74", domain: "uploaded · 14 scans", kept: "3 Feb",
    description: "Scans from a run of Swiss magazine spreads. Tight measure, generous leading, almost no rules or boxes.",
    tags: ["typography", "print", "reference"], highlights: [], note: "The spacing, not the grid, is what makes these calm.",
    related: ["t2", "c2"], context: "Started the print pile. Everything else here was saved because of it.",
  },
  {
    id: "t2", kind: "article", cluster: "C", x: 536, y: 824, w: 190, title: "Optical sizes, explained properly", domain: "typographica.org", kept: "5 Feb",
    description: "Why a display cut and a text cut of the same typeface are not the same drawing, and what breaks when you scale one into the other's job.",
    tags: ["typography", "type design"],
    highlights: [{ text: "A text face scaled up is not a display face; it is a text face in the wrong place.", at: "§ 2" }],
    note: "", related: ["t1", "t3"], context: "Read after the scans, to work out why the spreads hold up at that size.",
  },
  {
    id: "t3", kind: "pdf", cluster: "C", x: 322, y: 1010, w: 188, title: "Specimen — Lyon Text", domain: "foundry pdf · 32pp", kept: "5 Feb",
    description: "Full specimen. The 9pt settings are the useful part; everything above 24pt is marketing.",
    tags: ["typography", "specimen"], highlights: [], note: "", related: ["t2"], context: "Kept for the small-size settings, which is the thing the print scans do well.",
  },
  {
    id: "u1", kind: "article", cluster: "D", x: 1160, y: 790, w: 196, title: "Making software feel physical", domain: "frankchimero.com", kept: "2 days ago",
    description: "On interfaces that behave like objects rather than documents — weight, inertia, and the difference between moving something and submitting a form.",
    tags: ["interaction", "craft"], highlights: [{ text: "Direct manipulation is a promise: what you touch is the thing itself.", at: "§ 4" }], note: "",
    related: ["u2", "l1"], context: "Not filed yet. It keeps drifting towards the local-first pile, which is probably where it belongs.",
  },
  {
    id: "u2", kind: "video", cluster: "D", x: 1400, y: 836, w: 194, title: "Hand-drawn interfaces", domain: "youtube.com · 41:08", kept: "yesterday", playhead: true,
    description: "Conference talk on drawing UI by hand before building it, and what gets decided in the drawing that never gets decided in Figma.",
    tags: ["interaction", "process"], highlights: [], note: "", related: ["u1"], context: "Saved yesterday, unsorted. Shares a topic with the physicality essay next to it.",
  },
  {
    id: "u3", kind: "quote", cluster: "D", x: 1172, y: 1000, w: 184, isText: true, body: "“Zooming out should tell you where you are, not just make things smaller.”", domain: "clipped quote", kept: "yesterday",
    title: "Clipped while watching the talk", description: "Pulled out of the hand-drawn interfaces talk.", tags: ["interaction"],
    highlights: [], note: "", related: ["u2"], context: "Clipped mid-talk. Unsorted, sitting next to the thing it came from.",
  },
];

export const CLUSTERS: Record<string, { name: string }> = {
  A: { name: "Local-first & sync" },
  B: { name: "Creator video" },
  C: { name: "Type & print" },
  D: { name: "Unsorted" },
};

export const RECENT = ["u3", "u2", "u1", "c4", "c2", "c1", "c3", "t3", "t2", "t1", "l4", "l2", "l3", "l5", "l1"];
export const BUCKET: Record<string, string> = {
  u3: "This week", u2: "This week", u1: "This week", c4: "August", c2: "August", c1: "August", c3: "August",
  t3: "February", t2: "February", t1: "February", l4: "January", l2: "January", l3: "January", l5: "January", l1: "January",
};

export const WHY: Record<string, string> = {
  l1: "named the pattern", l2: "argues with the essay", l3: "came from its references", l4: "written while reading the CRDT post", l5: "clipped from the essay",
  c1: "the teardown itself", c2: "saved a day after the teardown", c3: "our numbers, same finding", c4: "the craft notes",
  t1: "started this pile", t2: "why the spreads work", t3: "kept for the small sizes", u1: "drifting towards local-first", u2: "shares a topic with the essay", u3: "clipped from the talk",
};

export const WHY_RELATED: Record<string, string> = {
  l1: "named the pattern", l2: "argues with it", l3: "from its references", l4: "written while reading", l5: "clipped from it",
  c1: "the teardown", c2: "saved a day later", c3: "same finding, our data", c4: "the craft notes",
  t1: "started this pile", t2: "why it works", t3: "the small sizes", u1: "shares a topic", u2: "the talk", u3: "clipped from it",
};
