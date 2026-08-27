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
import sys
import warnings

warnings.filterwarnings("ignore")


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

    try:
        frame = scrape_jobs(**kwargs)
    except Exception as error:  # noqa: BLE001 - any scraper failure is a skip
        fail(f"{type(error).__name__}: {error}", out_path)

    jobs = []
    if frame is not None and len(frame) > 0:
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
        json.dump({"jobs": jobs}, handle, ensure_ascii=False)


if __name__ == "__main__":
    main()
