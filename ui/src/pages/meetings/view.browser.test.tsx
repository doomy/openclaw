import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import "../../styles.css";
import "./meetings.css";
import { meetingEntry, meetingPage } from "../../test-helpers/transcripts.test-support.ts";
import type { TranscriptsViewProps } from "./view-types.ts";
import { TranscriptsView } from "./view.tsx";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
let container: HTMLDivElement;
let updateView: (props: TranscriptsViewProps) => void;
let props: TranscriptsViewProps;
const query = <T extends HTMLElement = HTMLElement>(selector: string) =>
  container.querySelector<T>(selector)!;
const rect = (element: Element) => element.getBoundingClientRect();
const keydown = (element: Element, key: string) =>
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
async function viewport(width = 1440, height = 1000) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, height);
}
function mountView(next: TranscriptsViewProps) {
  updateView(next);
  flush();
}

beforeEach(() => {
  props = readerProps();
  const [value, setValue] = createSignal(props);
  updateView = (next) => setValue({ ...next });
  ({ container } = mountSolid(() => <TranscriptsView {...value()} />));
});
function readerProps(): TranscriptsViewProps {
  return {
    basePath: "",
    now: Date.parse(meetingEntry.updatedAt),
    search: "?selector=meeting",
    drafts: {},
    onDraft: vi.fn(),
    connected: true,
    allowed: true,
    list: { sessions: [meetingEntry], nextCursor: null },
    listLoading: false,
    listError: null,
    reader: {
      summary: meetingPage,
      pages: [
        {
          ...meetingPage,
          utterances: [{ sequence: 0, speakerLabel: "Avery", text: "Unbroken".repeat(120) }],
        },
      ],
      loading: false,
      error: null,
    },
    readerTab: "text",
    exportState: { kind: "idle" },
    onNavigate: vi.fn(),
    onOpenCaptureSettings: vi.fn(),
    onRefresh: vi.fn(),
    onReaderRetry: vi.fn(),
    onReaderTab: vi.fn(),
    onDownload: vi.fn(),
  };
}

describe.skipIf(!hasBrowserLayout)("meeting transcript responsive reader", () => {
  it("keeps long speaker text inside the reading column and switches to a mobile drill-in", async () => {
    await viewport(1320, 900);
    mountView(props);
    const library = query(".transcripts-library");
    const reader = query(".transcripts-reader");
    expect(getComputedStyle(library).display).not.toBe("none");
    expect(rect(reader).left).toBeGreaterThanOrEqual(rect(library).right - 1);
    expect(reader.scrollWidth).toBeLessThanOrEqual(reader.clientWidth + 1);
    await viewport(390, 844);
    expect(getComputedStyle(library).display).toBe("none");
    expect(rect(reader).right).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(reader.scrollWidth).toBeLessThanOrEqual(reader.clientWidth + 1);
    const transcript = query("#transcript-reader-tab-text");
    const summary = query("#transcript-reader-tab-summary");
    transcript.focus();
    keydown(transcript, "ArrowLeft");
    expect(document.activeElement).toBe(summary);
    expect(summary.getAttribute("aria-selected")).toBe("false");
    expect(transcript.getAttribute("aria-selected")).toBe("true");
    expect(props.onReaderTab).not.toHaveBeenCalled();
    keydown(summary, "Enter");
    expect(props.onReaderTab).toHaveBeenCalledExactlyOnceWith("summary");
    mountView({ ...props, readerTab: "summary" });
    expect(summary.getAttribute("aria-selected")).toBe("true");
    const panel = query('[role="tabpanel"]');
    expect(panel.getAttribute("aria-labelledby")).toBe(summary.id);
    keydown(summary, "Enter");
    expect(props.onReaderTab).toHaveBeenCalledExactlyOnceWith("summary");
    expect(panel.textContent).toContain("Notes extracted using text heuristics");
  });
  it("uses themed search controls and keeps the third library entry above the fold", async () => {
    await viewport();
    props.list = {
      sessions: [
        meetingEntry,
        { ...meetingEntry, selector: "second" },
        { ...meetingEntry, selector: "third" },
      ],
      nextCursor: null,
    };
    mountView(props);
    const libraryStyle = getComputedStyle(query('input[name="query"]'));
    const readerStyle = getComputedStyle(query('input[name="find"]'));
    for (const property of ["backgroundColor", "borderRadius", "paddingLeft"] as const) {
      expect(readerStyle[property]).toBe(libraryStyle[property]);
    }
    const third = container.querySelectorAll(".transcripts-list__entry")[2]!;
    expect(rect(third).bottom).toBeLessThan(window.innerHeight);
    expect(query<HTMLDetailsElement>(".transcripts-filters details").open).toBe(false);
    const overview = "A readable summary of the decisions and follow-up work. ".repeat(5);
    props.search = "";
    props.list.sessions[0] = { ...meetingEntry, overview };
    mountView(props);
    expect(container.querySelector(".transcripts-reader")).toBeNull();
    expect(rect(query(".transcripts-library")).width).toBeGreaterThan(600);
    const preview = query(".meetings-row__overview");
    expect(preview.textContent).toBe(overview);
    expect(rect(preview).height).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(preview).lineHeight),
    );
    expect(preview.scrollWidth).toBeLessThanOrEqual(preview.clientWidth + 1);
  });

  it("preserves stored Markdown notes while keeping transcript speech in its own tab", async () => {
    await viewport();
    props.readerTab = "summary";
    props.reader.summary = {
      ...meetingPage,
      summary: {
        ...meetingPage.summary!,
        markdown:
          "# Design review\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Next steps\n- Follow up.\n\n```md\n## Transcript\nA heading example, not recorded speech.\n```\n\n## Transcript\n- Avery: Raw recorded speech.\n",
      },
    };
    mountView(props);
    const notes = query(".meetings-notes");
    expect([...notes.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "Next steps",
    ]);
    expect(notes.textContent).not.toContain("Raw recorded speech.");
    expect(notes.querySelector("code")?.textContent).toContain("## Transcript");
    const paragraphs = notes.querySelectorAll("p");
    expect([...paragraphs].map((paragraph) => paragraph.textContent)).toEqual([
      "First paragraph.",
      "Second paragraph.",
    ]);
    expect(notes.querySelector("li")?.textContent).toBe("Follow up.");
    const lineHeight = Number.parseFloat(getComputedStyle(paragraphs[0]!).lineHeight);
    expect(rect(paragraphs[1]!).top - rect(paragraphs[0]!).bottom).toBeLessThan(lineHeight * 2);
  });
});
