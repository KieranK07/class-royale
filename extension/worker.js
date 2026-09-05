// Class Royale Sync — background worker.
//
// This does exactly one thing: fetch the transcript page from the user's own
// logged-in session and hand back the HTML. It does NOT parse it. Parsing
// lives in the Class Royale app (src/lib/transcript.ts), so there is only one
// parser to fix when Jenzabar changes their markup.
//
// It never reads, stores or transmits a cookie. `credentials: "include"` asks
// the BROWSER to attach the session it already has; this code never sees it.
// Nothing is sent to any server — the HTML goes straight back to the page.

const TRANSCRIPT_URL =
  "https://myfranciscan.franciscan.edu/ICS/Registration/New_Undergraduate.jnz" +
  "?portlet=My_Unofficial_Transcript&hideUI=1";

const LOGIN_URL = "https://myfranciscan.franciscan.edu/ICS/";

// The page that carries the course-search endpoint pre-filled with the
// portlet id, the student id and the current term.
const SECTION_SEARCH_PAGE =
  "https://myfranciscan.franciscan.edu/ICS/Academics/Academics_Homepage.jnz" +
  "?portlet=Student_Registration&screen=StudentRegistrationPortlet_CourseSearchView&screenType=next";

/**
 * Only this one endpoint may be POSTed to.
 *
 * The URL is supplied by the page, because it carries live ids this worker
 * has no way to know. That does NOT mean it can be used unchecked — a bounded
 * worker that refuses anything else is the difference between a sync tool and
 * a general-purpose request proxy sitting on the user's Franciscan session.
 */
function isAllowedSectionEndpoint(url) {
  try {
    const u = new URL(url, "https://myfranciscan.franciscan.edu");
    return (
      u.protocol === "https:" &&
      u.hostname === "myfranciscan.franciscan.edu" &&
      u.pathname ===
        "/ICS/webserviceproxy/exi/rest/studentregistration/pagedsectiondataforsearch"
    );
  } catch {
    return false;
  }
}

/**
 * The registration portlet's own form endpoint — where its term dropdown
 * posts when a student changes term.
 *
 * Same reasoning as isAllowedSectionEndpoint: the app supplies the URL
 * because it read it off the page, and this worker refuses anything that
 * isn't precisely that one portlet's form. The field names are bounded too,
 * so this can never become a way to post arbitrary form data into someone's
 * Jenzabar session.
 */
// Field NAMES can't be an allowlist here: the app serializes whatever form
// the portal actually rendered, so a hardcoded list would silently drop a
// field the server started requiring. They're bounded by SHAPE instead —
// plausible form-field names, a sane count, and a sane size — which keeps
// this from becoming a way to post arbitrary payloads while still letting
// the real form through unchanged.
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const MAX_FIELDS = 60;
const MAX_VALUE_LENGTH = 1024;

function checkFields(fields) {
  const entries = Object.entries(fields || {});
  if (entries.length > MAX_FIELDS) return `too many fields (${entries.length})`;
  for (const [name, value] of entries) {
    if (!FIELD_NAME.test(name)) return `field name not allowed: ${name}`;
    if (String(value).length > MAX_VALUE_LENGTH) return `field too long: ${name}`;
  }
  return null;
}

function isAllowedPortletFormUrl(url) {
  try {
    const u = new URL(url, "https://myfranciscan.franciscan.edu");
    return (
      u.protocol === "https:" &&
      u.hostname === "myfranciscan.franciscan.edu" &&
      u.pathname === "/ICS/Academics/Academics_Homepage.jnz" &&
      u.searchParams.get("portlet") === "Student_Registration"
    );
  } catch {
    return false;
  }
}

/**
 * A logged-out fetch doesn't fail — it succeeds, and returns Franciscan's SAML
 * redirect page with a 200. Detect it by what the transcript page must
 * contain, rather than by status code.
 */
function looksLoggedOut(html) {
  return !html.includes("GroupedGrid");
}

