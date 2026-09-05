// Reads a prerequisite sentence as the boolean expression it is.
//
// The catalog states prerequisites in English, and the connectives carry the
// whole meaning:
//
//   "CSC 141, CSC 171 or CSC 144"          any one of three
//   "SFE 128 and SFE 240"                  both
//   "SFE 128 and (SFE 240 or CSC 256)"     one, plus either of two
//   "MTH 161 or permission of instructor"  one, or ask
//   "Sophomore Standing and CSC 144"       a credit threshold, plus a course
//
// Two wrong readings of that last-but-two case were live in this codebase at
// once. `planner.ts` treated any "or" anywhere as making the whole sentence a
// disjunction, so SFE 128 alone satisfied it — too permissive, and it offers
// students courses they can't register for. `plan.ts` treated any "and" as
// making it a conjunction, so it demanded CSC 256 as well — too strict, and it
// pushed a sophomore course past graduation. Neither is a small error: one
// invents eligibility, the other invents a blocker.
//
// So the sentence gets parsed once, here, and both callers use the result.
//
// Three-valued on purpose. "Permission of instructor" and standings we can't
// evaluate come back as `unknown` rather than false, because a planner that
// refuses to schedule anything gated on permission is more wrong than one that
// schedules it and says so.

export type Verdict = true | false | "unknown";

export interface PrereqResult {
  met: Verdict;
  /** Codes that would satisfy it if taken. Empty when already met. */
  missing: string[];
  /** Conditions we can't check ourselves, verbatim-ish */
  notes: string[];
}

type Node =
  | { type: "course"; code: string; concurrent?: boolean }
  | { type: "standing"; level: string; credits: number | null }
  | { type: "permission"; text: string }
  | { type: "and" | "or"; children: Node[] };

const COURSE = /^[A-Z]{2,4}\s?\d{3}[A-Z]?$/;

/**
 * Credit thresholds for class standing.
 *
 * These are the conventional US definitions and the catalog doesn't restate
 * them per course, so they live here — but a standing is only ever evaluated
 * when the caller supplies earned credits, and comes back `unknown` otherwise
 * rather than being assumed met.
 */
const STANDING_CREDITS: Record<string, number> = {
  freshman: 0,
  sophomore: 30,
  junior: 60,
  senior: 90,
};

/* -------------------------------------------------------------- tokenizer */

type Token =
  | { t: "code"; v: string; concurrent?: boolean }
  | { t: "and" | "or" | "(" | ")" }
  | { t: "comma" }
  | { t: "standing"; v: string }
  | { t: "permission"; v: string };

