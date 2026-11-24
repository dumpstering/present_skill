# present

A Claude Code skill that opens a long reply, plan or question as a formatted
page in your browser. One page per chat, updated in place. Local files only:
nothing is sent anywhere, and the page's security policy blocks all network
access.

- `/present` opens the previous reply. It is copied from the session
  transcript, so it costs no extra output.
- Claude may also use it on its own for a long read, and keeps the bottom
  line and any question in the chat.
- Three or more short sections open as slides; anything else opens as a
  scrolling document. `S` and `D` switch between the two.
- Thirteen page styles, picked from a dropdown on the page or with
  `/present theme <name>`.

Runs on Windows, macOS and Linux, and works in Chrome, Edge, Firefox and
Safari.

## Requirements

- Claude Code with skills (CLI, VS Code extension, or the desktop app), in a
  session that runs on your own computer.
- Python 3.8 or later. Standard library only.
- Any current browser.

## Install

Clone into your skills folder as `present`.

macOS / Linux:

```
git clone https://github.com/dumpstering/present_skill ~/.claude/skills/present
```

Windows (PowerShell):

```
git clone https://github.com/dumpstering/present_skill "$env:USERPROFILE\.claude\skills\present"
```

For one project only, clone into `<project>/.claude/skills/present` instead.
Start a new chat and type `/present status`.

## Use

In a chat:

| You type | What happens |
|---|---|
| `/present` | Opens the previous reply as a page |
| `/present back 2` | The reply before that |
| `/present open` | Reopens the newest page (use this if you closed the tab) |
| `/present theme` | Lists the styles |
| `/present theme brutalist-raw` | Switches every open page to that style |
| `/present status` | Shows the current state |

From a shell (`python` on Windows, `python3` elsewhere):

```
python3 present.py show <file.md> [--kind reply|question|plan] [--session=ID] [--open] [--no-open]
python3 present.py turn [--back N] [--session=ID] [--open] [--no-open]
python3 present.py theme [id]
python3 present.py on | off | status | last | prune
```

`show` renders a markdown file (`-` for stdin). `turn` renders a finished
reply from the transcript, including text written before tool calls, not only
the last message. Without `--session`, `turn` uses the most recently written
transcript, which can be another chat when several are open.

## Styles

`classic` is the default: a quiet neutral page with a blue accent. `parks` is
a 1970s NASA graphics manual and park service look. Both follow your system
light or dark setting. The others are fixed schemes:
`cyberpunk-crypto`, `editorial-magazine`, `luxury-premium`, `dark-tech`,
`enterprise-saas`, `landing-conversion`, `playful-creative`, `brutalist-raw`,
`retro-synthwave`, `organic-wellness`, `portfolio-showcase`.

The newest choice wins, whether you made it in the dropdown or with
`present.py theme`. The dropdown choice is kept in the browser's storage; the
`theme` command is kept in `settings.json` in this folder.

Fonts are whatever is installed: the page loads nothing from the network, so
each style names its ideal font first and falls back to a system one.

To add a style, add a `:root[data-theme="<id>"]` token block in
`template.html` and a row to `THEMES` in `page.js`.

## How it works

- `out/<session>.html` is a static shell built from `template.html`.
- `out/<session>.data.js` is the feed: the last 25 entries for that chat. The
  page reloads it every 1.5 seconds, and again whenever its tab is shown or
  focused, and re-renders when the feed changes.
- `out/_assets/` holds copies of `page.js` and `marked.umd.js`, because
  browsers restrict a page opened from disk to files in its own folder.
- The first call for a chat opens a tab in the default browser. Later calls
  only rewrite the feed. A closed tab is not detected: use `/present open`.
- When `template.html` or `page.js` changes, an open page reloads itself once.
- Nothing can pull the browser to the front. A page that arrives while its
  tab is hidden puts `(new)` in the tab title. The tab icon is a dot in the
  style's accent color that changes color when Claude is waiting on you, and
  question and plan pages show a banner saying so, with a "Jump to the
  question" button on long ones.
- AskUserQuestion pages (hook mode) show each question's options as cards
  under that question, with a copy button per option.
- Page controls: style dropdown, Older / Newer (entries in this chat),
  Slides / Document, Copy markdown, and a copy button on each code block.
- A page with three or more `##` sections of 220 words or fewer opens as
  slides; anything else opens as a document. Sections split on `#` when there
  is no `##`. An opening paragraph becomes a lead slide with the headings as
  an agenda. Any page with two or more sections can be switched by hand; the
  switch holds for that page only. Keys: `S` slides, `D` document, arrows /
  space / `J` / `K` to move, Home and End.
