#!/usr/bin/env python3
"""Open a long Claude Code reply, question, or plan as a formatted local browser page.

Windows / macOS / Linux; Chrome, Edge, Firefox, Safari. Standard library only,
Python 3.8+. See README.md.

One page per session (out/<session>.html). The page polls a sibling feed file
(out/<session>.data.js) and re-renders in place, so there is no tab scripting:
the first call opens a tab, later calls only rewrite the feed.

CLI:
  present.py show <file.md | ->  [--kind reply|question|plan] [--session=ID] [--open] [--no-open]
  present.py turn                [--back N] [--session=ID] [--open] [--no-open]
  present.py theme [id]
  present.py on | off | status | last | prune
  present.py                     (no arguments: hook mode, reads a hook payload on stdin)

  show   render a markdown file (or stdin) that Claude wrote
  turn   render a finished turn straight from the session transcript (no rewriting)
         --back 1 (default) is the turn before the one now running
  theme  list the page styles, or set the one open pages switch to
  on/off enable or disable HOOK mode only (hooks are optional; README.md)
  last   reopen the newest page

Env knobs:
  CLAUDE_PRESENT=0       disable hook mode for this shell
  PRESENT_MIN_WORDS=200  hook mode: word threshold for plain replies
  PRESENT_DRY_RUN=1      decide and log, but write and open nothing
  PRESENT_OUT=<dir>      write pages somewhere other than ./out (used by the tests)
  CLAUDE_CONFIG_DIR      honored when looking for transcripts and settings
"""
import argparse
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import webbrowser
from datetime import datetime
from pathlib import Path

HOME = Path(__file__).resolve().parent
OUT = Path(os.environ.get("PRESENT_OUT") or HOME / "out")
ASSETS = "_assets"  # copied next to the pages: browsers restrict file:// pages to their own folder
LOG = Path(os.environ.get("PRESENT_LOG") or HOME / "present.log")
OFF = HOME / "OFF"
SETTINGS = Path(os.environ.get("PRESENT_SETTINGS") or HOME / "settings.json")
TEMPLATE = HOME / "template.html"
PAGE_JS = HOME / "page.js"
VENDOR_MARKED = HOME / "vendor" / "marked.umd.js"
CONFIG_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
PROJECTS = CONFIG_DIR / "projects"

# No inline script and no network. Both 'self' and file: are listed because browsers differ on
# which of the two matches a page opened from disk.
CSP = ("default-src 'none'; script-src 'self' file:; style-src 'unsafe-inline'; "
       "font-src 'self' file:; img-src data:; base-uri 'none'; form-action 'none'")

MIN_WORDS = int(os.environ.get("PRESENT_MIN_WORDS", "200"))
TABLE_MIN_WORDS = 80
QUESTION_MIN_WORDS = 60
RETENTION_DAYS = 14
MAX_ENTRIES = 25      # per session page; older entries drop off the feed
SHOWN_MAX_AGE = 1800  # seconds; a marker older than this belongs to an earlier turn

FEED_PREFIX = "window.__present && window.__present("
FEED_SUFFIX = ");\n"

TABLE_RE = re.compile(r"(?m)^\s*\|.*\|\s*$\n^\s*\|?\s*:?-{3,}")
ENDS_WITH_QUESTION_RE = re.compile(r"\?[\s*_`)\]]*$")

LABELS = {"reply": "Reply", "question": "Waiting on you", "ask": "Waiting on you",
          "plan": "Plan for approval"}


def log(**fields):
    fields["ts"] = datetime.now().isoformat(timespec="seconds")
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(fields) + "\n")
    except OSError:
        pass


def session_key(session_id):
    key = re.sub(r"[^A-Za-z0-9]", "", session_id or "")[:8]
    return key or "nosession"


# ---------------------------------------------------------------- transcript

