import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationResolution,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { getImageModels } from "./model-catalog.js";
import { OPENROUTER_BASE_URL, resolveConfiguredBaseUrl } from "./openrouter-config.js";

const DEFAULT_OPENROUTER_IMAGE_MODEL = "google/gemini-2.5-flash-image";
const OPENROUTER_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
] as const;
const OPENROUTER_IMAGE_RESOLUTIONS: readonly ImageGenerationResolution[] = ["1K", "2K", "4K"];

type OpenRouterImageMessage = {
  role: string;
  content?: string;
  images?: Array<{
    type?: string;
    image_url?: {
      url?: string;
    };
  }>;
};

type OpenRouterImageApiResponse = {
  choices?: Array<{
    message?: OpenRouterImageMessage;
  }>;
};

function extractBase64FromDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/u.exec(dataUrl);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    buffer: Buffer.from(match[2], "base64"),
    mimeType: match[1],
  };
}

function resolveFileExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/png":
      return "png";
    default: {
      // Derive extension from MIME subtype for unknown formats (e.g. image/avif -> avif).
      const subtype = mimeType.split("/")[1]?.split(";")[0]?.trim();
      if (subtype && /^[a-z0-9+-]+$/u.test(subtype)) return subtype;
      return "png";
    }
  }
}

export function buildOpenrouterImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_OPENROUTER_IMAGE_MODEL,
    get models() {
      return getImageModels();
    },
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "openrouter",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: false,
      },
      geometry: {
        aspectRatios: [...OPENROUTER_IMAGE_ASPECT_RATIOS],
        resolutions: [...OPENROUTER_IMAGE_RESOLUTIONS],
      },
    },
    async generateImage(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("OpenRouter image generation does not support image editing");
      }

      const auth = await resolveApiKeyForProvider({
        provider: "openrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveConfiguredBaseUrl(req.cfg),
          defaultBaseUrl: OPENROUTER_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: "openrouter",
          capability: "image",
          transport: "http",
        });

      const model = normalizeOptionalString(req.model) ?? DEFAULT_OPENROUTER_IMAGE_MODEL;
      const aspectRatio = normalizeOptionalString(req.aspectRatio);
      const resolution = normalizeOptionalString(req.resolution);

      const imageConfig: Record<string, string> = {};
      if (aspectRatio) {
        imageConfig.aspect_ratio = aspectRatio;
      }
      if (resolution) {
        imageConfig.image_size = resolution;
      }

      const jsonHeaders = new Headers(headers);
      jsonHeaders.set("Content-Type", "application/json");
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/chat/completions`,
        headers: jsonHeaders,
        body: {
          model,
          messages: [{ role: "user", content: req.prompt }],
          modalities: ["image"],
          ...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
        },
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "OpenRouter image generation failed");
        const data = (await response.json()) as OpenRouterImageApiResponse;
        const rawImages = data.choices?.[0]?.message?.images ?? [];

        const images: GeneratedImageAsset[] = rawImages
          .map((entry, index) => {
            const url = normalizeOptionalString(entry.image_url?.url);
            if (!url) {
              return null;
            }
            const parsed = extractBase64FromDataUrl(url);
            if (!parsed) {
              return null;
            }
            const mimeType = parsed.mimeType.toLowerCase();
            if (!mimeType.startsWith("image/")) {
              return null;
            }
            return {
              buffer: parsed.buffer,
              mimeType,
              fileName: `image-${index + 1}.${resolveFileExtension(mimeType)}`,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        if (images.length === 0) {
          throw new Error("OpenRouter image generation response missing image data");
        }

        return {
          images,
          model,
        };
      } finally {
        await release();
      }
    },
  };
}
