import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import * as avatarImage from "./avatar-image.ts";
import { AvatarPicker, type AvatarPickerProps, type GeneratedAvatar } from "./avatar-picker.tsx";

const avatar = "data:image/webp;base64,YXZhdGFy";
const generated = { name: "Garden keeper", description: "A tiny gardener.", svg: "<svg/>" };
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.spyOn(avatarImage, "svgToAvatarDataUrl").mockResolvedValue({ ok: true, dataUrl: avatar });
});
afterEach(() => {
  dispose?.();
  vi.restoreAllMocks();
});

function mount(onGenerate: AvatarPickerProps["onGenerate"] = vi.fn().mockResolvedValue(generated)) {
  const props: AvatarPickerProps = {
    agentId: "beta",
    avatar: null,
    disabled: false,
    onSelect: vi.fn(),
    onUpload: vi.fn(),
    onGenerate,
  };
  const view = mountSolid(AvatarPicker, props);
  dispose = view.dispose;
  const click = (label: string) => {
    const button = [...view.container.querySelectorAll("button")].findLast(
      (entry) => entry.textContent?.trim() === label,
    );
    if (!button) {
      throw new Error(`Missing button: ${label}`);
    }
    button.click();
    flush();
  };
  const describe = (value: string) => {
    click("Generate");
    const input = view.container.querySelector("textarea")!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
  };
  return { ...view, props, click, describe };
}

it("offers bundled character presets without a Lobsterdex collection", () => {
  const view = mount();
  for (const name of ["Clawnstantine", "Clawie Stardust", "24K"]) {
    const preset = view.container.querySelector(`.avatar-picker__preset[aria-label="${name}"]`);
    expect(preset).not.toBeNull();
    expect(preset?.hasAttribute("disabled")).toBe(false);
  }
  expect(view.container.querySelectorAll(".avatar-picker__preset:disabled")).toHaveLength(0);
});

it("submits only the description and requires acceptance before replacing identity", async () => {
  const generate = vi.fn().mockResolvedValue(generated);
  const view = mount(generate);
  view.describe("  A patient gardener with a watering can  ");
  view.click("Generate");
  await waitForFast(() => expect(view.container.textContent).toContain("Garden keeper"));
  expect(view.container.textContent).not.toContain("Generate again");
  expect(generate).toHaveBeenCalledWith("A patient gardener with a watering can");
  expect(view.props.onSelect).not.toHaveBeenCalled();
  expect(view.container.textContent).not.toContain("Chat and sidebar preview");
  expect(
    [...view.container.querySelectorAll(".avatar-picker__actions button")].map((button) =>
      button.textContent?.trim(),
    ),
  ).toEqual(["Discard", "Use avatar"]);
  view.click("Discard");
  expect(view.props.onSelect).not.toHaveBeenCalled();
  view.click("Generate");
  await waitForFast(() => expect(view.container.textContent).toContain("Use avatar"));
  view.click("Use avatar");
  expect(view.props.onSelect).toHaveBeenCalledWith(avatar);
});

it("retires generation on mode changes and when its agent chooser is disposed", async () => {
  const pending = createDeferred<GeneratedAvatar>();
  const view = mount(() => pending.promise);
  view.describe("Explorer");
  view.click("Generate");
  view.click("Blobster");
  pending.resolve(generated);
  await pending.promise;
  await Promise.resolve();
  flush();
  view.click("Generate");
  expect(view.container.textContent).not.toContain("Use avatar");
  expect(view.props.onSelect).not.toHaveBeenCalled();
  const next = createDeferred<GeneratedAvatar>();
  view.update({ ...view.props, onGenerate: () => next.promise });
  view.click("Generate");
  view.dispose();
  next.resolve(generated);
  await next.promise;
  await Promise.resolve();
  expect(view.props.onSelect).not.toHaveBeenCalled();
});

