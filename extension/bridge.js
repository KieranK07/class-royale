// Class Royale Sync — page bridge.
//
// Runs only on the Class Royale origin. Relays messages between the page and
// the worker, and announces its presence so the app can swap its setup
// instructions for a Sync button.
//
// The page cannot talk to the worker directly (chrome.runtime isn't exposed to
// page scripts), and the worker can't touch the page's DOM. This is the seam.

const TAG = "class-royale-sync";

// Deliberately does NOT touch the DOM. Stamping an attribute on <html> here
// runs before React hydrates and trips a hydration mismatch — the app then
// warns in console on every load. Announcing over postMessage only, and
// answering PING, gives the same detection with no DOM interference.
// What this build of the extension can do. The page checks this rather than
// discovering an old extension by waiting 12 seconds for a reply that is
// never coming.
const SUPPORTS = ["SYNC", "SECTION_PAGE", "SECTIONS", "TERM_PAGE", "OPEN_LOGIN", "UNINSTALL"];

function announce() {
  window.postMessage(
    {
      source: TAG,
      type: "READY",
      version: chrome.runtime.getManifest().version,
      supports: SUPPORTS,
    },
    window.location.origin
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", announce, { once: true });
} else {
  announce();
}
// The React app mounts after we announce, so we answer PING too.
window.addEventListener("message", (event) => {
  if (event.source !== window) return; // only same-page messages
  const msg = event.data;
  if (!msg || msg.source !== "class-royale-page") return;

  if (msg.type === "PING") {
    announce();
    return;
  }

  const forward = {
    SYNC: "CLASS_ROYALE_FETCH_TRANSCRIPT",
    SECTION_PAGE: "CLASS_ROYALE_FETCH_SECTION_PAGE",
    SECTIONS: "CLASS_ROYALE_FETCH_SECTIONS",
    TERM_PAGE: "CLASS_ROYALE_FETCH_TERM_PAGE",
    OPEN_LOGIN: "CLASS_ROYALE_OPEN_LOGIN",
    UNINSTALL: "CLASS_ROYALE_UNINSTALL",
  }[msg.type];

  // Never drop a request silently. Dropping one makes an out-of-date
  // extension look like a 12-second network timeout, which is the least
  // useful thing this could possibly report.
  if (!forward) {
    window.postMessage(
      {
        source: TAG,
        type: `${msg.type}_RESULT`,
        requestId: msg.requestId,
        result: {
          ok: false,
          reason: "unsupported",
          message: `This extension build (${chrome.runtime.getManifest().version}) doesn't handle ${msg.type}.`,
        },
      },
      window.location.origin
    );
    return;
  }

  // `url`/`body` travel for SECTIONS and `url`/`fields` for TERM_PAGE; the
  // worker validates the URL, and the field names, before it uses them.
  chrome.runtime.sendMessage(
    { type: forward, url: msg.url, body: msg.body, fields: msg.fields },
    (response) => {
      window.postMessage(
        {
          source: TAG,
          type: `${msg.type}_RESULT`,
          requestId: msg.requestId,
          result: chrome.runtime.lastError
            ? { ok: false, reason: "extension", message: chrome.runtime.lastError.message }
            : response,
        },
        window.location.origin
      );
    }
  );
});
