// Core data model for Class Royale
//
// Everything here is designed around one goal: given a student's completed
// coursework, figure out (a) what's left for their declared major, and
// (b) which other majors/minors/concentrations are "almost free" because
// their requirements overlap heavily with courses the student has already
// taken or already needs.

/** A single course as it appears in the catalog. */
export interface Course {
  /** e.g. "CSC-215" — should be unique and match how the school lists it */
  code: string;
  title: string;
  credits: number;
  /** Free-text description from the catalog, optional */
  description?: string;
  /** Terms it's typically offered, e.g. ["Fall", "Spring"] */
  termsOffered?: string[];
  /** Departments/tags this course counts toward, for cross-listing */
  tags?: string[];
  /** Course codes named as prerequisites */
  prerequisites?: string[];
  /**
   * The prerequisite sentence verbatim. The connectives matter — "CSC 141,
   * CSC 171 or CSC 144" is a different requirement from "CSC 141 and
   * CSC 171" — and the code list alone loses that.
   */
  prerequisiteText?: string;
  corequisites?: string[];
  /** Same course under another code; either satisfies a requirement */
  crossListed?: string[];
  subject?: string;
  /**
   * Undergraduate unless we can show otherwise.
   *
   * The 2026-2027 catalog merged the undergraduate and graduate books, so the
   * course list went from 993 to 1,294 and now includes things like CSL 630
   * (Clinical Mental Health Counseling). Offering those to an undergraduate is
   * a wrong answer with no error attached, so they're marked — see
   * markGraduateCourses.
   */
  level?: "undergraduate" | "graduate";
}

/** One requirement "slot" within a program (major/minor/concentration/core). */
export interface RequirementGroup {
  id: string;
  /** Human label, e.g. "Core Programming Sequence" or "Free Electives" */
  label: string;
  /**
   * How many courses (or credits) from `options` are needed to satisfy
   * this group. If `unit` is "credits", `count` is a credit total;
   * if "courses", `count` is a number of courses.
   */
  count: number;
  unit: "courses" | "credits";
  /** Course codes that satisfy this group. Empty = any course matching `tags`. */
  options: string[];
  /** Alternative: satisfy via tag match instead of an explicit list */
  tags?: string[];
  /** Nested sub-requirements, if the school structures it that way */
  subgroups?: RequirementGroup[];
  /**
   * The catalog named this slot but gave no course code for it ("Statistics
   * Elective", "Natural Science Core with Lab"). It's a real requirement
   * with no resolvable options, so it can never be auto-satisfied — surface
   * it to the student rather than pretending it's done.
   */
  unresolved?: boolean;
  /**
   * These options came from a prose note beside the table ("Social Work
   * Elective Options: SWK 316, SWK 317, …") rather than from the requirement
   * row itself. Worth surfacing, since the binding is a judgement call.
   */
  optionsFromNote?: boolean;
  /**
   * These options came from the university Core Curriculum, because the row
   * only named a Core category ("Theology Core") and the courses live in the
   * Core section rather than on the program page.
   */
  optionsFromCore?: boolean;
  /** Which Core categories this row points at, e.g. ["THE"] or ["LIT","CFA"] */
  coreCategories?: string[];
  /**
   * Some requirements are a level range, not a list: "9 credits in 200-400
   * level biology courses, BIO 106 excluded". Kept as a rule rather than a
   * frozen list so it stays correct when the university adds courses — and
   * so a transcript course that isn't in our scraped catalog still matches.
   */
  subjectRule?: {
    subjects: string[];
    minLevel?: number | null;
    maxLevel?: number | null;
    excludes?: string[];
  };
  /** Where a rule came from, for provenance in the UI */
  ruleSource?: "catalog-note" | "catalog-prose" | "derived";
  /**
   * A genuinely unconstrained elective — the catalog lists no courses because
   * ANY course counts. That's a satisfiable requirement, not a gap, and
   * showing it as "no course list in the catalog" understates a student's
   * progress and misreads the catalog.
   */
  freeElective?: boolean;
}

