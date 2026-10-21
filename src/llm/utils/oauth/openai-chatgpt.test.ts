import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthLoginCallbacks } from "./types.js";

type LoginOpenAICodexOAuth =
  typeof import("../../../plugins/provider-openai-chatgpt-oauth.js").loginOpenAICodexOAuth;

const {
  loginOpenAICodexOAuth,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
  refreshOpenAICodexToken,
  refreshProviderOAuthCredentialWithPlugin,
} = vi.hoisted(() => ({
  loginOpenAICodexOAuth: vi.fn<LoginOpenAICodexOAuth>(),
  loadActivatedBundledPluginPublicSurfaceModuleSync: vi.fn(),
  refreshOpenAICodexToken: vi.fn(),
  refreshProviderOAuthCredentialWithPlugin: vi.fn(),
}));

vi.mock("../../../plugins/provider-openai-chatgpt-oauth.js", () => ({
  loginOpenAICodexOAuth,
}));

vi.mock("../../../plugins/provider-runtime.runtime.js", () => ({
  refreshProviderOAuthCredentialWithPlugin,
}));

vi.mock("../../../plugin-sdk/facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync,
}));

import { openaiCodexOAuthProvider } from "./openai-chatgpt.js";

async function loginThroughOpenAIProvider(callbacks: Partial<OAuthLoginCallbacks> = {}) {
  return await openaiCodexOAuthProvider.login({
    onAuth: vi.fn(),
    onPrompt: vi.fn(async () => "manual-code"),
    ...callbacks,
  });
}

async function expectCancelled(
  controller: AbortController,
  callbacks: Partial<OAuthLoginCallbacks> = {},
) {
  await expect(
    loginThroughOpenAIProvider({ ...callbacks, signal: controller.signal }),
  ).rejects.toThrow("Login cancelled");
}

async function refreshThroughOpenAIProvider(refreshToken: string) {
  return await openaiCodexOAuthProvider.refreshToken({
    access: "expired-access-token",
    refresh: refreshToken,
    expires: 0,
  });
}

const tokens = {
  access: "access-token",
  refresh: "refresh-token",
  expires: 1_700_000_000_000,
  accountId: "acct_123",
};
const createCredential = () => ({ type: "oauth" as const, provider: "openai", ...tokens });

describe("OpenAI Codex OAuth compatibility provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue({ refreshOpenAICodexToken });
  });

  it("waits for the auth URL to render before requesting manual input", async () => {
    let finishAuth!: () => void;
    const authRendered = new Promise<void>((resolve) => {
      finishAuth = resolve;
    });
    const onAuth = vi.fn(async () => authRendered);
    const onPrompt = vi.fn(async () => "manual-code");
    loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      await params.openUrl("https://auth.openai.com/oauth/authorize?state=abc");
      await params.prompter.text({ message: "Paste code" });
      return createCredential();
    });

    const login = loginThroughOpenAIProvider({ onAuth, onPrompt });
    await vi.waitFor(() => expect(onAuth).toHaveBeenCalledOnce());
    expect(onPrompt).not.toHaveBeenCalled();

    finishAuth();
    await expect(login).resolves.toEqual(createCredential());
    expect(onPrompt).toHaveBeenCalledOnce();
  });

  it("passes legacy manual input through so it starts alongside browser auth", async () => {
    const onManualCodeInput = vi.fn(async () => "manual-code");
    loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      await expect(params.onManualCodeInput?.()).resolves.toBe("manual-code");
      await expect(params.prompter.text({ message: "Fallback code" })).resolves.toBe(
        "fallback-code",
      );
      return createCredential();
    });

    await expect(
      loginThroughOpenAIProvider({
        onPrompt: vi.fn(async () => "fallback-code"),
        onManualCodeInput,
      }),
    ).resolves.toEqual(createCredential());

    expect(onManualCodeInput).toHaveBeenCalledOnce();
  });

  it("honors legacy login cancellation before opening OAuth", async () => {
    const controller = new AbortController();
    controller.abort();

    await expectCancelled(controller);
    expect(loginOpenAICodexOAuth).not.toHaveBeenCalled();
  });

  it("passes legacy cancellation into the provider auth hook", async () => {
    const controller = new AbortController();
    loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      expect(params.signal).toBe(controller.signal);
      controller.abort();
      await expect(params.onManualCodeInput?.()).rejects.toThrow("Login cancelled");
      return createCredential();
    });

    await expectCancelled(controller, { onManualCodeInput: vi.fn(async () => "manual-code") });
  });

  it("does not return completed credentials after login cancellation", async () => {
    const controller = new AbortController();
    loginOpenAICodexOAuth.mockImplementationOnce(() => {
      queueMicrotask(() => controller.abort());
      return Promise.resolve(createCredential());
    });

    await expectCancelled(controller);
  });

  it("honors legacy login cancellation before invoking the auth callback", async () => {
    const controller = new AbortController();
    const onAuth = vi.fn();
    loginOpenAICodexOAuth.mockImplementationOnce(async (params) => {
      controller.abort();
      await params.openUrl("https://auth.openai.com/oauth/authorize?state=abc");
      return createCredential();
    });

    await expectCancelled(controller, { onAuth });
    expect(onAuth).not.toHaveBeenCalled();
  });

  it("refreshes through the provider runtime hook without returning auth-profile fields", async () => {
    refreshProviderOAuthCredentialWithPlugin.mockResolvedValueOnce(createCredential());

    await expect(refreshThroughOpenAIProvider("old-refresh-token")).resolves.toEqual(tokens);

    expect(refreshProviderOAuthCredentialWithPlugin).toHaveBeenCalledWith({
      provider: "openai",
      context: {
        type: "oauth",
        provider: "openai",
        access: "",
        refresh: "old-refresh-token",
        expires: 0,
      },
    });
    expect(loadActivatedBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("falls back to the OpenAI plugin facade when provider runtime refresh is unavailable", async () => {
    const credential = {
      access: "facade-access-token",
      refresh: "facade-refresh-token",
      expires: 1_700_000_000_000,
      accountId: "acct_facade",
    };
    refreshProviderOAuthCredentialWithPlugin.mockResolvedValueOnce(null);
    refreshOpenAICodexToken.mockResolvedValueOnce(credential);

    await expect(refreshThroughOpenAIProvider("old-refresh-token")).resolves.toEqual(credential);

    expect(loadActivatedBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "openai",
      artifactBasename: "api.js",
    });
    expect(refreshOpenAICodexToken).toHaveBeenCalledWith("old-refresh-token");
  });

  it("preserves activated-facade failures when refresh fallback is disabled", async () => {
    refreshProviderOAuthCredentialWithPlugin.mockResolvedValueOnce(null);
    loadActivatedBundledPluginPublicSurfaceModuleSync.mockImplementationOnce(() => {
      throw new Error("plugin runtime is not activated");
    });

    await expect(refreshThroughOpenAIProvider("old-refresh-token")).rejects.toThrow(
      "plugin runtime is not activated",
    );
    expect(refreshOpenAICodexToken).not.toHaveBeenCalled();
  });
});
