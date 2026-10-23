/**
 * jobkey.ts — one identity for a posting, used everywhere a job is compared:
 * dedupe, the dismissed list, and "have I applied to this?".
 *
 * Exact URLs are not an identity. Boards append tracking parameters that come
 * and go — Himalayas started adding `?utm_source=api` to every link in October
 * 2026, and every job hidden or applied to before that came back as new. But
 * stripping the whole query string is wrong too: plenty of career sites keep
 * the job id there (`jobdetails?id=R00363440`, `Offer.aspx?oid=…`,
 * `career_job_req_id=…`), and dropping it merged distinct roles into one.
 *
 * So: drop only parameters known to be tracking, keep everything else, and sort
 * what is left so parameter order cannot matter. No dependencies on purpose —
 * db.ts imports this, and db.ts must stay the only better-sqlite3 importer
 * without dragging the source adapters along.
 */

/** Query parameters that never identify a job — only where the click came from. */
const TRACKING_PARAMS = new Set([
  "source",
  "src",
  "ref",
  "refid",
  "trk",
  "gh_src",
  "lever-source",
  "lever-origin",
  "jobsite",
  "jobboard",
  "posteddate",
  "iis",
  "iisn",
  "indeed-apply-token",
  "in_iframe",
  "lang",
  "locale",
]);

function isTracking(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

/**
 * host + path + identifying query, lowercased, without scheme, `www.` or a
 * trailing slash. A fragment is kept only when it carries an id (single-page
 * career sites route `#detail/job/897441`); `#apply`-style anchors are dropped.
 */
export function jobKey(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !isTracking(name))
    .map(([name, value]) => `${name}=${value}`)
    .sort();
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  const fragment = /\d/.test(parsed.hash) ? parsed.hash : "";

  return `${host}${path}${query}${fragment}`.toLowerCase();
}
