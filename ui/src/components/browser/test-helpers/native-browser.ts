import { afterEach, beforeEach, vi } from "vitest";
import type {
  NativeBrowserMessage,
  NativeBrowserState,
  NativeBrowserTab,
} from "../../../app/native-browser-bridge.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createInspectedNode,
  stubScreenshotMedia,
  TestBrowserPanelHost,
} from "../browser-panel-controller-test-support.ts";
import type { BrowserPanel } from "../browser-panel-owner.ts";
import "../browser-panel.ts";

export const nativeTab = (
  id: string,
  url = "https://example.test/page",
  sessionKey = "",
): NativeBrowserTab => ({
  id,
  sessionKey,
  url,
  title: "Example page",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  openedBy: "web",
});

export function fakeNativeBrowser(tabs: NativeBrowserTab[] = [], legacy = false) {
  let state: NativeBrowserState = { revision: 0, tabs };
  const publish = (nextTabs: NativeBrowserTab[]) => {
    state = { revision: state.revision + 1, tabs: nextTabs };
    vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", state);
    window.dispatchEvent(new CustomEvent("openclaw:native-browser-state", { detail: state }));
  };
  const postMessage = vi.fn(async (message: NativeBrowserMessage) => {
    switch (message.type) {
      case "open": {
        const tab = nativeTab(message.tabId, message.url, message.sessionKey);
        if (legacy) {
          delete tab.sessionKey;
        }
        publish([...state.tabs, tab]);
        return { ok: true, tabId: message.tabId };
      }
      case "close":
        publish(state.tabs.filter((tab) => tab.id !== message.tabId));
        break;
      case "snapshot":
        return {
          ok: true,
          dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==",
          cssWidth: 100,
          cssHeight: 100,
        };
      case "inspect":
        return { ok: true, node: createInspectedNode("Save") };
      case "download":
        return { ok: true, cancelled: false };
    }
    return { ok: true };
  });
  vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", state);
  return {
    publish,
    postMessage,
    messages: () => postMessage.mock.calls.map(([message]) => message),
  };
}

export function setupNativeBrowserPanelTests() {
  const controllers: BrowserPanel[] = [];
  const cleanups: (() => void)[] = [];
  let hit: Element | null;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  function controllerFixture(screencast = false, sessionKey = "") {
    let remoteOpen = true;
    const remote = { targetId: "remote", url: "https://remote.test/" };
    const { client, request } = createBrowserClient(
      async ({ method, path }) => {
        if (method === "DELETE" && path === "/tabs/remote") {
          remoteOpen = false;
          return { ok: true };
        }
        switch (path) {
          case "/tabs":
            return {
              running: true,
              tabs: remoteOpen ? [{ ...remote, tabId: "remote", title: "Remote" }] : [],
            };
          case "/screencast":
            return { ...remote, token: "token", wsPath: "/browser/screencast?token=token" };
          case "/screenshot":
            return { ...remote, path: "/fresh.png" };
          case "/download":
            return { download: { path: "/managed/remote.png", suggestedFilename: "remote.png" } };
          case "/act":
            return createBrowserPanelTestMetrics(remote.url, "Remote");
          default:
            return { ok: true };
        }
      },
      { screencast },
    );
    const host = new TestBrowserPanelHost(client);
    host.sessionKey = sessionKey;
    document.body.append(host.renderRoot);
    const stage = host.stage;
    hit = stage;
    const controller = host.createPanel();
    cleanups.push(controller.native.presentation.mountStage(stage));
    controllers.push(controller);
    const stopNative = controller.native.mount();
    if (stopNative) {
      cleanups.push(stopNative);
    }
    return { controller, host, request };
  }

  function flushFrames() {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((frame) => frame(0));
  }

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    hit = null;
    vi.stubGlobal("localStorage", createStorageMock());
    // Geometry and hit testing below own this no-layout native presentation.
    class GeometryObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", GeometryObserver);
    vi.stubGlobal(
      "IntersectionObserver",
      class extends GeometryObserver {
        takeRecords() {
          return [];
        }
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    stubScreenshotMedia();
  });

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    controllers.splice(0).forEach((controller) => controller.suspendView());
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  return {
    controllerFixture,
    flushFrames,
    setHit: (element: Element | null) => {
      hit = element;
    },
  };
}

export async function mountSessionPanel(sessionKey: string) {
  const panel = document.createElement("openclaw-browser-panel");
  panel.sessionKey = sessionKey;
  panel.available = true;
  panel.remoteAvailable = false;
  panel.embedded = true;
  panel.presented = true;
  mountSolid(() => panel);
  await panel.updateComplete;
  return panel;
}
