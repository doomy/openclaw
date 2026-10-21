import { describe, expect, it } from "vitest";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "../scenario-catalog.js";
import * as discordScenarioRuntime from "./discord/scenario-runtime.js";
import * as slackScenarioRuntime from "./slack/scenario-runtime.js";

type ScenarioModuleCall = {
  args?: unknown[];
  call: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readScenarioModuleCall(
  scenario: QaSeedScenarioWithSource,
  channel: string,
): ScenarioModuleCall | undefined {
  if (scenario.execution.kind !== "flow" || !scenario.execution.flow) {
    return undefined;
  }
  const actions = scenario.execution.flow.steps.flatMap((step) => step.actions);
  const modulePath = `./live-transports/${channel}/scenario-runtime.js`;
  const importExpression = `await qaImport(${JSON.stringify(modulePath)})`;
  const importsModule = actions.some(
    (action) =>
      isRecord(action) &&
      action.set === "scenarioModule" &&
      readExpression(action.value) === importExpression,
  );
  if (!importsModule) {
    return undefined;
  }
  const callPrefix = "scenarioModule.";
  const callAction = actions.find(
    (action): action is ScenarioModuleCall =>
      isRecord(action) && typeof action.call === "string" && action.call.startsWith(callPrefix),
  );
  if (!callAction) {
    throw new Error(`scenario module flow has no call: ${scenario.id}`);
  }
  return { ...callAction, call: callAction.call.slice(callPrefix.length) };
}

function readExpression(value: unknown): string | undefined {
  return isRecord(value) && typeof value.expr === "string" ? value.expr : undefined;
}

describe("live transport scenario module routing", () => {
  it.each([
    { channel: "discord", runnerName: "runDiscordScenario", runtime: discordScenarioRuntime },
    { channel: "slack", runnerName: "runSlackScenario", runtime: slackScenarioRuntime },
  ])(
    "routes every $channel flow through one shared channel runner",
    ({ channel, runnerName, runtime }) => {
      expect(Reflect.get(runtime, runnerName)).toBeTypeOf("function");

      for (const scenario of readQaScenarioPack().scenarios) {
        if (scenario.execution.kind !== "flow" || scenario.execution.channel !== channel) {
          continue;
        }
        const call = readScenarioModuleCall(scenario, channel);
        if (!call) {
          continue;
        }
        expect(call.call, scenario.id).toBe(runnerName);
        expect(call.args, scenario.id).toHaveLength(2);
        expect(readExpression(call.args?.[0]), scenario.id).toBe(`${channel}ScenarioContext`);

        const match = readExpression(call.args?.[1])?.match(/^scenarioModule\["(\w+)"\]$/);
        expect(match, scenario.id).toBeTruthy();
        expect(Reflect.get(runtime, match?.[1] ?? ""), scenario.id).toBeTypeOf("object");
      }
    },
  );
});