/** A university-wide rule that must hold at graduation, independent of program. */
export interface GraduationRule {
  rule: string;
  number: number | null;
  unit: string | null;
  /** "all", "BA", "AA/AS", "minors", "undergraduate", … */
  appliesTo: string;
  /** The exact catalog sentence this came from */
  evidence: string;
  source: string;
}

export type ProgramType =
  | "major"
  | "minor"
  | "concentration"
  | "core"
  /**
   * A real catalog page that is NOT something a student declares —
   * a department overview ("Physics", "Modern Languages and Literatures")
   * or a reference listing ("Courses Grouped By Field"). Kept, because some
   * carry real rules in prose (the Honors Program page states the whole
   * Honors-to-Core substitution table), but never offered as a major.
   */
  | "reference";

export interface Program {
  id: string;
  name: string;
  type: ProgramType;
  /** Degree this program falls under, e.g. "BS", "BA" — majors only */
  degree?: string;
  totalCreditsRequired?: number;
  requirements: RequirementGroup[];
  /** Source URL this was scraped from, for provenance/debugging */
  sourceUrl?: string;
  lastScraped?: string; // ISO date
  department?: string;
  catalogYear?: string;
  /** Which catalog page shape this came from — see scripts/scrape-catalog.mjs */
  kind?: "tables" | "narrative" | "informational" | "department-page";
  /**
   * For narrative programs: the requirement text verbatim, because there is
   * no table to structure. Shown to the student as-is rather than being
   * silently treated as "no requirements".
   */
  narrative?: string[];
  /** Course codes found inside that prose */
  mentionedCodes?: string[];
  /**
   * Prose beside the requirements that isn't itself a requirement row —
   * substitution rules, recommendations, caveats. Kept verbatim because it
   * often changes what actually satisfies a requirement.
   */
  notes?: { section: string | null; text: string; codes: string[] }[];
  /**
   * Whether this program has requirements the engines can actually evaluate.
   * False for prose-only programs. Never rank or score an unscorable
   * program — empty requirements look identical to "already satisfied".
   */
  scorable?: boolean;
  /**
   * This program has no requirements section in the catalog — its courses
   * were read off the suggested four-year schedule, which mixes in Core
   * Curriculum. Its requirements therefore overlap the Core and will
   * double-count against it. Surface this rather than blending silently.
   */
  requirementsFromSchedule?: boolean;
}

/** A course the student has actually completed (or is currently taking). */
export interface CompletedCourse {
  /** Normalized to catalog form, e.g. "CSC 145" — section/mode suffix stripped */
  code: string;
  term: string; // e.g. "Fall 2025"
  grade?: string;
  creditsEarned: number;
  /** Currently enrolled, not yet graded (transcript grade "WIP") */
  inProgress?: boolean;
  /** Section/delivery-mode suffix as printed, e.g. "A", "HY B", "OL A" */
  section?: string;
  title?: string;
  attemptedCredits?: number;
  /** Credit transferred in from elsewhere (transcript grade "TR#") */
  isTransfer?: boolean;
}

export interface StudentRecord {
  studentId?: string;
  declaredMajor?: string; // Program id
  declaredMinors?: string[]; // Program ids
  completedCourses: CompletedCourse[];
}

/** Result of checking one program against a student's completed courses. */
export interface ProgramProgress {
  program: Program;
  satisfiedGroups: { groupId: string; satisfiedBy: string[] }[];
  remainingGroups: {
    groupId: string;
    label: string;
    stillNeeded: number;
    unit: "courses" | "credits";
    eligibleOptions: string[];
  }[];
  creditsCompleted: number;
  creditsRemaining: number;
  percentComplete: number;
}

/**
 * Result of the "free major" analysis: for a candidate program the student
 * hasn't declared, how much of it is already covered by courses they've
 * taken or still need for their declared major/minors.
 */
export interface OverlapAnalysis {
  program: Program;
  /** Courses already completed that count toward this program */
  overlappingCompleted: string[];
  /** Courses required by the declared major/minors that ALSO count here */
  overlappingWithDeclared: string[];
  /** Net new courses required to add this program */
  netNewCoursesNeeded: number;
  netNewCreditsNeeded: number;
}
