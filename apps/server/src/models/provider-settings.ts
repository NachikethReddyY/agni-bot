/** Persist provider credentials on the daemon host and refresh its live router. */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { providerConfigPath } from "./providers";
import { homePath } from "../home";
import {
  loadCustomProviders,
  loadProviders,
  nextCustomProviderID,
  providerCredentialTarget,
  validateCustomBaseUrl,
  type CustomProviderEntry,
} from "./providers";
import type { Router } from "./router";

export type AddProviderResult =
  | { ok: true; providers: ReturnType<Router["status"]> }
  | { ok: false; code: "unknown_provider" | "invalid_key" | "provider_exists" | "provider_storage"; message: string };

/** What the app sends when it adds an endpoint of its own. */
export interface CustomProviderInput {
  baseUrl?: string;
  label?: string;
}

/**
 * The API key arrives only over the authenticated socket. It is written to the
 * daemon's .env with mode 0600, never returned to the client, and applied to
 * the live router without restarting the process.
 *
 * A custom endpoint also needs somewhere to live: its URL, label and model are
 * written to the provider config file, and its key to .env under a variable
 * the entry names.
 */
export async function addProviderCredential(
  router: Router,
  providerID: string,
  rawKey: string,
  model?: string,
  custom?: CustomProviderInput,
): Promise<AddProviderResult> {
  const apiKey = rawKey.trim();
  if (!apiKey || apiKey.length > 4096 || /[\u0000\r\n]/.test(apiKey)) {
    return { ok: false, code: "invalid_key", message: "Enter a valid API key." };
  }
  if (providerID === "custom") {
    return addCustomProvider(router, apiKey, model, custom);
  }
  const target = providerCredentialTarget(providerID);
  if (!target) {
    return { ok: false, code: "unknown_provider", message: "Choose a supported API provider." };
  }
  if (router.status().some((provider) => provider.id === target.id)) {
    return { ok: false, code: "provider_exists", message: `${target.label} is already configured.` };
  }

  const envPath = homePath("config.env");
  const temporaryPath = `${envPath}.${randomUUID()}.tmp`;
  try {
    const nextContents = await writeEnvValues(envPath, { [target.envKey]: apiKey });
    await writeEnvFile(envPath, temporaryPath, nextContents);
    // Bun.env is the environment map used by the rest of this process.
    Bun.env[target.envKey] = apiKey;
    if (model?.trim()) await saveProviderModel(providerID, validateModel(model));
    router.replaceProviders(loadProviders(Bun.env));
    return { ok: true, providers: router.status() };
  } catch {
    // Do not include the key or filesystem content in the response/log path.
    return { ok: false, code: "provider_storage", message: "Could not save the provider key on the daemon." };
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

/** Add an endpoint of the owner's own: any OpenAI-compatible chat/completions. */
async function addCustomProvider(
  router: Router,
  apiKey: string,
  model?: string,
  custom?: CustomProviderInput,
): Promise<AddProviderResult> {
  const baseUrl = validateCustomBaseUrl(custom?.baseUrl ?? "");
  if (!baseUrl) {
    return { ok: false, code: "unknown_provider", message: "Enter the endpoint URL, for example https://host/v1." };
  }
  const label = (custom?.label ?? "").trim() || defaultCustomLabel(baseUrl);
  const existing = loadCustomProviders(Bun.env);
  const id = nextCustomProviderID(existing);
  const envKey = nextCustomEnvKey(existing);
  const entry: CustomProviderEntry = {
    id,
    label: label.slice(0, 64),
    baseUrl,
    model: model?.trim() ? validateModel(model) : "",
    envKey,
  };
  const envPath = homePath("config.env");
  const temporaryPath = `${envPath}.${randomUUID()}.tmp`;
  try {
    const nextContents = await writeEnvValues(envPath, { [envKey]: apiKey });
    await writeEnvFile(envPath, temporaryPath, nextContents);
    Bun.env[envKey] = apiKey;
    await saveCustomProvider(entry);
    router.replaceProviders(loadProviders(Bun.env));
    return { ok: true, providers: router.status() };
  } catch {
    return { ok: false, code: "provider_storage", message: "Could not save the endpoint on the daemon." };
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

/** The host of the endpoint, as a name to show in the list. */
function defaultCustomLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "Custom endpoint";
  }
}

/** The next free env variable name for a custom endpoint's key. */
function nextCustomEnvKey(existing: CustomProviderEntry[]): string {
  const used = new Set(existing.map((entry) => entry.envKey));
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `AGNI_CUSTOM_KEY_${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `AGNI_CUSTOM_KEY_${Date.now()}`;
}


export async function setProviderModel(router: Router, providerID: string, rawModel: string): Promise<AddProviderResult> {
  if (!router.status().some((provider) => provider.id === providerID)) {
    return { ok: false, code: "provider_exists", message: "Add this provider before changing its model." };
  }
  let model: string;
  try { model = validateModel(rawModel); } catch (error) {
    return { ok: false, code: "invalid_key", message: error instanceof Error ? error.message : "Enter a valid model ID." };
  }
  try {
    await saveProviderModel(providerID, model);
    router.replaceProviders(loadProviders(Bun.env));
    return { ok: true, providers: router.status() };
  } catch {
    return { ok: false, code: "provider_storage", message: "Could not save the model setting on the daemon." };
  }
}

/** Read the .env file, or an empty one when it does not exist yet. */
async function readEnvContents(envPath: string): Promise<string> {
  try {
    return await readFile(envPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

/** The .env contents with these keys set, added or replaced. */
async function writeEnvValues(envPath: string, values: Record<string, string>): Promise<string> {
  return updateEnv(await readEnvContents(envPath), values);
}

/** Write the .env file atomically, mode 600, so a key is never half-written. */
async function writeEnvFile(envPath: string, temporaryPath: string, contents: string): Promise<void> {
  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, envPath);
  await chmod(envPath, 0o600);
}

async function saveProviderModel(providerID: string, model: string): Promise<void> {
  const path = providerConfigPath();
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  let models: Record<string, string> = {};
  let custom: CustomProviderEntry[] = [];
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; models?: unknown; custom?: unknown };
    if (value.version === 1 && value.models && typeof value.models === "object" && !Array.isArray(value.models)) {
      models = Object.fromEntries(Object.entries(value.models).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
    if (Array.isArray(value.custom)) {
      custom = value.custom.filter(
        (entry): entry is CustomProviderEntry =>
          !!entry && typeof entry === "object" && typeof (entry as CustomProviderEntry).id === "string",
      );
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("The provider config file is invalid or unreadable.");
    }
  }
  models[providerID] = model;
  await writeProviderConfig(path, temporaryPath, { models, custom });
}

/** Store a custom endpoint next to the chosen models. */
async function saveCustomProvider(entry: CustomProviderEntry): Promise<void> {
  const path = providerConfigPath();
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  let models: Record<string, string> = {};
  let custom: CustomProviderEntry[] = [];
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; models?: unknown; custom?: unknown };
    if (value.version === 1 && value.models && typeof value.models === "object" && !Array.isArray(value.models)) {
      models = Object.fromEntries(Object.entries(value.models).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
    if (Array.isArray(value.custom)) {
      custom = value.custom.filter(
        (item): item is CustomProviderEntry =>
          !!item && typeof item === "object" && typeof (item as CustomProviderEntry).id === "string",
      );
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("The provider config file is invalid or unreadable.");
    }
  }
  const existing = custom.findIndex((item) => item.id === entry.id);
  if (existing >= 0) custom[existing] = entry;
  else custom.push(entry);
  await writeProviderConfig(path, temporaryPath, { models, custom });
}

async function writeProviderConfig(
  path: string,
  temporaryPath: string,
  value: { models: Record<string, string>; custom: CustomProviderEntry[] },
): Promise<void> {
  const body = `${JSON.stringify({ version: 1, models: value.models, custom: value.custom }, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function validateModel(raw: string): string {
  const model = raw.trim();
  if (!model || model.length > 200 || /[\u0000\r\n]/.test(model)) throw new Error("Enter a model ID up to 200 characters.");
  return model;
}

function updateEnv(contents: string, values: Record<string, string>): string {
  let next = contents;
  for (const [key, value] of Object.entries(values)) {
    const assignment = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, "m");
    next = pattern.test(next) ? next.replace(pattern, assignment) : `${next}${next.length > 0 && !next.endsWith("\n") ? "\n" : ""}${assignment}\n`;
  }
  return next;
}
