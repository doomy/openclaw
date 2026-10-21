import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
  OpenClawPluginServiceV2,
  PluginJsonValue,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin, { DEFAULT_REVIEW_INSTRUCTIONS } from "./index.js";

type AgentEventSubscription = Parameters<OpenClawPluginApi["registerAgentEventSubscription"]>[0];
type EventContext = Parameters<AgentEventSubscription["handle"]>[1];
type Hook = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function setup(pluginConfig: Record<string, unknown>, reply = "NO_CHANGE") {
  const runContexts = new Map<string, PluginJsonValue>();
  let subscription: AgentEventSubscription | undefined;
  let beforeReply: Hook | undefined;
  let service: OpenClawPluginServiceV2 | undefined;
  const forkSession = vi.fn<OpenClawPluginApi["runtime"]["subagent"]["forkSession"]>(async () => ({
    text: reply,
  }));
  const steer = vi.fn<OpenClawPluginApi["session"]["workflow"]["steerActiveRun"]>(async () => ({
    steered: true,
  }));
  const warn = vi.fn();
  const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
  const api = createTestPluginApi({
    id: "advisor",
    pluginConfig,
    logger,
    runtime: createPluginRuntimeMock({
      subagent: { forkSession },
      config: {
        current: () => ({ plugins: { entries: { advisor: { config: pluginConfig } } } }),
      },
    }),
    registerService: (registered) => {
      if (registered.apiVersion === 2) {
        service = registered;
      }
    },
    on: (name, handler) => {
      if (name === "before_agent_reply") {
        beforeReply = handler as Hook;
      }
    },
    registerAgentEventSubscription: (registered) => {
      subscription = registered;
    },
  });
  api.session.workflow.steerActiveRun = steer;
  api.runContext.setRunContext = ({ runId, namespace, value }) => {
    if (value !== undefined) {
      runContexts.set(`${runId}:${namespace}`, value);
    }
    return true;
  };
  plugin.register(api);
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const serviceContext: OpenClawPluginServiceContextV2 = {
    config: {},
    stateDir: "/tmp/advisor-test",
    logger,
    scheduler,
  };
  let calls = 0;
  const emit = (
    stream: "tool" | "lifecycle" | "codex_app_server.item",
    phase: string,
    runId: string,
    data: Record<string, unknown> = {},
  ) =>
    subscription?.handle(
      { runId, seq: 1, ts: Date.now(), stream, data: { phase, ...data } },
      {
        // SAFETY: Mirrors the host owner; run-context reads are caller-typed by namespace.
        getRunContext: ((namespace: string) =>
          runContexts.get(`${runId}:${namespace}`)) as EventContext["getRunContext"],
        setRunContext: () => {},
        clearRunContext: () => {},
      },
    );
  return {
    forkSession,
    steer,
    warn,
    service,
    start: () => service?.start(serviceContext),
    startRun: async (runId = "run-1", trigger = "user") => {
      await beforeReply?.(
        {},
        { sessionKey: "agent:main:main", agentId: "main", runId, trigger, sessionId: "s" },
      );
      await emit("lifecycle", "start", runId);
    },
    tool: async (runId = "run-1") => {
      const toolCallId = `call-${(calls += 1)}`;
      await emit("tool", "start", runId, { toolCallId });
      await emit("tool", "result", runId, { toolCallId });
    },
    emit,
    item: (phase: string, itemId: string, type: string) =>
      emit("codex_app_server.item", phase, "run-1", { itemId, type }),
    endRun: (runId = "run-1", aborted = false) => emit("lifecycle", "end", runId, { aborted }),
    flush: async () => {
      await clock.wake();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
  };
}

async function startAdvisor(everyToolCalls = 1, reply = "NO_CHANGE") {
  const run = setup({ everyToolCalls, everyMinutes: 0 }, reply);
  await run.start();
  await run.startRun();
  return run;
}

describe("advisor", () => {
  it("steers an active run after N tool calls", async () => {
    const run = await startAdvisor(2, "CORRECTION\nStop polling.");
    await run.tool();
    await run.flush();
    expect(run.forkSession).not.toHaveBeenCalled();
    await run.tool();
    await run.flush();
    expect(run.forkSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: expect.stringContaining(DEFAULT_REVIEW_INSTRUCTIONS),
      }),
    );
    expect(run.steer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ displayText: "Stop polling." }),
    );
  });

  it("waits for a running tool's real result before forking, including Codex native tools", async () => {
    const run = await startAdvisor();
    await run.emit("tool", "start", "run-1", { toolCallId: "call-1" });
    await run.flush();
    expect(run.forkSession).not.toHaveBeenCalled();
    await run.emit("tool", "result", "run-1", { toolCallId: "call-1" });
    await run.flush();
    expect(run.forkSession).toHaveBeenCalledOnce();

    // A native Codex tool's early result is not authoritative; its item completion is.
    await run.emit("tool", "start", "run-1", { toolCallId: "item-1", itemId: "item-1" });
    await run.emit("tool", "result", "run-1", { toolCallId: "item-1", itemId: "item-1" });
    await run.flush();
    expect(run.forkSession).toHaveBeenCalledOnce();
    await run.emit("codex_app_server.item", "completed", "run-1", { itemId: "item-1" });
    await run.flush();
    expect(run.forkSession).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["outer", "child", "custom_tool_call", "custom_tool_call_output"],
    ["x", "x", "function_call", "function_call_output"],
  ])("keeps raw %s pending after native %s finishes", async (outer, child, call, output) => {
    const run = await startAdvisor();
    await run.item("started", outer, call);
    await run.emit("tool", "start", "run-1", { toolCallId: child, itemId: child });
    await run.item("completed", child, "commandExecution");
    await run.flush();
    expect(run.forkSession).not.toHaveBeenCalled();
    await run.item("completed", outer, output);
    await run.flush();
    expect(run.forkSession).toHaveBeenCalledOnce();
  });

  it("rechecks running calls when a queued review dispatches", async () => {
    const run = await startAdvisor(2);
    await run.tool();
    await run.tool();
    // A third call starts after the review is queued but before the scheduler runs it.
    await run.emit("tool", "start", "run-1", { toolCallId: "late" });
    await run.flush();
    expect(run.forkSession).not.toHaveBeenCalled();
    await run.emit("tool", "result", "run-1", { toolCallId: "late" });
    await run.flush();
    expect(run.forkSession).toHaveBeenCalledOnce();
  });

  it.each(["Looks fine to me.", "CORRECTION", "NO_CHANGE"])(
    "does not steer on a reply of %j",
    async (reply) => {
      const run = await startAdvisor(1, reply);
      await run.tool();
      await run.flush();
      expect(run.forkSession).toHaveBeenCalledOnce();
      expect(run.steer).not.toHaveBeenCalled();
    },
  );

  it("ignores non-user runs and does not review at run end", async () => {
    const run = setup({ everyToolCalls: 1, everyMinutes: 0 });
    await run.start();
    await run.startRun("run-1", "cron");
    await run.tool("run-1");
    await run.endRun("run-1");
    await run.flush();
    expect(run.forkSession).not.toHaveBeenCalled();
    await run.startRun("run-2");
    await run.endRun("run-2");
    await run.flush();
    expect(run.forkSession).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "cancels an in-flight review when the run ends (aborted=%s)",
    async (aborted) => {
      const run = setup({ everyToolCalls: 1, everyMinutes: 0 }, "CORRECTION\nStop.");
      run.forkSession.mockImplementation(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      await run.start();
      await run.startRun();
      await run.tool();
      const review = run.flush();
      await vi.waitFor(() => expect(run.forkSession).toHaveBeenCalledOnce());
      expect(run.forkSession.mock.calls[0]?.[0].signal?.aborted).toBe(false);
      await run.endRun("run-1", aborted);
      await review;
      expect(run.forkSession.mock.calls[0]?.[0].signal?.aborted).toBe(true);
      expect(run.steer).not.toHaveBeenCalled();
      expect(run.warn).not.toHaveBeenCalled();
    },
  );

  it("registers nothing when both triggers are off", () => {
    const run = setup({ everyToolCalls: 0, everyMinutes: 0 });
    expect(run.service).toBeUndefined();
    expect(run.warn).toHaveBeenCalledOnce();
  });
});
