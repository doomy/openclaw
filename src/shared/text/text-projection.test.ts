import { describe, expect, it, vi } from "vitest";
import { findCodeRegions } from "./code-regions.js";
import {
  applyTextFilters,
  createTextProjection,
  duplicateParagraphTextFilter,
  leadingEmptyLinesTextFilter,
  trimTextFilter,
  type TextFilter,
  type TextProjection,
} from "./text-projection.js";

vi.mock("./code-regions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./code-regions.js")>();
  return { ...actual, findCodeRegions: vi.fn(actual.findCodeRegions) };
});

const expectUpdate = (actual: TextProjection, text: string, delta: string | null = text) =>
  expect(actual).toEqual({ text, delta });

describe("createTextProjection", () => {
  it("activates split markers, reprojects completed syntax, and replaces the source", () => {
    const projection = createTextProjection([
      {
        activationTokens: ["<private>"],
        transform: (text) => text.replace(/<private>[\s\S]*?<\/private>/gi, ""),
      },
    ]);
    expectUpdate(projection.append("Before <PRI"), "Before <PRI");
    expectUpdate(projection.append("VATE>secret"), "Before <PRIVATE>secret", "VATE>secret");
    expectUpdate(projection.append("</PRIVATE>after"), "Before after", null);
    expectUpdate(projection.append("."), "Before after.", ".");
    expectUpdate(projection.replace("Fresh "), "Fresh ", null);
    expectUpdate(projection.append("reply"), "Fresh reply", "reply");
    expect(projection.source).toBe("Fresh reply");
    expect(projection.text).toBe("Fresh reply");
  });

  it("rechecks downstream activation when a preceding filter joins a marker", () => {
    const filters: TextFilter[] = [
      { activationTokens: ["<cut>"], transform: (text) => text.replace(/<cut>.*?<\/cut>/g, "") },
      { activationTokens: ["BEGIN"], transform: (text) => text.replace(/BEGIN.*?END/g, "") },
    ];
    const projection = createTextProjection(filters);
    projection.append("Before BE<cut>hidden");
    expectUpdate(projection.append("</cut>GIN private ENDafter"), "Before after", null);
    expect(applyTextFilters(projection.source, filters)).toBe("Before after");
  });

  it("preserves an append when downstream filtering cancels an intermediate correction", () => {
    const projection = createTextProjection([
      { activationTokens: ["<cut>"], transform: (text) => text.replace(/<cut>.*?<\/cut>/g, "") },
      { activationTokens: ["<cut>"], transform: (text) => text.replace(/<cut>.*/g, "") },
    ]);
    expectUpdate(projection.append("Ready <cut>hidden"), "Ready ");
    expectUpdate(projection.append("</cut>reply"), "Ready reply", "reply");
    expectUpdate(projection.replace("Ready reply"), "Ready reply", null);
  });

  it.each(["none", "start", "both"] as const)("trims %s across whitespace boundaries", (mode) => {
    const filter = trimTextFilter(mode);
    const projection = createTextProjection([filter]);
    let source = "";
    let delivered = "";
    for (const delta of [" \r", "\n\u00a0", " A ", "\t", "B\r", "\n", " C", "  "]) {
      source += delta;
      const result = projection.append(delta);
      const expected =
        mode === "both" ? source.trim() : mode === "start" ? source.trimStart() : source;
      expectUpdate(result, expected, expected.slice(delivered.length));
      expect(projection.matchesTrimmedSource).toBe(expected === source.trim());
      delivered = expected;
    }
    expectUpdate(projection.replace(" \tReset \n"), filter.transform(" \tReset \n"), null);
    expect(projection.append("end").text).toBe(filter.transform(" \tReset \nend"));
  });

  it("distinguishes preserved indentation and equal-length rewrites from trimmed source", () => {
    const projection = createTextProjection([
      { activationTokens: ["swap"], transform: (text) => text.replace("swap", "edit") },
      trimTextFilter("both", { preserveCodeIndentation: true }),
    ]);
    for (const source of ["\u00a0plain \n", "    code\n", " swap ", "\t\n"]) {
      projection.replace(source);
      expect(projection.matchesTrimmedSource).toBe(projection.text === source.trim());
      projection.append(" tail");
      expect(projection.matchesTrimmedSource).toBe(projection.text === `${source} tail`.trim());
    }
    const padding = createTextProjection([
      { activationTokens: ["\n"], transform: (text) => text.replace(/^\n/, "") },
      trimTextFilter("both"),
    ]);
    padding.append("\nSame ");
    expect(padding.matchesTrimmedSource).toBe(true);
  });

  it("removes only leading empty lines", () => {
    const projection = createTextProjection([leadingEmptyLinesTextFilter]);
    let delivered = "";
    for (const chunk of [" \r", "\n\t\n", "  Code", "\n next"]) {
      const result = projection.append(chunk);
      expect(result.delta).not.toBeNull();
      delivered += result.delta;
      expect(delivered).toBe(result.text);
    }
    expect(projection.text).toBe("  Code\n next");
    expectUpdate(projection.replace("\n  Reset"), "  Reset", null);
  });
});