function tokenize(text: string): Token[] {
  const cleaned = text
    .replace(/^\s*(pre-?requisites?|prereq)\s*:?\s*/i, "")
    .replace(/–|—/g, "-")
    .trim();

  const tokens: Token[] = [];
  let i = 0;

  while (i < cleaned.length) {
    const rest = cleaned.slice(i);

    if (/^\s/.test(rest)) { i++; continue; }
    if (rest[0] === "(") { tokens.push({ t: "(" }); i++; continue; }
    if (rest[0] === ")") { tokens.push({ t: ")" }); i++; continue; }
    if (rest[0] === "," ) { tokens.push({ t: "comma" }); i++; continue; }
    if (rest[0] === ";" ) { tokens.push({ t: "and" }); i++; continue; }
    if (rest[0] === "." ) { i++; continue; }
    // "BIO 133- BIO 134" and "BIO 142-BIO 143" are course SEQUENCES: both are
    // required. Dropping the hyphen as punctuation lost the second course
    // entirely, which reads as a course with a lighter prerequisite than it
    // has.
    if (rest[0] === "-" ) { tokens.push({ t: "and" }); i++; continue; }

    const standing = rest.match(/^(freshman|sophomore|junior|senior)\s+standing/i);
    if (standing) {
      tokens.push({ t: "standing", v: standing[1].toLowerCase() });
      i += standing[0].length;
      continue;
    }

    // "permission of the instructor", "consent of the department chair"
    const permission = rest.match(/^(permission|consent)\b[^,;.()]*/i);
    if (permission) {
      tokens.push({ t: "permission", v: permission[0].trim() });
      i += permission[0].length;
      continue;
    }

    const code = rest.match(/^[A-Z]{2,4}\s?\d{3}[A-Z]?/);
    if (code) {
      i += code[0].length;
      // "CHM 112 (may be taken concurrently)" is a COREQUISITE, and the
      // distinction is the difference between a course you can take this term
      // and one you must wait a year for. The department guides show the same
      // thing informally — CSC 276 is scheduled beside SFE 240, which the
      // catalog calls its prerequisite.
      const concurrent = cleaned.slice(i).match(/^\s*\(\s*may be taken concurrently\s*\)/i);
      if (concurrent) i += concurrent[0].length;
      tokens.push({
        t: "code",
        v: code[0].replace(/\s+/g, " ").trim().toUpperCase(),
        concurrent: !!concurrent,
      });
      continue;
    }

    const word = rest.match(/^[A-Za-z][A-Za-z'-]*/);
    if (word) {
      const w = word[0].toLowerCase();
      if (w === "and" || w === "plus" || w === "both") tokens.push({ t: "and" });
      else if (w === "or" || w === "either") tokens.push({ t: "or" });
      // every other word is prose we don't need — "the", "of", "a grade of C"
      i += word[0].length;
      continue;
    }
    i++;
  }

  return tokens;
}

/**
 * Commas mean whichever connective closes the list.
 *
 * "CSC 141, CSC 171 or CSC 144" is three alternatives; "SFE 112, MTH 161 and
 * PHY 220" is three requirements. The comma itself is silent, so it takes its
 * meaning from the nearest explicit connective at the same nesting depth —
 * and where there is none, "and" is the safer default: over-requiring shows a
 * student a blocker they can check, while over-permitting sends them to a
 * registration screen that rejects them.
 */
function resolveCommas(input: Token[]): Token[] {
  // Drop parentheticals that hold no requirement at all — "(except for Honors
  // Program students)" is prose, and leaving an empty group in the stream
  // ended the parse there, silently dropping every course after it.
  const out: Token[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i].t !== "(") { out.push(input[i]); continue; }
    let depth = 1;
    let j = i + 1;
    let hasTerm = false;
    for (; j < input.length && depth > 0; j++) {
      const t = input[j].t;
      if (t === "(") depth++;
      else if (t === ")") depth--;
      else if (t === "code" || t === "standing" || t === "permission") hasTerm = true;
    }
    if (hasTerm) { out.push(input[i]); continue; }
    i = j - 1; // skip the whole empty group
  }
  let depth = 0;
  const depthOf: number[] = [];
  for (const tok of out) {
    if (tok.t === "(") { depthOf.push(depth); depth++; continue; }
    if (tok.t === ")") { depth--; depthOf.push(depth); continue; }
    depthOf.push(depth);
  }

  for (let i = 0; i < out.length; i++) {
    if (out[i].t !== "comma") continue;
    let connective: "and" | "or" = "and";
    for (let j = i + 1; j < out.length; j++) {
      if (depthOf[j] !== depthOf[i]) continue;
      if (out[j].t === "and" || out[j].t === "or") { connective = out[j].t as "and" | "or"; break; }
    }
    out[i] = { t: connective };
  }

  // "BUS 202, BUS 215, and ECO 212" becomes "and and" once the commas resolve,
  // and a doubled connective stops the parse dead — losing every term after
  // it. Collapse runs, and drop connectives that lead a group, which is what
  // prose like "All junior-level nursing courses and NUR 401" leaves behind
  // once the words are stripped.
  const collapsed: Token[] = [];
  for (const tok of out) {
    const prev = collapsed[collapsed.length - 1];
    const isConn = tok.t === "and" || tok.t === "or";
    if (isConn && (!prev || prev.t === "and" || prev.t === "or" || prev.t === "(")) continue;
    collapsed.push(tok);
  }
  while (collapsed.length && (collapsed[collapsed.length - 1].t === "and" || collapsed[collapsed.length - 1].t === "or")) {
    collapsed.pop();
  }
  return collapsed;
}

/* ----------------------------------------------------------------- parser */