def find_transcript(session_id):
    """The session's transcript, or the most recently written one when no id is known."""
    if session_id:
        hits = list(PROJECTS.glob(f"*/{session_id}.jsonl"))
        return hits[0] if hits else None
    hits = sorted(PROJECTS.glob("*/*.jsonl"), key=lambda p: p.stat().st_mtime)
    return hits[-1] if hits else None


def _is_prompt(entry, content):
    if entry.get("isMeta"):
        return False
    if "origin" in entry:
        return (entry.get("origin") or {}).get("kind") == "human"
    if isinstance(content, str):
        return True
    types = {b.get("type") for b in content or [] if isinstance(b, dict)}
    return "text" in types and "tool_result" not in types


def read_turns(path):
    """Every turn's assistant text, oldest first: [[text, text, ...], ...]."""
    turns = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get("isSidechain"):
                continue
            content = (entry.get("message") or {}).get("content")
            if entry.get("type") == "user" and _is_prompt(entry, content):
                turns.append([])
            elif entry.get("type") == "assistant" and turns and isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict) or block.get("type") != "text":
                        continue
                    text = (block.get("text") or "").strip()
                    if text and (not turns[-1] or turns[-1][-1] != text):
                        turns[-1].append(text)
    return turns


# ---------------------------------------------------------------- triggers

def stop_decision(text):
    """Return (kind, reason) if the reply should be presented, else (None, reason)."""
    words = len(text.split())
    asks = bool(ENDS_WITH_QUESTION_RE.search(text.strip()))
    if asks and words >= QUESTION_MIN_WORDS:
        return "question", f"question, {words} words"
    if words >= MIN_WORDS:
        return "reply", f"{words} words"
    if words >= TABLE_MIN_WORDS and TABLE_RE.search(text):
        return "reply", f"table, {words} words"
    return None, f"short ({words} words, question={asks})"


def ask_markdown(tool_input):
    parts, options = [], []
    for qi, q in enumerate(tool_input.get("questions") or [], 1):
        header = q.get("header") or f"Question {qi}"
        parts.append(f"## {header}\n\n**{q.get('question', '')}**")
        if q.get("multiSelect"):
            parts.append("*Pick one or more.*")
        opts = []
        for oi, opt in enumerate(q.get("options") or [], 1):
            opts.append({"n": oi, "label": opt.get("label", ""),
                         "description": opt.get("description", ""),
                         "preview": opt.get("preview", "")})
        options.append({"question": qi, "header": header, "options": opts})
    return "\n\n".join(parts), options


# ---------------------------------------------------------------- render + open

def safe_json(obj):
    # Loaded as a script: keep it ASCII and neutralise </script>, <!-- and JS line separators.
    s = json.dumps(obj, ensure_ascii=True)
    return s.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")


def git_branch(cwd):
    try:
        r = subprocess.run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
                           capture_output=True, text=True, timeout=2)
        return r.stdout.strip() if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def feed_path(key):
    return OUT / f"{key}.data.js"


def page_path(key):
    return OUT / f"{key}.html"


def read_feed(key):
    try:
        raw = feed_path(key).read_text(encoding="utf-8")
    except OSError:
        return None
    if not (raw.startswith(FEED_PREFIX) and raw.endswith(FEED_SUFFIX)):
        return None
    try:
        return json.loads(raw[len(FEED_PREFIX):-len(FEED_SUFFIX)])
    except ValueError:
        return None


def write_atomic(path, text):
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)


