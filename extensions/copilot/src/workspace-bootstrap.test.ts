import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHarnessAttemptParamsV2 as AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { loadCopilotWorkspaceInstructions } from "./workspace-bootstrap.js";

function makeAttempt(workspaceDir: string | undefined): AgentHarnessAttemptParams {
  return {
    agentId: "agent-1",
    hostCapabilities: createCopilotTestHostCapabilities(),
    prompt: "hello",
    runId: "run-1",
    sessionFile: "session.json",
    sessionId: "session-1",
    timeoutMs: 5000,
    workspaceDir,
  } as unknown as AgentHarnessAttemptParams;
}

describe("loadCopilotWorkspaceInstructions", () => {
  let workspaceDir: string;

  const write = (name: string, content: string) =>
    writeFile(path.join(workspaceDir, name), content);
  const load = (source: string | undefined, effectiveWorkspaceDir = source) =>
    loadCopilotWorkspaceInstructions({ attempt: makeAttempt(source), effectiveWorkspaceDir });

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "copilot-bootstrap-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { force: true, recursive: true });
  });

  it("returns undefined instructions when workspaceDir is missing", async () => {
    await expect(load(undefined)).resolves.toBeUndefined();
  });

  it("orders persona context and renders the SOUL hint through the workspace boundary", async () => {
    await write("USER.md", "USER body");
    await write("SOUL.md", "SOUL body");
    const instructions = (await load(workspaceDir)) ?? "";
    expect(instructions).toContain("SOUL.md: persona/tone");
    expect(instructions.indexOf("SOUL body")).toBeLessThan(instructions.indexOf("USER body"));
    expect(instructions).toContain(`## ${path.join(workspaceDir, "SOUL.md")}`);
    expect(instructions).toContain(`## ${path.join(workspaceDir, "USER.md")}`);
  });

  it("filters AGENTS.md out of the rendered block (SDK loads it natively)", async () => {
    await write("AGENTS.md", "Follow AGENTS guidance.");
    await write("SOUL.md", "Soul voice goes here.");
    const result = await load(workspaceDir);
    expect(result).toContain("Soul voice goes here.");
    expect(result).not.toContain("Follow AGENTS guidance.");
    expect(result).toContain("Copilot SDK loads AGENTS.md natively");
  });

  it("includes [MISSING] placeholders for files that don't exist (parity with PI/codex)", async () => {
    await write("AGENTS.md", "Follow AGENTS guidance.");
    const result = await load(workspaceDir);
    expect(result).toBeDefined();
    expect(result).toContain("[MISSING] Expected at:");
    expect(result).toContain("SOUL.md");
    expect(result).not.toContain("Follow AGENTS guidance.");
  });

  it("rewrites rendered context paths from host workspace to sandbox workspace when effective differs", async () => {
    const sandboxDir = path.join(tmpdir(), "copilot-rendered-sandbox");
    await write("SOUL.md", "Soul voice from host.");
    const result = await load(workspaceDir, sandboxDir);
    expect(result).toBeDefined();
    expect(result).toContain("Soul voice from host.");
    expect(result).toContain(`## ${path.join(sandboxDir, "SOUL.md")}`);
    // Missing-file bodies retain the canonical source path; only rendered headers remap.
    const headerLines = (result ?? "").split("\n").filter((line) => line.startsWith("## "));
    expect(headerLines.length).toBeGreaterThan(0);
    for (const line of headerLines) {
      expect(line).not.toContain(workspaceDir);
    }
  });
});
