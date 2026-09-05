// Shared helpers for the catalog scrapers (scrape-catalog.mjs, scrape-core.mjs).

import * as cheerio from "cheerio";
import { ProxyAgent, setGlobalDispatcher } from "undici";

export const BASE = "https://franciscan.smartcatalogiq.com";
export const REQUEST_DELAY_MS = 400; // be polite — this is someone else's server

// Only relevant inside a sandboxed environment that routes egress through an
// HTTP(S) proxy (e.g. an https_proxy/HTTPS_PROXY env var, as some sandboxed
// dev environments set) — Node's built-in fetch does NOT honor those env
// vars automatically the way curl does, so without this, fetch() silently
// gets blocked even when curl works fine and the proxy would actually allow
// the request through. On a normal machine (no proxy env var set — the
// common case, e.g. running this directly in your own terminal) this is a
// no-op and fetch behaves normally.
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`(routing requests through proxy: ${proxyUrl})`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Class Royale catalog scraper)" },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.text();
}

/**
 * Works out which catalog is current, and where its parts live.
 *
 * Nothing here is constructed from a pattern, because the pattern has already
 * changed twice:
 *
 *   /en/2023-2024/undergraduate-catalog
 *   /en/2025-2026/undergraduate-catalog-2025-2026
 *   /en/2026-2027/academic-catalog-2026-2027        <- undergrad + graduate merged
 *
 * The old resolver matched only the middle form, so when the 2026-2027 catalog
 * appeared it silently kept returning 2025-2026 — the newest catalog it could
 * still recognise. No error, no empty result: a whole year stale, quietly.
 * That is the exact failure this project keeps designing against, so the slug
 * is now READ from the homepage rather than rebuilt from the year, and the
 * section that holds academic programs is read from the catalog's own index
 * rather than assumed.
 */
export async function resolveCatalog() {
  const $ = cheerio.load(await fetchHtml(`${BASE}/`));

  const byYear = new Map(); // "2026-2027" -> Set of slugs
  $("a[href^='/en/']").each((_, el) => {
    const m = ($(el).attr("href") || "").match(/^\/en\/(\d{4}-\d{4})\/([a-z0-9-]+)\/?$/);
    if (!m) return;
    if (!byYear.has(m[1])) byYear.set(m[1], new Set());
    byYear.get(m[1]).add(m[2]);
  });
  if (byYear.size === 0) {
    throw new Error(
      "Couldn't find any /en/<year>/<catalog> links on the catalog homepage — the site structure has changed."
    );
  }

  // "2026-2027" > "2025-2026" as plain strings works for this format.
  const year = [...byYear.keys()].sort().at(-1);
  const slugs = [...byYear.get(year)];

  // A graduate-only catalog is not the one we want; anything else is a
  // candidate, and a merged "academic-catalog" beats a split one.
  const usable = slugs.filter((s) => !/^graduate-catalog/.test(s));
  const slug =
    usable.find((s) => s.startsWith("academic-catalog")) ??
    usable.find((s) => s.startsWith("undergraduate-catalog")) ??
    usable[0];
  if (!slug) {
    throw new Error(
      `The newest catalog year (${year}) only has a graduate catalog: ${slugs.join(", ")}.`
    );
  }

  const catalogUrl = `${BASE}/en/${year}/${slug}`;

  // Which section holds the programs? 2025-2026 called it "academic-programs";
  // 2026-2027 splits undergraduate from graduate. Reading it off the index
  // means a rename doesn't silently scrape the wrong degree level — or
  // nothing at all.
  const index = cheerio.load(await fetchHtml(catalogUrl));
  const sections = new Set();
  index(`a[href^='/en/${year}/${slug}/']`).each((_, el) => {
    const parts = ($(el).attr?.("href") ?? index(el).attr("href") ?? "")
      .replace(`/en/${year}/${slug}/`, "")
      .replace(/\/$/, "")
      .split("/");
    if (parts.length === 1 && parts[0]) sections.add(parts[0]);
  });

  const programCandidates = [...sections].filter((s) => s.endsWith("academic-programs"));
  const programsPath =
    programCandidates.find((s) => s.startsWith("undergraduate")) ??
    programCandidates.find((s) => s === "academic-programs") ??
    programCandidates[0];
  if (!programsPath) {
    throw new Error(
      `Couldn't find an academic-programs section in ${catalogUrl}. Sections seen: ${[...sections].join(", ")}`
    );
  }

  return { year, slug, catalogUrl, programsPath };
}

/**
 * Back-compat for callers that only want the year string.
 *
 * Kept deliberately thin: everything that builds a URL should take the whole
 * resolved catalog, because the year alone is no longer enough to rebuild one.
 */
export async function resolveCurrentCatalogYear() {
  return (await resolveCatalog()).year;
}

/**
 * Department-level links have exactly one path segment after the programs
 * section; program-level links (a specific BS/minor/concentration) have two.
 * Filtering by path shape rather than CSS classes is more robust to markup
 * changes.
 */
export async function listDepartments(catalog) {
  const marker = `/${catalog.programsPath}/`;
  const $ = cheerio.load(await fetchHtml(`${catalog.catalogUrl}/${catalog.programsPath}`));
  const depts = new Map();

  $(`a[href*='${marker}']`).each((_, el) => {
    const href = $(el).attr("href") || "";
    const idx = href.indexOf(marker);
    if (idx === -1) return;
    const rest = href.slice(idx + marker.length).replace(/\/$/, "");
    if (rest.includes("/")) return; // program-level link, not a department
    if (!rest) return;
    const name = $(el).text().trim();
    if (!name) return;
    depts.set(rest, { slug: rest, name, url: `${BASE}${href}` });
  });

  return [...depts.values()];
}

/** Same path-shape trick, one level deeper: dept-slug/program-slug. */
export async function listPrograms(catalog, dept) {
  const marker = `/${catalog.programsPath}/`;
  const $ = cheerio.load(await fetchHtml(dept.url));
  const programs = new Map();

  $(`a[href*='${marker}']`).each((_, el) => {
    const href = $(el).attr("href") || "";
    const idx = href.indexOf(marker);
    if (idx === -1) return;
    const rest = href.slice(idx + marker.length).replace(/\/$/, "");
    const parts = rest.split("/");
    if (parts.length !== 2) return;
    if (parts[0] !== dept.slug) return;
    const name = $(el).text().trim();
    if (!name) return;
    programs.set(parts[1], { slug: parts[1], name, url: `${BASE}${href}` });
  });

  return [...programs.values()];
}
