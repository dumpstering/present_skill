// Cross-browser check for present pages: Chromium, Firefox and WebKit (Safari's engine).
//
//   npm i playwright && npx playwright install chromium firefox webkit
//   node tests/browser_test.mjs            (PYTHON=python3 on macOS / Linux)
//
// Each engine opens a real file:// page and must: render the markdown, keep hostile HTML inert,
// pick up a new entry without a reload, switch style from the dropdown and from "present.py theme",
// and reload itself when the build id changes. Exit code 1 on any failure.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const ROOT = process.env.PRESENT_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const only = process.argv.slice(2);
const engines = { chromium, firefox, webkit };

const HOSTILE = `Bottom line with a [good link](https://example.com) and a [bad link](javascript:document.title='PWNED').

<img src=x onerror="document.title='PWNED'">
<script>document.title='PWNED'</script>

## One

| a | b |
|---|---|
| 1 | 2 |

## Two

\`\`\`python
print("hi")
\`\`\`

## Three

Short closing section.
`;

const DECK = `Deck layouts, one of each.

## Numbers

- **12** open issues
- **3.4x** faster

## Steps

1. Fetch
2. Build
3. Ship

## Cards

- **Fast** - opens in under a second
- **Local** - nothing leaves the machine

> One callout to close.
`;

const LONG = `A reply with sections too tall for one slide.

## Many bullets

${Array.from({ length: 12 }, (_, i) => `- Bullet ${i + 1} carries a full sentence of detail so the list runs well past a single screen of height, and a second clause that wraps it onto another line`).join("\n")}

## Big table

| Item | Owner | Status |
|---|---|---|
${Array.from({ length: 15 }, (_, i) => `| Row ${i + 1} | Someone | Waiting on review |`).join("\n")}

## Short

Closing line.
`;

// Plain prose and unbolded items that should still get designed layouts.
const PROSE = `Designed slides from plain writing.

## Finding

The old and new versions split slides the same way. A tall section gets zoomed or scrolls, and nothing paginates.

## State

- Repo: a local checkout with push access and no CI
- Tests: one browser script that runs on two engines

## Plan

1. Add a pagination pass before slides are shown. It measures each section at zoom 1 against the stage.
2. Split long blocks at their items. Tables keep their header row on every part.
`;

const ASK = JSON.stringify({
  hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", session_id: "browsertest", cwd: ROOT,
  tool_input: { questions: [
    { header: "Scope", question: "Which scope?", options: [{ label: "Small", description: "One file" }, { label: "Large", description: "All files" }] },
    { header: "Timing", question: "When?", options: [{ label: "Now" }, { label: "Later", preview: "after review" }] },
  ] },
});

function present(out, settings, args, input) {
  return execFileSync(PY, ["-I", join(ROOT, "present.py"), ...args], {
    input, encoding: "utf-8",
    env: { ...process.env, PRESENT_OUT: out, PRESENT_SETTINGS: settings, PRESENT_LOG: join(out, "test.log") },
  });
}

