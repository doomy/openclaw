import { beforeEach, expect, it, vi } from "vitest";
import type { OAuthLoginCallbacks } from "./types.js";

type LoginOpenAICodexOAuth =
  typeof import("../../../plugins/provider-openai-chatgpt-oauth.js").loginOpenAICodexOAuth;

const { loginOAuth, loadFacade, refreshFacade, refreshRuntime } = vi.hoisted(() => ({
  loginOAuth: vi.fn<LoginOpenAICodexOAuth>(),
  loadFacade: vi.fn(),
  refreshFacade: vi.fn(),
  refreshRuntime: vi.fn(),
}));

vi.mock("../../../plugins/provider-openai-chatgpt-oauth.js", () => ({
  loginOpenAICodexOAuth: loginOAuth,
}));
vi.mock("../../../plugins/provider-runtime.runtime.js", () => ({
  refreshProviderOAuthCredentialWithPlugin: refreshRuntime,
}));
vi.mock("../../../plugin-sdk/facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync: loadFacade,
}));

import { openaiCodexOAuthProvider } from "./openai-chatgpt.js";

async function login(callbacks: Partial<OAuthLoginCallbacks> = {}) {
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
  await expect(login({ ...callbacks, signal: controller.signal })).rejects.toThrow(
    "Login cancelled",
  );
}

const expired = { access: "expired-access-token", refresh: "old-refresh-token", expires: 0 };
const refresh = () => openaiCodexOAuthProvider.refreshToken(expired);

const tokens = {
  access: "access-token",
  refresh: "refresh-token",
  expires: 1_700_000_000_000,
  accountId: "acct_123",
};
const createCredential = () => ({ type: "oauth" as const, provider: "openai", ...tokens });

beforeEach(() => {
  vi.clearAllMocks();
  loadFacade.mockReturnValue({ refreshOpenAICodexToken: refreshFacade });
});

it("waits for the auth URL to render before requesting manual input", async () => {
  let finishAuth!: () => void;
  const authRendered = new Promise<void>((resolve) => {
    finishAuth = resolve;
  });
  const onAuth = vi.fn(async () => authRendered);
  const onPrompt = vi.fn(async () => "manual-code");
  loginOAuth.mockImplementationOnce(async (params) => {
    await params.openUrl("https://auth.openai.com/oauth/authorize?state=abc");
    await params.prompter.text({ message: "Paste code" });
    return createCredential();
  });

  const pendingLogin = login({ onAuth, onPrompt });
  await vi.waitFor(() => expect(onAuth).toHaveBeenCalledOnce());
  expect(onPrompt).not.toHaveBeenCalled();

  finishAuth();
  await expect(pendingLogin).resolves.toEqual(createCredential());
  expect(onPrompt).toHaveBeenCalledOnce();
});

it("passes legacy manual input through so it starts alongside browser auth", async () => {
  const onManualCodeInput = vi.fn(async () => "manual-code");
  loginOAuth.mockImplementationOnce(async (params) => {
    await expect(params.onManualCodeInput?.()).resolves.toBe("manual-code");
    await expect(params.prompter.text({ message: "Fallback code" })).resolves.toBe("fallback-code");
    return createCredential();
  });

  await expect(
    login({
      onPrompt: vi.fn(async () => "fallback-code"),
      onManualCodeInput,
    }),
  ).resolves.toEqual(createCredential());

  expect(onManualCodeInput).toHaveBeenCalledOnce();
});

it.each(["before login", "before auth callback", "after credentials"] as const)(
  "rejects cancellation %s without invoking auth",
  async (stage) => {
    const controller = new AbortController();
    const onAuth = vi.fn();
    if (stage === "before login") {
      controller.abort();
    } else {
      loginOAuth.mockImplementationOnce(async (params) => {
        if (stage === "before auth callback") {
          controller.abort();
          await params.openUrl("https://auth.openai.com/oauth/authorize?state=abc");
        } else {
          queueMicrotask(() => controller.abort());
        }
        return createCredential();
      });
    }
    await expectCancelled(controller, { onAuth });
    expect(onAuth).not.toHaveBeenCalled();
    if (stage === "before login") {
      expect(loginOAuth).not.toHaveBeenCalled();
    }
  },
);

it("passes legacy cancellation into the provider auth hook", async () => {
  const controller = new AbortController();
  loginOAuth.mockImplementationOnce(async (params) => {
    expect(params.signal).toBe(controller.signal);
    controller.abort();
    await expect(params.onManualCodeInput?.()).rejects.toThrow("Login cancelled");
    return createCredential();
  });

  await expectCancelled(controller, { onManualCodeInput: vi.fn(async () => "manual-code") });
});

it("refreshes through the provider runtime hook without returning auth-profile fields", async () => {
  refreshRuntime.mockResolvedValueOnce(createCredential());

  await expect(refresh()).resolves.toEqual(tokens);

  expect(refreshRuntime).toHaveBeenCalledWith({
    provider: "openai",
    context: {
      ...expired,
      type: "oauth",
      provider: "openai",
      access: "",
    },
  });
  expect(loadFacade).not.toHaveBeenCalled();
});

it("falls back to the OpenAI plugin facade when provider runtime refresh is unavailable", async () => {
  refreshRuntime.mockResolvedValueOnce(null);
  refreshFacade.mockResolvedValueOnce(tokens);

  await expect(refresh()).resolves.toEqual(tokens);

  expect(loadFacade).toHaveBeenCalledWith({ dirName: "openai", artifactBasename: "api.js" });
  expect(refreshFacade).toHaveBeenCalledWith("old-refresh-token");
});

it("preserves activated-facade failures when refresh fallback is disabled", async () => {
  refreshRuntime.mockResolvedValueOnce(null);
  loadFacade.mockImplementationOnce(() => {
    throw new Error("plugin runtime is not activated");
  });

  await expect(refresh()).rejects.toThrow("plugin runtime is not activated");
  expect(refreshFacade).not.toHaveBeenCalled();
});
