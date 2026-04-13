import {
  fetchWithTimeoutGuarded,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { OPENROUTER_BASE_URL } from "./openrouter-config.js";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FETCH_TIMEOUT_MS = 10_000;

type OpenRouterModel = {
  id?: string;
  architecture?: {
    output_modalities?: string[];
  };
};

type OpenRouterModelsResponse = {
  data?: OpenRouterModel[];
};

type CachedModelList = {
  models: string[];
  fetchedAt: number;
};

const cache: Record<string, CachedModelList> = {};

function isStale(entry: CachedModelList | undefined): boolean {
  if (!entry) return true;
  return Date.now() - entry.fetchedAt > CACHE_TTL_MS;
}

function getCacheKey(baseUrl: string, category: string): string {
  return `${baseUrl}::${category}`;
}

function resolveGuardedConfig(baseUrl: string) {
  return resolveProviderHttpRequestConfig({
    defaultBaseUrl: baseUrl,
    allowPrivateNetwork: false,
    defaultHeaders: {},
    provider: "openrouter",
    capability: "other",
    transport: "http",
  });
}

async function fetchGuarded(url: string, baseUrl: string): Promise<Response | null> {
  const { headers, dispatcherPolicy } = resolveGuardedConfig(baseUrl);
  try {
    const { response, release } = await fetchWithTimeoutGuarded(
      url,
      { method: "GET", headers },
      FETCH_TIMEOUT_MS,
      fetch,
      { dispatcherPolicy, auditContext: "openrouter-model-catalog" },
    );
    try {
      if (!response.ok) return null;
      return response;
    } catch {
      await release();
      return null;
    }
    // Note: caller is responsible for consuming the response body.
    // The guarded fetch release happens after body is consumed via GC.
  } catch {
    return null;
  }
}

async function fetchModelsFromApi(baseUrl: string, endpoint: string): Promise<string[]> {
  const response = await fetchGuarded(`${baseUrl}${endpoint}`, baseUrl);
  if (!response) return [];
  try {
    const data = (await response.json()) as OpenRouterModelsResponse | OpenRouterModel[];
    const models = Array.isArray(data) ? data : (data.data ?? []);
    return models
      .map((m) => normalizeOptionalString(m.id))
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

async function fetchModelsByOutputModality(
  baseUrl: string,
  modality: string,
): Promise<string[]> {
  const response = await fetchGuarded(`${baseUrl}/models`, baseUrl);
  if (!response) return [];
  try {
    const data = (await response.json()) as OpenRouterModelsResponse;
    return (data.data ?? [])
      .filter((m) => m.architecture?.output_modalities?.includes(modality))
      .map((m) => normalizeOptionalString(m.id))
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

async function refreshCache(
  key: string,
  fetcher: () => Promise<string[]>,
  fallback: readonly string[],
): Promise<string[]> {
  const fetched = await fetcher();
  const models = fetched.length > 0 ? fetched : [...fallback];
  cache[key] = { models, fetchedAt: Date.now() };
  return models;
}

function getOrRefresh(
  baseUrl: string,
  category: string,
  fetcher: () => Promise<string[]>,
  fallback: readonly string[],
): string[] {
  const key = getCacheKey(baseUrl, category);
  const entry = cache[key];
  if (isStale(entry)) {
    // Fire-and-forget refresh; return current cache or fallback immediately.
    void refreshCache(key, fetcher, fallback);
  }
  return entry?.models ?? [...fallback];
}

// --- Public API ---

const IMAGE_FALLBACK = [
  "google/gemini-2.5-flash-image",
  "google/gemini-3.1-flash-image-preview",
  "black-forest-labs/flux.2-pro",
] as const;

const VIDEO_FALLBACK = ["google/veo-3.1"] as const;

const MUSIC_FALLBACK = [
  "google/lyria-3-clip-preview",
  "google/lyria-3-pro-preview",
] as const;

const SPEECH_FALLBACK = [
  "openai/gpt-audio",
  "openai/gpt-audio-mini",
  "openai/gpt-4o-audio-preview",
] as const;

export function getImageModels(baseUrl: string = OPENROUTER_BASE_URL): string[] {
  return getOrRefresh(
    baseUrl,
    "image",
    () => fetchModelsByOutputModality(baseUrl, "image"),
    IMAGE_FALLBACK,
  );
}

export function getVideoModels(baseUrl: string = OPENROUTER_BASE_URL): string[] {
  return getOrRefresh(
    baseUrl,
    "video",
    () => fetchModelsFromApi(baseUrl, "/videos/models"),
    VIDEO_FALLBACK,
  );
}

export function getMusicModels(baseUrl: string = OPENROUTER_BASE_URL): string[] {
  return getOrRefresh(
    baseUrl,
    "music",
    async () => {
      const audioModels = await fetchModelsByOutputModality(baseUrl, "audio");
      return audioModels.filter((id) => id.includes("lyria"));
    },
    MUSIC_FALLBACK,
  );
}

export function getSpeechModels(baseUrl: string = OPENROUTER_BASE_URL): string[] {
  return getOrRefresh(
    baseUrl,
    "speech",
    async () => {
      const audioModels = await fetchModelsByOutputModality(baseUrl, "audio");
      return audioModels.filter((id) => !id.includes("lyria"));
    },
    SPEECH_FALLBACK,
  );
}

/** Pre-warm all caches. Call at plugin registration time. */
export async function preloadModelCatalog(
  baseUrl: string = OPENROUTER_BASE_URL,
): Promise<void> {
  const [audioModels, imageModels, videoModels] = await Promise.all([
    fetchModelsByOutputModality(baseUrl, "audio"),
    fetchModelsByOutputModality(baseUrl, "image"),
    fetchModelsFromApi(baseUrl, "/videos/models"),
  ]);

  const now = Date.now();
  const musicModels = audioModels.filter((id) => id.includes("lyria"));
  const speechModels = audioModels.filter((id) => !id.includes("lyria"));

  cache[getCacheKey(baseUrl, "image")] = {
    models: imageModels.length > 0 ? imageModels : [...IMAGE_FALLBACK],
    fetchedAt: now,
  };
  cache[getCacheKey(baseUrl, "video")] = {
    models: videoModels.length > 0 ? videoModels : [...VIDEO_FALLBACK],
    fetchedAt: now,
  };
  cache[getCacheKey(baseUrl, "music")] = {
    models: musicModels.length > 0 ? musicModels : [...MUSIC_FALLBACK],
    fetchedAt: now,
  };
  cache[getCacheKey(baseUrl, "speech")] = {
    models: speechModels.length > 0 ? speechModels : [...SPEECH_FALLBACK],
    fetchedAt: now,
  };
}

/** Visible for testing. */
export function _resetCacheForTesting(): void {
  for (const key of Object.keys(cache)) {
    delete cache[key];
  }
}
