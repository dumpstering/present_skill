#!/usr/bin/env python3
"""Collect recent Claude Code, Codex and Pi sessions into one digest for finding loose threads.

Standard library only, Python 3.8+. Reads transcripts and runs read-only git commands; it writes
nothing but the digest. Claude reads the digest, judges what was left open, and presents the
ranked result with `present.py show <board.json> --kind threads`.

  threads.py --since 1d [--exclude SESSION_ID] [--no-gh] [--out FILE]

  --since    1h, 4h, 1d (default), 1w, 1m, or any number with h/d/w/m (m = 30 days)
  --exclude  a session id to leave out, normally the session running this command
  --no-gh    skip the GitHub lookup of open pull requests

Roots (env): CLAUDE_CONFIG_DIR (~/.claude), CODEX_HOME (~/.codex), PI_SESSIONS (~/.pi/agent/sessions).
Subagent transcripts (Claude) and child sessions (Pi) are skipped: their parent reports what they did.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

WINDOW_RE = re.compile(r"^(\d+)([hdwm])$")
UNIT_SECONDS = {"h": 3600, "d": 86400, "w": 7 * 86400, "m": 30 * 86400}
ASK_TEXT_CHARS = 300    # each user message kept in the digest
FINAL_TEXT_CHARS = 900  # the last assistant message
RECENT_ASKS = 3
GIT_TIMEOUT = 5
# Injected context, not something the user typed: command wrappers, reminders, AGENTS.md blocks.
NOT_TYPED_RE = re.compile(r"^\s*(<|# AGENTS\.md|\[external_agent|Caveat:)")
INTERRUPTED = "[Request interrupted by user"
QUESTION_END_RE = re.compile(r"\?[\s*_`)\]]*$")


def roots():
    home = Path.home()
    claude = Path(os.environ.get("CLAUDE_CONFIG_DIR") or home / ".claude") / "projects"
    codex = Path(os.environ.get("CODEX_HOME") or home / ".codex") / "sessions"
    pi = Path(os.environ.get("PI_SESSIONS") or home / ".pi" / "agent" / "sessions")
    return claude, codex, pi


def window_seconds(text):
    m = WINDOW_RE.match(text.strip().lower())
    if not m or int(m.group(1)) < 1:
        raise ValueError(f"window must look like 4h, 1d, 1w or 1m, not {text!r}")
    return int(m.group(1)) * UNIT_SECONDS[m.group(2)]


def read_jsonl(path):
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    records = []
    for line in lines:
        try:
            records.append(json.loads(line))
        except ValueError:
            continue  # a line still being written
    return records


def text_parts(content, kinds=("text", "input_text", "output_text")):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") in kinds).strip()


def clip(text, limit):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def epoch(stamp):
    try:
        return int(datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return 0


def session(source, sid, cwd, title, asks, final, interrupted, started, ended, resume):
    return {"source": source, "id": sid, "cwd": cwd, "title": title, "asks": asks, "final": final,
            "interrupted": interrupted, "ends_with_question": bool(QUESTION_END_RE.search(final or "")),
            "started": started, "ended": ended, "resume": resume}


def read_claude(path):
    records = read_jsonl(path)
    cwd, title, asks, final, interrupted, stamps = "", "", [], "", False, []
    for r in records:
        if r.get("timestamp"):
            stamps.append(epoch(r["timestamp"]))
        cwd = r.get("cwd") or cwd
        if r.get("type") == "ai-title":
            title = r.get("aiTitle") or title
        if r.get("type") == "user" and not r.get("isMeta"):
            text = text_parts((r.get("message") or {}).get("content"), ("text",))
            if text.startswith(INTERRUPTED):
                interrupted = True
            elif text and not NOT_TYPED_RE.match(text):
                asks.append(text)
                interrupted = False
        if r.get("type") == "assistant":
            text = text_parts((r.get("message") or {}).get("content"), ("text",))
            if text:
                final = text
    if not asks:
        return None
    sid = path.stem
    return session("claude", sid, cwd, title or asks[0], asks, final, interrupted,
                   min(stamps or [0]), max(stamps or [0]), f"cd {cwd} && claude --resume {sid}")


def read_codex(path):
    records = read_jsonl(path)
    cwd, sid, asks, final, stamps = "", path.stem, [], "", []
    for r in records:
        if r.get("timestamp"):
            stamps.append(epoch(r["timestamp"]))
        p = r.get("payload") or {}
        if r.get("type") == "session_meta":
            cwd, sid = p.get("cwd") or cwd, p.get("id") or sid
        if r.get("type") == "response_item" and p.get("type") == "message":
            text = text_parts(p.get("content"))
            if p.get("role") == "user" and text and not NOT_TYPED_RE.match(text):
                asks.append(text)
            if p.get("role") == "assistant" and text and not NOT_TYPED_RE.match(text):
                final = text
        if r.get("type") == "event_msg" and p.get("type") == "task_complete" and p.get("last_agent_message"):
            final = p["last_agent_message"]
    if not asks:
        return None
    return session("codex", sid, cwd, asks[0], asks, final, False,
                   min(stamps or [0]), max(stamps or [0]), f"cd {cwd} && codex resume {sid}")


def read_pi(path):
    records = read_jsonl(path)
    cwd, sid, title, asks, final, stamps = "", path.stem, "", [], "", []
    for r in records:
        if r.get("timestamp"):
            stamps.append(epoch(r["timestamp"]))
        if r.get("type") == "session":
            if r.get("parentSession"):
                return None  # a worker spawned by another session
            cwd, sid = r.get("cwd") or cwd, r.get("id") or sid
        if r.get("type") == "session_info":
            title = r.get("name") or title
        if r.get("type") == "message":
            m = r.get("message") or {}
            text = text_parts(m.get("content"))
            if m.get("role") == "user" and text and not NOT_TYPED_RE.match(text):
                asks.append(text)
            if m.get("role") == "assistant" and text:
                final = text
    if not asks:
        return None
    return session("pi", sid, cwd, title or asks[0], asks, final, False,
                   min(stamps or [0]), max(stamps or [0]), f"cd {cwd} && pi --session {sid}")


def recent_files(since):
    claude, codex, pi = roots()
    found = []
    for source, root, pattern in (("claude", claude, "*/*.jsonl"), ("codex", codex, "**/rollout-*.jsonl"),
                                  ("pi", pi, "*/*.jsonl")):
        if not root.is_dir():
            continue
        for path in root.glob(pattern):
            try:
                if path.stat().st_mtime >= since:
                    found.append((source, path))
            except OSError:
                continue
    return found


def run(args, cwd):
    try:
        r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=GIT_TIMEOUT)
        return r.stdout.strip() if r.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def git_state(cwd, use_gh):
    """Uncommitted files, commits not on the upstream, and open PRs for one working folder."""
    if not cwd or not Path(cwd).is_dir() or run(["git", "rev-parse", "--is-inside-work-tree"], cwd) != "true":
        return None
    status = run(["git", "status", "--porcelain"], cwd) or ""
    state = {"branch": run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd) or "",
             "uncommitted": len([l for l in status.splitlines() if l.strip()])}
    ahead = run(["git", "rev-list", "--count", "@{upstream}..HEAD"], cwd)
    state["unpushed"] = int(ahead) if ahead is not None and ahead.isdigit() else None  # None: no upstream
    if use_gh:
        prs = run(["gh", "pr", "list", "--author", "@me", "--state", "open", "--json", "number,title,headRefName"], cwd)
        try:
            state["open_prs"] = json.loads(prs) if prs else []
        except ValueError:
            state["open_prs"] = []
    return state


def stamp(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if ts else "unknown"


def digest(since_seconds, exclude="", use_gh=True, now=None):
    now = now or time.time()
    readers = {"claude": read_claude, "codex": read_codex, "pi": read_pi}
    sessions = []
    for source, path in recent_files(now - since_seconds):
        s = readers[source](path)
        if s and s["id"] != exclude and not (exclude and path.stem == exclude):
            sessions.append(s)
    sessions.sort(key=lambda s: s["ended"], reverse=True)
    repos = {}
    for s in sessions:
        if s["cwd"] not in repos:
            repos[s["cwd"]] = git_state(s["cwd"], use_gh)

    out = [f"# Session digest: {len(sessions)} session(s) active since {stamp(now - since_seconds)}", ""]
    for s in sessions:
        flags = [f for f, on in (("interrupted", s["interrupted"]), ("ends with a question", s["ends_with_question"])) if on]
        out += [f"## {s['source']} {s['id']}: {clip(s['title'], 90)}",
                f"- folder: {s['cwd'] or 'unknown'}",
                f"- active: {stamp(s['started'])} to {stamp(s['ended'])} (ended_epoch={s['ended']})",
                f"- resume: `{s['resume']}`"]
        if flags:
            out.append("- flags: " + ", ".join(flags))
        out.append("- first ask: " + clip(s["asks"][0], ASK_TEXT_CHARS))
        for ask in s["asks"][1:][-RECENT_ASKS:]:
            out.append("- later ask: " + clip(ask, ASK_TEXT_CHARS))
        out += ["- last reply: " + (clip(s["final"], FINAL_TEXT_CHARS) or "(none)"), ""]

    out += ["# Git state per folder", ""]
    for cwd, g in repos.items():
        if not g:
            continue
        upstream = "no upstream" if g["unpushed"] is None else f"{g['unpushed']} unpushed commit(s)"
        line = f"- {cwd} [{g['branch']}]: {g['uncommitted']} uncommitted file(s), {upstream}"
        if g.get("open_prs"):
            line += "; open PRs: " + ", ".join(f"#{p['number']} {p['title']}" for p in g["open_prs"])
        out.append(line)
    return "\n".join(out) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(prog="threads.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--since", default="1d")
    parser.add_argument("--exclude", default="")
    parser.add_argument("--no-gh", action="store_true")
    parser.add_argument("--out", default="")
    args = parser.parse_args(argv)
    try:
        seconds = window_seconds(args.since)
    except ValueError as exc:
        parser.error(str(exc))
    text = digest(seconds, args.exclude.strip(), not args.no_gh)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"Digest written: {args.out} ({text.count(chr(10) + '## ')} session(s))")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
