import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import type * as Video from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();
let provider: Video.VideoGenerationProvider;

beforeAll(async () => {
  const { default: plugin } = await import("./index.js");
  const registered = capturePluginRegistration(plugin).videoGenerationProviders[0];
  if (!registered) {
    throw new Error("Z.AI video generation provider was not registered");
  }
  provider = registered;
});
installProviderHttpMockCleanup();
afterEach(() => vi.useRealTimers());
const prompt = "A blue cube sliding across a studio floor";
const videoUrl = "https://example.com/video.mp4";

function generateVideo(request: Partial<Video.VideoGenerationRequest> = {}) {
  return provider.generateVideo({
    provider: "zai",
    model: "cogvideox-3",
    prompt,
    cfg: {},
    ...request,
  });
}

function mockSubmit() {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockResolvedValueOnce({
    response: Response.json({ id: "task-1", task_status: "PROCESSING" }),
    release,
  });
  return release;
}

function mockSuccess() {
  fetchWithTimeoutMock
    .mockResolvedValueOnce(
      Response.json({ task_status: "SUCCESS", video_result: [{ url: videoUrl }] }),
    )
    .mockResolvedValueOnce(new Response("mp4-bytes", { headers: { "content-type": "video/mp4" } }));
}

function expectSubmission(body: unknown, baseUrl = "https://api.z.ai/api/paas/v4") {
  expect(postJsonRequestMock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      url: `${baseUrl}/videos/generations`,
      headers: expect.any(Headers),
      body,
    }),
  );
}
function expectPoll(call: number, baseUrl: string, options: object) {
  expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
    call,
    `${baseUrl}/async-result/task-1`,
    expect.objectContaining(options),
    expect.any(Number),
    fetch,
  );
}

describe("Z.AI video generation", () => {
  it("submits CogVideoX fields, waits for SUCCESS, and downloads the video", async () => {
    vi.useFakeTimers();
    const release = mockSubmit();
    fetchWithTimeoutMock.mockResolvedValueOnce(Response.json({ task_status: "PROCESSING" }));
    mockSuccess();
    const pending = generateVideo({
      durationSeconds: 10,
      size: "1900x1069",
      audio: true,
      providerOptions: { quality: "quality", fps: 60 },
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expectSubmission({
      model: "cogvideox-3",
      prompt,
      duration: 10,
      size: "1920x1080",
      with_audio: true,
      quality: "quality",
      fps: 60,
    });
    expectPoll(2, "https://api.z.ai/api/paas/v4", { method: "GET" });
    expect(release).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      model: "cogvideox-3",
      videos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
      metadata: { taskId: "task-1", status: "SUCCESS" },
    });
  });

  it.each([
    ["https://open.bigmodel.cn/api/coding/paas/v4/", "https://open.bigmodel.cn/api/paas/v4"],
    ["https://api.z.ai/api/coding/paas/v4", "https://api.z.ai/api/paas/v4"],
    ["https://proxy.example/zai/", "https://proxy.example/zai"],
  ])("reuses %s for regional image-to-video", async (baseUrl, videoBaseUrl) => {
    mockSubmit();
    mockSuccess();
    const remoteImage = baseUrl === "https://proxy.example/zai/";
    const image = remoteImage
      ? { url: "https://example.com/frame.jpg" }
      : { buffer: Buffer.from("png-bytes"), mimeType: "image/png" };
    await generateVideo({
      cfg: { models: { providers: { zai: { baseUrl, models: [] } } } },
      ...(remoteImage ? {} : { durationSeconds: 5, aspectRatio: "9:16" }),
      inputImages: [image],
    });
    expectSubmission(
      expect.objectContaining({
        image_url: remoteImage
          ? "https://example.com/frame.jpg"
          : "data:image/png;base64,cG5nLWJ5dGVz",
        duration: 5,
        size: remoteImage ? "1280x720" : "720x1280",
        with_audio: false,
      }),
      videoBaseUrl,
    );
    expectPoll(1, videoBaseUrl, {
      method: "GET",
      headers: new Headers({
        Authorization: "Bearer provider-key",
        "Content-Type": "application/json",
      }),
    });
  });

  it.each<{ request: Partial<Video.VideoGenerationRequest>; error: string }>`
    request                                                                                          | error
    ${{ inputImages: [{ url: "https://example.com/1.png" }, { url: "https://example.com/2.png" }] }} | ${"at most one input image"}
    ${{ inputVideos: [{ url: "https://example.com/input.mp4" }] }}                                   | ${"does not support video or audio reference"}
    ${{ inputImages: [{ buffer: Buffer.from("gif"), mimeType: "image/gif" }] }}                      | ${"PNG or JPEG"}
    ${{ inputImages: [{ buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimeType: "image/png" }] }}       | ${"no larger than 5 MB"}
    ${{ providerOptions: { fps: 24 } }}                                                              | ${"fps must be 30 or 60"}
    ${{ providerOptions: { quality: "draft" } }}                                                     | ${"quality must be"}
  `("rejects unsupported input before submission: $error", async ({ request, error }) => {
    await expect(generateVideo(request)).rejects.toThrow(error);
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it.each<{ payload: Record<string, unknown>; error: string }>`
    payload                                                               | error
    ${{ task_status: "FAIL", error: { message: "Generation rejected" } }} | ${"Generation rejected"}
    ${{ task_status: "SUCCESS", video_result: [] }}                       | ${"completed without a video URL"}
    ${{}}                                                                 | ${"missing or unknown task_status"}
  `("reports unusable task results: $error", async ({ payload, error }) => {
    mockSubmit();
    fetchWithTimeoutMock.mockResolvedValueOnce(Response.json(payload));
    await expect(generateVideo()).rejects.toThrow(error);
    expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
  });
});
