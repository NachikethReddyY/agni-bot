import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Provider catalog — every source is OpenAI-compatible `chat/completions`,
 * enabled by the presence of its API key (except LM Studio, which is local).
 * Free-first per Blueprint v3 §8: the router orders providers around health,
 * failover on 429/timeout. Ordering here is only the default.
 *
 * A custom endpoint (a token router, a proxy, a self-hosted gateway) is not in
 * this list: it is described at runtime in the provider config file and points
 * at an OpenAI-compatible `/chat/completions`.
 */

export interface ProviderConfig {
  supportsVision?: boolean;
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** A user-supplied OpenAI-compatible endpoint. The key lives in the env. */
export interface CustomProviderEntry {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  /** The env variable that carries this endpoint's key. */
  envKey: string;
}

interface ProviderSpec {
  id: string;
  label: string;
  baseUrl: string;
  /** Environment variable that carries the API key. LM Studio has none. */
  envKey: string | null;
  /** Optional env override for the endpoint (proxies, self-hosted, tests). */
  envBaseUrl?: string;
  envModel: string;
  model: string;
}

/** The id a custom endpoint takes when it is the first one. */
export const CUSTOM_PROVIDER_PREFIX = "custom";

const SPECS: ProviderSpec[] = [
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    envBaseUrl: "GROQ_BASE_URL",
    envModel: "GROQ_MODEL",
    model: "llama-3.1-8b-instant",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    envBaseUrl: "CEREBRAS_BASE_URL",
    envModel: "CEREBRAS_MODEL",
    model: "llama3.1-8b",
  },
  {
    id: "nim",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    envBaseUrl: "NVIDIA_BASE_URL",
    envModel: "NIM_MODEL",
    model: "meta/llama-3.3-70b-instruct",
  },
  {
    id: "gemini",
    label: "Gemini (free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    envBaseUrl: "GEMINI_BASE_URL",
    envModel: "GEMINI_MODEL",
    model: "gemini-2.0-flash",
  },
  {
    id: "openrouter",
    label: "OpenRouter (:free)",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    envBaseUrl: "OPENROUTER_BASE_URL",
    envModel: "OPENROUTER_MODEL",
    model: "meta-llama/llama-3.3-70b-instruct:free",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    envKey: null,
    envBaseUrl: "LMSTUDIO_BASE_URL",
    envModel: "LMSTUDIO_MODEL",
    model: "",
  },
];

/** Public metadata for the providers the authenticated app can configure. */
export function providerCredentialTarget(id: string): { id: string; label: string; envKey: string; envModel: string } | null {
  const spec = SPECS.find((candidate) => candidate.id === id);
  if (!spec || !spec.envKey) return null;
  return { id: spec.id, label: spec.label, envKey: spec.envKey, envModel: spec.envModel };
}

export function providerModelTarget(id: string): { id: string; envModel: string } | null {
  const spec = SPECS.find((candidate) => candidate.id === id && candidate.envKey !== null);
  return spec ? { id: spec.id, envModel: spec.envModel } : null;
}

/** The provider config file: chosen models plus the custom endpoints. */
export function providerConfigPath(env: Record<string, string | undefined> = Bun.env): string {
  return resolve(env.AGNI_PROVIDER_CONFIG_PATH?.trim() || "data/providers.json");
}

interface ProviderConfigFile {
  version?: unknown;
  models?: unknown;
  custom?: unknown;
}

/** Read the config file; a missing or invalid file is simply empty. */
export function readProviderConfigFile(path: string): ProviderConfigFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProviderConfigFile;
  } catch {
    // Missing or invalid optional config falls back to environment defaults.
    return {};
  }
}

function customEntries(value: unknown): CustomProviderEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: CustomProviderEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Partial<CustomProviderEntry>;
    if (typeof entry.id !== "string" || !entry.id) continue;
    if (typeof entry.baseUrl !== "string" || !entry.baseUrl) continue;
    if (typeof entry.envKey !== "string" || !entry.envKey) continue;
    entries.push({
      id: entry.id,
      label: typeof entry.label === "string" && entry.label ? entry.label : entry.id,
      baseUrl: entry.baseUrl,
      model: typeof entry.model === "string" ? entry.model : "",
      envKey: entry.envKey,
    });
  }
  return entries;
}

/** The custom endpoints the owner configured, in file order. */
export function loadCustomProviders(env: Record<string, string | undefined> = Bun.env): CustomProviderEntry[] {
  return customEntries(readProviderConfigFile(providerConfigPath(env)).custom);
}

/**
 * The next free id for a custom endpoint: `custom`, then `custom-2`, and so on.
 * Ids are stable once written, so the app can address an endpoint later.
 */
export function nextCustomProviderID(existing: CustomProviderEntry[]): string {
  const taken = new Set(existing.map((entry) => entry.id));
  if (!taken.has(CUSTOM_PROVIDER_PREFIX)) return CUSTOM_PROVIDER_PREFIX;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${CUSTOM_PROVIDER_PREFIX}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${CUSTOM_PROVIDER_PREFIX}-${Date.now()}`;
}

/**
 * A base URL for an OpenAI-compatible endpoint. The path is kept as given:
 * gateways differ (`/v1`, `/openai/v1`, nothing at all).
 */
export function validateCustomBaseUrl(raw: string): string | null {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value || value.length > 500 || /[\s\u0000-\u001f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return value;
}

export function loadProviders(env: Record<string, string | undefined>): ProviderConfig[] {
  const modelConfigPath = providerConfigPath(env);
  const config = readProviderConfigFile(modelConfigPath);
  let configuredModels: Record<string, string> = {};
  if (config.version === 1 && config.models && typeof config.models === "object" && !Array.isArray(config.models)) {
    configuredModels = Object.fromEntries(
      Object.entries(config.models).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  const providers: ProviderConfig[] = [];
  for (const spec of SPECS) {
    if (spec.envKey === null) {
      // Local provider: enabled by explicitly naming a model to serve.
      const model = (configuredModels[spec.id] || env[spec.envModel])?.trim();
      if (!model) continue;
      providers.push({
        id: spec.id,
        label: spec.label,
        baseUrl: (spec.envBaseUrl && env[spec.envBaseUrl]?.trim()) || spec.baseUrl,
        apiKey: "lm-studio", // LM Studio ignores auth but the header must exist.
        model,
      });
      continue;
    }
    const apiKey = env[spec.envKey]?.trim();
    if (!apiKey) continue;
    providers.push({
      id: spec.id,
      label: spec.label,
      baseUrl: (spec.envBaseUrl && env[spec.envBaseUrl]?.trim()) || spec.baseUrl,
      apiKey,
      model: (configuredModels[spec.id] || env[spec.envModel])?.trim() || spec.model,
    });
  }
  // Custom endpoints last: the free lanes come first, the owner's gateway is
  // the fallback that always answers.
  for (const entry of customEntries(config.custom)) {
    const apiKey = env[entry.envKey]?.trim();
    if (!apiKey) continue;
    const model = (configuredModels[entry.id] || entry.model).trim();
    if (!model) continue;
    providers.push({
      id: entry.id,
      label: entry.label,
      baseUrl: entry.baseUrl,
      apiKey,
      model,
    });
  }
  const visionModels = new Set((env.AGNI_VISION_MODELS ?? "").split(",").map((model) => model.trim()).filter(Boolean));
  return providers.map((provider) => ({ ...provider, supportsVision: visionModels.has(provider.model) }));
}
