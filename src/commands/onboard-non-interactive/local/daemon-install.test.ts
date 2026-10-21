import { beforeEach, describe, expect, it, vi } from "vitest";
import { installGatewayDaemonNonInteractive } from "./daemon-install.js";

const readDaemonRuntimePinForInstall = vi.hoisted(() =>
  vi.fn<typeof import("../../../daemon/runtime-pin-state.js").readDaemonRuntimePinForInstall>(),
);
// mock-isolation: Service-planning fixtures replace pin admission without opening stores or native locks.
vi.mock("../../../daemon/runtime-pin-state.js", () => ({
  readDaemonRuntimePinForInstall,
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, read: () => T): Promise<T> =>
    read(),
}));

const buildGatewayInstallPlan = vi.hoisted(() => vi.fn());
const gatewayInstallErrorHint = vi.hoisted(() => vi.fn(() => "hint"));
const resolveGatewayInstallToken = vi.hoisted(() => vi.fn());
const serviceInstall = vi.hoisted(() => vi.fn(async () => {}));
const serviceReadCommand = vi.hoisted(() => vi.fn());
const ensureSystemdUserLingerNonInteractive = vi.hoisted(() => vi.fn(async () => {}));
const isSystemdUserServiceAvailable = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../daemon-install-helpers.js", () => ({
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
}));

vi.mock("../../gateway-install-token.js", () => ({ resolveGatewayInstallToken }));

vi.mock("../../../daemon/service.js", () => ({
  resolveGatewayService: vi.fn(() => ({
    install: serviceInstall,
    readCommand: serviceReadCommand,
  })),
}));

vi.mock("../../../daemon/systemd.js", () => ({ isSystemdUserServiceAvailable }));
vi.mock("../../daemon-runtime.js", () => ({ DEFAULT_GATEWAY_DAEMON_RUNTIME: "node" }));
vi.mock("../../systemd-linger.js", () => ({ ensureSystemdUserLingerNonInteractive }));

describe("installGatewayDaemonNonInteractive", () => {
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const install = (
    overrides: Partial<Parameters<typeof installGatewayDaemonNonInteractive>[0]> = {},
  ) =>
    installGatewayDaemonNonInteractive({
      nextConfig: {},
      opts: { installDaemon: true },
      runtime,
      port: 18789,
      ...overrides,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    readDaemonRuntimePinForInstall.mockReturnValue({ revision: "empty", stored: false });
    serviceReadCommand.mockResolvedValue(null);
    isSystemdUserServiceAvailable.mockResolvedValue(true);
    resolveGatewayInstallToken.mockResolvedValue({ warnings: [] });
    buildGatewayInstallPlan.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "run"],
      workingDirectory: "/tmp",
      environment: {},
    });
  });

  it("preserves stored heap controls without passing plaintext tokens for SecretRef-managed install", async () => {
    const managedDefinition = {
      programArguments: [
        "/usr/bin/node",
        "--max-old-space-size=24576",
        "--require=/tmp/service-preload.js",
        "/usr/local/bin/openclaw",
        "gateway",
      ],
      environment: { NODE_OPTIONS: "--max-heap-size=32768", UNRELATED: "not-persisted" },
    };
    const existingCommand = {
      programArguments: ["/operator/drop-in-wrapper", "gateway"],
      environment: { NODE_OPTIONS: "--max-old-space-size=1024" },
      managedDefinition,
      managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
    };
    serviceReadCommand.mockResolvedValue(existingCommand);

    await install({
      nextConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
          },
        },
      },
    });

    expect(resolveGatewayInstallToken).toHaveBeenCalledTimes(1);
    expect(buildGatewayInstallPlan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ existingCommand }),
    );
    expect(buildGatewayInstallPlan.mock.calls[0]?.[0]).not.toHaveProperty("existingEnvironment");
    expect(buildGatewayInstallPlan.mock.calls[0]?.[0]).not.toHaveProperty("token");
    expect(serviceInstall).toHaveBeenCalledTimes(1);
  });

  it("forwards Bun as the explicit daemon runtime", async () => {
    await install({ opts: { installDaemon: true, daemonRuntime: "bun" } });

    expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "bun" }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("aborts with actionable error when SecretRef is unresolved", async () => {
    resolveGatewayInstallToken.mockResolvedValue({
      unavailableReason: "gateway.auth.token SecretRef is configured but unresolved (boom).",
      warnings: [],
    });
    await install();

    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      "Gateway install blocked: gateway.auth.token SecretRef is configured but unresolved (boom). Fix gateway auth config/token input and rerun setup.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(buildGatewayInstallPlan).not.toHaveBeenCalled();
    expect(serviceInstall).not.toHaveBeenCalled();
  });

  it("returns a skipped result when Linux user systemd is unavailable", async () => {
    const originalPlatform = process.platform;

    isSystemdUserServiceAvailable.mockResolvedValue(false);
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

    try {
      expect(await install()).toEqual({
        installed: false,
        skippedReason: "systemd-user-unavailable",
      });
      expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
        "Systemd user services are unavailable; skipping service install. Use a direct shell run (`openclaw gateway run`) or rerun without --install-daemon on this session.",
      );
      expect(buildGatewayInstallPlan).not.toHaveBeenCalled();
      expect(serviceInstall).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  });
  it.each([undefined, "node", "bun"] as const)(
    "carries installed pin intent through setup (explicit=%s)",
    async (daemonRuntime) => {
      const pin = { runtime: "bun", path: "/opt/pinned/bun" } as const;
      const expected = { revision: "installed-pin", stored: true, pin };
      const existingCommand = {
        programArguments: [pin.path, "/app/openclaw.mjs", "gateway"],
        environment: { OPENCLAW_WRAPPER: "/opt/wrapper" },
      };
      serviceReadCommand.mockResolvedValue(existingCommand);
      readDaemonRuntimePinForInstall.mockReturnValue(expected);
      await install({ opts: { installDaemon: true, daemonRuntime } });
      expect(buildGatewayInstallPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: daemonRuntime ?? "bun",
          pinnedRuntimePath: daemonRuntime ? undefined : pin.path,
          existingCommand,
          env: expect.objectContaining({ OPENCLAW_WRAPPER: "/opt/wrapper" }),
        }),
      );
      expect(serviceInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePinUpdate: { expected, pin: daemonRuntime ? undefined : pin },
        }),
      );
    },
  );
});
