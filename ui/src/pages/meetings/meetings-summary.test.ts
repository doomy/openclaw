import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { meetingEntry } from "../../test-helpers/transcripts.test-support.ts";
import { button, meetingPage, mount } from "./meetings-page.test-support.tsx";

const missingSummary = { ...meetingPage, summary: undefined };
const generatedText = "Reader layout discussed.";
const generatingText = "Generating meeting summary";
const waitForText = (page: Element, text: string) =>
  waitForSolid(() => expect(page.textContent).toContain(text));
function archiveRequest(
  read: () => typeof missingSummary | typeof meetingPage,
  summarize: () => Promise<typeof meetingPage>,
  sessions = [meetingEntry],
) {
  return vi.fn(async (method: string) => {
    if (method === "transcripts.list") {
      return { sessions, nextCursor: null };
    }
    return method === "transcripts.summarize" ? summarize() : read();
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("meeting summary generation", () => {
  it("generates on open, holds failures without retry loops, and retries explicitly", async () => {
    vi.useFakeTimers();
    const pending = deferred<typeof meetingPage>();
    let attempts = 0;
    const missing = { ...missingSummary, session: { ...meetingEntry, hasSummary: false } };
    const request = archiveRequest(
      () => (attempts > 1 ? meetingPage : missing),
      async () => (++attempts === 1 ? pending.promise : meetingPage),
    );
    const { page } = mount(request, "?selector=meeting");
    await waitForText(page, generatingText);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(attempts).toBe(1);
    pending.reject(new Error("Summary provider unavailable"));
    await waitForText(page, "Summary provider unavailable");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(attempts).toBe(1);
    button(page.querySelector(".transcripts-summary")!, "Retry").click();
    await waitForText(page, generatedText);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(attempts).toBe(2);
    expect(page.textContent).not.toContain("Summary provider unavailable");
  });

  it.each([
    ["read-only", "No summary is available yet."],
    ["silent", "No speech captured"],
    ["saved", generatedText],
  ])("does not generate notes for a %s reader", async (kind, expected) => {
    const detail = {
      ...meetingPage,
      summary: kind === "saved" ? meetingPage.summary : undefined,
      session: { ...meetingEntry, utteranceCount: kind === "silent" ? 0 : 2 },
    };
    const request = vi.fn(async (method: string) =>
      method === "transcripts.list" ? { sessions: [detail.session], nextCursor: null } : detail,
    );
    const { page } = mount(
      request,
      "?selector=meeting",
      kind === "read-only" ? ["operator.read"] : ["operator.admin"],
    );
    await waitForSolid(() => expect(page.querySelector(".transcripts-summary")).not.toBeNull());
    expect(request.mock.calls.some(([method]) => method === "transcripts.summarize")).toBe(false);
    expect(page.textContent).toContain(expected);
  });

  it.each(["selection", "client", "authorization"])("fences replaced %s", async (replacement) => {
    const pending = deferred<typeof meetingPage>();
    let replaced = false;
    const request = archiveRequest(
      () => (replaced ? meetingPage : missingSummary),
      () => pending.promise,
      [],
    );
    const { page, setSearch, snapshot, notify } = mount(request, "?selector=old");
    await waitForText(page, generatingText);
    replaced = true;
    if (replacement === "selection") {
      setSearch("?selector=new");
    } else if (replacement === "client") {
      snapshot.client = { request } as unknown as GatewayBrowserClient;
      notify();
    } else {
      snapshot.hello = {
        ...snapshot.hello,
        auth: { role: "operator", scopes: ["operator.read"] },
      } as ApplicationGatewaySnapshot["hello"];
      notify();
    }
    await waitForText(page, generatedText);
    pending.resolve({
      ...meetingPage,
      summary: { ...meetingPage.summary, markdown: "Late private notes" },
    });
    await pending.promise;
    flush();
    expect(page.textContent).not.toContain("Late private notes");
    expect(page.textContent).toContain(generatedText);
  });
});
