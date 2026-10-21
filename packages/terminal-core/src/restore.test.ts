import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./progress-line.js", () => ({
  clearActiveProgressLine: vi.fn(),
}));

import { restoreTerminalState } from "./restore.js";

function configureTerminalIO(params: {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  setRawMode?: (mode: boolean) => void;
  resume?: () => void;
  isPaused?: () => boolean;
}) {
  Object.defineProperty(process.stdin, "isTTY", { value: params.stdinIsTTY, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: params.stdoutIsTTY, configurable: true });
  (process.stdin as { setRawMode?: (mode: boolean) => void }).setRawMode = params.setRawMode;
  (process.stdin as { resume?: () => void }).resume = params.resume;
  (process.stdin as { isPaused?: () => boolean }).isPaused = params.isPaused;
}

function setupPausedTTYStdin(stdinIsTTY = true, stdoutIsTTY = false) {
  const stdin = { setRawMode: vi.fn(), resume: vi.fn(), isPaused: vi.fn(() => true) };
  configureTerminalIO({ stdinIsTTY, stdoutIsTTY, ...stdin });
  return stdin;
}

describe("restoreTerminalState", () => {
  const original = {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
    setRawMode: process.stdin.setRawMode,
    resume: process.stdin.resume,
    isPaused: process.stdin.isPaused,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    configureTerminalIO(original);
  });

  it("does not resume paused stdin by default", () => {
    const { setRawMode, resume } = setupPausedTTYStdin();

    restoreTerminalState("test");

    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(resume).not.toHaveBeenCalled();
  });

  it("resumes paused stdin when resumeStdin is true", () => {
    const { setRawMode, resume } = setupPausedTTYStdin();

    restoreTerminalState("test", { resumeStdinIfPaused: true });

    expect(setRawMode).toHaveBeenCalledWith(false);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("does not touch stdin when stdin is not a TTY", () => {
    const { setRawMode, resume } = setupPausedTTYStdin(false);

    restoreTerminalState("test", { resumeStdinIfPaused: true });

    expect(setRawMode).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("writes kitty and modifyOtherKeys reset sequences to stdout", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    configureTerminalIO({ stdinIsTTY: false, stdoutIsTTY: true });
    restoreTerminalState("test");

    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("\x1b[<u");
    expect(output).toContain("\x1b[>4;0m");
  });

  it("writes reset sequences only to a custom TTY stream", () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const resetWrite = vi.fn(() => true);
    const resetStream = { isTTY: true, write: resetWrite } as unknown as NodeJS.WriteStream;

    configureTerminalIO({ stdinIsTTY: false, stdoutIsTTY: true });
    restoreTerminalState("test", { resetStream });

    expect(resetWrite).toHaveBeenCalledWith(expect.stringContaining("\x1b[?25h"));
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
