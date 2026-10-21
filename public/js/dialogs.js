// Alertas de confirmação modernos (no lugar do confirm() do navegador).
// Uso: adicione data-confirm="mensagem" em um botão, link ou <form>. Opcionais:
//   data-title="Título"  data-ok="Texto do botão"  data-tone="danger | primary" (padrão: danger)
(function () {
  var dlg, resolver;

  // Fecha o alerta e devolve a resposta (true = confirmou) para quem perguntou.
  function finish(ok) {
    if (dlg.open) dlg.close();
    if (resolver) { var r = resolver; resolver = null; r(ok); }
  }

  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.setAttribute('role', 'alertdialog');
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    dlg.setAttribute('aria-describedby', 'dlg-msg');
    dlg.innerHTML =
      '<div class="p-6">' +
        '<div class="flex flex-col items-center gap-4 text-center sm:flex-row sm:items-start sm:text-left">' +
          '<span data-icon class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-2xl font-bold"></span>' +
          '<div class="min-w-0"><h3 id="dlg-title" class="text-lg font-extrabold"></h3>' +
          '<p id="dlg-msg" class="mt-1 text-sm text-slate-500"></p></div>' +
        '</div>' +
        '<div class="mt-6 grid grid-cols-2 gap-3 sm:flex sm:justify-end">' +
          '<button type="button" data-cancel autofocus class="btn-ghost ring-1 ring-slate-200">Voltar</button>' +
          '<button type="button" data-ok class="btn-danger"></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);

    dlg.querySelector('[data-cancel]').addEventListener('click', function () { finish(false); });
    dlg.querySelector('[data-ok]').addEventListener('click', function () { finish(true); });
    // clicar fora do cartão (no fundo escurecido) e a tecla Esc também cancelam
    dlg.addEventListener('click', function (e) { if (e.target === dlg) finish(false); });
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); finish(false); });
  }

  function ask(el) {
    if (!dlg) build();
    var danger = (el.getAttribute('data-tone') || 'danger') === 'danger';
    var icon = dlg.querySelector('[data-icon]');
    icon.textContent = danger ? '!' : '✓';
    icon.className = 'flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-2xl font-bold ' +
      (danger ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300' : 'bg-brand-soft text-brand');
    dlg.querySelector('#dlg-title').textContent = el.getAttribute('data-title') || (danger ? 'Tem certeza?' : 'Confirmar ação?');
    dlg.querySelector('#dlg-msg').textContent = el.getAttribute('data-confirm');
    var ok = dlg.querySelector('[data-ok]');
    ok.textContent = el.getAttribute('data-ok') || 'Confirmar';
    ok.className = danger ? 'btn-danger' : 'btn-primary';
    return new Promise(function (resolve) { resolver = resolve; dlg.showModal(); });
  }

  // botões e links
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-confirm]');
    if (!el || el.tagName === 'FORM') return;
    if (el._confirmed) { el._confirmed = false; return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    ask(el).then(function (ok) { if (ok) { el._confirmed = true; el.click(); } });
  }, true);

  // formulários inteiros (ex.: "Confirmar todos")
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f.hasAttribute || !f.hasAttribute('data-confirm')) return;
    if (f._confirmed) { f._confirmed = false; return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    ask(f).then(function (ok) { if (ok) { f._confirmed = true; f.requestSubmit(); } });
  }, true);
})();
