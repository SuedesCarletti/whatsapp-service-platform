(function () {
  'use strict';
  var C = window.LFCHAT_CONFIG;
  if (!C || window.__wppchatLoaded) return;
  window.__wppchatLoaded = true;

  var TOKEN_KEY = 'wppchat_token_' + C.siteKey;
  var state = { token: null, lastId: 0, seen: {}, open: false, unread: 0, polling: false, verified: false, needsForm: false, identity: null, started: false, pending: null, context: null, expiresAt: 0, protocol: null };
  var el = {};

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} return null; }

  function api(method, path, body) {
    var opts = { method: method, headers: { 'ngrok-skip-browser-warning': '1' } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(C.apiBase + '/api/site-chat' + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.detail || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return d;
      });
    });
  }

  function fetchIdentity() {
    if (!C.loggedIn) return Promise.resolve(null);
    return fetch(C.identityUrl, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { return d && d.identity ? d.identity : null; })
      .catch(function () { return null; });
  }

  /* ───────── UI ───────── */
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; }

  function build() {
    var root = h('div', 'wppchat-root lf-' + C.position);
    root.style.setProperty('--wpp-color', C.color || '#1E293B');

    var panel = h('div', 'wppchat-panel');
    var head = h('div', 'wppchat-head');
    var ttl = h('div', 'wppchat-ttl'); ttl.appendChild(h('b', '', C.title));
    el.proto = h('small', 'wppchat-proto'); ttl.appendChild(el.proto);
    head.appendChild(ttl);
    var x = h('button', 'wppchat-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Fechar');
    x.onclick = toggle; head.appendChild(x);
    panel.appendChild(head);

    el.ctx = h('div', 'wppchat-ctx'); el.ctx.style.display = 'none';
    panel.appendChild(el.ctx);

    el.form = h('div', 'wppchat-form');
    el.form.style.display = 'none';
    el.form.appendChild(h('p', '', 'Para começar, nos diga quem você é:'));
    el.name = h('input'); el.name.placeholder = 'Seu nome'; el.name.maxLength = 100;
    el.email = h('input'); el.email.placeholder = 'Seu e-mail (opcional)'; el.email.type = 'email';
    el.phone = h('input'); el.phone.placeholder = 'Seu WhatsApp/telefone (opcional)'; el.phone.type = 'tel';
    var go = h('button', '', 'Iniciar conversa'); go.type = 'button';
    go.onclick = submitForm;
    el.form.appendChild(el.name); el.form.appendChild(el.email); el.form.appendChild(el.phone); el.form.appendChild(go);
    panel.appendChild(el.form);

    el.msgs = h('div', 'wppchat-msgs');
    panel.appendChild(el.msgs);
    el.err = h('div', 'wppchat-err'); el.err.style.display = 'none';
    panel.appendChild(el.err);

    el.foot = h('div', 'wppchat-foot');
    el.input = h('textarea'); el.input.rows = 1; el.input.placeholder = 'Digite sua mensagem...'; el.input.maxLength = 4000;
    el.input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    el.input.addEventListener('input', function () { el.input.style.height = 'auto'; el.input.style.height = Math.min(el.input.scrollHeight, 90) + 'px'; });
    el.sendBtn = h('button', 'wppchat-send', 'Enviar'); el.sendBtn.type = 'button'; el.sendBtn.onclick = send;
    el.foot.appendChild(el.input); el.foot.appendChild(el.sendBtn);
    panel.appendChild(el.foot);

    el.fab = h('button', 'wppchat-fab'); el.fab.type = 'button'; el.fab.setAttribute('aria-label', 'Abrir chat');
    el.fab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>';
    el.badge = h('span', 'wppchat-badge'); el.fab.appendChild(el.badge);
    el.fab.onclick = toggle;

    root.appendChild(panel); root.appendChild(el.fab);
    document.body.appendChild(root);
    el.root = root;

    el.hello = h('div', 'wppchat-hello', C.greeting);
    el.msgs.appendChild(el.hello);
  }

  function setError(msg) { el.err.textContent = msg || ''; el.err.style.display = msg ? 'block' : 'none'; }

  function linkify(parent, text) {
    var re = /(https?:\/\/[^\s<]+)/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = document.createElement('a'); a.href = m[1]; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = m[1];
      parent.appendChild(a); last = m.index + m[1].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function addMessage(m) {
    if (state.seen[m.id]) return false;
    state.seen[m.id] = true;
    if (m.id > state.lastId) state.lastId = m.id;
    var b = h('div', 'wppchat-m ' + (m.from === 'agent' ? 'agent' : 'visitor'));
    if (m.from === 'agent' && m.agent) b.appendChild(h('div', 'wppchat-who', m.agent));
    linkify(b, m.text || '');
    el.msgs.appendChild(b);
    el.msgs.scrollTop = el.msgs.scrollHeight;
    return true;
  }

  /* Protocolo: passou o prazo (configurado no painel, 24h por padrão) sem atividade, o próximo
     clique recomeça do zero. O histórico completo continua no painel de atendimento. */
  function setProtocol(p) {
    state.protocol = p && p.number ? p.number : null;
    state.expiresAt = p && p.expires_at ? p.expires_at : 0;
    if (el.proto) el.proto.textContent = state.protocol ? 'Protocolo ' + state.protocol : '';
  }

  function resetView() {
    el.msgs.innerHTML = '';
    state.seen = {};
    setProtocol(null);
  }

  function showForm(show) {
    el.form.style.display = show ? 'flex' : 'none';
    el.msgs.style.display = show ? 'none' : 'flex';
    el.foot.style.display = show ? 'none' : 'flex';
  }

  function updateBadge() {
    el.badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
    el.badge.style.display = state.unread > 0 ? 'flex' : 'none';
  }

  /* ───────── Sessão / mensagens ───────── */
  function pageInfo() { return { page_url: location.href, page_title: document.title }; }

  function openSession(extra) {
    var body = Object.assign({ site_key: C.siteKey, token: state.token }, pageInfo(), extra || {});
    if (state.identity) body.identity = state.identity;
    return api('POST', '/session', body).then(function (d) {
      state.token = d.token; store(TOKEN_KEY, d.token);
      state.verified = d.verified;
      state.needsForm = d.needs_identity;
      setProtocol(d.protocol);
      (d.messages || []).forEach(addMessage);
      return d;
    });
  }

  function start() {
    if (state.started) return Promise.resolve();
    state.started = true;
    return fetchIdentity().then(function (idn) {
      state.identity = idn;
      return openSession();
    }).then(function (d) {
      showForm(d.needs_identity);
      poll();
      flushPending();
    }).catch(function (e) {
      state.started = false;
      setError('Chat indisponível no momento.');
    });
  }

  function submitForm() {
    var name = el.name.value.trim();
    if (!name) { el.name.focus(); return; }
    openSession({ name: name, email: el.email.value.trim(), phone: el.phone.value.trim() })
      .then(function () { showForm(false); setError(''); el.input.focus(); flushPending(); })
      .catch(function () { setError('Não foi possível iniciar. Tente novamente.'); });
  }

  function send() {
    var text = el.input.value.trim();
    if (!text || el.sendBtn.disabled) return;
    sendText(text, true);
  }

  function sendText(text, fromInput) {
    el.sendBtn.disabled = true; setError('');
    return api('POST', '/messages', Object.assign({ site_key: C.siteKey, token: state.token, text: text }, pageInfo()))
      .then(function (d) {
        if (fromInput) { el.input.value = ''; el.input.style.height = 'auto'; }
        if (d.message && d.message.id) addMessage(d.message);
        if (d.protocol) setProtocol(d.protocol);
      })
      .catch(function (e) {
        if (e.status === 401) { state.token = null; store(TOKEN_KEY, null); state.started = false; start(); }
        setError(e.status === 429 ? 'Muitas mensagens. Aguarde um instante.' : 'Não foi possível enviar. Tente novamente.');
      })
      .then(function () { el.sendBtn.disabled = false; if (fromInput) el.input.focus(); });
  }

  /* ───────── Dúvida sobre produto (API pública) ─────────
     window.LFChat.open({ message, context: { title, url } })
     ou document.dispatchEvent(new CustomEvent('wppchat:open', { detail: {...} })).
     Abre o chat, mostra o produto em destaque e envia a primeira mensagem já com
     o contexto (nome + link), para o atendente não precisar perguntar "qual produto?".
     Se o visitante ainda precisa se identificar, a mensagem espera o formulário. */
  function setContext(ctx) {
    state.context = ctx || null;
    el.ctx.textContent = '';
    if (!ctx || !ctx.title) { el.ctx.style.display = 'none'; return; }
    el.ctx.appendChild(h('span', 'wppchat-ctx-label', 'Dúvida sobre:'));
    if (ctx.url) {
      var a = document.createElement('a'); a.href = ctx.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = ctx.title;
      el.ctx.appendChild(a);
    } else {
      el.ctx.appendChild(h('b', '', ctx.title));
    }
    el.ctx.style.display = 'block';
  }

  function flushPending() {
    if (!state.pending || !state.token || el.form.style.display !== 'none') return;
    var text = state.pending; state.pending = null;
    sendText(text, false);
  }

  function openChat(opts) {
    opts = opts || {};
    setContext(opts.context);
    if (opts.message) {
      var msg = String(opts.message);
      if (opts.context && opts.context.url && msg.indexOf(opts.context.url) === -1) msg += '\n' + opts.context.url;
      state.pending = msg;
    }
    if (!state.open) toggle();
    else if (state.started) flushPending();
    else start();
  }

  window.LFChat = { open: openChat };
  document.addEventListener('wppchat:open', function (e) { openChat(e.detail || {}); });

  function poll() {
    if (state.polling || !state.token) return;
    state.polling = true;
    var delay = 0;
    (function loop() {
      if (!state.token) { state.polling = false; return; }
      var q = '?site_key=' + encodeURIComponent(C.siteKey) + '&token=' + encodeURIComponent(state.token) + '&after=' + state.lastId + '&wait=25';
      api('GET', '/messages' + q).then(function (d) {
        delay = 0;
        var fresh = 0;
        (d.messages || []).forEach(function (m) { if (addMessage(m) && m.from === 'agent') fresh++; });
        if (fresh && !state.open) { state.unread += fresh; updateBadge(); }
      }).catch(function (e) {
        if (e.status === 401) { state.token = null; store(TOKEN_KEY, null); state.polling = false; state.started = false; return 'stop'; }
        delay = Math.min((delay || 2000) * 2, 30000);
      }).then(function (r) { if (r === 'stop') return; setTimeout(loop, delay); });
    })();
  }

  function toggle() {
    state.open = !state.open;
    el.root.classList.toggle('wpp-open', state.open);
    if (state.open) {
      state.unread = 0; updateBadge();
      if (!state.started) start();
      else if (state.expiresAt && Date.now() > state.expiresAt) {
        resetView();
        openSession().then(function (d) { showForm(d.needs_identity); flushPending(); })
          .catch(function () { setError('Chat indisponível no momento.'); });
      }
      else { showForm(state.needsForm && !state.verified); flushPending(); }
      setTimeout(function () { el.msgs.scrollTop = el.msgs.scrollHeight; if (el.foot.style.display !== 'none') el.input.focus(); }, 50);
    }
  }

  function init() {
    build();
    state.token = store(TOKEN_KEY);
    // Visitante que já conversou antes: retoma em segundo plano (histórico + aviso de resposta).
    if (state.token) start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
