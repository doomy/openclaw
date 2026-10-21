import type {
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { settingsViews } from "./index.tsx";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) {
    stop();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
});
const ok = (data: Record<string, unknown>) => ({
  ok: true,
  status: 200,
  data,
  errorMessage: "HTTP 200",
});
async function settle() {
  flush();
  await Promise.resolve();
  await Promise.resolve();
  flush();
}
function fixture() {
  const abort = new AbortController();
  let snapshot: ControlUiChannelSettingsSnapshot = {
    channelId: "nostr",
    status: { configured: true, running: true, profile: { name: "Alice" } },
    accounts: [],
    connected: true,
    canAdmin: true,
    connectionEpoch: 1,
    locale: "en",
    presented: true,
  };
  const unavailable = () => {
    throw new Error("Nostr's native markup does not mount generic Settings widgets");
  };
  const request = vi
    .fn<ControlUiChannelSettingsContext["request"]>()
    .mockResolvedValue(ok({ ok: true, persisted: true }));
  const refresh = vi.fn<ControlUiChannelSettingsContext["refresh"]>().mockResolvedValue();
  const formatError = vi.fn((error: unknown) => String(error));
  const context: ControlUiChannelSettingsContext = {
    props: snapshot,
    signal: abort.signal,
    components: {
      mountSection: unavailable,
      mountRow: unavailable,
      mountStatus: unavailable,
      mountValue: unavailable,
      mountNavigation: unavailable,
      mountLobster: unavailable,
    },
    request,
    refresh,
    formatError,
    formatExternalText: (text) => text,
    formatRelativeTimestamp: () => "recently",
    mountConfig: () => () => {},
  };
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = settingsViews[0]!.mount(container, context);
  cleanups.push(() => {
    abort.abort();
    mounted.dispose();
    container.remove();
  });
  flush();
  function button(label: string) {
    const node = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!node) {
      throw new Error(`Missing button ${label}`);
    }
    return node;
  }
  function field(name: string, value: string) {
    const node = input(name);
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    return node;
  }
  function input(name: string) {
    return container.querySelector<HTMLInputElement>(`#nostr-profile-${name}`)!;
  }
  function click(label: string) {
    button(label).click();
    flush();
  }
  function pending(action: string) {
    const result =
      createDeferred<Awaited<ReturnType<ControlUiChannelSettingsContext["request"]>>>();
    request.mockReturnValueOnce(result.promise);
    click(action);
    return result;
  }
  async function waitForText(text: string) {
    await vi.waitFor(() => {
      flush();
      expect(container.textContent).toContain(text);
    });
  }
  function update(patch: Partial<ControlUiChannelSettingsSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    mounted.update(snapshot);
    flush();
  }
  click("Edit Profile");
  field("name", "Alice Updated");
  return {
    container,
    abort,
    request,
    refresh,
    formatError,
    button,
    click,
    input,
    field,
    update,
    pending,
    waitForText,
  };
}

it("keeps the actual editor node while replacing its draft and calls the current save action", async () => {
  const f = fixture();
  const input = f.input("name");
  expect(input.value).toBe("Alice Updated");
  f.field("name", "after");
  expect(f.input("name")).toBe(input);
  expect(input.value).toBe("after");
  expect(f.container.textContent).toContain("You have unsaved changes");
  f.click("Save & Publish");
  await settle();
  expect(f.request).toHaveBeenCalledOnce();
  expect(f.request).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "default",
      path: ["profile"],
      method: "PUT",
      body: expect.objectContaining({ name: "after" }),
    }),
  );
  expect(f.container.textContent).toContain("Profile published to relays.");
  expect(f.button("Save & Publish").disabled).toBe(true);
  expect(f.refresh).toHaveBeenCalledWith(true);
});

it("preserves null imported names and extra profile metadata", async () => {
  const f = fixture();
  f.request.mockResolvedValue(
    ok({
      ok: true,
      saved: true,
      merged: { name: null, displayName: "Imported display", extra: { value: true } },
    }),
  );
  f.click("Import from Relays");
  await f.waitForText("Profile imported from relays. Review and publish.");
  expect(f.input("name").value).toBe("");
  expect(f.input("displayName").value).toBe("Imported display");
  expect(f.refresh).toHaveBeenCalledWith(true);
});