async function fetchTranscript() {
  let res;
  try {
    res = await fetch(TRANSCRIPT_URL, {
      credentials: "include",
      redirect: "follow",
      headers: { Accept: "text/html" },
    });
  } catch (err) {
    return { ok: false, reason: "network", message: String(err) };
  }

  if (!res.ok) {
    return { ok: false, reason: "http", message: `${res.status} ${res.statusText}` };
  }

  const html = await res.text();
  if (looksLoggedOut(html)) {
    return { ok: false, reason: "auth", loginUrl: LOGIN_URL };
  }
  return { ok: true, html };
}

/** Fetch the registration page so the app can read the endpoint off it. */
async function fetchSectionSearchPage() {
  try {
    const res = await fetch(SECTION_SEARCH_PAGE, {
      credentials: "include",
      redirect: "follow",
      headers: { Accept: "text/html" },
    });
    if (!res.ok) return { ok: false, reason: "http", message: `${res.status} ${res.statusText}` };
    const html = await res.text();
    // Same tell as the transcript: a logged-out fetch returns 200 with the
    // SSO page, so detect by what the page must contain.
    if (!html.includes("pagedsectiondataforsearch")) {
      return { ok: false, reason: "auth", loginUrl: LOGIN_URL };
    }
    return { ok: true, html };
  } catch (err) {
    return { ok: false, reason: "network", message: String(err) };
  }
}

/** POST one page of section results. `url` and `body` both come from the app. */
async function fetchSectionsPage(url, body) {
  if (!isAllowedSectionEndpoint(url)) {
    return { ok: false, reason: "blocked", message: "URL is not the section-search endpoint" };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/html, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
      },
      body,
    });
    if (!res.ok) return { ok: false, reason: "http", message: `${res.status} ${res.statusText}` };
    return { ok: true, payload: await res.json() };
  } catch (err) {
    return { ok: false, reason: "network", message: String(err) };
  }
}

/**
 * POST one of the registration portlet's own forms — the term dropdown, or
 * the course search — and hand back the re-rendered screen. The app reads that term's own search endpoint off it —
 * asking the page beats rewriting the term in a URL, because each portlet id
 * seen so far has been bound to one term and rewriting may quietly return the
 * wrong one.
 */
async function fetchTermPage(url, fields) {
  if (!isAllowedPortletFormUrl(url)) {
    return { ok: false, reason: "blocked", message: "URL is not the registration portlet form" };
  }
  const problem = checkFields(fields);
  if (problem) return { ok: false, reason: "blocked", message: problem };
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields || {})) body.set(name, String(value));
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      redirect: "follow",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "text/html, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
    });
    if (!res.ok) return { ok: false, reason: "http", message: `${res.status} ${res.statusText}` };
    return { ok: true, html: await res.text() };
  } catch (err) {
    return { ok: false, reason: "network", message: String(err) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CLASS_ROYALE_PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }
  if (msg?.type === "CLASS_ROYALE_FETCH_TRANSCRIPT") {
    fetchTranscript().then(sendResponse);
    return true; // keep the message channel open for the async reply
  }
  if (msg?.type === "CLASS_ROYALE_FETCH_SECTION_PAGE") {
    fetchSectionSearchPage().then(sendResponse);
    return true;
  }
  if (msg?.type === "CLASS_ROYALE_FETCH_SECTIONS") {
    fetchSectionsPage(msg.url, msg.body).then(sendResponse);
    return true;
  }
  if (msg?.type === "CLASS_ROYALE_FETCH_TERM_PAGE") {
    fetchTermPage(msg.url, msg.fields).then(sendResponse);
    return true;
  }
  if (msg?.type === "CLASS_ROYALE_OPEN_LOGIN") {
    chrome.tabs.create({ url: LOGIN_URL });
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "CLASS_ROYALE_UNINSTALL") {
    // Clean exit hatch — the extension removes itself. The browser still
    // shows its own confirmation prompt; that can't be bypassed.
    chrome.management.uninstallSelf({ showConfirmDialog: true });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
