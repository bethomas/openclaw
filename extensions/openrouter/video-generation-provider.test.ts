import { beforeAll, describe, expect, it, vi } from "vitest";
import { expectExplicitVideoGenerationCapabilities } from "../../test/helpers/media-generation/provider-capability-assertions.js";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "../../test/helpers/media-generation/provider-http-mocks.js";

const { postJsonRequestMock, fetchWithTimeoutMock, resolveProviderHttpRequestConfigMock } =
  getProviderHttpMocks();

let buildOpenRouterVideoGenerationProvider: typeof import("./video-generation-provider.js").buildOpenRouterVideoGenerationProvider;

beforeAll(async () => {
  ({ buildOpenRouterVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

describe("openrouter video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildOpenRouterVideoGenerationProvider());
  });

  it("submits to /videos, polls, and downloads via unsigned CDN url", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "vid_abc",
          polling_url: "https://openrouter.ai/api/v1/videos/vid_abc",
          status: "pending",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_abc",
          generation_id: "gen_abc",
          status: "completed",
          unsigned_urls: ["https://cdn.example.com/vid_abc.mp4"],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenRouterVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "A paper airplane gliding through golden hour light",
      cfg: {},
      durationSeconds: 4,
      aspectRatio: "16:9",
      resolution: "720P",
      audio: true,
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://openrouter.ai/api/v1/videos",
        body: expect.objectContaining({
          model: "google/veo-3.1",
          prompt: "A paper airplane gliding through golden hour light",
          duration: 4,
          aspect_ratio: "16:9",
          resolution: "720p",
          generate_audio: true,
        }),
        allowPrivateNetwork: false,
      }),
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://openrouter.ai/api/v1/videos/vid_abc",
      expect.objectContaining({ method: "GET" }),
      120000,
      fetch,
    );
    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      2,
      "https://cdn.example.com/vid_abc.mp4",
      expect.objectContaining({ method: "GET" }),
      120000,
      fetch,
    );
    const downloadCall = fetchWithTimeoutMock.mock.calls[1];
    expect(downloadCall?.[1]).not.toHaveProperty("headers");
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/mp4");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        videoId: "vid_abc",
        generationId: "gen_abc",
        status: "completed",
      }),
    );
  });

  it("falls back to authed /content endpoint when no unsigned url is returned", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "vid_noauth",
          status: "pending",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_noauth",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenRouterVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "Authed download path",
      cfg: {},
    });

    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      2,
      "https://openrouter.ai/api/v1/videos/vid_noauth/content?index=0",
      expect.objectContaining({ method: "GET", headers: expect.any(Headers) }),
      120000,
      fetch,
    );
  });

  it("rejects off-origin polling_url and falls back to canonical polling endpoint", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({
          id: "vid_ssrf",
          polling_url: "https://attacker.example.com/leak",
          status: "pending",
        }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_ssrf",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenRouterVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "Never follow attacker polling url",
      cfg: {},
    });

    expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
      1,
      "https://openrouter.ai/api/v1/videos/vid_ssrf",
      expect.objectContaining({ method: "GET" }),
      120000,
      fetch,
    );
  });

  it("uses image-to-video data URL reference when one image is provided", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ id: "vid_i2v", status: "pending" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_i2v",
          status: "completed",
          unsigned_urls: ["https://cdn.example.com/vid_i2v.mp4"],
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenRouterVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "Animate this frame",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
    });

    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          input_references: [
            {
              type: "image_url",
              image_url: "data:image/png;base64,cG5nLWJ5dGVz",
            },
          ],
        }),
      }),
    );
  });

  it("rejects multiple reference images", async () => {
    const provider = buildOpenRouterVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "openrouter",
        model: "google/veo-3.1",
        prompt: "Too many references",
        cfg: {},
        inputImages: [
          { buffer: Buffer.from("a"), mimeType: "image/png" },
          { buffer: Buffer.from("b"), mimeType: "image/png" },
        ],
      }),
    ).rejects.toThrow("OpenRouter video generation supports at most one reference image.");
  });

  it("honors configured baseUrl for video requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => ({ id: "vid_local", status: "pending" }),
      },
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({ id: "vid_local", status: "completed" }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenRouterVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openrouter",
      model: "google/veo-3.1",
      prompt: "Render via local relay",
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.ai/v1/",
            },
          },
        },
      },
    });

    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://openrouter.ai/api/v1",
        defaultHeaders: expect.objectContaining({
          "HTTP-Referer": "https://openclaw.ai",
          "X-OpenRouter-Title": "OpenClaw",
          "Content-Type": "application/json",
        }),
        provider: "openrouter",
        capability: "video",
      }),
    );
    expect(postJsonRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://openrouter.ai/api/v1/videos",
      }),
    );
  });
});
