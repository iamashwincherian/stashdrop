import type { Kind } from "./data";

export interface PageMeta {
  url: string;
  title: string;
  domain: string;
  description: string;
  textSample: string;
  contentType: string;
  image: string | null;
}

function metaContent(html: string, attr: "name" | "property", key: string): string | null {
  const tag = html.match(new RegExp(`<meta[^>]*${attr}=["']${key}["'][^>]*>`, "i"))?.[0];
  if (!tag) return null;
  return tag.match(/content=["']([^"']*)["']/i)?.[1]?.trim() || null;
}

// Titles/descriptions are pulled out of raw HTML attributes, which arrive
// entity-encoded (Don&#39;t → Don't). Covers the common named + numeric forms.
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'");
}

// This fetches whatever URL the user pastes, server-side — block obvious
// requests at internal/private infrastructure (loopback, RFC1918 ranges,
// link-local incl. cloud metadata endpoints). Checked by literal
// hostname/IP, not resolved DNS, so it isn't rebinding-proof — a
// reasonable bar for a single-user local tool, not a public-facing one.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "[::1]") return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

export async function fetchPageMeta(url: string): Promise<PageMeta> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Unsupported URL scheme");
  if (isBlockedHost(target.hostname)) throw new Error("That address isn't allowed");

  const res = await fetch(target, {
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; StashdropBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  if (isBlockedHost(new URL(res.url).hostname)) throw new Error("That address isn't allowed");

  const finalUrl = res.url || url;
  const domain = new URL(finalUrl).hostname.replace(/^www\./, "");
  const contentType = res.headers.get("content-type") || "";

  if (!contentType.includes("text/html")) {
    const image = contentType.startsWith("image/") ? finalUrl : null;
    return { url: finalUrl, title: domain, domain, description: "", textSample: "", contentType, image };
  }

  const html = await res.text();
  const rawTitle =
    metaContent(html, "property", "og:title") ||
    html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ||
    domain;
  const title = decodeEntities(rawTitle.trim());
  const description = decodeEntities(metaContent(html, "name", "description") || metaContent(html, "property", "og:description") || "");
  const rawImage = metaContent(html, "property", "og:image") || metaContent(html, "name", "twitter:image");
  let image: string | null = null;
  if (rawImage) {
    try {
      const imgUrl = new URL(rawImage, finalUrl);
      if (imgUrl.protocol === "http:" || imgUrl.protocol === "https:") image = imgUrl.href;
    } catch { image = null; }
  }
  const textSample = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000)
  );

  return { url: finalUrl, title, domain, description, textSample, contentType, image };
}

const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id", "utm_name",
  "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid", "igshid", "ref_src", "ref",
];

// Two URLs that differ only by tracking params or a trailing slash are the
// same page for "have I already kept this" purposes.
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    u.searchParams.sort();
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return (u.origin + path + (u.search || "")).toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function detectKind(url: string, contentType: string): Kind {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/.test(host)) return "video";
  if (host === "github.com") return "repo";
  if (contentType.includes("application/pdf") || url.toLowerCase().endsWith(".pdf")) return "pdf";
  if (contentType.startsWith("image/")) return "image";
  return "article";
}