def read_settings():
    try:
        data = json.loads(SETTINGS.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def theme_ids():
    """Styles the template defines; the first is the default."""
    found = re.findall(r':root\[data-theme="([a-z0-9-]+)"\]\s*\{', TEMPLATE.read_text(encoding="utf-8"))
    return ["parks"] + [t for t in dict.fromkeys(found) if t != "parks"]


def sync_assets():
    """Keep a copy of the renderer and marked beside the pages."""
    folder = OUT / ASSETS
    folder.mkdir(parents=True, exist_ok=True)
    for src in (PAGE_JS, VENDOR_MARKED):
        dst = folder / src.name
        if not dst.exists() or dst.read_bytes() != src.read_bytes():
            shutil.copyfile(src, dst)


def build_id():
    """Changes whenever the template or renderer does; an open page reloads itself on a new one."""
    digest = hashlib.sha1()
    for part in (TEMPLATE, PAGE_JS):
        digest.update(part.read_bytes())
    return digest.hexdigest()[:10]


def render(session_id, cwd, kind, markdown, options=None):
    """Append an entry to the session feed. Returns (page path, True if the page is new)."""
    OUT.mkdir(parents=True, exist_ok=True)
    key = session_key(session_id)
    project = os.path.basename(os.path.normpath(cwd)) if cwd else "claude"
    now = datetime.now()
    feed = read_feed(key) or {"entries": []}
    feed["entries"].append({
        "kind": kind,
        "label": LABELS.get(kind, kind),
        "markdown": markdown,
        "options": options or [],
        "time": f"{now:%a %b} {now.day}, {now:%H:%M}",
    })
    feed["entries"] = feed["entries"][-MAX_ENTRIES:]
    build = build_id()
    settings = read_settings()
    feed.update(rev=str(time.time_ns()), build=build, session=key, project=project,
                branch=git_branch(cwd) if cwd else "",
                theme=settings.get("theme", ""), themeRev=settings.get("themeRev", ""))
    sync_assets()

    # Page before feed: an open tab that sees the new build in the feed reloads into the new page.
    page = page_path(key)
    is_new = not page.exists()
    write_atomic(page, TEMPLATE.read_text(encoding="utf-8")
                 .replace("{{TITLE}}", html.escape(f"{LABELS.get(kind, kind)} - {project}"))
                 .replace("{{CSP}}", html.escape(CSP))
                 .replace("{{MARKED_SRC}}", f"{ASSETS}/{VENDOR_MARKED.name}?v={build}")
                 .replace("{{PAGE_SRC}}", f"{ASSETS}/{PAGE_JS.name}?v={build}")
                 .replace("{{BUILD}}", build)
                 .replace("{{FEED}}", feed_path(key).name))
    write_atomic(feed_path(key), FEED_PREFIX + safe_json(feed) + FEED_SUFFIX)
    return page, is_new


def open_page(path):
    try:
        if sys.platform == "win32":
            os.startfile(str(path))  # default browser; no console window
        else:
            webbrowser.open(path.as_uri())
        return "opened"
    except OSError as exc:
        return f"open failed: {exc}"


def present(session_id, cwd, kind, markdown, options=None, reason="", event="cli", open_mode="auto"):
    """open_mode: auto (open only a new page), always, never."""
    if os.environ.get("PRESENT_DRY_RUN") == "1":
        log(event=event, decision="dry-run", kind=kind, reason=reason)
        return None, "dry-run"
    path, is_new = render(session_id, cwd, kind, markdown, options)
    if open_mode == "always" or (open_mode == "auto" and is_new):
        how = open_page(path)
    else:
        how = "not opened" if is_new else "updated in place"
    log(event=event, decision="presented", kind=kind, reason=reason, how=how,
        file=path.name, session=session_key(session_id))
    return path, how


# ---------------------------------------------------------------- housekeeping

def shown_marker(session_id):
    return OUT / f"{session_key(session_id)}.shown"


def prune():
    if not OUT.exists():
        return 0
    cutoff = time.time() - RETENTION_DAYS * 86400
    n = 0
    for p in OUT.iterdir():
        try:
            if p.is_file() and p.stat().st_mtime < cutoff:
                p.unlink()
                n += 1
        except OSError:
            pass
    return n


def latest_page():
    pages = sorted(OUT.glob("*.html"), key=lambda p: p.stat().st_mtime) if OUT.exists() else []
    return pages[-1] if pages else None


def hooks_wired():
    for settings in (Path.cwd() / ".claude" / "settings.json", CONFIG_DIR / "settings.json"):
        try:
            if "present.py" in settings.read_text(encoding="utf-8"):
                return str(settings)
        except OSError:
            pass
    return None


# ---------------------------------------------------------------- hook mode

def skip_reason(payload):
    if os.environ.get("CLAUDE_PRESENT") == "0":
        return "env CLAUDE_PRESENT=0"
    if OFF.exists():
        return "OFF file"
    if os.environ.get("CLAUDE_CODE_SESSION_ATTENDED") == "0":
        return "unattended session"
    if payload.get("agent_id") or payload.get("agent_type"):
        return "subagent or teammate"
    return None


def turn_text(payload):
    """The whole turn from the transcript; the hook's last message covers a late flush."""
    last = (payload.get("last_assistant_message") or "").strip()
    texts = []
    try:
        turns = read_turns(payload["transcript_path"])
        texts = turns[-1] if turns else []
    except (KeyError, OSError):
        pass
    if last and last not in texts:
        texts = texts + [last]
    return "\n\n".join(texts)


def handle_hook(payload):
    event = payload.get("hook_event_name")
    tool = payload.get("tool_name")
    session_id = payload.get("session_id")
    cwd = payload.get("cwd") or ""
    ctx = {"event": event, "tool": tool, "session": session_key(session_id)}

    reason = skip_reason(payload)
    if reason:
        log(decision="skip", reason=reason, **ctx)
        return

    tool_input = payload.get("tool_input") or {}

    if event == "PreToolUse" and tool == "AskUserQuestion":
        md, options = ask_markdown(tool_input)
        present(session_id, cwd, "ask", md, options, "AskUserQuestion", event)
        return

    if event == "PreToolUse" and tool == "ExitPlanMode":
        plan = tool_input.get("plan") or ""
        if plan.strip():
            present(session_id, cwd, "plan", plan, None, "ExitPlanMode", event)
        return

    if event == "Stop":
        if payload.get("stop_hook_active"):
            return
        marker = shown_marker(session_id)
        if marker.exists():
            fresh = time.time() - marker.stat().st_mtime < SHOWN_MAX_AGE
            marker.unlink(missing_ok=True)
            if fresh:
                log(decision="skip", reason="already presented this turn", **ctx)
                return
        text = turn_text(payload)
        kind, why = stop_decision(text)
        if not kind:
            log(decision="skip", reason=why, **ctx)
            return
        present(session_id, cwd, kind, text, None, why, event)
        if datetime.now().minute % 10 == 0:
            prune()


# ---------------------------------------------------------------- CLI

def clean_session(value):
    # An unexpanded ${CLAUDE_SESSION_ID} placeholder arrives as "" or a literal "$..." string.
    value = (value or "").strip()
    return None if not value or value.startswith("$") else value


def cmd_show(args):
    session_id = clean_session(args.session)
    try:
        markdown = sys.stdin.read() if args.file == "-" else Path(args.file).read_text(encoding="utf-8-sig")
    except OSError as exc:
        print(f"Cannot read {args.file}: {exc}")
        return 1
    if not markdown.strip():
        print("Nothing to present: the file is empty.")
        return 1
    path, how = present(session_id, os.getcwd(), args.kind, markdown, None, "show", "cli", args.open_mode)
    if path:
        shown_marker(session_id).touch()
    print(f"Presented ({how}): {path}")
    return 0


def cmd_turn(args):
    session_id = clean_session(args.session)
    transcript = find_transcript(session_id)
    if not transcript:
        print("No transcript found" + (f" for session {session_id}." if session_id else "."))
        return 1
    # The last turn is the one running this command, so it is never a candidate.
    finished = [t for t in read_turns(transcript)[:-1] if t]
    if len(finished) < args.back:
        print(f"Only {len(finished)} finished turn(s) with text in {transcript.name}.")
        return 1
    text = "\n\n".join(finished[-args.back])
    kind = "question" if ENDS_WITH_QUESTION_RE.search(text) else "reply"
    session_id = session_id or transcript.stem
    path, how = present(session_id, os.getcwd(), kind, text, None, f"turn back={args.back}", "cli",
                        args.open_mode)
    if path:
        shown_marker(session_id).touch()
    print(f"Presented ({how}, {len(text.split())} words): {path}")
    return 0


def cmd_theme(theme):
    known = theme_ids()
    current = read_settings().get("theme") or known[0]
    if not theme:
        for t in known:
            print(("* " if t == current else "  ") + t)
        return 0
    if theme not in known:
        print(f"Unknown style '{theme}'. Choose one of: " + ", ".join(known))
        return 1
    settings = read_settings()
    settings.update(theme=theme, themeRev=str(time.time_ns()))
    write_atomic(SETTINGS, json.dumps(settings, indent=2) + "\n")
    # Open pages switch as soon as their feed carries the new choice.
    touched = 0
    for feed_file in (OUT.glob("*.data.js") if OUT.exists() else []):
        feed = read_feed(feed_file.name[:-len(".data.js")])
        if feed:
            feed.update(rev=str(time.time_ns()), theme=theme, themeRev=settings["themeRev"])
            write_atomic(feed_file, FEED_PREFIX + safe_json(feed) + FEED_SUFFIX)
            touched += 1
    print(f"Style set to {theme}; {touched} existing page(s) updated.")
    return 0


def cmd_simple(cmd):
    if cmd == "off":
        OFF.touch()
        print("Hook mode OFF. /present still works by hand.")
    elif cmd == "on":
        OFF.unlink(missing_ok=True)
        print("Hook mode ON" + ("." if hooks_wired() else " (but no hooks are wired; see README.md)."))
    elif cmd == "status":
        print("hook mode:", "OFF" if OFF.exists() else "ON")
        print("hooks wired in:", hooks_wired() or "nowhere (skill-invoked only)")
        print("min words (hooks):", MIN_WORDS)
        print("style:", read_settings().get("theme") or theme_ids()[0])
        print("last page:", latest_page() or "none")
    elif cmd == "last":
        last = latest_page()
        if not last:
            print("No pages yet.")
            return 1
        print(f"{open_page(last)}: {last}")
    elif cmd == "prune":
        print("Removed", prune(), "old files.")
    return 0


def cli(argv):
    parser = argparse.ArgumentParser(prog="present.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    def page_args(p):
        p.add_argument("--session", default="")
        p.add_argument("--open", dest="open_mode", action="store_const", const="always", default="auto",
                       help="open a tab even when this session already has a page")
        p.add_argument("--no-open", dest="open_mode", action="store_const", const="never")

    show = sub.add_parser("show")
    show.add_argument("file")
    show.add_argument("--kind", choices=["reply", "question", "plan"], default="reply")
    page_args(show)
    turn = sub.add_parser("turn")
    turn.add_argument("--back", type=int, default=1)
    page_args(turn)
    theme = sub.add_parser("theme")
    theme.add_argument("id", nargs="?", default="")
    for name in ("on", "off", "status", "last", "prune"):
        sub.add_parser(name)

    args = parser.parse_args(argv)
    if args.cmd == "show":
        return cmd_show(args)
    if args.cmd == "theme":
        return cmd_theme(args.id)
    if args.cmd == "turn":
        if args.back < 1:
            parser.error("--back must be 1 or more")
        return cmd_turn(args)
    return cmd_simple(args.cmd)


def main():
    if len(sys.argv) > 1:
        return cli(sys.argv[1:])
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    try:
        handle_hook(payload)
    except Exception as exc:  # never break a Claude turn over a presentation
        log(decision="error", error=repr(exc), event=payload.get("hook_event_name"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
