"""
jobspy_fetch.py — the Python side of the JobSpy bridge.

Reads a JSON config on stdin, runs JobSpy, writes a JSON array of jobs to the
file path given as argv[1]. Nothing is printed to stdout.

Writing to a file rather than stdout is deliberate: JobSpy (and the HTTP stack
under it) log to the console, and any stray line would corrupt a stdout JSON
stream. The file is the contract; stdout/stderr are free to be noisy.

Encoding is forced to UTF-8 everywhere. Polish listings are full of ł/ę/ó and
the Windows console default (cp1252) raises UnicodeEncodeError on them.
"""

import json
import logging
import random
import sys
import time
import warnings

warnings.filterwarnings("ignore")

# LinkedIn pages hold 10 cards. JobSpy 1.1.82 pages them wrongly: after each
# page it moves `start` by the whole list collected so far (0, 10, 30, 60,
# 100…), so of the first 200 results of a query it reads 60. And on HTTP 429 it
# logs an error and returns what it has, with no exception: the run looked like
# a success, and the next incremental pass started after the gap. So LinkedIn
# is paged here, one page per call (offset), and the bridge watches the log.
LINKEDIN_PAGE = 10
# Under jobspy.ts's 180 s kill: stop early and keep what was read. A cap like
# results_wanted, not a failure: the most relevant results come first.
LINKEDIN_BUDGET_S = 150


class ErrorLog(logging.Handler):
    """Collects the error lines JobSpy logs instead of raising."""

    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


def keep_one_part_locations() -> None:
    """
    JobSpy 1.1.82 reads a LinkedIn card's location only when it has two or
    three parts ("Warsaw, Mazowieckie, Poland"). A one-part one — "Poland",
    "European Union", "EMEA", which on a remote search means "anywhere there" —
    becomes country "worldwide", and display_location() drops that: 185 of 723
    stored LinkedIn rows had no location though LinkedIn said Poland, and the
    verdict read "Где: не указано". Keep the string as the location.
    """
    try:
        from jobspy.linkedin import LinkedIn
        from jobspy.model import Location
    except ImportError:
        return
    original = LinkedIn._get_location

    def get_location(self, metadata_card):
        location = original(self, metadata_card)
        tag = metadata_card.find("span", class_="job-search-card__location") if metadata_card is not None else None
        text = tag.text.strip() if tag else ""
        return Location(country=text) if text and ", " not in text else location

    LinkedIn._get_location = get_location


def scrape_linkedin(scrape_jobs, kwargs: dict) -> tuple[list, str | None]:
    """All pages up to results_wanted, one request per call. Returns (frames, partial)."""
    errors = ErrorLog()
    logging.getLogger("JobSpy:LinkedIn").addHandler(errors)
    wanted = kwargs["results_wanted"]
    started = time.monotonic()
    frames, seen, offset = [], set(), 0
    partial = None
    while offset < min(wanted, 1000):
        before = len(errors.messages)
        frame = scrape_jobs(**{**kwargs, "results_wanted": LINKEDIN_PAGE, "offset": offset})
        failed = errors.messages[before:]
        rows = 0 if frame is None else len(frame)
        if rows:
            fresh = frame[~frame["id"].isin(seen)] if "id" in frame else frame
            seen.update(fresh["id"].tolist() if "id" in fresh else [])
            frames.append(fresh)
        if failed:
            partial = failed[-1]
            break
        if rows < LINKEDIN_PAGE:
            break
        offset += LINKEDIN_PAGE
        if time.monotonic() - started > LINKEDIN_BUDGET_S:
            break
        # JobSpy's own pause between pages.
        time.sleep(random.uniform(3, 7))
    return frames, partial


def fail(message: str, out_path: str | None) -> None:
    """Report a fatal error through the result file, then exit non-zero."""
    if out_path:
        try:
            with open(out_path, "w", encoding="utf-8") as handle:
                json.dump({"error": message, "jobs": []}, handle)
        except OSError:
            pass
    print(message, file=sys.stderr)
    sys.exit(1)


def main() -> None:
    out_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not out_path:
        fail("usage: jobspy_fetch.py <output.json>  (config on stdin)", None)

    try:
        config = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as error:
        fail(f"bad config JSON: {error}", out_path)

    try:
        from jobspy import scrape_jobs
    except ImportError:
        fail("python-jobspy is not installed in this interpreter", out_path)

    # Only pass through what JobSpy actually accepts, so a stray key from the
    # Node side can never blow up the call.
    kwargs = {
        "site_name": config.get("sites") or ["indeed"],
        "search_term": config.get("query") or "",
        "location": config.get("location") or "Poland",
        "results_wanted": int(config.get("resultsWanted") or 50),
        "hours_old": int(config.get("hoursOld") or 336),
        "country_indeed": config.get("countryIndeed") or "poland",
        "description_format": "markdown",
        "verbose": 0,
    }
    if config.get("isRemote"):
        kwargs["is_remote"] = True
    if config.get("jobType"):
        kwargs["jobType"] = config["jobType"]
    if config.get("googleSearchTerm"):
        kwargs["google_search_term"] = config["googleSearchTerm"]
    if config.get("linkedinFetchDescription"):
        kwargs["linkedin_fetch_description"] = True
    if config.get("proxies"):
        kwargs["proxies"] = config["proxies"]

    partial = None
    try:
        if kwargs["site_name"] == ["linkedin"]:
            keep_one_part_locations()
            frames, partial = scrape_linkedin(scrape_jobs, kwargs)
        else:
            frames = [scrape_jobs(**kwargs)]
    except Exception as error:  # noqa: BLE001 - any scraper failure is a skip
        fail(f"{type(error).__name__}: {error}", out_path)

    jobs = []
    for frame in frames:
        if frame is None or len(frame) == 0:
            continue
        # NaN/NaT are not valid JSON; convert the frame to objects and clean up.
        for record in frame.to_dict(orient="records"):
            clean = {}
            for key, value in record.items():
                if value is None:
                    continue
                # pandas NaN/NaT: not equal to itself.
                if isinstance(value, float) and value != value:
                    continue
                if hasattr(value, "isoformat"):
                    clean[key] = value.isoformat()
                elif isinstance(value, (str, int, float, bool)):
                    clean[key] = value
                else:
                    clean[key] = str(value)
            jobs.append(clean)

    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({"jobs": jobs, "partial": partial}, handle, ensure_ascii=False)


if __name__ == "__main__":
    main()
