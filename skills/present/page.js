/* Renderer for present.py pages. Loaded from _assets/ beside the page; the CSP allows no inline script.
   The page polls its small feed file (out/<session>.data.js), which calls window.__present(data) with
   the newest reply number; each reply lives in its own file and is fetched only when shown. */
(function () {
  "use strict";

  var FEED = document.currentScript.getAttribute("data-feed");
  var BUILD = document.currentScript.getAttribute("data-build");
  // <key>.data.js -> <key>: reply files are <key>.r000042.js, the title list <key>.index.js.
  var SESSION = FEED.replace(/\.data\.js$/, "");
  var POLL_MS = 1500;
  var SLIDE_MIN_SECTIONS = 3;
  var BANNERS = {
    plan: "Claude is waiting for plan approval. Approve or give feedback in the chat.",
    ask: "Claude is asking. Pick an option in the chat; the copy buttons grab the label.",
    question: "Claude is waiting on you. Answer in the chat."
  };
  var WAITING = { question: true, ask: true, plan: true };
  var META_SEP = "  \u00b7  ";
  var SAFE_HREF = /^(https?:|mailto:|#)/i;
  var DROP_TAGS = /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META|BASE|FORM|INPUT|BUTTON|TEXTAREA|SELECT)$/;
  // View id, button label, key. Slide-shaped pages open in whichever slide style was picked last.
  var VIEWS = [["doc", "Document", "d"], ["slides", "Text slides", "s"], ["designed", "Designed slides", "v"]];
  var STYLE_KEY = "present.slideStyle", FIT_KEY = "present.fit";
  // A bold lead that is just a number ("**12**", "**~40%**", "**3.2x**") makes the list a row of stat tiles.
  var STAT_RE = /^[~\u2248<>$+-]?\s*\d[\d.,]*\s*(%|[kKMB]|x|ms|s|m|h|d|wk|mo|yr|lb|kg|bpm|TB|GB|MB|KB|kB)?\+?$/;

  // Looks defined in template.html; the first is the default.
  var THEMES = [
    ["classic", "Classic"],
    ["parks", "Retro Parks"],
    ["cyberpunk-crypto", "Cyberpunk Crypto"],
    ["editorial-magazine", "Editorial Magazine"],
    ["luxury-premium", "Luxury Premium"],
    ["dark-tech", "Dark Tech"],
    ["enterprise-saas", "Enterprise SaaS"],
    ["landing-conversion", "Landing Conversion"],
    ["playful-creative", "Playful Creative"],
    ["brutalist-raw", "Brutalist Raw"],
    ["retro-synthwave", "Retro Synthwave"],
    ["organic-wellness", "Organic Wellness"],
    ["portfolio-showcase", "Portfolio Showcase"]
  ];

  var state = { rev: null, data: null, entry: null, cache: {}, want: null, indexRev: null, mode: "doc", canToggle: false, splitTag: "H2", slide: 0,
    unread: false, themeRev: null, fit: storeGet(FIT_KEY) !== "0" };
  var $ = function (id) { return document.getElementById(id); };

  function storeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* storage blocked */ }
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // Raw HTML in the markdown is shown as text, never parsed: replies can quote untrusted content.
  var HAS_MARKED = typeof marked !== "undefined";
  if (HAS_MARKED) {
    marked.use({
      gfm: true,
      renderer: { html: function (token) { return esc(typeof token === "string" ? token : (token.raw || token.text || "")); } }
    });
  }

  // If marked did not load, the reply is still readable as plain text.
  function renderMarkdown(markdown) {
    var holder = document.createElement("template");
    if (HAS_MARKED) {
      holder.innerHTML = marked.parse(markdown);
      sanitize(holder.content);
    } else {
      holder.content.appendChild(el("pre", "", markdown));
    }
    return holder.content;
  }

  // Second line of defence behind the renderer override and the CSP.
  function sanitize(root) {
    var nodes = root.querySelectorAll("*");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (DROP_TAGS.test(node.tagName)) { node.remove(); continue; }
      for (var j = node.attributes.length - 1; j >= 0; j--) {
        var name = node.attributes[j].name.toLowerCase();
        if (name.indexOf("on") === 0 || name === "style" || name === "srcdoc") node.removeAttribute(name);
      }
      if (node.tagName === "A") {
        var href = node.getAttribute("href") || "";
        if (SAFE_HREF.test(href)) {
          if (href.charAt(0) !== "#") { node.target = "_blank"; node.rel = "noopener noreferrer"; }
        } else {
          node.removeAttribute("href");
          if (href) node.title = href;
        }
      } else if (node.tagName === "IMG") {
        var src = node.getAttribute("src") || "";
        node.replaceWith(el("span", "img-ref", "[image: " + (node.getAttribute("alt") || "no description") +
          (src.indexOf("data:") === 0 ? "" : " - " + src) + "]"));
      }
    }
  }

  var toastTimer = null;
  function toast(message) {
    var box = $("toast");
    box.textContent = message;
    box.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove("on"); }, 1400);
  }

  function copyText(text) {
    function done() { toast("Copied. Paste it in the chat."); }
    function fallback() {
      var ta = el("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* nothing more to try */ }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  function copyButton(getText) {
    var b = el("button", "copy", "Copy");
    b.type = "button";
    b.addEventListener("click", function () { copyText(getText()); });
    return b;
  }

  // Wrap the article into one <section> per h2, or per h1 when there is no h2. Content before
  // the first such heading is its own section.
  function sectionize(article) {
    var sections = [], current = null;
    state.splitTag = article.querySelector("h2") ? "H2" : "H1";
    Array.prototype.slice.call(article.childNodes).forEach(function (node) {
      if (node.nodeType === 1 && node.tagName === state.splitTag || !current) {
        if (node.nodeType !== 1 && !node.textContent.trim()) return;
        current = el("section");
        sections.push(current);
      }
      current.appendChild(node);
    });
    sections.forEach(function (s) { article.appendChild(s); });
    return sections;
  }

  function slideEligible(sections) {
    return sections.filter(isHeaded).length >= SLIDE_MIN_SECTIONS;
  }

  function buildOutline(article) {
    var outline = $("outline");
    outline.replaceChildren();
    var heads = article.querySelectorAll("h2, h3");
    for (var i = 0; i < heads.length; i++) {
      heads[i].id = "s" + i;
      var a = el("a", heads[i].tagName === "H3" ? "h3" : "", heads[i].textContent);
      a.href = "#s" + i;
      outline.appendChild(a);
    }
    $("doc").classList.toggle("has-outline", heads.length >= 3);
  }

  function isHeaded(section) {
    return !!section.firstElementChild && section.firstElementChild.tagName === state.splitTag;
  }

  function optionCards(group) {
    var box = el("div", "optgroup");
    (group.options || []).forEach(function (opt) {
      var card = el("div", "opt");
      card.appendChild(el("div", "n", opt.n));
      card.appendChild(el("div", "label", opt.label));
      card.appendChild(copyButton(function () { return opt.label; }));
      if (opt.description) card.appendChild(el("div", "desc", opt.description));
      if (opt.preview) card.appendChild(el("pre", "", opt.preview));
      box.appendChild(card);
    });
    box.appendChild(el("p", "hint",
      'Pick it in the chat (in a terminal, press its number), or choose "Other" there to type your own answer.'));
    return box;
  }

  // Each question's cards go under that question's heading; if the two do not line up,
  // all cards go below the article.
  function buildOptions(groups, sections) {
    var box = $("options");
    box.replaceChildren();
    groups = groups || [];
    var headed = sections.filter(isHeaded);
    groups.forEach(function (group, i) {
      if (headed.length === groups.length) {
        headed[i].appendChild(optionCards(group));
      } else {
        if (groups.length > 1) box.appendChild(el("h3", "", group.header));
        box.appendChild(optionCards(group));
      }
    });
  }

  function slideSections() {
    return $("article").querySelectorAll(":scope > section");
  }

  function showSlide() {
    var sections = slideSections();
    state.slide = Math.max(0, Math.min(state.slide, sections.length - 1));
    for (var i = 0; i < sections.length; i++) sections[i].classList.toggle("on", i === state.slide);
    $("slidecount").textContent = (state.slide + 1) + " / " + sections.length;
    $("prog").style.width = ((state.slide + 1) / sections.length * 100) + "%";
    $("prev").disabled = state.slide === 0;
    $("next").disabled = state.slide === sections.length - 1;
    $("article").scrollTop = 0;
    fit();
  }

  // An opening section with no heading becomes the lead slide, with the headings as an agenda.
  function addAgenda() {
    var sections = slideSections();
    if (!sections.length || isHeaded(sections[0])) return;
    var agenda = el("ol", "agenda");
    for (var i = 1; i < sections.length; i++) {
      if (isHeaded(sections[i])) agenda.appendChild(el("li", "", sections[i].firstElementChild.textContent));
    }
    sections[0].classList.add("lead");
    sections[0].appendChild(agenda);
  }

  function setKeys(on) {
    var keys = $("keys");
    keys.replaceChildren();
    if (!state.canToggle) return;
    if (on) {
      keys.append(el("kbd", "", "\u2190"), " ", el("kbd", "", "\u2192"), " or click / scroll to navigate \u00a0 ",
        el("kbd", "", "f"), " fit \u00a0 ", el("kbd", "", "p"), " full screen \u00a0 ");
    }
    keys.append(el("kbd", "", "d"), " ", el("kbd", "", "s"), " ", el("kbd", "", "v"), " views");
  }

  function buildViews() {
    var box = $("views");
    box.replaceChildren();
    // Always shown so the toolbar keeps one shape; slide views are disabled for replies with under two sections.
    box.hidden = false;
    VIEWS.forEach(function (v) {
      var b = el("button", v[0] === state.mode ? "on" : "", v[1]);
      b.type = "button";
      b.disabled = !state.canToggle && v[0] !== "doc";
      b.title = b.disabled ? "This reply has no sections to make slides from" : "Press " + v[2];
      b.addEventListener("click", function () { setView(v[0]); });
      box.appendChild(b);
    });
  }

  function applyView() {
    if (!state.canToggle) state.mode = "doc";
    var on = state.mode !== "doc";
    document.body.classList.toggle("slides-on", on);
    $("doc").classList.toggle("slides", on);
    $("doc").classList.toggle("deck", state.mode === "designed");
    $("slidebar").hidden = !on;
    buildViews();
    setKeys(on);
    if (state.mode === "designed") designDeck();
    else if (on) addAgenda();
    if (on) { paginate(); showSlide(); } else fit();
  }

  function preferredSlideMode() {
    return storeGet(STYLE_KEY) === "slides" ? "slides" : "designed";
  }

  // A manual switch holds for the page being viewed; the next page picks its own view again.
  function setView(mode) {
    if (!state.data || !state.canToggle || state.mode === mode) return;
    if (mode !== "doc") storeSet(STYLE_KEY, mode);
    state.mode = mode;
    draw(true);
  }

  // ---------- designed slides: map markdown structure onto visual layouts ----------
  // ---------- reply age: "12 min ago", green, then amber, then red ----------
  var STALE_MIN = 15, SUPER_STALE_MIN = 120, AGE_TICK_MS = 30000;

  // Replies stored before "at" existed have no age and show nothing.
  function setAge(node, at) {
    node.hidden = !at;
    if (!at) return;
    var min = Math.max(0, Math.floor((Date.now() / 1000 - at) / 60));
    node.textContent = min < 1 ? "just now" : min < 60 ? min + " min ago"
      : min < 48 * 60 ? Math.floor(min / 60) + " h ago" : Math.floor(min / 1440) + " d ago";
    node.className = "age " + (min >= SUPER_STALE_MIN ? "superstale" : min >= STALE_MIN ? "stale" : "fresh");
  }

  function tickAges() {
    if (state.entry) setAge($("age"), state.entry.at);
    var spans = $("hlist").querySelectorAll(".age");
    for (var i = 0; i < spans.length; i++) setAge(spans[i], Number(spans[i].dataset.at));
  }

  // ---------- loose threads: a board of cards with a sort toggle ----------
  var SORT_KEY = "present.threadSort";
  var SORTS = [["priority", "Priority"], ["effort", "Quick wins"], ["newest", "Newest"]];
  var RANK = { high: 0, medium: 1, low: 2, quick: 0, long: 2 };

  function sortThreads(threads, by) {
    return threads.slice().sort(function (a, b) {
      var p = RANK[a.priority] - RANK[b.priority], e = RANK[a.effort] - RANK[b.effort], n = (b.at || 0) - (a.at || 0);
      return by === "effort" ? e || p || n : by === "newest" ? n || p || e : p || e || n;
    });
  }

  function threadCard(t) {
    var card = el("div", "thread p-" + t.priority), tags = el("div", "ttags");
    tags.append(el("span", "tag pri", t.priority), el("span", "tag", t.effort));
    [t.project, t.source].filter(Boolean).forEach(function (x) { tags.appendChild(el("span", "tag", x)); });
    card.append(tags, el("div", "ttitle", t.title));
    if (t.why) card.appendChild(el("div", "twhy", t.why));
    if (t.next) {
      var next = el("div", "tnext");
      next.append(el("code", "", t.next), copyButton(function () { return t.next; }));
      card.appendChild(next);
    }
    return card;
  }

  function buildBoard(board) {
    var box = el("div", "board"), bar = el("div", "tsort"), list = el("div", "threads");
    var by = storeGet(SORT_KEY) || "priority";
    function fill() {
      list.replaceChildren.apply(list, sortThreads(board.threads || [], by).map(threadCard));
      for (var i = 0; i < bar.children.length; i++) bar.children[i].classList.toggle("on", bar.children[i].dataset.sort === by);
    }
    SORTS.forEach(function (s) {
      var b = el("button", "", s[1]);
      b.type = "button";
      b.dataset.sort = s[0];
      b.addEventListener("click", function () { by = s[0]; storeSet(SORT_KEY, by); fill(); });
      bar.appendChild(b);
    });
    box.appendChild(el("h1", "", board.title || "Loose threads"));
    if (board.summary) box.appendChild(el("p", "tsummary", board.summary));
    if (!(board.threads || []).length) box.appendChild(el("p", "tsummary", "Nothing left open."));
    box.append(bar, list);
    fill();
    return box;
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function firstReal(node) {
    var c = node.firstChild;
    while (c && c.nodeType === 3 && !c.textContent.trim()) c = c.nextSibling;
    return c;
  }

  // Items with no bold lead still get a title when one is plain to see: a short label before a
  // colon ("Repo: ..."), a short first sentence with more after it, or the clause before a colon.
  // The title is wrapped in a <strong> in place, so the item reads like "**Lead** rest".
  var LABEL_RE = /^\s*([^:.!?]{1,32}?):\s+/;
  var SENTENCE_END_RE = /[.!?](\s+|$)/;
  var CLAUSE_END_RE = /:\s+/;
  var TITLE_MAX_WORDS = 14, STATEMENT_MAX_WORDS = 24, BODY_MIN_WORDS = 5;
  function wordsIn(text) { return text.trim() ? text.trim().split(/\s+/).length : 0; }

  // Wrap everything before the first match of endRe (in a text node) in a <strong>, if that makes a
  // title of at most maxWords with at least BODY_MIN_WORDS after it.
  function splitTitle(holder, endRe, maxWords) {
    var nodes = Array.prototype.slice.call(holder.childNodes), before = "";
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i], end = node.nodeType === 3 ? endRe.exec(node.textContent) : null;
      if (!end) { before += node.textContent; continue; }
      var title = before + node.textContent.slice(0, end.index);
      if (wordsIn(title) > maxWords || wordsIn(holder.textContent) - wordsIn(title) < BODY_MIN_WORDS) return false;
      var strong = el("strong");
      for (var j = 0; j < i; j++) strong.appendChild(nodes[j]);
      strong.appendChild(document.createTextNode(node.textContent.slice(0, end.index)));
      node.textContent = node.textContent.slice(end.index + end[0].length);
      holder.insertBefore(strong, node);
      return true;
    }
    return false;
  }

  function deriveLead(holder, maxWords) {
    var first = firstReal(holder);
    var label = first && first.nodeType === 3 ? LABEL_RE.exec(first.textContent) : null;
    if (label && wordsIn(label[1]) <= 4) {
      var strong = el("strong", "", label[1].trim());
      first.textContent = first.textContent.slice(label[0].length);
      holder.insertBefore(strong, first);
      return true;
    }
    maxWords = maxWords || TITLE_MAX_WORDS;
    return splitTitle(holder, SENTENCE_END_RE, maxWords) || splitTitle(holder, CLAUSE_END_RE, maxWords);
  }

  // "- **Lead** rest" -> { lead, rest }: lead is the <strong>, rest a fragment with everything after it.
  // null when the item does not open with bold text.
  function boldLead(li) {
    var holder = li.firstElementChild && li.firstElementChild.tagName === "P" && firstReal(li) === li.firstElementChild
      ? li.firstElementChild : li;
    var strong = firstReal(holder);
    if (!strong || strong.nodeType !== 1 || strong.tagName !== "STRONG") {
      if (!deriveLead(holder)) return null;
      strong = firstReal(holder);
    }
    var rest = document.createDocumentFragment();
    var node = strong.nextSibling;
    while (node) { var next = node.nextSibling; rest.appendChild(node); node = next; }
    if (holder !== li) {
      node = holder.nextSibling;
      while (node) { var after = node.nextSibling; rest.appendChild(node); node = after; }
    }
    // "**Lead**: under X" reads as "Under X" once it sits on its own line.
    var head = rest.firstChild;
    if (head && head.nodeType === 3) {
      head.textContent = head.textContent.replace(/^\s*[:\-\u2013\u2014.]?\s*/, "").replace(/^[a-z]/, function (c) { return c.toUpperCase(); });
    }
    return { lead: strong, rest: rest };
  }

  function cardInner(li, lead) {
    var frag = document.createDocumentFragment();
    if (lead) {
      var h = el("div", "card-h");
      h.append.apply(h, Array.prototype.slice.call(lead.lead.childNodes));
      frag.appendChild(h);
      if (lead.rest.textContent.trim() || lead.rest.querySelector && lead.rest.querySelector("*")) {
        var b = el("div", "card-b");
        b.appendChild(lead.rest);
        frag.appendChild(b);
      }
    } else {
      var plain = el("div", "card-b plain");
      plain.append.apply(plain, Array.prototype.slice.call(li.childNodes));
      frag.appendChild(plain);
    }
    return frag;
  }

  function designList(list) {
    var items = Array.prototype.slice.call(list.children).filter(function (n) { return n.tagName === "LI"; });
    var leadText = items.map(function (li) {
      var holder = li.firstElementChild && li.firstElementChild.tagName === "P" ? li.firstElementChild : li;
      var s = firstReal(holder);
      return s && s.nodeType === 1 && s.tagName === "STRONG" ? s.textContent.trim() : null;
    });
    var leads = items.map(boldLead);
    var out;
    if (items.length >= 2 && items.length <= 6 && leadText.every(function (t) { return t !== null && STAT_RE.test(t); })) {
      out = el("div", "stats");
      items.forEach(function (li, i) {
        var tile = el("div", "stat"), v = el("div", "v"), l = el("div", "l");
        v.append.apply(v, Array.prototype.slice.call(leads[i].lead.childNodes));
        l.appendChild(leads[i].rest);
        tile.append(v, l);
        out.appendChild(tile);
      });
    } else if (list.tagName === "OL") {
      out = el("ol", "steps");
      var start = Number(list.getAttribute("start")) || 1;
      items.forEach(function (li, i) {
        var row = el("li"), body = el("div");
        body.appendChild(cardInner(li, leads[i]));
        row.append(el("span", "dot", String(start + i)), body);
        out.appendChild(row);
      });
    } else if (items.length <= 6) {
      out = el("div", "cards n" + items.length);
      items.forEach(function (li, i) {
        var card = el("div", "card");
        card.appendChild(cardInner(li, leads[i]));
        out.appendChild(card);
      });
    } else {
      out = el("ul", "chips");
      items.forEach(function (li, i) {
        var chip = el("li");
        if (leads[i]) {
          var b = el("b");
          b.append.apply(b, Array.prototype.slice.call(leads[i].lead.childNodes));
          chip.append(b, " ", leads[i].rest);
        } else {
          chip.append.apply(chip, Array.prototype.slice.call(li.childNodes));
        }
        out.appendChild(chip);
      });
    }
    return out;
  }

  function designSection(section, num) {
    var kids = Array.prototype.slice.call(section.children);
    var heading = kids.shift();
    var head = el("div", "dhead");
    head.append(el("span", "num", pad2(num)), heading);
    var body = el("div", "dbody");
    var leadDone = false;
    // A section of only paragraphs opens on a statement: its first sentence as a headline.
    var prose = kids.every(function (n) { return n.tagName === "P" || n.tagName === "HR"; });
    if (prose && kids[0] && kids[0].tagName === "P") {
      deriveLead(kids[0], STATEMENT_MAX_WORDS);
      kids[0].className = "dstate";
      body.appendChild(kids.shift());
      leadDone = true;
    }
    kids.forEach(function (node) {
      var tag = node.tagName;
      if (tag === "HR") return;
      if (/^H[1-6]$/.test(tag)) { node.className = "dsub"; body.appendChild(node); return; }
      if (tag === "P") { node.className = leadDone ? "dpara" : "dlead"; leadDone = true; body.appendChild(node); return; }
      if (tag === "UL" || tag === "OL") { body.appendChild(designList(node)); return; }
      if (tag === "BLOCKQUOTE") { node.className = "quote"; body.appendChild(node); return; }
      if (tag === "TABLE") { var wrap = el("div", "dtable"); wrap.appendChild(node); body.appendChild(wrap); return; }
      body.appendChild(node);
    });
    section.classList.add("dslide");
    section.replaceChildren(head, body);
  }

  // Cover slide: kicker, title, any opening paragraph, and the section titles as numbered bubbles.
  function coverSection(sections) {
    var d = state.data, entry = state.entry;
    var headed = sections.filter(isHeaded);
    var opener = sections.length && !isHeaded(sections[0]) ? sections[0] : null;
    var h1 = opener && opener.querySelector(":scope > h1");
    var title = h1 ? h1.textContent : (d.project || entry.label || "");
    if (h1) h1.remove();
    var hero = el("div", "hero");
    hero.appendChild(el("div", "kicker", [entry.label, d.project, entry.time].filter(Boolean).join(META_SEP)));
    hero.appendChild(el("h1", "", title));
    if (opener && opener.textContent.trim()) {
      var lead = el("div", "hero-lead");
      lead.append.apply(lead, Array.prototype.slice.call(opener.childNodes));
      hero.appendChild(lead);
    }
    var bubbles = el("div", "bubbles");
    headed.forEach(function (s, i) {
      var bubble = el("span", "bubble");
      bubble.append(el("b", "", String(i + 1)), s.firstElementChild.textContent);
      bubbles.appendChild(bubble);
    });
    hero.appendChild(bubbles);
    var cover = opener || el("section");
    cover.replaceChildren(hero);
    cover.classList.add("cover");
    return cover;
  }

  function designDeck() {
    var article = $("article");
    var sections = Array.prototype.slice.call(slideSections());
    var cover = coverSection(sections);
    if (cover.parentNode !== article) article.insertBefore(cover, article.firstChild);
    var num = 0;
    sections.forEach(function (s) { if (s !== cover && isHeaded(s)) designSection(s, ++num); });
  }

  // ---------- pagination: a section taller than the stage continues on more slides ----------
  // Where a block's items live and an empty copy to move trailing items into, or null when the
  // block can't be split (code, quotes, paragraphs). Tables keep their header on every part.
  function splitParts(block) {
    var table = block.tagName === "TABLE" ? block : block.classList.contains("dtable") ? block.querySelector("table") : null;
    if (table) {
      if (!table.tBodies[0]) return null;
      var copy = block.cloneNode(false), tableCopy = table === block ? copy : copy.appendChild(table.cloneNode(false));
      if (table.tHead) tableCopy.appendChild(table.tHead.cloneNode(true));
      return { from: table.tBodies[0], block: copy, to: tableCopy.appendChild(table.tBodies[0].cloneNode(false)) };
    }
    if (/^(UL|OL)$/.test(block.tagName) || block.classList.contains("cards") || block.classList.contains("stats")) {
      var list = block.cloneNode(false);
      return { from: block, block: list, to: list };
    }
    return null;
  }

  // Move trailing items out of block until what is left fits. Returns the moved part, or null
  // (with nothing moved) when the block can't be split or even its first item doesn't fit.
  function splitBlock(block, fits) {
    var p = splitParts(block);
    if (!p) return null;
    while (!fits() && p.from.children.length > 1) p.to.insertBefore(p.from.lastElementChild, p.to.firstChild);
    if (!p.to.children.length || !fits()) {
      while (p.to.firstChild) p.from.appendChild(p.to.firstChild);
      return null;
    }
    if (block.tagName === "OL" && !block.classList.contains("steps")) p.block.start = (block.start || 1) + p.from.children.length;
    if (block.classList.contains("cards")) {
      block.className = "cards n" + block.children.length;
      p.block.className = "cards n" + p.block.children.length;
    }
    return p.block;
  }

  // Fill pages block by block. A block that overflows is split at its items (list items, cards,
  // table rows) or, if it can't be, moved whole to the next page. A subheading never ends a page.
  function paginateSection(section, maxH) {
    var designed = section.classList.contains("dslide");
    var head = section.firstElementChild;
    var body = designed ? section.querySelector(":scope > .dbody") : section;
    var page = section, parts = [section];
    var fits = function () { return page.offsetHeight <= maxH; };
    var blockCount = function () { return body.children.length - (designed ? 0 : 1); };

    function newPage() {
      var last = body.lastElementChild;
      var carry = blockCount() > 1 && /^H[1-6]$/.test(last.tagName) ? last : null;
      page.classList.remove("on");
      var next = section.cloneNode(false), headCopy = head.cloneNode(true);
      headCopy.removeAttribute("id");
      headCopy.querySelectorAll("[id]").forEach(function (n) { n.removeAttribute("id"); });
      next.appendChild(headCopy);
      body = designed ? next.appendChild(el("div", "dbody")) : next;
      page.after(next);
      parts.push(next);
      page = next;
      page.classList.add("on");
      if (carry) body.appendChild(carry);
    }

    function place(block) {
      body.appendChild(block);
      if (fits()) return;
      var rest = splitBlock(block, fits);
      if (rest) { newPage(); place(rest); return; }
      if (blockCount() > 1) { block.remove(); newPage(); place(block); }
    }

    section.classList.add("on");
    if (fits() || !body) { section.classList.remove("on"); return; }
    var blocks = Array.prototype.slice.call(body.children).filter(function (n) { return n !== head; });
    blocks.forEach(function (b) { b.remove(); });
    blocks.forEach(place);
    page.classList.remove("on");
    if (parts.length < 2) return;
    parts.forEach(function (p, i) {
      var title = designed ? p.firstElementChild.lastElementChild : p.firstElementChild;
      title.appendChild(el("span", "part", (i + 1) + " / " + parts.length));
    });
  }

  // Measured at zoom 1 against the stage, so fit() only ever scales a slide up.
  function paginate() {
    var stage = $("article"), cs = getComputedStyle(stage);
    var maxH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (maxH <= 0) return;
    Array.prototype.slice.call(slideSections()).forEach(function (section) {
      // The cover and the text-slide lead are summaries; they stay one slide.
      if (section.classList.contains("dslide") || isHeaded(section)) paginateSection(section, maxH);
    });
  }

  // Re-paginate when the stage changes size: a window resize or entering/leaving full screen.
  var relayoutTimer = null;
  function relayout() {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(function () {
      if (state.entry && $("doc").classList.contains("slides")) draw(true);
      else fit();
    }, 150);
  }

  // Zoom the current slide so it fills the stage. Width is pinned to its natural size first so the
  // zoom scales the layout as it is instead of reflowing it wider.
  function fit() {
    var doc = $("doc"), on = doc.classList.contains("slides");
    doc.classList.toggle("fit", on && state.fit);
    $("fit").classList.toggle("on", state.fit);
    var sections = slideSections();
    for (var i = 0; i < sections.length; i++) { sections[i].style.zoom = ""; sections[i].style.width = ""; }
    if (!on || !state.fit) return;
    var stage = $("article"), slide = sections[state.slide];
    if (!slide) return;
    var cs = getComputedStyle(stage);
    var availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    var w = slide.offsetWidth, h = slide.offsetHeight;
    if (!w || !h) return;
    slide.style.width = w + "px";
    slide.style.zoom = Math.max(0.35, Math.min(availW / w, availH / h, 2.2));
  }

  function toggleFit() {
    state.fit = !state.fit;
    storeSet(FIT_KEY, state.fit ? "1" : "0");
    fit();
  }

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(function () { toast("Full screen was blocked."); });
  }

  // The last section holds the question; in slides that is the last slide.
  function jumpToEnd() {
    var sections = slideSections();
    if (!sections.length) return;
    if ($("doc").classList.contains("slides")) {
      state.slide = sections.length - 1;
      showSlide();
    } else {
      sections[sections.length - 1].scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function setBanner(entry, waiting, sections) {
    var banner = $("banner");
    banner.hidden = !waiting;
    banner.replaceChildren();
    if (!waiting) return;
    banner.appendChild(document.createTextNode(BANNERS[entry.kind] || BANNERS.question));
    if (entry.kind === "question" && sections.length >= 2) {
      var jump = el("button", "", "Jump to the question");
      jump.type = "button";
      jump.addEventListener("click", jumpToEnd);
      banner.appendChild(jump);
    }
  }

  // A colored dot in the tab: the style's accent, or its waiting color when Claude needs an answer.
  function setFavicon() {
    var waiting = document.body.classList.contains("waiting");
    var color = getComputedStyle(document.documentElement).getPropertyValue(waiting ? "--pill-wait" : "--accent").trim() || "#888888";
    var old = document.getElementById("favicon");
    if (old) old.remove();
    var link = document.createElement("link");
    link.id = "favicon";
    link.rel = "icon";
    link.href = "data:image/svg+xml," + encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='" + color + "'/></svg>");
    document.head.appendChild(link);
  }

  function setTitle() {
    var d = state.data, entry = state.entry;
    document.title = (state.unread ? "(new) " : "") + [entry.label, d.project, d.branch].filter(Boolean).join(" \u00b7 ");
  }

  // keepView: redraw the same page after a manual Slides / Document switch.
  function draw(keepView) {
    var d = state.data, entry = state.entry;
    var waiting = !!WAITING[entry.kind] && entry.n === d.latest;

    document.body.classList.toggle("waiting", waiting);
    $("pill").textContent = entry.label;
    $("meta").textContent = [d.project, d.branch, entry.time].filter(Boolean).join(META_SEP);
    setAge($("age"), entry.at);
    $("count").textContent = (entry.n - d.first + 1) + " / " + (d.latest - d.first + 1);
    $("older").disabled = entry.n <= d.first;
    $("newer").disabled = entry.n >= d.latest;
    markCurrent();

    var article = $("article");
    article.replaceChildren(entry.board ? buildBoard(entry.board) : renderMarkdown(entry.markdown || ""));

    var pres = article.querySelectorAll("pre");
    for (var i = 0; i < pres.length; i++) {
      (function (pre) {
        var code = pre.textContent;
        pre.appendChild(copyButton(function () { return code; }));
      })(pres[i]);
    }

    buildOutline(article);
    var sections = sectionize(article);
    state.canToggle = sections.length >= 2;
    if (!keepView) {
      // Three or more short sections open as slides; everything else as a document.
      state.mode = slideEligible(sections) ? preferredSlideMode() : "doc";
      state.slide = 0;
    }
    buildOptions(entry.options, sections);
    setBanner(entry, waiting, sections);
    applyView();
    setTitle();
    setFavicon();
    window.scrollTo(0, 0);
  }

  // ---------- history: one file per reply, fetched only when you go to it ----------
  function loadScript(src, onError) {
    var s = document.createElement("script");
    s.src = src;
    s.onload = function () { s.remove(); };
    s.onerror = function () { s.remove(); if (onError) onError(); };
    document.head.appendChild(s);
  }

  function showReply(n) {
    var d = state.data;
    if (!d || n < d.first || n > d.latest) return;
    if (state.cache[n]) {
      state.want = null;
      state.entry = state.cache[n];
      draw();
      return;
    }
    state.want = n;
    loadScript(SESSION + ".r" + ("00000" + n).slice(-6) + ".js", function () {
      if (state.want === n) toast("That reply is no longer stored.");
    });
  }

  window.__presentEntry = function (entry) {
    if (!entry || typeof entry.n !== "number") return;
    state.cache[entry.n] = entry;
    if (entry.n === state.want) showReply(entry.n);
  };

  function go(delta) {
    if (state.entry) showReply(state.entry.n + delta);
  }

  function markCurrent() {
    var items = $("hlist").children;
    for (var i = 0; i < items.length; i++) items[i].classList.toggle("on", +items[i].dataset.n === (state.entry && state.entry.n));
  }

  window.__presentIndex = function (index) {
    var list = $("hlist");
    list.replaceChildren();
    ((index && index.items) || []).slice().reverse().forEach(function (item) {
      var li = el("li");
      li.dataset.n = item.n;
      li.tabIndex = 0;
      li.appendChild(el("span", "htitle", item.title || item.label));
      var meta = el("span", "hmeta", [item.label, item.time, item.words + " words"].join(META_SEP));
      var age = el("span", "age");
      age.dataset.at = item.at || "";
      setAge(age, item.at);
      meta.appendChild(age);
      li.appendChild(meta);
      li.addEventListener("click", function () { showReply(item.n); });
      li.addEventListener("keydown", function (ev) { if (ev.key === "Enter") showReply(item.n); });
      list.appendChild(li);
    });
    state.indexRev = state.rev;
    markCurrent();
  };

  // The title list is only fetched when the drawer opens, and again only after a new reply.
  function toggleHistory(open) {
    var drawer = $("drawer");
    open = typeof open === "boolean" ? open : drawer.hidden;
    drawer.hidden = !open;
    $("history").classList.toggle("on", open);
    if (open && state.indexRev !== state.rev) loadScript(SESSION + ".index.js?t=" + Date.now());
  }

  function step(delta) {
    state.slide += delta;
    showSlide();
  }

  // The template or this script changed since the tab loaded: reload once to pick it up.
  function staleBuild(build) {
    if (!build || !BUILD || build === BUILD) return false;
    try {
      if (sessionStorage.getItem("present.reloaded") === build) return false;
      sessionStorage.setItem("present.reloaded", build);
    } catch (e) { return false; }
    location.reload();
    return true;
  }

  // Called by the feed file each time it is (re)loaded.
  // A new reply always takes over the view, even while you are reading an older one.
  window.__present = function (data) {
    if (!data || !data.latest || data.rev === state.rev) return;
    if (staleBuild(data.build)) return;
    feedTheme(data);
    var first = state.rev === null;
    var bumped = !state.data || data.latest !== state.data.latest;
    state.rev = data.rev;
    state.data = data;
    if (!bumped) return;
    state.unread = !first && document.hidden;
    showReply(data.latest);
    if (!$("drawer").hidden) toggleHistory(true);
  };

  function poll() {
    var s = document.createElement("script");
    s.src = FEED + "?t=" + Date.now();
    s.onload = s.onerror = function () { s.remove(); };
    document.head.appendChild(s);
  }

  function setTheme(id) {
    var known = THEMES.some(function (t) { return t[0] === id; });
    document.documentElement.setAttribute("data-theme", known ? id : THEMES[0][0]);
    $("theme").value = known ? id : THEMES[0][0];
    setFavicon();
  }

  // "present.py theme <id>" reaches the page through the feed. The newest choice wins, whether it
  // was made there or in the dropdown, so a feed choice is applied once per themeRev.
  function feedTheme(data) {
    if (!data.theme || !data.themeRev || state.themeRev === data.themeRev) return;
    state.themeRev = data.themeRev;
    var seen = null;
    try { seen = localStorage.getItem("present.themeRev"); } catch (e) { /* storage blocked */ }
    if (seen === data.themeRev) return;
    setTheme(data.theme);
    try {
      localStorage.setItem("present.themeRev", data.themeRev);
      localStorage.setItem("present.theme", data.theme);
    } catch (e) { /* storage blocked */ }
  }

  THEMES.forEach(function (t) {
    var option = el("option", "", t[1]);
    option.value = t[0];
    $("theme").appendChild(option);
  });
  var savedTheme = null;
  try { savedTheme = localStorage.getItem("present.theme"); } catch (e) { /* storage blocked */ }
  setTheme(savedTheme);

  $("theme").addEventListener("change", function () {
    setTheme($("theme").value);
    try { localStorage.setItem("present.theme", $("theme").value); } catch (e) { /* storage blocked */ }
  });

  $("older").addEventListener("click", function () { go(-1); });
  $("newer").addEventListener("click", function () { go(1); });
  $("history").addEventListener("click", function () { toggleHistory(); });
  $("hclose").addEventListener("click", function () { toggleHistory(false); });
  $("prev").addEventListener("click", function () { step(-1); });
  $("next").addEventListener("click", function () { step(1); });
  $("copy-all").addEventListener("click", function () {
    if (state.entry) copyText(state.entry.markdown || "");
  });
  $("fit").addEventListener("click", toggleFit);
  $("full").addEventListener("click", toggleFull);
  window.addEventListener("resize", relayout);
  document.addEventListener("fullscreenchange", relayout);
  document.addEventListener("keydown", function (ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || /^(SELECT|INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
    var key = ev.key.toLowerCase();
    if (ev.target.tagName === "BUTTON" && (key === " " || key === "enter")) return;  // the button's own action
    var inSlides = $("doc").classList.contains("slides");
    // History works in every view: [ ] (or Shift+arrows) step through earlier replies, H lists them, Esc returns.
    if (key === "[" || (ev.shiftKey && key === "arrowleft")) { ev.preventDefault(); return go(-1); }
    if (key === "]" || (ev.shiftKey && key === "arrowright")) { ev.preventDefault(); return go(1); }
    if (key === "h") return toggleHistory();
    if (key === "escape") {
      if (!$("drawer").hidden) return toggleHistory(false);
      if (state.data && !document.fullscreenElement) return showReply(state.data.latest);
    }
    for (var v = 0; v < VIEWS.length; v++) if (key === VIEWS[v][2]) return setView(VIEWS[v][0]);
    if (!inSlides) return;
    if (key === "f") return toggleFit();
    if (key === "p") return toggleFull();
    var last = slideSections().length - 1;
    if (key === "arrowright" || key === "pagedown" || key === " " || key === "j") { step(1); ev.preventDefault(); }
    if (key === "arrowleft" || key === "pageup" || key === "k") { step(-1); ev.preventDefault(); }
    if (key === "home") { state.slide = 0; showSlide(); ev.preventDefault(); }
    if (key === "end") { state.slide = last; showSlide(); ev.preventDefault(); }
  });
  // ---------- mouse and touch in slides: wheel, click, side buttons, swipe ----------
  var WHEEL_STEP = 60, WHEEL_QUIET_MS = 450, LINE_PX = 40, SWIPE_MIN = 50, CLICK_BACK_ZONE = 0.3;
  // Clicks on these keep their own meaning instead of changing slides.
  var CLICKABLE = "a, button, input, select, textarea, summary, pre, code, .opt";
  var wheel = { sum: 0, last: 0, lockedUntil: 0 }, touchX = null;
  function slidesOn() { return $("doc").classList.contains("slides"); }

  // A trackpad flick sends a long burst of wheel events with momentum. Step once per burst:
  // after a step, events keep the lock alive until the wheel has been quiet for a moment.
  $("article").addEventListener("wheel", function (ev) {
    if (!slidesOn() || ev.ctrlKey) return;  // ctrl+wheel is pinch zoom
    ev.preventDefault();
    var now = Date.now(), d = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
    if (ev.deltaMode === 1) d *= LINE_PX;
    if (now < wheel.lockedUntil) { wheel.lockedUntil = now + WHEEL_QUIET_MS; return; }
    if (now - wheel.last > WHEEL_QUIET_MS) wheel.sum = 0;
    wheel.last = now;
    wheel.sum += d;
    if (Math.abs(wheel.sum) < WHEEL_STEP) return;
    step(wheel.sum > 0 ? 1 : -1);
    wheel.sum = 0;
    wheel.lockedUntil = now + WHEEL_QUIET_MS;
  }, { passive: false });

  $("article").addEventListener("click", function (ev) {
    if (!slidesOn() || ev.button !== 0 || ev.target.closest(CLICKABLE)) return;
    if (String(window.getSelection() || "")) return;  // the end of a text selection, not a click
    var box = this.getBoundingClientRect();
    step(ev.clientX - box.left < box.width * CLICK_BACK_ZONE ? -1 : 1);
  });

  // Mouse side buttons: 3 is back, 4 is forward.
  document.addEventListener("mouseup", function (ev) {
    if (!slidesOn() || (ev.button !== 3 && ev.button !== 4)) return;
    ev.preventDefault();
    step(ev.button === 4 ? 1 : -1);
  });

  $("article").addEventListener("touchstart", function (ev) {
    touchX = ev.touches.length === 1 ? ev.touches[0].clientX : null;
  }, { passive: true });
  $("article").addEventListener("touchend", function (ev) {
    if (touchX === null || !slidesOn()) return;
    var dx = ev.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) >= SWIPE_MIN) step(dx < 0 ? 1 : -1);
  });

  // Browsers slow timers in background tabs, so also check the moment the tab is looked at.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    poll();
    tickAges();
    if (state.unread) { state.unread = false; setTitle(); }
  });
  window.addEventListener("focus", poll);

  poll();
  setInterval(poll, POLL_MS);
  setInterval(tickAges, AGE_TICK_MS);
})();
