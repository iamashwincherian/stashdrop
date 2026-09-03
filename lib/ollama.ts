const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:e2b";

export interface Enrichment {
  description: string;
  tags: string[];
  cluster: string;
  context: string;
  highlights: { text: string; at: string }[];
}

export async function enrichWithOllama(input: {
  title: string;
  domain: string;
  description: string;
  textSample: string;
  clusters: { key: string; name: string }[];
}): Promise<Enrichment | null> {
  const prompt = `You are filing a saved link into one of these existing piles:
${input.clusters.map((c) => `${c.key}: ${c.name}`).join("\n")}

Saved page:
Title: ${input.title}
Domain: ${input.domain}
Existing description: ${input.description || "(none)"}
Content sample: ${input.textSample.slice(0, 1500) || "(none)"}

Respond with ONLY JSON in this exact shape:
{"description": "one or two sentence summary, in the voice of someone noting why they saved it", "tags": ["3-4 short lowercase tags"], "cluster": "the single best-fit pile letter from the list above", "context": "one sentence on why it belongs in that pile", "highlights": [{"text": "a notable sentence or claim from the content sample, close to verbatim", "at": "a short location hint like 'early in the piece' or 'near the end'"}]}
Include 0-2 highlights — only if the content sample actually has a genuinely quotable line; don't invent one.`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: "json",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data.message.content);
    const clusterKey = input.clusters.some((c) => c.key === parsed.cluster) ? parsed.cluster : input.clusters.at(-1)!.key;
    const highlights = Array.isArray(parsed.highlights)
      ? parsed.highlights
          .filter((h: unknown): h is { text: unknown; at: unknown } => !!h && typeof h === "object" && "text" in h)
          .slice(0, 2)
          .map((h: { text: unknown; at: unknown }) => ({ text: String(h.text).slice(0, 300), at: String(h.at || "").slice(0, 60) }))
          .filter((h: { text: string }) => h.text.trim().length > 0)
      : [];
    return {
      description: String(parsed.description || "").slice(0, 500),
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 6).map(String) : [],
      cluster: clusterKey,
      context: String(parsed.context || "").slice(0, 500),
      highlights,
    };
  } catch {
    return null;
  }
}
