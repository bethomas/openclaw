import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  fetchWithTimeout,
  pollProviderOperationJson,
  postJsonRequest,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResolution,
} from "openclaw/plugin-sdk/video-generation";
import { normalizeOpenRouterBaseUrl, OPENROUTER_BASE_URL } from "./provider-catalog.js";

const DEFAULT_OPENROUTER_VIDEO_MODEL = "google/veo-3.1";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const OPENROUTER_VIDEO_MODELS = [
  DEFAULT_OPENROUTER_VIDEO_MODEL,
  "google/veo-3.1-fast",
  "bytedance/seedance-2.0/text-to-video",
  "bytedance/seedance-2.0/image-to-video",
] as const;
const OPENROUTER_VIDEO_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
const OPENROUTER_VIDEO_RESOLUTIONS: readonly VideoGenerationResolution[] = [
  "480P",
  "720P",
  "1080P",
];

type OpenRouterVideoStatus = "pending" | "in_progress" | "completed" | "failed";

type OpenRouterVideoSubmitResponse = {
  id?: string;
  polling_url?: string;
  status?: OpenRouterVideoStatus;
};

type OpenRouterVideoPollResponse = {
  id?: string;
  generation_id?: string;
  polling_url?: string;
  status?: OpenRouterVideoStatus;
  unsigned_urls?: string[];
  error?: {
    code?: string;
    message?: string;
  } | null;
};

function isSameOrigin(baseUrl: string, candidateUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === new URL(candidateUrl).origin;
  } catch {
    return false;
  }
}

function toBase64DataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function buildInputReferences(req: VideoGenerationRequest) {
  const images = req.inputImages ?? [];
  if (images.length === 0) {
    return undefined;
  }
  if (images.length > 1) {
    throw new Error("OpenRouter video generation supports at most one reference image.");
  }
  const [image] = images;
  if (!image?.buffer) {
    throw new Error(
      "OpenRouter video generation currently requires local image uploads for reference assets.",
    );
  }
  const mimeType = normalizeOptionalString(image.mimeType) ?? "image/png";
  return [
    {
      type: "image_url",
      image_url: toBase64DataUrl(image.buffer, mimeType),
    },
  ];
}

async function pollOpenRouterVideo(params: {
  pollingUrl: string;
  videoId: string;
  headers: Headers;
  timeoutMs?: number;
  fetchFn: typeof fetch;
}): Promise<OpenRouterVideoPollResponse> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.timeoutMs,
    label: `OpenRouter video generation task ${params.videoId}`,
  });
  return await pollProviderOperationJson<OpenRouterVideoPollResponse>({
    url: params.pollingUrl,
    headers: params.headers,
    deadline,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    fetchFn: params.fetchFn,
    maxAttempts: MAX_POLL_ATTEMPTS,
    pollIntervalMs: POLL_INTERVAL_MS,
    requestFailedMessage: "OpenRouter video status request failed",
    timeoutMessage: `OpenRouter video generation task ${params.videoId} did not finish in time`,
    isComplete: (payload) => payload.status === "completed",
    getFailureMessage: (payload) =>
      payload.status === "failed"
        ? normalizeOptionalString(payload.error?.message) || "OpenRouter video generation failed"
        : undefined,
  });
}

async function downloadOpenRouterVideo(params: {
  videoId: string;
  baseUrl: string;
  headers: Headers;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  unsignedUrl?: string;
}): Promise<GeneratedVideoAsset> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const trustedUnsignedUrl = params.unsignedUrl;
  const response = trustedUnsignedUrl
    ? await fetchWithTimeout(
        trustedUnsignedUrl,
        { method: "GET" },
        timeoutMs,
        params.fetchFn,
      )
    : await fetchWithTimeout(
        `${params.baseUrl}/videos/${params.videoId}/content?index=0`,
        { method: "GET", headers: params.headers },
        timeoutMs,
        params.fetchFn,
      );
  await assertOkOrThrowHttpError(response, "OpenRouter video download failed");
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
  };
}

export function buildOpenRouterVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_OPENROUTER_VIDEO_MODEL,
    models: [...OPENROUTER_VIDEO_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "openrouter",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: false,
        aspectRatios: OPENROUTER_VIDEO_ASPECT_RATIOS,
        resolutions: OPENROUTER_VIDEO_RESOLUTIONS,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
        supportsWatermark: false,
        aspectRatios: OPENROUTER_VIDEO_ASPECT_RATIOS,
        resolutions: OPENROUTER_VIDEO_RESOLUTIONS,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "openrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "OpenRouter video generation",
      });
      const configuredBaseUrl = normalizeOpenRouterBaseUrl(
        normalizeOptionalString(req.cfg?.models?.providers?.openrouter?.baseUrl),
      );
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: configuredBaseUrl,
          defaultBaseUrl: OPENROUTER_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://openclaw.ai",
            "X-OpenRouter-Title": "OpenClaw",
          },
          provider: "openrouter",
          capability: "video",
          transport: "http",
        });

      const model = normalizeOptionalString(req.model) ?? DEFAULT_OPENROUTER_VIDEO_MODEL;
      const aspectRatio = normalizeOptionalString(req.aspectRatio);
      const resolution = normalizeOptionalString(req.resolution);
      const inputReferences = buildInputReferences(req);

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/videos`,
        headers,
        body: {
          model,
          prompt: req.prompt,
          ...(req.durationSeconds == null ? {} : { duration: req.durationSeconds }),
          ...(resolution == null ? {} : { resolution: resolution.toLowerCase() }),
          ...(aspectRatio == null ? {} : { aspect_ratio: aspectRatio }),
          ...(req.audio == null ? {} : { generate_audio: req.audio }),
          ...(inputReferences == null ? {} : { input_references: inputReferences }),
        },
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      let videoId: string;
      let pollingUrl: string;
      try {
        await assertOkOrThrowHttpError(response, "OpenRouter video generation failed");
        const submitted = (await response.json()) as OpenRouterVideoSubmitResponse;
        videoId = normalizeOptionalString(submitted.id) ?? "";
        if (!videoId) {
          throw new Error("OpenRouter video generation response missing video id");
        }
        const candidatePollingUrl = normalizeOptionalString(submitted.polling_url);
        pollingUrl =
          candidatePollingUrl && isSameOrigin(baseUrl, candidatePollingUrl)
            ? candidatePollingUrl
            : `${baseUrl}/videos/${videoId}`;
      } finally {
        await release();
      }

      const completed = await pollOpenRouterVideo({
        pollingUrl,
        videoId,
        headers,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        fetchFn,
      });

      const unsignedUrl = normalizeOptionalString(completed.unsigned_urls?.[0]);
      const video = await downloadOpenRouterVideo({
        videoId,
        baseUrl,
        headers,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        fetchFn,
        unsignedUrl,
      });

      return {
        videos: [video],
        model,
        metadata: {
          videoId,
          ...(completed.generation_id == null ? {} : { generationId: completed.generation_id }),
          ...(completed.status == null ? {} : { status: completed.status }),
        },
      };
    },
  };
}
