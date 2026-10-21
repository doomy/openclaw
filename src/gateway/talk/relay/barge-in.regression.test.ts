import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRealtimeVoiceProviderCapabilitiesAsync } from "../../../talk/provider-resolver.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { createIdleRelayProvider, makeRelayTransport } from "./index.test-support.js";
import { closeRelaySession } from "./operations.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { relaySessions, type RelaySession } from "./state.js";

const cfg = { agents: { entries: { main: {} } } };

describe("Talk relay barge-in under forced agent consults", () => {
  let state: OpenClawTestState;
  let relay: RelaySession | undefined;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "relay-barge-in", applyEnv: true });
  });

  afterEach(async () => {
    if (relay) {
      await closeRelaySession(relay, "completed");
      relay = undefined;
    }
    await state.cleanup();
  });

  // Regression for #139278: forced consults suppress automatic audio turns, but
  // must not disable interruption. Both flags were derived from the same boolean.
  it.each([
    { forced: true, interrupt: undefined, expectedInterrupt: true },
    { forced: false, interrupt: undefined, expectedInterrupt: true },
    { forced: false, interrupt: false, expectedInterrupt: false },
    { forced: true, interrupt: false, expectedInterrupt: false },
  ])(
    "resolves forced audio routing $forced independently of interruption $interrupt",
    async ({ forced, interrupt, expectedInterrupt }) => {
      const createBridge = vi.fn((_request: RealtimeVoiceBridgeCreateRequest) =>
        makeRelayTransport(),
      );
      const provider = createIdleRelayProvider(createBridge);
      const providerConfig =
        interrupt === undefined ? {} : { interruptResponseOnInputAudio: interrupt };
      const capabilities = await resolveRealtimeVoiceProviderCapabilitiesAsync({
        provider,
        providerConfig,
        cfg,
        surface: "gateway-relay",
      });
      const session = createTalkRealtimeRelaySession({
        context: { broadcastToConnIds: vi.fn() } as never,
        connId: "conn-1",
        cfg,
        provider,
        providerConfig,
        controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
        capabilities,
        instructions: "be brief",
        tools: [],
        sessionTarget: await prepareTalkSessionTarget(cfg, "agent:main:main"),
        forceAgentConsultOnFinalTranscript: forced,
      });
      relay = relaySessions.get(session.relaySessionId);
      expect(createBridge.mock.calls[0][0]).toMatchObject({
        autoRespondToAudio: !forced,
        interruptResponseOnInputAudio: expectedInterrupt,
      });
    },
  );
});