describe("duplicate paragraphs", () => {
  it.each([
    ["A\n\nA\n\n \n\nB", "A\n\n\n\nB"],
    [
      "\0\0\0\n\nrepeat\n\nrepeat\n\nUse `x`\u0000`y` and `x`.",
      "\0\0\0\n\nrepeat\n\nUse `x`\u0000`y` and `x`.",
    ],
    ["repeat\n\nrepeat `x`", "repeat\n\nrepeat `x`"],
  ])("preserves canonical separators and whitespace %#", (text, expected) => {
    expect(duplicateParagraphTextFilter.transform(text)).toBe(expected);
    const partitions = [
      text.split(""),
      ...Array.from({ length: text.length + 1 }, (_, i) => [text.slice(0, i), text.slice(i)]),
    ];
    for (const chunks of partitions) {
      const projection = createTextProjection([duplicateParagraphTextFilter]);
      let delivered = "";
      for (const chunk of chunks) {
        const result = projection.append(chunk);
        delivered = result.delta === null ? result.text : delivered + result.delta;
        expect(delivered).toBe(result.text);
      }
      expect(projection.text).toBe(expected);
    }
  });

  it.each([
    ["A\n\n\nB\n\nB", "A\n\nB", " changes", "A\n\n\nB\n\nB changes", null],
    [
      "first\n\nfirst",
      "first",
      " diverges\n\nfirst diverges",
      "first\n\nfirst diverges",
      "\n\nfirst diverges",
    ],
  ] as const)(
    "reconciles a provisional duplicate as later paragraphs diverge %#",
    (initial, initialText, appended, expected, delta) => {
      const projection = createTextProjection([duplicateParagraphTextFilter]);
      expectUpdate(projection.append(initial), initialText);
      expectUpdate(projection.append(appended), expected, delta);
      expectUpdate(projection.replace("  New\n\nNew"), "New", null);
      expectUpdate(projection.append("\n\nLast "), "New\n\nLast", "\n\nLast");
      expectUpdate(projection.append("word"), "New\n\nLast word", " word");
    },
  );

  it("keeps code-bearing continuation appends on the incremental suffix path", () => {
    const parser = vi.mocked(findCodeRegions);
    parser.mockClear();
    const code = "```text\ninside\n\ninside\n```";
    const source = `${code}\n\nrepeat\n\nrepeat\n\ntail`;
    const projection = createTextProjection([duplicateParagraphTextFilter]);
    expect(projection.append(source).text).toBe(`${code}\n\nrepeat\n\ntail`);
    const initialParses = parser.mock.calls.length;
    expect(initialParses).toBeGreaterThan(0);

    for (let index = 0; index < 256; index++) {
      const delta = `-${index}`;
      expect(projection.append(delta).delta).toBe(delta);
    }
    expect(parser).toHaveBeenCalledTimes(initialParses);
    expect(projection.text).toBe(duplicateParagraphTextFilter.transform(projection.source));
  });
});
