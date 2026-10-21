/**
 * Embeddings — the optional half of hybrid retrieval (D-02, D-03).
 *
 * The embedder is **optional**: it runs locally (LM Studio, Ollama) and if
 * it is down, retrieval falls back to FTS alone rather than failing. That
 * matters more than the quality difference — a search that fails is worse
 * than a search that is a little less clever.
 *
 * There is no vector *service*. At personal scale the vectors live in the
 * `embedding` BLOB of `agent_memories` and the similarity is computed in
 * JavaScript. A separate store only earns its keep when the corpus grows
 * past what a linear scan can do.
 */
import { log } from "../log";

export interface EmbedderConfig {
  /** An OpenAI-compatible base URL (LM Studio) or an Ollama base URL. */
  baseURL: string;
  model: string;
  /** Which dialect the endpoint speaks. */
  kind: "openai" | "ollama";
  timeoutMs: number;
}

/** The embedder, read from the environment. Null when none is configured. */
export function embedderConfig(env: Record<string, string | undefined> = Bun.env): EmbedderConfig | null {
  const ollama = env.AGNI_OLLAMA_BASE_URL?.trim();
  if (ollama) {
    const model = env.AGNI_EMBEDDING_MODEL?.trim() || env.AGNI_OLLAMA_EMBED_MODEL?.trim() || "nomic-embed-text";
    return { baseURL: ollama.replace(/\/$/, ""), model, kind: "ollama", timeoutMs: 8_000 };
  }
  const baseURL = env.AGNI_EMBEDDING_BASE_URL?.trim();
  if (!baseURL) return null;
  return {
    baseURL: baseURL.replace(/\/$/, ""),
    model: env.AGNI_EMBEDDING_MODEL?.trim() || "text-embedding-nomic-embed-text",
    kind: "openai",
    timeoutMs: 8_000,
  };
}

/**
 * Embed one text. Returns null when the embedder is not configured, not
 * reachable, or answers with something unexpected — the caller's job is to
 * fall back to FTS, not to fail.
 */
export async function embedText(
  text: string,
  config: EmbedderConfig | null,
  fetchFn: typeof fetch = fetch,
): Promise<Float32Array | null> {
  if (!config) return null;
  const body = text.trim();
  if (!body) return null;
  try {
    const response = await fetchFn(`${config.baseURL}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, input: body }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      log.warn(`embedder ${config.model} answered ${response.status}`);
      return null;
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
      embedding?: number[];
    };
    const vector = payload.data?.[0]?.embedding ?? payload.embedding;
    if (!Array.isArray(vector) || vector.length === 0) return null;
    return Float32Array.from(vector);
  } catch (error) {
    log.warn(`embedder ${config.model} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Cosine similarity. Two vectors of different lengths are not comparable, so
 * they score zero rather than pretending.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Pack a vector for the BLOB column. */
export function packVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(0));
}

/** Unpack a vector from the BLOB column. */
export function unpackVector(blob: Uint8Array | null | undefined): Float32Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer);
}
