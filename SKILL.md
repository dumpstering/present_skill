---
name: present
description: Open a long reply, plan or question as a formatted page in the user's browser (one tab per chat, updated in place, local files only). Optional. Use for "/present", "open that in the browser", "show me that as a page", or on your own when a read-only reply would run long - past about 400 words, a wide table, or several sections - and the user has not said to keep it in chat.
argument-hint: "optional: last (default: previous reply) | back N | open | theme [name] | on | off | status | prune"
---

# Present

Renders markdown to a local HTML page and opens it in the default browser.
The page re-reads its feed every 1.5 seconds, so a later call updates the
same tab. Nothing is sent anywhere.

The script is `present.py` in this skill's base directory (shown at the top
of this message). Run it as `python3 -I "<base directory>/present.py" ...`;
on Windows use `python` in place of `python3`. Details: [README.md](README.md).

This chat's session id: `${CLAUDE_SESSION_ID}`. Pass it as `--session=<id>` on
every `show` and `turn` call. If the id above is blank or still a `$`
placeholder, leave `--session` off.

Only use this where the session runs on the user's own computer. In a remote,
cloud, SSH or container session there is no browser to open: say so and keep
the reply in chat.

## The user asks (`/present ...`)

| Argument | Run |
|---|---|
| none, `last` | `present.py turn --session=<id>` - the previous reply, read from the transcript |
| `back N` | `present.py turn --back N --session=<id>` - N replies back |
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
  short sections also get a Slides toggle on the page.
- Put the question or numbered options last.
- Raw HTML and images are shown as text, by design. For charts or custom
  layout, write a separate HTML file.
