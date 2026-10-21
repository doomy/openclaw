import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { ensureClientVoiceAgentSessionEntry } from "../../../talk/client-voice-session-write.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceBridgeCreateRequest,
} from "../../../talk/provider-types.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { controlBridge, controlContext } from "../client-gateway-control.test-support.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createIdleRelayProvider } from "./index.test-support.js";
import { closeRelaySession } from "./operations.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { relaySessions, type RelaySession } from "./state.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), steer: vi.fn() }));
// mock-isolation: isolate relay lifecycle from deterministic consult execution.
vi.mock("../client-agent-consult.js", () => ({
  createTalkClientAgentConsultRunner: () => ({
    runPrompt: Object.assign(mocks.run, {
      adoptCompletionClaims: vi.fn(),
      claimAppend: vi.fn(() => true),
      claimFailureAppend: vi.fn(() => true),
      steer: mocks.steer,
    }),
    getToolAuthorityOverlay: vi.fn(),
  }),
}));

describe("native relay transcript readiness", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let ownedRelay: RelaySession | undefined;
  let request: RealtimeVoiceBridgeCreateRequest;
  let runConsult: RealtimeVoiceAgentConsultRunner;
  let queue: RelaySession["voiceTranscriptQueue"];

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "relay-confirmation", applyEnv: true });
    await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey: "agent:main:main" });
    mocks.run.mockReset().mockResolvedValue({ text: "Read result." });
    mocks.steer.mockReset().mockResolvedValue({ text: "Read result." });
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    const createBridge = vi.fn((_request: RealtimeVoiceBridgeCreateRequest) => controlBridge());
    const session = createTalkRealtimeRelaySession({
      cfg,
      context: controlContext(),
      connId: "relay-confirmation-client",
      sessionTarget: await prepareTalkSessionTarget(cfg, "agent:main:main"),
      controlSource: "delegation",
      provider: createIdleRelayProvider(createBridge),
      providerConfig: {},
      instructions: "Answer briefly.",
      tools: [],
    });
    const relay = relaySessions.get(session.relaySessionId);
    const captured = createBridge.mock.calls[0]?.[0];
    const run = captured?.runAgentConsult;
    if (!relay || !captured || !run) {
      throw new Error("expected a registered native relay");
    }
    ownedRelay = relay;
    request = captured;
    runConsult = run;
    queue = relay.voiceTranscriptQueue;
  });

  afterEach(async () => {
    if (ownedRelay) {
      await closeRelaySession(ownedRelay, "completed");
      ownedRelay = undefined;
    }
    clientVoiceSessionTesting.reset();
    await state.cleanup();
  });

  it("delegates without waiting for a future spoken confirmation", async () => {
    request.onTranscript?.("user", "Create the", false);
    expect(await runConsult({ prompt: "Create the requested note" })).toEqual({
      text: "Read result.",
    });
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("drains already admitted transcript work before delegating", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    queue.enqueue(() => {
      entered.resolve();
      return release.promise;
    });
    await entered.promise;
    const run = runConsult({ prompt: "Continue the request" });
    expect(mocks.run).not.toHaveBeenCalled();
    release.resolve();
    expect(await run).toEqual({ text: "Read result." });
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("cancels a held transcript drain without dispatching", async () => {
    const release = createDeferredCore();
    queue.enqueue(() => release.promise);
    const controller = new AbortController();
    const run = runConsult({ prompt: "Continue", signal: controller.signal });
    const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(mocks.run).not.toHaveBeenCalled();
    release.resolve();
    await queue.flush();
  });
});