- If the markdown library fails to load, the reply is shown as plain text.

## Safety

- Content-Security-Policy: `default-src 'none'`, scripts and fonts only from
  local files, no inline script, images only from `data:`.
- Raw HTML in the markdown is escaped and shown as text. A second pass strips
  event-handler attributes, script-like tags and any link that is not
  `http(s)`, `mailto` or an in-page anchor. Images are replaced by a text
  reference. Replies often quote web pages, mail or tickets, so the page
  treats its own content as untrusted.
- Pages hold the text of your replies. They live in `out/` in this folder and
  are deleted after 14 days by `present.py prune` (hook mode prunes on its
  own). `out/`, `present.log`, `settings.json` and `OFF` are gitignored.

## What was tested

| Area | Result |
|---|---|
| Chromium 159, Firefox 159, WebKit 27.2 (Safari's engine) | All checks in `tests/browser_test.mjs` pass, run through Playwright on Windows 11 |
| Windows 11, Python 3.14, VS Code extension | Used day to day |
| macOS, Linux | Not yet run. The code has no platform-specific calls beyond opening the browser |
| Safari itself, Claude Code CLI, desktop app | Not yet run. The skill uses nothing specific to one surface |
| Python 3.8 - 3.13 | Not yet run; written to 3.8 syntax and library |

Run the browser checks:

```
npm i playwright
npx playwright install chromium firefox webkit
node tests/browser_test.mjs
```

On macOS or Linux set `PYTHON=python3` if `python3` is not the default.

## Optional hook mode

With hooks, pages appear without anyone asking: on a reply past 200 words, one
with a table (80+ words), or one ending in a question (60+ words), and on
AskUserQuestion and ExitPlanMode. Subagents and unattended sessions are
skipped, and a turn that already called `show` or `turn` is not presented
twice.

Add to `~/.claude/settings.json` (append to arrays you already have), with
the full path to `present.py` and `python` in place of `python3` on Windows:

```json
{
  "hooks": {
    "Stop": [
      {"hooks": [{"type": "command", "command": "python3 -I \"/full/path/to/present.py\"", "async": true, "timeout": 20}]}
    ],
    "PreToolUse": [
      {"matcher": "AskUserQuestion|ExitPlanMode",
       "hooks": [{"type": "command", "command": "python3 -I \"/full/path/to/present.py\"", "async": true, "timeout": 20}]}
    ],
    "PostToolUse": [
      {"matcher": "Bash|PowerShell",
       "hooks": [{"type": "command", "command": "python3 -I \"/full/path/to/present.py\"", "async": true, "timeout": 20}]}
    ]
  }
}
```

The PostToolUse hook is optional. It notices when Claude opens an HTML page of
its own during a turn, so the Stop hook does not open a second one.

`present.py off` and `present.py on` pause and resume hook mode. Env knobs:
`CLAUDE_PRESENT=0` (off for one shell), `PRESENT_MIN_WORDS`,
`PRESENT_FOCUS=input|always|never` (macOS only: whether a newly opened tab
brings the browser forward; `input`, the default, does so only when Claude is
waiting on you), `PRESENT_DRY_RUN=1` (log the decision, write nothing).
Decisions are logged to `present.log`.

With hook mode on, these habits in your `CLAUDE.md` make the pages read well.
They help in the chat too:

```
## Browser presentations
- Lead with the bottom line in the first sentence or two.
- Use ## headings only when there are three or more distinct sections. Three or
  more short sections render as slides; everything else as a scrolling document.
- When you need something from me, put it last: one explicit question, or
  numbered options.
- Don't hand-write HTML for ordinary replies; the hook already renders them.
- If something needs charts, diagrams or custom layout, write a self-contained
  HTML file and open it. The hook sees that and skips its own page for the turn.
```

## Credits and license

- Markdown rendering: [marked](https://github.com/markedjs/marked) 18.1.1,
  vendored at `vendor/marked.umd.js` from the npm tarball (sha512
  `zEGgrtUG8crk+TrMacJSVABU4DYDDkS8uqgU3ohrn/2fW9C2AEfUrO3m6IhpIpQpl7YcVpiXXC9cSMWDANT3dg==`),
  MIT, license in `vendor/LICENSE.marked.txt`.
- This skill: MIT, see [LICENSE](LICENSE).
