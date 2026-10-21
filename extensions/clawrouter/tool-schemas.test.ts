import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import plugin from "./index.js";

let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
beforeAll(async () => {
  provider = await registerSingleProviderPlugin(plugin);
});

function toolSchema(name: string, parameters: unknown) {
  return [{ name, description: "Test tool", parameters }];
}
const object = (properties: Record<string, unknown>) => ({ type: "object", properties });
const emptyObject = object({});
function normalize(tools: unknown[], modelId = "perplexity/sonar-pro") {
  return provider.normalizeToolSchemas?.(schemaContext(modelId, tools));
}
function schemaContext(modelId: string, tools: unknown[]) {
  return {
    provider: "clawrouter",
    modelId,
    modelApi: "openai-responses",
    model: {
      provider: "clawrouter",
      api: "openai-responses",
      baseUrl: "https://clawrouter.openclaw.ai/v1",
      id: modelId,
    },
    tools,
  } as never;
}

describe("ClawRouter Perplexity tool schemas", () => {
  it("normalizes exec-like object maps", () => {
    const tools = toolSchema("exec", {
      type: "object",
      properties: {
        env: {
          type: "object",
          patternProperties: { "^.*$": { type: "object" } },
          additionalProperties: { type: "object" },
        },
      },
      additionalProperties: false,
    });

    expect(normalize(tools)?.[0]?.parameters).toEqual(object({ env: emptyObject }));
    expect(provider.inspectToolSchemas?.(schemaContext("perplexity/sonar-pro", tools))).toEqual([
      {
        toolName: "exec",
        toolIndex: 0,
        violations: [
          "exec.parameters.properties.env.patternProperties",
          "exec.parameters.properties.env.additionalProperties",
          "exec.parameters.additionalProperties",
          "exec.parameters.properties.env.properties",
        ],
      },
    ]);
  });

  it("normalizes nested unions, arrays, and definitions", () => {
    const tools = toolSchema("nested", {
      type: "object",
      anyOf: [
        { type: "object", additionalProperties: true },
        {
          type: "array",
          items: object({ value: { anyOf: [{ type: "object" }, { type: "string" }] } }),
        },
      ],
      $defs: {
        metadata: { type: "object", patternProperties: { ".*": { type: "string" } } },
      },
    });

    expect(normalize(tools)?.[0]?.parameters).toEqual({
      ...emptyObject,
      anyOf: [
        emptyObject,
        {
          type: "array",
          items: object({ value: { anyOf: [emptyObject, { type: "string" }] } }),
        },
      ],
      $defs: { metadata: emptyObject },
    });
  });

  it("treats union types containing object as object schemas", () => {
    const tools = toolSchema(
      "union",
      object({
        payload: { type: ["object", "null"], additionalProperties: { type: "string" } },
      }),
    );

    expect(normalize(tools)?.[0]?.parameters).toEqual(
      object({ payload: { type: ["object", "null"], properties: {} } }),
    );
    expect(provider.inspectToolSchemas?.(schemaContext("perplexity/sonar-pro", tools))).toEqual([
      {
        toolName: "union",
        toolIndex: 0,
        violations: [
          "union.parameters.properties.payload.additionalProperties",
          "union.parameters.properties.payload.properties",
        ],
      },
    ]);
  });

  it("traverses dependentSchemas and unevaluatedProperties containers", () => {
    const tools = toolSchema("containers", {
      type: "object",
      properties: {},
      dependentSchemas: {
        x: { type: "object", additionalProperties: false },
      },
      unevaluatedProperties: { type: "object" },
      additionalItems: { type: "object", additionalProperties: false },
    });

    expect(normalize(tools)?.[0]?.parameters).toEqual({
      ...emptyObject,
      dependentSchemas: { x: emptyObject },
      unevaluatedProperties: emptyObject,
      additionalItems: emptyObject,
    });
  });

  it("routes only Perplexity models through the plugin-local normalizer", () => {
    const tools = toolSchema("exec", {
      type: "object",
      patternProperties: { ".*": { type: "string" } },
    });

    expect(normalize(tools, "PeRpLeXiTy/sonar-pro")?.[0]?.parameters).toEqual(emptyObject);
    expect(normalize(tools, "openai/gpt-5.5")).toBe(tools);
  });
});
