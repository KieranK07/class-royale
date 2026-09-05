"use client";

// Client side of the extension bridge. Talks to extension/bridge.js over
// window.postMessage — the page can't reach chrome.runtime directly.
//
// Everything here degrades to "no extension installed", which is a fully
// supported state: the site works without it, and the transcript can always
// be pasted instead.

const PAGE = "class-royale-page";
const EXT = "class-royale-sync";
const TIMEOUT_MS = 12000;

export type SyncResult =
  | { ok: true; html: string }
  | { ok: false; reason: "auth"; loginUrl: string }
  | { ok: false; reason: "network" | "http" | "extension" | "timeout"; message?: string };

let requestCounter = 0;

function send<T>(
  type: string,
  timeoutMs = TIMEOUT_MS,
  extra: Record<string, unknown> = {}
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${requestCounter++}`;
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("timeout"));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.source !== EXT) return;
      if (msg.type !== `${type}_RESULT` || msg.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(msg.result as T);
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ source: PAGE, type, requestId, ...extra }, window.location.origin);
  });
}

/**
 * Is the extension present? Detection is purely message-based — the content
 * script must not touch the DOM, or it trips React's hydration check. It
 * registers its listener at document_start, so a PING sent after mount is
 * always heard.
 */
export interface ExtensionInfo {
  present: boolean;
  version?: string;
  /** Message types this build handles — see bridge.js SUPPORTS */
  supports: string[];
}

export function detectExtensionInfo(timeoutMs = 800): Promise<ExtensionInfo> {
  if (typeof window === "undefined") return Promise.resolve({ present: false, supports: [] });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ present: false, supports: [] });
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      if (event.data?.source !== EXT || event.data?.type !== "READY") return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve({
        present: true,
        version: event.data.version,
        // An older build announced no capabilities at all. Treat that as
        // "transcript only" rather than assuming it can do everything.
        supports: Array.isArray(event.data.supports) ? event.data.supports : ["SYNC"],
      });
    }

    window.addEventListener("message", onMessage);
    window.postMessage({ source: PAGE, type: "PING" }, window.location.origin);
  });
}

export function detectExtension(timeoutMs = 800): Promise<boolean> {
  return detectExtensionInfo(timeoutMs).then((i) => i.present);
}

export async function syncTranscript(): Promise<SyncResult> {
  try {
    return await send<SyncResult>("SYNC");
  } catch {
    return { ok: false, reason: "timeout" };
  }
}

export async function openLogin(): Promise<void> {
  try {
    await send("OPEN_LOGIN", 3000);
  } catch {
    window.open("https://myfranciscan.franciscan.edu/ICS/", "_blank");
  }
}

export async function uninstallExtension(): Promise<void> {
  try {
    await send("UNINSTALL", 3000);
  } catch {
    // the browser's own confirm dialog handles it; nothing to do here
  }
}

// ---- live section search ----

export type SectionPageResult =
  | { ok: true; html: string }
  | { ok: false; reason: "auth"; loginUrl: string }
  | {
      ok: false;
      reason: "network" | "http" | "extension" | "timeout" | "unsupported";
      message?: string;
    };

export type SectionsResult =
  | { ok: true; payload: unknown }
  | {
      ok: false;
      reason: "network" | "http" | "blocked" | "extension" | "timeout" | "unsupported";
      message?: string;
    };

/**
 * Fetch the registration page. The app reads the search endpoint off it —
 * the worker can't, because an MV3 service worker has no DOMParser, and
 * because keeping every parser in one place is the whole point.
 */
export async function fetchSectionSearchPage(): Promise<SectionPageResult> {
  try {
    // The registration page is a heavy Jenzabar render — give it longer than
    // a normal message round trip.
    return await send<SectionPageResult>("SECTION_PAGE", 30000);
  } catch {
    return { ok: false, reason: "timeout" };
  }
}

/**
 * POST one page of results. The URL comes from the page and is re-validated
 * by the worker before use.
 *
 * The default here is generous because this endpoint does real work: it's
 * Jenzabar building a page of section rows out of a term with ~1,100 of them,
 * and a bigger page asks for proportionally more of it. Twelve seconds — fine
 * for fetching a page — turned a slow response into "timeout", which reads
 * like the extension is broken rather than the server being busy.
 */
export async function fetchSectionsPage(
  url: string,
  body: string,
  timeoutMs = 45000
): Promise<SectionsResult> {
  try {
    return await send<SectionsResult>("SECTIONS", timeoutMs, { url, body });
  } catch {
    return { ok: false, reason: "timeout" };
  }
}

/**
 * Switch the registration portlet to another term, and hand back the
 * re-rendered screen so the app can read that term's own search endpoint off
 * it. `fields` are the page's own hidden inputs plus the chosen term; the
 * worker refuses any other field name.
 */
export async function fetchTermPage(
  url: string,
  fields: Record<string, string>
): Promise<SectionPageResult> {
  try {
    return await send<SectionPageResult>("TERM_PAGE", 30000, { url, fields });
  } catch {
    return { ok: false, reason: "timeout" };
  }
}
