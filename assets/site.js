// Site behavior — no framework: responsive navigation plus three code-block jobs:
//   1. syntax-highlight code blocks that DECLARE a language (never auto-detect,
//      so plain-text/ASCII blocks are left untouched),
//   2. give every code block a copy button (copies the code only — never
//      line numbers or prompts),
//   3. add a line-number gutter to declared-language blocks of 4+ lines,
//      as a separate non-selectable column so copy/select stays clean.
// Plus a tiny tab switcher for elements marked .tabs (landing quickstart).
(function () {
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    var chinese = document.documentElement.lang === 'zh-CN';
    document.querySelectorAll('[data-language-switch]').forEach(function (link) {
      function preserveLocation() {
        var target = new URL(link.href, window.location.href);
        target.hash = window.location.hash;
        target.search = window.location.search;
        link.href = target.href;
      }
      preserveLocation();
      window.addEventListener('hashchange', preserveLocation);
    });
    // Native disclosures keep every destination available without JavaScript.
    // Move only the prefix that fits into the row; keep the same anchor nodes so
    // their current-page state and focus survive a change in available width.
    document.querySelectorAll('[data-overflow]').forEach(function (row) {
      var primary = row.querySelector('.overflow-primary');
      var more = row.querySelector('.overflow-more');
      var items = more.querySelector('.overflow-items');
      var summary = more.querySelector('summary');
      var links = Array.from(items.children);
      var label = summary.getAttribute('aria-label');
      links.forEach(function (link) {
        var target = new URL(link.href, window.location.href);
        if (!target.hash && target.pathname === window.location.pathname) {
          link.setAttribute('aria-current', 'page');
        }
      });

      function distribute() {
        var focused = document.activeElement;
        var focusedLink = links.indexOf(focused) !== -1;
        // Right-aligned flex overflow can extend to the left without increasing
        // scrollWidth. Measure the child widths instead, in the same coordinate
        // system as the row (which also works when the page is zoomed).
        function fits() {
          var children = Array.from(row.children).filter(function (child) {
            return getComputedStyle(child).display !== 'none';
          });
          var scale = row.getBoundingClientRect().width / row.offsetWidth;
          var gap = parseFloat(getComputedStyle(row).columnGap) || 0;
          var width = children.reduce(function (sum, child) {
            return sum + child.getBoundingClientRect().width;
          }, Math.max(0, children.length - 1) * gap * scale);
          return width <= row.getBoundingClientRect().width + 0.5;
        }
        links.forEach(function (link) { primary.appendChild(link); });
        more.hidden = true;
        if (!fits()) {
          more.hidden = false;
          while (primary.lastElementChild && !fits()) {
            items.insertBefore(primary.lastElementChild, items.firstChild);
          }
        }
        var current = items.querySelector('[aria-current="page"]');
        more.classList.toggle('has-current', Boolean(current));
        summary.setAttribute('aria-label', label + (current ? (chinese ? '；当前页面：' : '; current page: ') + current.textContent : ''));
        if (more.hidden) more.open = false;
        if (focusedLink) {
          if (items.contains(focused)) more.open = true;
          focused.focus({ preventScroll: true });
          if (items.contains(focused)) {
            // Retain the page's scroll position, but reveal a restored link in
            // the panel's own scroll area on short screens.
            var panel = items.getBoundingClientRect();
            var target = focused.getBoundingClientRect();
            var scale = panel.height / items.offsetHeight;
            if (target.top < panel.top) items.scrollTop -= (panel.top - target.top) / scale;
            else if (target.bottom > panel.bottom) items.scrollTop += (target.bottom - panel.bottom) / scale;
          }
        } else if (focused === summary) {
          (more.hidden ? primary.lastElementChild || row.querySelector('a') : summary).focus({ preventScroll: true });
        }
      }

      more.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && more.open) {
          more.open = false;
          summary.focus();
          event.preventDefault();
        }
      });
      more.addEventListener('focusout', function () {
        setTimeout(function () {
          if (!more.contains(document.activeElement)) more.open = false;
        }, 0);
      });
      more.addEventListener('click', function (event) {
        if (event.target.closest('a')) more.open = false;
      });
      document.addEventListener('click', function (event) {
        if (!more.contains(event.target)) more.open = false;
      });
      // Observe the available row width, rather than the overflowing contents.
      if (window.ResizeObserver) new ResizeObserver(distribute).observe(row);
      else window.addEventListener('resize', distribute);
      if (document.fonts) {
        document.fonts.ready.then(distribute);
        document.fonts.addEventListener('loadingdone', distribute);
      }
      distribute();
    });

    var brand = document.querySelector('nav.top .brand');
    if (brand && /\/(?:index\.html)?$/.test(window.location.pathname)) {
      brand.setAttribute('aria-current', 'page');
    }

    // Keep section anchors visible below the navigation.
    var nav = document.querySelector('nav.top');
    if (nav && window.ResizeObserver) {
      new ResizeObserver(function () {
        document.documentElement.style.scrollPaddingTop = (nav.offsetHeight + 16) + 'px';
      }).observe(nav);
    }

    // 1 · highlight declared languages only
    if (window.hljs) {
      window.hljs.configure({ cssSelector: 'pre code[class*="language-"]' });
      window.hljs.highlightAll();
    }

    // 2 + 3 · copy button and gutter per block
    document.querySelectorAll('pre').forEach(function (pre) {
      if (pre.closest('figure.fig')) return; // never decorate figures
      var code = pre.querySelector('code');
      var text = (code || pre).innerText.replace(/\n$/, '');

      var box = document.createElement('div');
      box.className = 'codebox';
      pre.parentNode.insertBefore(box, pre);

      var declared = code && /language-/.test(code.className);
      var lines = text.split('\n').length;
      if (declared && lines >= 4) {
        var gutter = document.createElement('div');
        gutter.className = 'gutter';
        gutter.setAttribute('aria-hidden', 'true');
        for (var i = 1; i <= lines; i++) {
          var n = document.createElement('span');
          n.textContent = i;
          gutter.appendChild(n);
        }
        var row = document.createElement('div');
        row.className = 'coderow';
        row.appendChild(gutter);
        row.appendChild(pre);
        box.appendChild(row);
      } else {
        box.appendChild(pre);
      }

      // Long code examples collapse; plain-text diagrams remain fully visible.
      if (declared && lines > 18) {
        box.classList.add('clip');
        var fade = document.createElement('div');
        fade.className = 'fade';
        box.appendChild(fade);
        var ex = document.createElement('button');
        ex.className = 'expandbtn';
        ex.type = 'button';
        ex.textContent = chinese ? '\u25be 展开全部 ' + lines + ' 行' : '\u25be show all ' + lines + ' lines';
        ex.addEventListener('click', function () {
          var open = box.classList.toggle('open');
          ex.textContent = open ? (chinese ? '\u25b4 收起' : '\u25b4 show less') : (chinese ? '\u25be 展开全部 ' + lines + ' 行' : '\u25be show all ' + lines + ' lines');
          if (!open) box.scrollIntoView({ block: 'nearest' });
        });
        box.appendChild(ex);
      }

      var btn = document.createElement('button');
      btn.className = 'copybtn';
      btn.type = 'button';
      btn.textContent = chinese ? '复制' : 'copy';
      btn.addEventListener('click', function () {
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = chinese ? '已复制 ✓' : 'copied ✓';
          btn.classList.add('ok');
          setTimeout(function () {
            btn.textContent = chinese ? '复制' : 'copy';
            btn.classList.remove('ok');
          }, 1500);
        });
      });
      box.appendChild(btn);
    });

    // 4 · tabs (landing quickstart)
    document.querySelectorAll('.tabs').forEach(function (tabs) {
      var buttons = tabs.querySelectorAll('.tabbar button');
      var panes = tabs.querySelectorAll('.tabpane');
      buttons.forEach(function (b) {
        b.addEventListener('click', function () {
          buttons.forEach(function (x) { x.classList.toggle('on', x === b); });
          panes.forEach(function (p) {
            p.classList.toggle('on', p.dataset.t === b.dataset.t);
          });
        });
      });
    });
  });
})();
