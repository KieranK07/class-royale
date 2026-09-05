/**
 * Bumped by hand whenever a build is handed over.
 *
 * It exists because "is the new code actually running?" cost a round trip
 * more than once: the app looked identical, the fix was in a file that hadn't
 * been unzipped, and nothing on screen could tell the two apart. Now it can.
 */
export const APP_BUILD = "2026.08.25-catalog2627";

/** The extension build this app expects. Older ones still work, with less. */
export const EXPECTED_EXTENSION = "0.4.0";
