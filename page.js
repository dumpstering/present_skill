/* Renderer for present.py pages. Loaded from _assets/ beside the page; the CSP allows no inline script.
   The page polls its feed file (out/<session>.data.js), which calls window.__present(data). */
(function () {
  "use strict";

  var FEED = document.currentScript.getAttribute("data-feed");
  var BUILD = document.currentScript.getAttribute("data-build");
  var POLL_MS = 1500;
  var SLIDE_MIN_SECTIONS = 3;
  var SLIDE_MAX_WORDS = 150;
  var WAITING = { question: true, ask: true, plan: true };
  var SAFE_HREF = /^(https?:|mailto:|#)/i;
  var DROP_TAGS = /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|LINK|META|BASE|FORM|INPUT|BUTTON|TEXTAREA|SELECT)$/;

  // Looks defined in template.html; the first is the default.
  var THEMES = [
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

  var state = { rev: null, data: null, index: 0, slides: false, slide: 0, unread: false, themeRev: null };
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
  marked.use({
    gfm: true,
    renderer: { html: function (token) { return esc(typeof token === "string" ? token : (token.raw || token.text || "")); } }
  });

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

  function copyText(text, button) {
    function done() {
      var old = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () { button.textContent = old; }, 1200);
    }
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
    b.addEventListener("click", function () { copyText(getText(), b); });
    return b;
  }

  function wordCount(node) {
    var text = node.textContent.trim();
    return text ? text.split(/\s+/).length : 0;
  }

  // Wrap the article into one <section> per h2 (content before the first h2 is its own section).
  function sectionize(article) {
    var sections = [], current = null;
    Array.prototype.slice.call(article.childNodes).forEach(function (node) {
      if (node.nodeType === 1 && node.tagName === "H2" || !current) {
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
    var headed = sections.filter(function (s) { return s.firstElementChild && s.firstElementChild.tagName === "H2"; });
    return headed.length >= SLIDE_MIN_SECTIONS &&
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

  function buildOptions(groups) {
    var box = $("options");
    box.replaceChildren();
    (groups || []).forEach(function (group) {
      if (groups.length > 1) box.appendChild(el("h3", "", group.header));
      (group.options || []).forEach(function (opt) {
        var card = el("div", "opt");
        card.appendChild(el("div", "n", opt.n));
        card.appendChild(el("div", "label", opt.label));
        card.appendChild(copyButton(function () { return opt.label; }));
        if (opt.description) card.appendChild(el("div", "desc", opt.description));
        if (opt.preview) card.appendChild(el("pre", "", opt.preview));
        box.appendChild(card);
      });
    });
  }

  function showSlide() {
    var sections = $("article").querySelectorAll(":scope > section");
    state.slide = Math.max(0, Math.min(state.slide, sections.length - 1));
    for (var i = 0; i < sections.length; i++) sections[i].classList.toggle("on", i === state.slide);
    $("slidecount").textContent = (state.slide + 1) + " / " + sections.length;
    $("prev").disabled = state.slide === 0;
    $("next").disabled = state.slide === sections.length - 1;
  }

  function applyView(eligible) {
    var on = eligible && state.slides;
    $("view").hidden = !eligible;
    $("view").textContent = on ? "Document" : "Slides";
    $("doc").classList.toggle("slides", on);
    $("slidebar").hidden = !on;
    if (on) showSlide();
  }

  function setTitle() {
    var d = state.data, entry = d.entries[state.index];
    document.title = (state.unread ? "(new) " : "") + entry.label + " - " + d.project;
  }

  function draw() {
    var d = state.data, entry = d.entries[state.index];
    var waiting = !!WAITING[entry.kind] && state.index === d.entries.length - 1;

    document.body.classList.toggle("waiting", waiting);
    $("pill").textContent = entry.label;
    $("banner").hidden = !waiting;
    $("meta").textContent = [d.project, d.branch, entry.time].filter(Boolean).join(" / ");
    $("count").textContent = (state.index + 1) + " / " + d.entries.length;
    $("older").disabled = state.index === 0;
    $("newer").disabled = state.index === d.entries.length - 1;

    var holder = document.createElement("template");
    holder.innerHTML = marked.parse(entry.markdown || "");
    sanitize(holder.content);
    var article = $("article");
    article.replaceChildren(holder.content);

    var pres = article.querySelectorAll("pre");
    for (var i = 0; i < pres.length; i++) {
      (function (pre) {
        var code = pre.textContent;
        pre.appendChild(copyButton(function () { return code; }));
      })(pres[i]);
    }

    buildOutline(article);
    buildOptions(entry.options);
    state.slide = 0;
    applyView(slideEligible(sectionize(article)));
    setTitle();
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
  try {
    state.slides = localStorage.getItem("present.slides") === "1";
    savedTheme = localStorage.getItem("present.theme");
  } catch (e) { /* storage blocked */ }
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
    if (state.data) copyText(state.data.entries[state.index].markdown || "", $("copy-all"));
  });
  $("view").addEventListener("click", function () {
    state.slides = !state.slides;
    try { localStorage.setItem("present.slides", state.slides ? "1" : "0"); } catch (e) { /* storage blocked */ }
    draw();
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.target.tagName === "SELECT") return;
    if (!$("doc").classList.contains("slides")) return;
    if (ev.key === "ArrowRight" || ev.key === "PageDown") { step(1); ev.preventDefault(); }
    if (ev.key === "ArrowLeft" || ev.key === "PageUp") { step(-1); ev.preventDefault(); }
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
