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
  var SLIDE_MAX_WORDS = 220;
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
  var DENSE_WORDS = 130;

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

  function wordCount(node) {
    var text = node.textContent.trim();
    return text ? text.split(/\s+/).length : 0;
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
    return sections.filter(isHeaded).length >= SLIDE_MIN_SECTIONS &&
      sections.every(function (s) { return wordCount(s) <= SLIDE_MAX_WORDS; });
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
      keys.append(el("kbd", "", "\u2190"), " ", el("kbd", "", "\u2192"), " navigate \u00a0 ",
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
    if (on) showSlide(); else fit();
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
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function firstReal(node) {
    var c = node.firstChild;
    while (c && c.nodeType === 3 && !c.textContent.trim()) c = c.nextSibling;
    return c;
  }

  // "- **Lead** rest" -> { lead, rest }: lead is the <strong>, rest a fragment with everything after it.
  // null when the item does not open with bold text.
  function boldLead(li) {
    var holder = li.firstElementChild && li.firstElementChild.tagName === "P" && firstReal(li) === li.firstElementChild
      ? li.firstElementChild : li;
    var strong = firstReal(holder);
    if (!strong || strong.nodeType !== 1 || strong.tagName !== "STRONG") return null;
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
    var dense = wordCount(section) > DENSE_WORDS;
    var kids = Array.prototype.slice.call(section.children);
    var heading = kids.shift();
    var head = el("div", "dhead");
    head.append(el("span", "num", pad2(num)), heading);
    var body = el("div", "dbody");
    var leadDone = false;
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
    section.classList.toggle("dense", dense);
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
    $("count").textContent = (entry.n - d.first + 1) + " / " + (d.latest - d.first + 1);
    $("older").disabled = entry.n <= d.first;
    $("newer").disabled = entry.n >= d.latest;
    markCurrent();

    var article = $("article");
    article.replaceChildren(renderMarkdown(entry.markdown || ""));

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
      li.appendChild(el("span", "hmeta", [item.label, item.time, item.words + " words"].join(META_SEP)));
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
  window.addEventListener("resize", fit);
  document.addEventListener("fullscreenchange", function () { requestAnimationFrame(fit); });
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
  // Browsers slow timers in background tabs, so also check the moment the tab is looked at.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    poll();
    if (state.unread) { state.unread = false; setTitle(); }
  });
  window.addEventListener("focus", poll);

  poll();
  setInterval(poll, POLL_MS);
})();