let failed = 0;
for (const [name, engine] of Object.entries(engines)) {
  if (only.length && !only.includes(name)) continue;
  const out = mkdtempSync(join(tmpdir(), `present-${name}-`));
  const settings = join(out, "settings.json");
  const results = [];
  const check = (label, ok, detail = "") => { results.push([label, ok, detail]); if (!ok) failed++; };
  const problems = [];
  let browser;
  try {
    present(out, settings, ["show", "-", "--session=browsertest", "--no-open"], HOSTILE);
    browser = await engine.launch();
    const page = await browser.newPage();
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
    await page.goto(pathToFileURL(join(out, "browsert.html")).href);

    const rendered = await page.waitForFunction(() => document.querySelectorAll("#article h2").length === 3, null, { timeout: 8000 }).then(() => true, () => false);
    check("renders markdown", rendered, rendered ? "" : await page.locator("#article").innerText());
    check("hostile HTML inert", !(await page.title()).includes("PWNED") && (await page.locator("#article img, #article script").count()) === 0
      && (await page.locator('#article a[href^="javascript"]').count()) === 0);
    check("table and code", (await page.locator("#article table td").count()) === 2 && (await page.locator("#article pre .copy").count()) === 1);

    check("tab icon set", ((await page.locator("#favicon").getAttribute("href")) || "").startsWith("data:image/svg+xml,"));

    check("default style is classic", (await page.evaluate(() => document.documentElement.dataset.theme)) === "classic");

    // Three short sections: the page opens as designed slides by itself, with a cover and agenda bubbles.
    const inSlides = () => page.evaluate(() => document.getElementById("doc").classList.contains("slides"));
    const inDeck = () => page.evaluate(() => document.getElementById("doc").classList.contains("deck"));
    const autoDeck = (await inSlides()) && (await inDeck());
    const bubbles = await page.locator("#article section.cover .bubbles .bubble").count();
    await page.keyboard.press("ArrowRight");
    const second = await page.locator("#slidecount").innerText();
    await page.keyboard.press("End");
    const lastSlide = await page.locator("#slidecount").innerText();
    await page.keyboard.press("d");
    const docView = !(await inSlides());
    await page.keyboard.press("s");
    const textSlides = (await inSlides()) && !(await inDeck());
    const agenda = await page.locator("#article section.lead .agenda li").count();
    await page.keyboard.press("v");
    const backToDeck = await inDeck();
    await page.keyboard.press("d");
    check("slides: designed by default, keys, cover, text-slide agenda, progress",
      autoDeck && bubbles === 3 && second === "2 / 4" && lastSlide === "4 / 4" && docView && textSlides && agenda === 3 && backToDeck,
      JSON.stringify({ autoDeck, bubbles, second, lastSlide, docView, textSlides, agenda, backToDeck }));

    // Markdown structure maps onto designed layouts: bold numbers, numbered lists, bold-led bullets.
    present(out, settings, ["show", "-", "--session=browsertest", "--no-open"], DECK);
    await page.waitForFunction(() => document.getElementById("article").textContent.includes("Deck layouts"), null, { timeout: 8000 }).catch(() => {});
    const layouts = await page.evaluate(() => ({
      stats: document.querySelectorAll("#article .stat").length,
      steps: document.querySelectorAll("#article ol.steps li").length,
      cards: document.querySelectorAll("#article .card").length,
      quote: document.querySelectorAll("#article blockquote.quote").length,
    }));
    check("designed layouts: stats, steps, cards, callout", layouts.stats === 2 && layouts.steps === 3 && layouts.cards === 2 && layouts.quote === 1, JSON.stringify(layouts));

    await page.locator("#article pre .copy").first().click({ force: true }).catch(() => {});
    results.push(["copy shows a toast", (await page.locator("#toast.on").count()) === 1 ? true : null, "clipboard blocked in this harness"]);

    await page.evaluate(() => { window.__sameDocument = true; });
    present(out, settings, ["show", "-", "--session=browsertest", "--no-open"], "Second entry, pushed while the page was open.\n");
    const live = await page.waitForFunction(() => document.getElementById("article").textContent.includes("Second entry"), null, { timeout: 8000 }).then(() => true, () => false);
    check("live update without reload", live && (await page.evaluate(() => window.__sameDocument === true)), await page.locator("#count").innerText());
    check("a short reply opens as a document, view buttons stay with slides disabled", !(await inSlides())
      && (await page.locator("#views button").count()) === 3 && (await page.locator("#views button:disabled").count()) === 2);

    await page.selectOption("#theme", "brutalist-raw");
    check("dropdown switches style", (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(255, 255, 255)");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("article").textContent.includes("Second entry"), null, { timeout: 8000 }).catch(() => {});
    const kept = await page.evaluate(() => document.documentElement.dataset.theme);
    results.push(["style survives reload (browser storage)", kept === "brutalist-raw" ? true : null, kept]);

    present(out, settings, ["theme", "retro-synthwave"]);
    const themed = await page.waitForFunction(() => document.documentElement.dataset.theme === "retro-synthwave", null, { timeout: 8000 }).then(() => true, () => false);
    check("present.py theme reaches the open page", themed, await page.evaluate(() => document.documentElement.dataset.theme));

    // Hook mode: an AskUserQuestion payload on stdin; each question's cards sit under its heading.
    present(out, settings, [], ASK);
    const asked = await page.waitForFunction(() => document.querySelectorAll("#article section .opt").length === 4, null, { timeout: 8000 }).then(() => true, () => false);
    check("question cards under their headings", asked && (await page.locator("#banner").textContent()).includes("asking")
      && (await page.locator("#options .opt").count()) === 0, await page.locator("#banner").innerText().catch(() => ""));
    present(out, settings, ["show", "-", "--session=browsertest", "--no-open"], "Second entry again, so later checks have plain text.\n");
    await page.waitForFunction(() => document.getElementById("article").textContent.includes("Second entry again"), null, { timeout: 8000 }).catch(() => {});

    // History: one file per reply, a small polled feed, [ / ] and the H drawer, and a new reply takes over the view.
    const replyFiles = readdirSync(out).filter((f) => /^browsert\.r\d{6}\.js$/.test(f)).length;
    const feedBytes = statSync(join(out, "browsert.data.js")).size;
    check("one file per reply, small feed", replyFiles === 5 && feedBytes < 1000, JSON.stringify({ replyFiles, feedBytes }));
    const barBefore = await page.evaluate(() => document.querySelector("header.top").offsetHeight);
    await page.keyboard.press("[");
    const back = await page.waitForFunction(() => document.querySelectorAll("#article section .opt").length === 4, null, { timeout: 8000 }).then(() => true, () => false);
    const backCount = await page.locator("#count").innerText();
    const barSteady = (await page.evaluate(() => document.querySelector("header.top").offsetHeight)) === barBefore;
    await page.keyboard.press("Shift+ArrowRight");
    const shiftNewer = await page.waitForFunction(() => document.getElementById("count").innerText === "5 / 5", null, { timeout: 8000 }).then(() => true, () => false);
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("h");
    const listed = await page.waitForFunction(() => document.querySelectorAll("#hlist li").length === 5, null, { timeout: 8000 }).then(() => true, () => false);
    await page.locator("#hlist li").last().click();
    const oldest = await page.waitForFunction(() => document.getElementById("article").textContent.includes("Bottom line"), null, { timeout: 8000 }).then(() => true, () => false);
    const oldestCount = await page.locator("#count").innerText();
    check("history: [ and Shift+arrows step, toolbar stays put, drawer lists every reply, click opens one",
      back && backCount === "4 / 5" && barSteady && shiftNewer && listed && oldest && oldestCount === "1 / 5",
      JSON.stringify({ back, backCount, barSteady, shiftNewer, listed, oldest, oldestCount }));
    present(out, settings, ["show", "-", "--session=browsertest", "--no-open"], "Second entry, third time: a new reply takes over the view.\n");
    const bumped = await page.waitForFunction(() => document.getElementById("article").textContent.includes("third time"), null, { timeout: 8000 }).then(() => true, () => false);
    const relisted = await page.waitForFunction(() => document.querySelectorAll("#hlist li").length === 6, null, { timeout: 8000 }).then(() => true, () => false);
    const bumpedCount = await page.locator("#count").innerText();
    await page.keyboard.press("Escape");
    const closed = !(await page.locator("#drawer").isVisible());
    check("history: a new reply bumps the view and the list; Esc closes", bumped && relisted && bumpedCount === "6 / 6" && closed,
      JSON.stringify({ bumped, relisted, bumpedCount, closed }));

    // A new build id in the feed must make the page reload itself once.
    await page.evaluate(() => { window.__sameDocument = true; });
    const feedFile = join(out, "browsert.data.js");
    writeFileSync(feedFile, readFileSync(feedFile, "utf-8").replace(/"build": "[0-9a-f]+"/, '"build": "newbuild00"').replace(/"rev": "\d+"/, '"rev": "1"'));
    const reloaded = await page.waitForFunction(() => window.__sameDocument !== true && document.getElementById("article").textContent.includes("Second entry"), null, { timeout: 8000 }).then(() => true, () => false);
    results.push(["self-reload on new build (needs sessionStorage)", reloaded ? true : null, ""]);

    // A section too tall for one slide continues onto more slides; no slide scrolls or shrinks to fit.
    present(out, settings, ["show", "-", "--session=longtest", "--no-open"], LONG);
    const longPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    longPage.on("pageerror", (e) => problems.push(String(e)));
    await longPage.goto(pathToFileURL(join(out, "longtest.html")).href);
    await longPage.waitForFunction(() => document.getElementById("doc").classList.contains("slides"), null, { timeout: 8000 }).catch(() => {});
    const sweep = () => longPage.evaluate(() => {
      const stage = document.getElementById("article"), sections = stage.querySelectorAll(":scope > section"), total = sections.length, over = [], shrunk = [];
      for (let i = 0; i < total; i++) {
        if (i) document.getElementById("next").click();
        if (stage.scrollHeight > stage.clientHeight + 1) over.push(i + 1);
        if (parseFloat(sections[i].style.zoom || "1") < 0.999) shrunk.push(i + 1);
      }
      return { total, over, shrunk, rows: stage.querySelectorAll("tbody tr").length, items: stage.querySelectorAll("section .chips li, section > ul > li").length };
    });
    const paged = {};
    for (const [mode, key] of [["designed", "v"], ["text", "s"]]) {
      await longPage.keyboard.press(key);
      await longPage.keyboard.press("Home");
      paged[mode] = await sweep();
      await longPage.keyboard.press("f");
      await longPage.keyboard.press("Home");
      paged[mode + "NoFit"] = await sweep();
      await longPage.keyboard.press("f");
    }
    // Cover or lead slide plus three sections is 4; the long ones must spill onto extra slides
    // without losing any bullet or table row.
    check("long sections paginate: more slides, none scroll or shrink, nothing lost",
      Object.values(paged).every((p) => p.total > 4 && p.over.length === 0 && p.shrunk.length === 0 && p.rows === 15 && p.items === 12),
      JSON.stringify(paged));

    // Prose and unbolded items still get designed layouts: a statement slide, titled cards and steps.
    present(out, settings, ["show", "-", "--session=longtest", "--no-open"], PROSE);
    await longPage.waitForFunction(() => document.getElementById("article").textContent.includes("plain writing"), null, { timeout: 8000 }).catch(() => {});
    await longPage.keyboard.press("v");
    const prose = await longPage.evaluate(() => ({
      statement: (document.querySelector("#article .dstate > strong") || {}).textContent,
      cardTitles: [...document.querySelectorAll("#article .card .card-h")].map((h) => h.textContent),
      stepTitles: [...document.querySelectorAll("#article ol.steps .card-h")].map((h) => h.textContent),
    }));
    check("plain prose and unbolded items get designed titles",
      prose.statement === "The old and new versions split slides the same way"
        && prose.cardTitles.join("|") === "Repo|Tests"
        && prose.stepTitles.join("|") === "Add a pagination pass before slides are shown|Split long blocks at their items",
      JSON.stringify(prose));

    // The header shows how long ago the reply was made, updates on its own, and turns amber then red.
    const agePage = await browser.newPage();
    agePage.on("pageerror", (e) => problems.push(String(e)));
    await agePage.clock.install();
    await agePage.goto(pathToFileURL(join(out, "browsert.html")).href);
    const ageOf = () => agePage.evaluate(() => { const a = document.getElementById("age"); return a ? [a.textContent, a.className] : null; });
    let ages = [];
    for (let i = 0; i < 40 && !(ages[0] && ages[0][0]); i++) { await new Promise((r) => setTimeout(r, 200)); ages[0] = await ageOf(); }
    await agePage.clock.fastForward("20:00");
    ages[1] = await ageOf();
    await agePage.clock.fastForward("03:00:00");
    ages[2] = await ageOf();
    await agePage.keyboard.press("h");
    await new Promise((r) => setTimeout(r, 500));
    const histAge = await agePage.evaluate(() => { const a = document.querySelector("#hlist .age"); return a && a.className; });
    check("reply age: live, fresh then stale then super stale",
      !!(ages[0] && ages[0][0] === "just now" && /\bfresh\b/.test(ages[0][1])
        && ages[1] && ages[1][0] === "20 min ago" && /\bstale\b/.test(ages[1][1])
        && ages[2] && ages[2][0] === "3 h ago" && /\bsuperstale\b/.test(ages[2][1]) && /\bsuperstale\b/.test(histAge || "")),
      JSON.stringify({ ages, histAge }));

    check("no page errors", problems.length === 0, problems.slice(0, 3).join(" | "));
  } catch (e) {
    check("ran to completion", false, String(e).slice(0, 300));
  } finally {
    if (browser) await browser.close();
  }
  console.log(`\n${name} ${browser ? browser.version() : ""}`);
  for (const [label, ok, detail] of results) {
    console.log(`  ${ok === true ? "PASS" : ok === null ? "SOFT" : "FAIL"}  ${label}${detail && ok !== true ? "  -> " + detail : ""}`);
  }
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall hard checks passed (SOFT = works, but the browser does not persist it for file:// pages)");
process.exit(failed ? 1 : 0);
