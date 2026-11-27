---
name: present
description: Open a long reply, plan or question as a formatted page in the user's browser (one tab per chat, updated in place, local files only), or a board of loose threads left open across recent Claude Code, Codex and Pi sessions. Optional. Use for "/present:present", "/present:present threads", "what did I leave open", "loose threads", "open that in the browser", "show me that as a page", or on your own when a read-only reply would run long - past about 400 words, a wide table, or several sections - and the user has not said to keep it in chat.
argument-hint: "optional: last (default: previous reply) | back N | threads [1h|4h|1d|1w|1m] | open | theme [name] | on | off | status | prune"
---

# Present

Renders markdown to a local HTML page and opens it in the default browser.
The page re-reads its feed every 1.5 seconds, so a later call updates the
same tab. Nothing is sent anywhere.

Every `present.py ...` below means this exact command, with the rest of the
arguments added:

`PRESENT_DATA="${CLAUDE_PLUGIN_DATA}" python3 -I "${CLAUDE_SKILL_DIR}/present.py" ...`

`PRESENT_DATA` keeps pages and settings in the plugin's data folder, which
survives updates. On Windows use `python` in place of `python3`. Details are in
the plugin's README.

This chat's session id: `${CLAUDE_SESSION_ID}`. Pass it as `--session=<id>` on
every `show` and `turn` call. If the id above is blank or still a `$`
placeholder, leave `--session` off.

Only use this where the session runs on the user's own computer. In a remote,
cloud, SSH or container session there is no browser to open: say so and keep
the reply in chat.

## The user asks (`/present:present ...`)

| Argument | Run |
|---|---|
| none, `last` | `present.py turn --session=<id>` - the previous reply, read from the transcript |
| `back N` | `present.py turn --back N --session=<id>` - N replies back |
| `threads [window]` | see "Loose threads" below; window defaults to `1d` |
| `open` | `present.py last` - reopen the newest page |
| `theme` | `present.py theme` - list the page styles |
| `theme <name>` | `present.py theme <name>` - switch every open page to that style |
| `on`, `off`, `status`, `prune` | `present.py <word>` (`on` / `off` only affect hook mode) |

`turn` copies the reply from the transcript, so never retype it. If the user
says no tab appeared or they closed it, rerun with `--open`.

Reply with one line: what was presented and the page path the script printed.

## On your own, for a long reply

1. Write the full reply once, as markdown, to a temporary file.
2. `present.py show <file> --session=<id>` (`--kind question` when it ends by
   asking the user something, `--kind plan` for a plan awaiting approval).
3. In chat, give the bottom line in a few sentences, any question you need
   answered, and the page path. Do not repeat the body.

Keep it in chat instead when:
- the reply is a draft the user will copy or approve (an email, a message, ticket or wiki text);
- it is under about 400 words with no wide table;
- the user asked a quick question, or said to stop presenting;
- you are a subagent.

## Writing for the page

- Lead with the bottom line.
- Use `##` headings only for three or more distinct sections. Three or more
  sections open as slides; a section too tall for one slide continues on the
  next. Everything else opens as a scrolling document.
- Put the question or numbered options last.
- Slides open in the designed style by default: bullets that open with a bold phrase
  become cards, a bold number (`**12** open issues`) a stat tile, a numbered list step
  bubbles, a blockquote a callout, and an opening paragraph the cover. `V` designed,
  `S` text slides, `D` document, `F` fit to screen, `P` full screen.
  Every reply in the chat is kept: `[` / `]` step back and forward, `H` lists them all.
- Raw HTML and images are shown as text, by design. For charts or custom
  layout, write a separate HTML file.

## Loose threads (`/present:present threads [1h|4h|1d|1w|1m]`)

Summarize every recent session and find the work left open, as one board with
two tabs: Loose threads (ranked) and Sessions (what each one did).

1. `python3 -I "${CLAUDE_SKILL_DIR}/threads.py" --since <window> --exclude <id> --out <scratch>/digest.md`
   (`<id>` is this chat's session id). For every main Claude Code, Codex and Pi
   session active in the window it lists status (`running now` when written to in
   the last 10 minutes), start and end times, each turn as the ask and the reply
   that ended it, flags (interrupted, ends with a question) and a resume command,
   then git state per folder (uncommitted files, unpushed commits, open PRs). It only reads.
2. For each session, write a one-sentence summary and split its turns into topics:
   group turns about the same thing, name the topic in a few words, and state its
   outcome in one sentence (what was produced, decided or left). Set `status`:
   `running` (digest says running now), `waiting` (ended on a question or approval
   for the user), `stopped` (interrupted or ended mid-task), else `done`.
3. Decide what is still open. A thread is open when a session stopped before the ask
   was done: a question or approval left waiting, an interrupted step, a PR not
   merged, commits not pushed, a "next step" or handoff nobody took up, or a failure
   left unresolved. A later session that finished the work closes it, so check across
   sessions first. Work in a running session is in progress, not loose.
   If the digest is over about 60 KB (a week or month), have a Sonnet subagent do
   steps 2 and 3 and return the board JSON.
4. Write the board as JSON and present it:
   `present.py show <scratch>/board.json --kind threads --session=<id>`

```json
{"title": "Loose threads, last day", "summary": "5 open threads across 3 projects; 9 sessions, 2 still running.",
 "threads": [{"title": "Merge PR #4 (designed titles)", "priority": "high", "effort": "quick",
   "why": "Open and tested; the skill checkout runs the PR branch until it merges.",
   "next": "gh pr merge 4 --merge", "project": "present", "source": "claude",
   "session": "a0454805-...", "at": 1764213000}],
 "sessions": [{"session": "a0454805-...", "title": "Slide pagination", "source": "claude",
   "project": "present", "status": "waiting", "started": 1764200000, "at": 1764213000,
   "summary": "Paginated tall slides and shipped four follow-up features.",
   "topics": [{"topic": "Slide pagination", "outcome": "Merged in PR #3; tall sections continue on new slides."},
              {"topic": "Plugin packaging", "outcome": "PR #8 open, waiting on a merge decision."}],
   "resume": "cd ~/git/present && claude --resume a0454805-..."}]}
```

- `priority`: `high` blocks other work or risks losing work (unpushed commits, a
  question someone is waiting on); `medium` is real but can wait; `low` is nice to have.
- `effort`: `quick` (minutes), `medium` (one session), `long` (more).
- `next`: the exact command or prompt that closes it; usually the digest's resume
  command plus what to ask for.
- `at` and `started`: the digest's `ended_epoch` and `started_epoch`. Cards show
  "3 h ago" from `at`, and Newest sorts by it.
- `session`: the full session id from the digest heading. A thread with one links
  to its session's card.
- Include every session from the digest in `sessions`, finished ones too.

In chat, give the thread count, the top one or two threads and how many sessions
ran, plus the page path.