it("merges an import into the live draft and reveals imported advanced fields", async () => {
  const f = fixture();
  const pending = f.pending("Import from Relays");
  f.field("displayName", "Typed during import");
  pending.resolve(ok({ ok: true, imported: { name: "Imported", website: "https://example.com" } }));
  await f.waitForText("Profile imported. Review and publish.");
  expect(f.input("displayName").value).toBe("Typed during import");
  expect(f.input("website").value).toBe("https://example.com");
  expect(f.refresh).not.toHaveBeenCalled();
});

it("renders validation details and clears a field error on editing", async () => {
  const f = fixture();
  f.request.mockResolvedValue({
    ok: false,
    status: 400,
    data: { ok: false, details: ["name: Name is too long"] },
    errorMessage: "HTTP 400: Validation failed",
  });
  f.click("Save & Publish");
  await settle();
  expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
    "HTTP 400: Validation failed",
  );
  expect(f.container.textContent).toContain("Name is too long");
  expect(f.input("name").getAttribute("aria-invalid")).toBe("true");
  f.field("name", "Short");
  expect(f.container.textContent).not.toContain("Name is too long");
  expect(f.refresh).not.toHaveBeenCalled();
});

it("keeps failed publication dirty without refreshing channel status", async () => {
  const f = fixture();
  f.request.mockResolvedValue(ok({ ok: true, persisted: false }));
  f.click("Save & Publish");
  await settle();
  expect(f.container.textContent).toContain("Profile publish failed on all relays.");
  expect(f.button("Save & Publish").disabled).toBe(false);
  expect(f.refresh).not.toHaveBeenCalled();
});

it.each(["Save & Publish", "Import from Relays"])(
  "applies one 30-second deadline and recovers rendered %s",
  async (action) => {
    vi.useFakeTimers();
    const f = fixture();
    f.request.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    f.click(action);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.container.textContent).not.toContain("Request timed out");
    expect(f.request.mock.calls[0]![0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(f.request.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(f.button(action).disabled).toBe(false);
    expect(f.container.textContent).toContain(
      "Request timed out after 30 seconds; the server may still have applied the change — check the profile before retrying.",
    );
    expect(f.refresh).not.toHaveBeenCalled();
  },
);

it.each(["disconnect", "replacement form", "abort"] as const)(
  "drops late import success and failure after %s before host formatting",
  async (retirement) => {
    const f = fixture();
    const pending = f.pending("Import from Relays");
    if (retirement === "disconnect") {
      f.update({ connected: false, connectionEpoch: 2 });
      expect(f.button("Save & Publish").disabled).toBe(true);
      expect(f.button("Import from Relays").disabled).toBe(true);
    } else if (retirement === "replacement form") {
      f.click("Cancel");
      f.click("Edit Profile");
      f.field("name", "Fresh draft");
    } else {
      f.abort.abort();
    }
    expect(f.request.mock.calls[0]![0].signal.aborted).toBe(true);
    pending.resolve(ok({ ok: true, saved: true, merged: { name: "Stale import" } }));
    await settle();
    expect(f.container.textContent).not.toContain("Profile imported");
    expect(f.container.textContent).not.toContain("Last error");
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.formatError).not.toHaveBeenCalled();
    if (retirement === "disconnect") {
      expect(f.input("name").value).toBe("Alice Updated");
      f.update({ connected: true, connectionEpoch: 3 });
      expect(f.button("Import from Relays").disabled).toBe(false);
    } else if (retirement === "replacement form") {
      expect(f.input("name").value).toBe("Fresh draft");
    }
  },
);

it("does not format a late failure after the view aborts", async () => {
  const f = fixture();
  const pending = f.pending("Save & Publish");
  f.abort.abort();
  pending.reject(new Error("late failure"));
  await settle();
  expect(f.formatError).not.toHaveBeenCalled();
  expect(f.refresh).not.toHaveBeenCalled();
});

it("settles while hidden and catches the retained editor up once on reveal", async () => {
  const f = fixture();
  const pending = f.pending("Import from Relays");
  f.update({ presented: false });
  pending.resolve(ok({ ok: true, saved: false, merged: { name: "Imported while hidden" } }));
  await settle();
  expect(f.input("name").value).toBe("Alice Updated");
  f.update({ presented: true });
  expect(f.input("name").value).toBe("Imported while hidden");
  expect(f.container.textContent).toContain("Profile imported.");
});
