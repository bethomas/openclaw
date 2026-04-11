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

async function fetchModelsFromApi(
  baseUrl: string,
  endpoint: string,
  timeoutMs: number,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as OpenRouterModelsResponse | OpenRouterModel[];
    const models = Array.isArray(data) ? data : (data.data ?? []);
    return models
      .map((m) => normalizeOptionalString(m.id))
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchModelsByOutputModality(
  baseUrl: string,
  modality: string,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as OpenRouterModelsResponse;
    return (data.data ?? [])
      .filter((m) => m.architecture?.output_modalities?.includes(modality))
      .map((m) => normalizeOptionalString(m.id))
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
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
  key: string,
  fetcher: () => Promise<string[]>,
  fallback: readonly string[],
): string[] {
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
    "image",
    () => fetchModelsByOutputModality(baseUrl, "image"),
    IMAGE_FALLBACK,
  );
}

export function getVideoModels(baseUrl: string = OPENROUTER_BASE_URL): string[] {
  return getOrRefresh(
    "video",
    () => fetchModelsFromApi(baseUrl, "/videos/models", FETCH_TIMEOUT_MS),
    VIDEO_FALLBACK,
  );
}

export function getMusicModels(baseUrl: string = OPENROUTER_BASE_URL): string[] {
  // Music models are audio-output models from Google Lyria family.
  return getOrRefresh(
    "music",
    async () => {
      const audioModels = await fetchModelsByOutputModality(baseUrl, "audio");
      return audioModels.filter((id) => id.includes("lyria"));
    },
    MUSIC_FALLBACK,
  );
}

export function getSpeechModels(baseUrl: string = OPENROUTER_BASE_URL): string[] {
  // Speech models are audio-output models excluding music (Lyria).
  return getOrRefresh(
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
  // Fetch /models once and /videos/models once, populate all caches.
  const [audioModels, imageModels, videoModels] = await Promise.all([
    fetchModelsByOutputModality(baseUrl, "audio"),
    fetchModelsByOutputModality(baseUrl, "image"),
    fetchModelsFromApi(baseUrl, "/videos/models", FETCH_TIMEOUT_MS),
  ]);

  const now = Date.now();
  cache.image = { models: imageModels.length > 0 ? imageModels : [...IMAGE_FALLBACK], fetchedAt: now };
  cache.video = { models: videoModels.length > 0 ? videoModels : [...VIDEO_FALLBACK], fetchedAt: now };
  cache.music = {
    models:
      audioModels.filter((id) => id.includes("lyria")).length > 0
        ? audioModels.filter((id) => id.includes("lyria"))
        : [...MUSIC_FALLBACK],
    fetchedAt: now,
  };
  cache.speech = {
    models:
      audioModels.filter((id) => !id.includes("lyria")).length > 0
        ? audioModels.filter((id) => !id.includes("lyria"))
        : [...SPEECH_FALLBACK],
    fetchedAt: now,
  };
}

/** Visible for testing. */
export function _resetCacheForTesting(): void {
  for (const key of Object.keys(cache)) {
    delete cache[key];
  }
}