/** Recursive descent: or binds loosest, then and, then a term. */
function parse(tokens: Token[]): Node | null {
  let pos = 0;

  function parseOr(): Node | null {
    const parts: Node[] = [];
    const first = parseAnd();
    if (first) parts.push(first);
    while (pos < tokens.length && tokens[pos].t === "or") {
      pos++;
      const next = parseAnd();
      if (next) parts.push(next);
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : { type: "or", children: parts };
  }

  function parseAnd(): Node | null {
    const parts: Node[] = [];
    const first = parseTerm();
    if (first) parts.push(first);
    while (pos < tokens.length) {
      if (tokens[pos].t === "and") {
        pos++;
      } else if (!isTermStart(tokens[pos])) {
        break;
      }
      // Two requirements side by side with no connective between them —
      // the catalog does this — are both required. Treating juxtaposition as
      // "stop parsing" silently halved those sentences.
      const next = parseTerm();
      if (!next) break;
      parts.push(next);
    }
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : { type: "and", children: parts };
  }

  function isTermStart(tok: Token | undefined): boolean {
    return !!tok && (tok.t === "code" || tok.t === "standing" || tok.t === "permission" || tok.t === "(");
  }

  function parseTerm(): Node | null {
    const tok = tokens[pos];
    if (!tok) return null;
    if (tok.t === "(") {
      pos++;
      const inner = parseOr();
      if (tokens[pos]?.t === ")") pos++;
      return inner;
    }
    if (tok.t === "code") { pos++; return { type: "course", code: tok.v, concurrent: tok.concurrent }; }
    if (tok.t === "standing") {
      pos++;
      return { type: "standing", level: tok.v, credits: STANDING_CREDITS[tok.v] ?? null };
    }
    if (tok.t === "permission") { pos++; return { type: "permission", text: tok.v }; }
    return null;
  }

  const tree = parseOr();
  return tree;
}

/*
 * Known limit: "at least seven of the following: …" is an N-of-M constraint,
 * and this grammar has no node for it (POL 435 is the only sentence in the
 * catalog that uses one). It parses as a conjunction of every course listed,
 * which over-requires rather than under-requires — the direction that shows a
 * student a blocker they can check with an advisor instead of sending them to
 * a registration screen that turns them away.
 */

/* -------------------------------------------------------------- evaluation */

function and3(values: Verdict[]): Verdict {
  if (values.includes(false)) return false;
  if (values.includes("unknown")) return "unknown";
  return true;
}
function or3(values: Verdict[]): Verdict {
  if (values.includes(true)) return true;
  if (values.includes("unknown")) return "unknown";
  return false;
}

export interface PrereqContext {
  completed: Set<string>;
  /** Credits earned by the time the course would be taken, if known */
  earnedCredits?: number;
}

function evaluate(node: Node, ctx: PrereqContext, missing: string[], notes: string[]): Verdict {
  switch (node.type) {
    case "course": {
      if (ctx.completed.has(node.code)) return true;
      if (node.concurrent) {
        // Not blocking: it can be taken in the same term. Say so rather than
        // scheduling around a wall that isn't there.
        notes.push(`${node.code} (may be taken concurrently)`);
        return "unknown";
      }
      missing.push(node.code);
      return false;
    }
    case "standing": {
      if (ctx.earnedCredits == null || node.credits == null) {
        notes.push(`${node.level} standing`);
        return "unknown";
      }
      const ok = ctx.earnedCredits >= node.credits;
      if (!ok) notes.push(`${node.level} standing (${node.credits} credits)`);
      return ok;
    }
    case "permission":
      notes.push(node.text);
      return "unknown";
    case "and":
      return and3(node.children.map((c) => evaluate(c, ctx, missing, notes)));
    case "or": {
      // Only report the missing codes of a disjunction if the whole thing
      // fails — listing alternatives a student doesn't need reads as a wall
      // of blockers.
      const sub: string[] = [];
      const verdict = or3(node.children.map((c) => evaluate(c, ctx, sub, notes)));
      if (verdict === false) missing.push(...sub);
      return verdict;
    }
  }
}

/**
 * Evaluates a prerequisite sentence.
 *
 * `codes` is the flat list the scraper extracted, used only as a fallback when
 * the sentence can't be parsed at all — in which case every code is required,
 * because that's the reading that fails safe.
 */
export function checkPrerequisites(
  text: string | undefined,
  codes: string[] | undefined,
  ctx: PrereqContext
): PrereqResult {
  const list = (codes ?? []).map((c) => c.replace(/\s+/g, " ").trim().toUpperCase());
  if (!text && list.length === 0) return { met: true, missing: [], notes: [] };

  const tree = text ? parse(resolveCommas(tokenize(text))) : null;
  if (!tree) {
    if (list.length > 0) {
      const missing = list.filter((c) => !ctx.completed.has(c));
      return { met: missing.length === 0, missing, notes: [] };
    }
    // A sentence with no course codes in it is still a requirement — "For CAT
    // majors only", "2 biology courses", "Junior or senior status with 3.0
    // qpa". Reading those as "no prerequisites" is how a planner cheerfully
    // schedules a course the student cannot register for, so they come back
    // unknown with the condition attached.
    const condition = (text ?? "").trim();
    return condition
      ? { met: "unknown", missing: [], notes: [condition] }
      : { met: true, missing: [], notes: [] };
  }

  const missing: string[] = [];
  const notes: string[] = [];
  const met = evaluate(tree, ctx, missing, notes);
  return {
    met,
    missing: met === true ? [] : [...new Set(missing)],
    notes: [...new Set(notes)],
  };
}

/** True when a course may be scheduled — permission-gated counts as maybe. */
export function schedulable(result: PrereqResult): boolean {
  return result.met !== false;
}

/** Exposed for tests: the parsed shape, so a bad reading is visible. */
export function describe(text: string): string {
  const tree = parse(resolveCommas(tokenize(text)));
  const render = (n: Node | null): string => {
    if (!n) return "-";
    switch (n.type) {
      case "course": return n.concurrent ? `${n.code}~` : n.code;
      case "standing": return `${n.level}-standing`;
      case "permission": return "permission";
      case "and": return `(${n.children.map(render).join(" AND ")})`;
      case "or": return `(${n.children.map(render).join(" OR ")})`;
    }
  };
  return render(tree);
}

export { COURSE as COURSE_CODE_PATTERN };