it("shows a Blobster silhouette and generating label while a preview is pending", async () => {
  const pending = createDeferred<GeneratedAvatar>();
  const view = mount(() => pending.promise);
  view.describe("Explorer");
  view.click("Generate");
  expect(view.container.querySelector(".avatar-picker__ghost .lobster-pet__svg")).not.toBeNull();
  expect(view.container.textContent).toContain("Generating...");
  pending.resolve(generated);
  await waitForFast(() => expect(view.container.textContent).toContain("Use avatar"));
  expect(view.container.querySelector(".avatar-picker__ghost")).toBeNull();
});

it("shows generation failures without changing the selected avatar", async () => {
  const view = mount(vi.fn().mockRejectedValue(new Error("Selected model is unavailable.")));
  view.describe("Explorer");
  view.click("Generate");
  await waitForFast(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Selected model is unavailable",
    ),
  );
  expect(view.props.onSelect).not.toHaveBeenCalled();
});

it.each(["success", "failure"] as const)(
  "lets a replacement generation settle before retired work (%s)",
  async (outcome) => {
    const retired = createDeferred<GeneratedAvatar>();
    const replacement = { ...generated, name: "New garden keeper" };
    const generate = vi.fn().mockReturnValueOnce(retired.promise).mockResolvedValue(replacement);
    const view = mount(generate);
    view.describe("Old explorer");
    view.click("Generate");
    view.click("Blobster");
    view.describe("New gardener");
    view.click("Generate");
    await waitForFast(() => expect(view.container.textContent).toContain(replacement.name));
    if (outcome === "success") {
      retired.resolve(generated);
    } else {
      retired.reject(new Error("Retired generation failed."));
    }
    await retired.promise.catch(() => undefined);
    await Promise.resolve();
    flush();
    expect(view.container.textContent).toContain(replacement.name);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.props.onSelect).not.toHaveBeenCalled();
    view.click("Use avatar");
    expect(view.props.onSelect).toHaveBeenCalledExactlyOnceWith(avatar);
  },
);

it("prepares a confirmed preset without publishing a retired preparation", async () => {
  const lobsterImage = await import("../../components/lobster-image.ts");
  const prepared = createDeferred<HTMLImageElement | null>();
  const retired = createDeferred<HTMLImageElement | null>();
  vi.spyOn(lobsterImage, "loadLobsterImage")
    .mockReturnValueOnce(prepared.promise)
    .mockReturnValueOnce(retired.promise);
  vi.spyOn(avatarImage, "imageToAvatarDataUrl").mockReturnValue({ ok: true, dataUrl: avatar });
  const view = mount();
  const selectPreset = () => {
    view.container.querySelector<HTMLButtonElement>(".avatar-picker__preset")!.click();
    flush();
  };
  selectPreset();
  expect(view.container.querySelector('[role="status"]')).not.toBeNull();
  expect(view.props.onSelect).not.toHaveBeenCalled();
  prepared.resolve(document.createElement("img"));
  await waitForFast(() => expect(view.props.onSelect).toHaveBeenCalledExactlyOnceWith(avatar));
  selectPreset();
  view.describe("A gardener");
  view.click("Generate");
  await waitForFast(() => expect(view.container.textContent).toContain("Use avatar"));
  retired.resolve(document.createElement("img"));
  await retired.promise;
  await Promise.resolve();
  flush();
  expect(view.props.onSelect).toHaveBeenCalledTimes(1);
  expect(view.container.textContent).toContain(generated.name);
});

it("clears a failed preparation while a retry is pending and keeps its controls", async () => {
  const retry = createDeferred<GeneratedAvatar>();
  const generate = vi
    .fn()
    .mockRejectedValueOnce(new Error("Synthetic failure."))
    .mockReturnValue(retry.promise);
  const view = mount(generate);
  view.describe("A gardener");
  view.click("Generate");
  await waitForFast(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Synthetic failure",
    ),
  );
  const prompt = view.container.querySelector("textarea");
  view.click("Generate");
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.container.querySelector("textarea")).toBe(prompt);
  expect(view.container.textContent).toContain("Generating...");
  retry.resolve(generated);
  await waitForFast(() => expect(view.container.textContent).toContain("Use avatar"));
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.container.querySelector("textarea")).toBe(prompt);
});
