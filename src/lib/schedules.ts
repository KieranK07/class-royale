// The catalog's own four-year schedules, trimmed for the browser.
//
// scrape-schedules.mjs writes ~800KB; the planner needs about an eighth of
// that, so the server trims before shipping (see catalog-server.ts). What
// survives is codes, labels, credits and which term each sits in — everything
// a layout needs and nothing a layout reads.

export interface TemplateEntry {
  kind: "course" | "slot" | "wildcard";
  /** Every code that satisfies it — more than one means cross-listed */
  codes?: string[];
  /** For a slot: what the catalog called it, e.g. "Theology Core" */
  label?: string;
  title?: string;
  credits?: number | null;
}

export interface TemplateTerm {
  /** 1-based across the whole degree; null for summer/winter terms */
  index: number | null;
  label: string;
  season: "Fall" | "Spring" | "Summer" | "Winter" | null;
  /**
   * Set when the year branches into named tracks (the pre-engineering 2+2
   * pages do this). Terms sharing a year and differing here are alternatives,
   * not a longer year.
   */
  variant?: string | null;
  entries: TemplateEntry[];
}

export interface ScheduleTemplate {
  name: string;
  slug: string;
  terms: TemplateTerm[];
  /** Total credits the catalog's own layout adds up to */
  credits: number;
  sourceUrl: string;
}

/**
 * Finds the schedule for a program.
 *
 * Program names come from one scrape and schedules from another, so they
 * match exactly far more often than not — but a concentration picked in the
 * UI ("Computer Science (Cybersecurity Concentration), Bachelor of Science")
 * has its own page and its own schedule, and falling back to the base major's
 * layout would quietly plan the wrong degree. So: exact match only, then a
 * deliberate, reported fallback.
 */
export function findTemplate(
  templates: ScheduleTemplate[],
  programName: string
): { template: ScheduleTemplate | null; exact: boolean } {
  const exact = templates.find((t) => t.name === programName);
  if (exact) return { template: exact, exact: true };
  return { template: null, exact: false };
}
