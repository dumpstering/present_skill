/* Renderer for present.py pages. Loaded from _assets/ beside the page; the CSP allows no inline script.
   The page polls its feed file (out/<session>.data.js), which calls window.__present(data). */
(function () {
  "use strict";

  var FEED = document.currentScript.getAttribute("data-feed");
  var BUILD = document.currentScript.getAttribute("data-build");
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

  var state = { rev: null, data: null, index: 0, slides: false, canToggle: false, splitTag: "H2", slide: 0,
    unread: false, themeRev: null };
  var $ = function (id) { return document.getElementById(id); };

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
    if (on) {
      keys.append(el("kbd", "", "\u2190"), " ", el("kbd", "", "\u2192"), " navigate \u00a0 ", el("kbd", "", "d"), " document view");
    } else if (state.canToggle) {
      keys.append(el("kbd", "", "s"), " slides");
    }
  }

  function applyView() {
    var on = state.canToggle && state.slides;
    $("view").hidden = !state.canToggle;
    $("view").textContent = on ? "Document" : "Slides";
    document.body.classList.toggle("slides-on", on);
    $("doc").classList.toggle("slides", on);
    $("slidebar").hidden = !on;
    setKeys(on);
    if (on) { addAgenda(); showSlide(); }
  }

  // A manual switch holds for the page being viewed; the next page picks its own view again.
  function setView(slides) {
    if (!state.data || !state.canToggle || state.slides === slides) return;
    state.slides = slides;
    draw(true);
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
    var d = state.data, entry = d.entries[state.index];
    document.title = (state.unread ? "(new) " : "") + [entry.label, d.project, d.branch].filter(Boolean).join(" \u00b7 ");
  }

  // keepView: redraw the same page after a manual Slides / Document switch.
  function draw(keepView) {
    var d = state.data, entry = d.entries[state.index];
    var waiting = !!WAITING[entry.kind] && state.index === d.entries.length - 1;

    document.body.classList.toggle("waiting", waiting);
    $("pill").textContent = entry.label;
    $("meta").textContent = [d.project, d.branch, entry.time].filter(Boolean).join(META_SEP);
    $("count").textContent = (state.index + 1) + " / " + d.entries.length;
    $("older").disabled = state.index === 0;
    $("newer").disabled = state.index === d.entries.length - 1;

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
      state.slides = slideEligible(sections);
      state.slide = 0;
    }
    buildOptions(entry.options, sections);
    setBanner(entry, waiting, sections);
    applyView();
    setTitle();
    setFavicon();
    window.scrollTo(0, 0);
  }

  function go(delta) {
    var next = state.index + delta;
    if (!state.data || next < 0 || next >= state.data.entries.length) return;
    state.index = next;
    draw();
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
  window.__present = function (data) {
    if (!data || !data.entries || !data.entries.length || data.rev === state.rev) return;
    if (staleBuild(data.build)) return;
    feedTheme(data);
    var first = state.rev === null;
    state.rev = data.rev;
    state.data = data;
    state.index = data.entries.length - 1;
    state.unread = !first && document.hidden;
    draw();
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
  $("prev").addEventListener("click", function () { step(-1); });
  $("next").addEventListener("click", function () { step(1); });
  $("copy-all").addEventListener("click", function () {
    if (state.data) copyText(state.data.entries[state.index].markdown || "");
  });
  $("view").addEventListener("click", function () { setView(!state.slides); });
  document.addEventListener("keydown", function (ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || /^(SELECT|INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
    var key = ev.key.toLowerCase();
    if (ev.target.tagName === "BUTTON" && (key === " " || key === "enter")) return;  // the button's own action
    var inSlides = $("doc").classList.contains("slides");
    if (key === "s" && !inSlides) return setView(true);
    if (key === "d" && inSlides) return setView(false);
    if (!inSlides) return;
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
