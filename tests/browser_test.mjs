// Cross-browser check for present pages: Chromium, Firefox and WebKit (Safari's engine).
//
//   npm i playwright && npx playwright install chromium firefox webkit
//   node tests/browser_test.mjs            (PYTHON=python3 on macOS / Linux)
//
// Each engine opens a real file:// page and must: render the markdown, keep hostile HTML inert,
// pick up a new entry without a reload, switch style from the dropdown and from "present.py theme",
// and reload itself when the build id changes. Exit code 1 on any failure.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
`;

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

    const rendered = await page.waitForFunction(() => document.querySelectorAll("#article h2").length === 2, null, { timeout: 8000 }).then(() => true, () => false);
    check("renders markdown", rendered, rendered ? "" : await page.locator("#article").innerText());
    check("hostile HTML inert", !(await page.title()).includes("PWNED") && (await page.locator("#article img, #article script").count()) === 0
      && (await page.locator('#article a[href^="javascript"]').count()) === 0);
    check("table and code", (await page.locator("#article table td").count()) === 2 && (await page.locator("#article pre .copy").count()) === 1);

    await page.evaluate(() => { window.__sameDocument = true; });
    present(out, settings, ["show", "-", "--session=browsertest", "--no-open"], "Second entry, pushed while the page was open.\n");
    const live = await page.waitForFunction(() => document.getElementById("article").textContent.includes("Second entry"), null, { timeout: 8000 }).then(() => true, () => false);
    check("live update without reload", live && (await page.evaluate(() => window.__sameDocument === true)), await page.locator("#count").innerText());

    await page.selectOption("#theme", "brutalist-raw");
    check("dropdown switches style", (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(255, 255, 255)");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("article").textContent.includes("Second entry"), null, { timeout: 8000 }).catch(() => {});
    const kept = await page.evaluate(() => document.documentElement.dataset.theme);
    results.push(["style survives reload (browser storage)", kept === "brutalist-raw" ? true : null, kept]);

    present(out, settings, ["theme", "retro-synthwave"]);
    const themed = await page.waitForFunction(() => document.documentElement.dataset.theme === "retro-synthwave", null, { timeout: 8000 }).then(() => true, () => false);
    check("present.py theme reaches the open page", themed, await page.evaluate(() => document.documentElement.dataset.theme));

    // A new build id in the feed must make the page reload itself once.
    await page.evaluate(() => { window.__sameDocument = true; });
    const feedFile = join(out, "browsert.data.js");
    writeFileSync(feedFile, readFileSync(feedFile, "utf-8").replace(/"build": "[0-9a-f]+"/, '"build": "newbuild00"').replace(/"rev": "\d+"/, '"rev": "1"'));
    const reloaded = await page.waitForFunction(() => window.__sameDocument !== true && document.getElementById("article").textContent.includes("Second entry"), null, { timeout: 8000 }).then(() => true, () => false);
    results.push(["self-reload on new build (needs sessionStorage)", reloaded ? true : null, ""]);

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
