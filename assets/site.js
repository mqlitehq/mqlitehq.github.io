// Site behavior — no framework, three jobs:
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
    // Keep section anchors visible below the navigation, including wrapped rows.
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
        ex.textContent = '\u25be show all ' + lines + ' lines';
        ex.addEventListener('click', function () {
          var open = box.classList.toggle('open');
          ex.textContent = open ? '\u25b4 show less' : '\u25be show all ' + lines + ' lines';
          if (!open) box.scrollIntoView({ block: 'nearest' });
        });
        box.appendChild(ex);
      }

      var btn = document.createElement('button');
      btn.className = 'copybtn';
      btn.type = 'button';
      btn.textContent = 'copy';
      btn.addEventListener('click', function () {
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = 'copied ✓';
          btn.classList.add('ok');
          setTimeout(function () {
            btn.textContent = 'copy';
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
