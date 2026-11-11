/* «Личное дело»: голосование зрителей, табло (?screen=1) и пульт ведущих (?admin=1). */
(() => {
  'use strict';

  // ---------------------------------------------------------------- настройки
  const API = 'api/index.php';
  const STATE_URL = 'api/state.json';
  const POLL_MS = { viewer: 2500, screen: 1000, admin: 1500 };
  const VOTED_SHEET_MS = 5000;

  const defaultPrizes = [
    {name:'Калькулятор времени',qty:'без ограничений',links:[['Забрать подарок','https://t.me/zarumnaya_time_gift_bot']]},
    {name:'Платформа мини-продуктов',qty:'без ограничений',links:[['Забрать подарок','https://t.me/zarumnaya_product_bot']]},
    {name:'Месяц участия в Нашем клубе',qty:'3 приза',links:[['Забрать подарок','https://t.me/+79381027053']]},
    {name:'Диагностика',qty:'3 приза',links:[['Записаться','https://t.me/+79381027053']]},
    {name:'Бизнес-консультация от Светланы Логуновой',qty:'1 приз',links:[['Написать Светлане','https://t.me/LanaLoguna']]},
    {name:'Консультация бизнес-наставника Светланы Логуновой',qty:'1 приз',links:[['Написать Светлане','https://t.me/LanaLoguna']]},
    {id:'show-ticket',name:'Билет на следующее шоу «Личное дело»',qty:'15 призов',links:[['Забрать билет','https://t.me/+79381027053']]},
    {name:'Персональный нумерологический квест по дате рождения',qty:'без ограничений',links:[['Открыть в MAX','https://max.ru/id645328396107_1_bot'],['Открыть в Telegram','https://t.me/Tregub_kvest_bot']]},
    {id:'phoenix-month',name:'Месяц участия в трансформационном клубе «Феникс»',qty:'2 шт',links:[['Написать в MAX','https://max.ru/u/f9LHodD0cOL1yqik7lLHO2puLqmokvARFHNdX8Uuk3dDSvxUzfpw0w-cvYQ'],['Написать в Telegram','https://t.me/Tatyana_Tregub']]},
    {name:'Скидка 10% на создание сайта',qty:'1 приз',links:[['Написать в MAX','https://max.ru/u/f9LHodD0cOL44FsDohSNLf8faLGo3MRFcC8Auq_8g9J4QUCj7GPTnQOt2zI'],['Написать в Telegram','https://t.me/+79381027053']]},
    {name:'Скидка 15% на создание личного ИИ-агента',qty:'1 приз',links:[['Написать в MAX','https://max.ru/u/f9LHodD0cOL44FsDohSNLf8faLGo3MRFcC8Auq_8g9J4QUCj7GPTnQOt2zI'],['Написать в Telegram','https://t.me/+79381027053']]}
  ];
  const TICKET_LIMIT = 15, PHOENIX_LIMIT = 2, TOTAL_GIFTS_LIMIT = 50;

  const CHOICES = {
    'Психология':   { api: 'psychology', phrase: 'за психологию' },
    'Нумерология':  { api: 'numerology', phrase: 'за нумерологию' },
    'Свой вариант': { api: 'custom',     phrase: 'за свой вариант' }
  };

  const KEY = {
    prizes: 'gift-wheel-prizes-v3', myVote: 'gift-wheel-my-vote-v2', mySuggestion: 'lichnoe-delo-my-suggestion-v1',
    played: 'gift-wheel-played-v1', wins: 'gift-wheel-wins-v1', totalWins: 'gift-wheel-total-wins-v1',
    voterId: 'gift-wheel-voter-id-v1', adminToken: 'lichnoe-delo-admin-session-v1'
  };

  // ---------------------------------------------------------------- утилиты
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const ls = {
    get: (k, d = null) => safe(() => { const v = localStorage.getItem(k); return v === null ? d : v; }, d),
    set: (k, v) => safe(() => localStorage.setItem(k, v)),
    del: k => safe(() => localStorage.removeItem(k)),
    json: (k, d) => safe(() => JSON.parse(localStorage.getItem(k)) ?? d, d)
  };
  const ss = {
    get: k => safe(() => sessionStorage.getItem(k) || '', ''),
    set: (k, v) => safe(() => sessionStorage.setItem(k, v)),
    del: k => safe(() => sessionStorage.removeItem(k))
  };
  const clampInt = (v, min, max, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d; };
  const haptic = p => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };

  // ---------------------------------------------------------------- режим
  const q = new URLSearchParams(location.search);
  const MODE = q.has('admin') ? 'admin' : q.has('screen') ? 'screen' : 'viewer';
  document.body.classList.add('page-' + MODE);

  // ---------------------------------------------------------------- состояние
  let votes = { psychology: 0, numerology: 0, abstain: 0 };
  let displayOverride = null, gaugeOverride = null, expectedVotes = 50;
  let suggestions = [], lastRev = null, connected = null;

  let voterId = ls.get(KEY.voterId);
  if (!voterId || !/^[A-Za-z0-9._-]{8,80}$/.test(voterId)) {
    voterId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    ls.set(KEY.voterId, voterId);
  }
  let selected = ls.get(KEY.myVote, '');
  if (selected === 'Воздержусь') selected = 'Свой вариант';
  if (!CHOICES[selected]) selected = '';
  let played = ls.get(KEY.played) === 'yes';
  let voting = false;

  let prizes = ls.json(KEY.prizes, null) || defaultPrizes;
  let prizeWins = ls.json(KEY.wins, {}) || {};
  let ticketWins = Number(prizeWins['show-ticket']) || 0;
  let phoenixWins = Number(prizeWins['phoenix-month']) || 0;
  let totalWins = Number(ls.get(KEY.totalWins)) || 0;
  let adminToken = ss.get(KEY.adminToken);

  // ---------------------------------------------------------------- сеть
  async function fetchState() {
    try {
      const r = await fetch(STATE_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) return await r.json();
    } catch {}
    const r = await fetch(API + '?a=state', { cache: 'no-store' });
    if (!r.ok) throw new Error('state ' + r.status);
    return r.json();
  }

  async function api(action, body, auth = false) {
    const headers = { 'content-type': 'application/json' };
    if (auth) { headers.authorization = 'Bearer ' + adminToken; headers['x-admin-token'] = adminToken; }
    const r = await fetch(API + '?a=' + action, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok) { const e = new Error(data.error || 'http ' + r.status); e.status = r.status; throw e; }
    return data;
  }

  function applyState(data, force = false) {
    if (!data || typeof data !== 'object') return;
    if (!force && lastRev !== null && data.rev === lastRev) return;
    lastRev = data.rev ?? null;
    const v = data.votes || {};
    votes = { psychology: Number(v.psychology) || 0, numerology: Number(v.numerology) || 0, abstain: Number(v.custom) || 0 };
    const c = data.control || {};
    displayOverride = c.display && typeof c.display === 'object' ? c.display : null;
    gaugeOverride = c.gaugeOverride == null ? null : Number(c.gaugeOverride);
    expectedVotes = clampInt(c.expectedVotes, 1, 10000, 50);
    suggestions = Array.isArray(data.suggestions) ? data.suggestions.filter(t => typeof t === 'string') : [];
    renderGauge();
    renderOwnEntries();
  }

  function setConnected(ok) {
    if (connected === ok) return;
    connected = ok;
    const dot = $('#liveDot');
    if (dot) { dot.classList.toggle('on', ok); dot.classList.toggle('off', !ok); }
    if (MODE === 'admin' && !ok) adminFeedback('Нет связи с голосованием. Проверь интернет — табло обновится само, когда связь вернётся.');
  }

  let pollTimer = 0;
  async function poll() {
    clearTimeout(pollTimer);
    try { applyState(await fetchState()); setConnected(true); }
    catch { setConnected(false); }
    if (!document.hidden) pollTimer = setTimeout(poll, POLL_MS[MODE]);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); else clearTimeout(pollTimer); });

  // ---------------------------------------------------------------- табло
  let prevShown = null;
  function renderGauge() {
    const realP = votes.psychology, realN = votes.numerology, realA = votes.abstain;
    setText('#realPsychCount', realP); setText('#realNumerCount', realN); setText('#realAbstainCount', realA); setText('#realTotalCount', realP + realN + realA);

    const shown = displayOverride || votes;
    const p = Number(shown.psychology) || 0, n = Number(shown.numerology) || 0, a = Number(shown.abstain) || 0;
    const stepsToEdge = Math.max(1, Math.ceil(expectedVotes / 2));
    const difference = n - p;
    const rawOffset = difference / (2 * stepsToEdge);
    // Даже один голос заметно сдвигает стрелку (не меньше 8° от центра).
    const visibleOffset = difference === 0 ? 0 : Math.sign(difference) * Math.max(Math.abs(rawOffset), 8 / 180);
    const ratio = gaugeOverride === null ? Math.max(0, Math.min(1, .5 + visibleOffset)) : Math.max(0, Math.min(100, gaugeOverride)) / 100;
    const needle = $('#needle');
    if (needle) needle.style.transform = 'translateX(-50%) rotate(' + (ratio * 180 - 90) + 'deg)';

    const next = { psychCount: p, numerCount: n, abstainCount: a, totalCount: p + n + a };
    Object.entries(next).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (prevShown && prevShown[id] !== val && MODE === 'screen') {
        const item = el.parentElement; item.classList.remove('bump'); void item.offsetWidth; item.classList.add('bump');
      }
      el.textContent = val;
    });
    prevShown = next;

    if (MODE !== 'admin') return;
    setIfUnfocused('#editPsych', p); setIfUnfocused('#editNumer', n); setIfUnfocused('#editAbstain', a);
    setIfUnfocused('#expectedVotes', expectedVotes);
    setText('#gaugeStepSummary', 'Шаг стрелки: 1/' + stepsToEdge + ' от центра к краю');
    const position = Math.round(ratio * 100);
    setIfUnfocused('#gaugeControl', position);
    setText('#gaugeControlValue', (100 - position) + ' / ' + position);
  }
  function setText(sel, v) { const el = $(sel); if (el) el.textContent = v; }
  function setIfUnfocused(sel, v) { const el = $(sel); if (el && document.activeElement !== el) el.value = v; }

  // ---------------------------------------------------------------- голосование
  const choicesBox = $('.choices');
  const voteStatus = $('#voteStatus');
  const btnFor = choice => $$('.choice').find(b => b.dataset.choice === choice);

  function renderChoices() {
    $$('.choice').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.choice === selected)));
    choicesBox.classList.toggle('has-vote', !!selected);
    if (!voteStatus || voting) return;
    voteStatus.className = 'vote-status';
    if (selected) {
      voteStatus.classList.add('ok');
      voteStatus.innerHTML = '';
      voteStatus.append('✓ Твой голос — ');
      const b = document.createElement('b'); b.textContent = CHOICES[selected].phrase; voteStatus.append(b);
      voteStatus.append('. Передумала — нажми другую карточку.');
    } else {
      voteStatus.textContent = 'Нажми на карточку — голос сразу попадёт на табло.';
    }
  }

  async function castVote(choice, suggestion = '') {
    if (voting) return false;
    const btn = btnFor(choice);
    voting = true;
    btn.classList.add('is-sending');
    voteStatus.className = 'vote-status';
    voteStatus.textContent = 'Отправляем голос…';
    // Щелчки «трещотки», замедляющиеся к остановке барабана (только Android)
    haptic([6, 70, 6, 80, 6, 100, 6, 130, 8, 170]);
    try {
      const [data] = await Promise.all([
        api('vote', { voterId, choice: CHOICES[choice].api, suggestion }),
        spinReel(btn, { loops: 2, duration: 900 })
      ]);
      selected = choice;
      ls.set(KEY.myVote, choice);
      if (choice === 'Свой вариант') ls.set(KEY.mySuggestion, suggestion);
      applyState(data.state, true);
      setConnected(true);
      voting = false;
      btn.classList.remove('is-sending');
      renderChoices();
      btn.classList.remove('just-voted'); void btn.offsetWidth; btn.classList.add('just-voted');
      haptic([20, 40, 60]);
      celebrate(btn);
      showVoted(choice, suggestion, false);
      syncSpin();
      return true;
    } catch (e) {
      voting = false;
      btn.classList.remove('is-sending');
      renderChoices();
      btn.classList.remove('is-error'); void btn.offsetWidth; btn.classList.add('is-error');
      haptic([70, 50, 70]);
      voteStatus.className = 'vote-status err';
      voteStatus.textContent = e.status === 429
        ? 'Сервер перегружен. Подожди пару секунд и нажми ещё раз.'
        : 'Голос не отправился. Проверь интернет и нажми ещё раз.';
      return false;
    }
  }

  function handleChoice(btn, event) {
    const choice = btn.dataset.choice;
    ripple(btn, event);
    if (choice === 'Свой вариант') { openOwn(); return; }
    if (choice === selected && !voting) { haptic(15); showVoted(choice, '', true); return; }
    castVote(choice);
  }

  $$('.choice').forEach(btn => btn.addEventListener('click', e => handleChoice(btn, e)));

  // Барабан игрового автомата: лента символов прокручивается в окне карточки и встаёт на свой символ
  const SYMBOLS = ['art-psych', 'art-numer', 'art-own'];
  function spinReel(btn, { loops = 3, duration = 1400, delay = 0 } = {}) {
    if (reduceMotion || !btn.animate) return Promise.resolve();
    const own = SYMBOLS.find(c => btn.querySelector('.choice-art').classList.contains(c));
    const start = SYMBOLS.indexOf(own);
    btn.querySelectorAll('.reel').forEach(r => r.remove());
    const win = document.createElement('span');
    win.className = 'reel';
    const strip = document.createElement('span');
    strip.className = 'reel-strip';
    const total = loops * 3 + 1;
    strip.style.height = total * 100 + '%';
    for (let i = 0; i < total; i++) {
      const item = document.createElement('span');
      item.className = 'reel-item';
      const face = document.createElement('span');
      face.className = 'reel-face ' + SYMBOLS[(start + i) % 3];
      item.append(face);
      strip.append(item);
    }
    win.append(strip);
    btn.append(win);
    const step = 100 / total;
    // Лента едет вниз, на последних процентах проскакивает и возвращается — как механический барабан
    const anim = strip.animate([
      { transform: `translateY(${-(total - 1) * step}%)`, filter: 'blur(0px)', easing: 'cubic-bezier(.45,.05,.25,1)' },
      { offset: .18, filter: 'blur(2.5px)' },
      { offset: .84, transform: `translateY(${step * .12}%)`, filter: 'blur(0px)', easing: 'cubic-bezier(.3,0,.4,1)' },
      { transform: 'translateY(0%)', filter: 'blur(0px)' }
    ], { duration, delay, fill: 'both' });
    return anim.finished.catch(() => {}).then(() => win.remove());
  }
  // Заставка: три барабана останавливаются по очереди, слева направо
  function introReels() {
    $$('.choice').forEach((btn, i) => spinReel(btn, { loops: 3 + i, duration: 1300 + i * 380, delay: 250 }));
  }

  // Отклик на нажатие: волна из точки касания
  function ripple(btn, e) {
    if (reduceMotion) return;
    const r = btn.getBoundingClientRect();
    const dot = document.createElement('span');
    dot.className = 'ripple';
    const x = e && e.clientX ? e.clientX - r.left : r.width / 2;
    const y = e && e.clientY ? e.clientY - r.top : r.height / 2;
    dot.style.left = x + 'px'; dot.style.top = y + 'px';
    btn.querySelector('.choice-art').append(dot);
    setTimeout(() => dot.remove(), 650);
  }

  // Конфетти из выбранной карточки
  function celebrate(btn) {
    if (reduceMotion) return;
    const layer = $('#burstLayer');
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const colors = ['#ffe2a0', '#e9b95c', '#ffffff', '#c0352a', '#2b6fc4', '#6fd49a'];
    for (let i = 0; i < 28; i++) {
      const p = document.createElement('i');
      const angle = Math.random() * Math.PI * 2;
      const dist = 70 + Math.random() * 150;
      p.style.left = cx + 'px'; p.style.top = cy + 'px';
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(angle) * dist - 40 + 'px');
      p.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
      p.style.animationDelay = (Math.random() * 80) + 'ms';
      if (i % 3 === 0) { p.style.width = '8px'; p.style.height = '8px'; p.style.borderRadius = '50%'; }
      layer.append(p);
      setTimeout(() => p.remove(), 1200);
    }
  }

  // Карточка «Голос учтён»
  const voted = $('#voted');
  let votedTimer = 0;
  function showVoted(choice, suggestion, already) {
    $('#votedTitle').textContent = already ? 'Твой голос уже учтён' : 'Голос учтён!';
    const line = $('#votedChoice');
    line.textContent = 'Ты голосуешь ';
    const b = document.createElement('b');
    b.textContent = CHOICES[choice].phrase + (suggestion ? ': «' + suggestion + '»' : '');
    line.append(b);
    $('#votedNote').textContent = choice === 'Свой вариант'
      ? 'Ведущие увидят твой вариант на пульте.'
      : 'Смотри на большой экран — стрелка уже сдвинулась.';
    const next = $('#votedNext');
    const canSpin = !played && totalWins < TOTAL_GIFTS_LIMIT;
    next.textContent = canSpin ? 'Крутить барабан ↓' : 'Готово';
    next.dataset.goto = canSpin ? 'wheel' : '';
    voted.classList.remove('closing');
    voted.hidden = false;
    voted.style.setProperty('--voted-ms', VOTED_SHEET_MS + 'ms');
    const timer = voted.querySelector('.voted-timer');
    timer.style.animation = 'none'; void timer.offsetWidth; timer.style.animation = '';
    clearTimeout(votedTimer);
    votedTimer = setTimeout(hideVoted, VOTED_SHEET_MS);
  }
  function hideVoted() {
    if (voted.hidden) return;
    clearTimeout(votedTimer);
    voted.classList.add('closing');
    setTimeout(() => { voted.hidden = true; voted.classList.remove('closing'); }, 220);
  }
  voted.addEventListener('click', e => { if (e.target === voted) hideVoted(); });
  $('#votedNext').addEventListener('click', e => {
    const go = e.currentTarget.dataset.goto;
    hideVoted();
    if (go === 'wheel') $('#wheelArea').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  });

  // «Свой вариант»
  const ownModal = $('#ownModal'), ownText = $('#ownText');
  function openOwn() {
    ownText.value = selected === 'Свой вариант' ? ls.get(KEY.mySuggestion, '') : '';
    $('#ownCount').textContent = ownText.value.length;
    ownModal.classList.add('show');
    setTimeout(() => ownText.focus(), 50);
  }
  function closeOwn() { ownModal.classList.remove('show'); }
  ownText.addEventListener('input', () => { $('#ownCount').textContent = ownText.value.length; });
  $('#ownForm').addEventListener('submit', async e => {
    e.preventDefault();
    const text = ownText.value.trim();
    if (!text) { ownText.focus(); return; }
    const submit = $('#submitOwn');
    submit.disabled = true; submit.textContent = 'Отправляем…';
    closeOwn();
    const ok = await castVote('Свой вариант', text);
    submit.disabled = false; submit.textContent = 'Отправить вариант';
    if (!ok) ownModal.classList.add('show');
  });
  $('#closeOwn').addEventListener('click', closeOwn);
  $('#cancelOwn').addEventListener('click', closeOwn);
  ownModal.addEventListener('click', e => { if (e.target === ownModal) closeOwn(); });

  // ---------------------------------------------------------------- барабан
  const wheel = $('#wheel'), spin = $('#spin'), hint = $('#hint'), modal = $('#modal');
  let wheelRotation = 0;

  function availablePrizes() {
    if (totalWins >= TOTAL_GIFTS_LIMIT) return [];
    return prizes.filter(p => (p.id !== 'show-ticket' || ticketWins < TICKET_LIMIT) && (p.id !== 'phoenix-month' || phoenixWins < PHOENIX_LIMIT));
  }

  function renderWheel() {
    const active = availablePrizes();
    const n = active.length;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '-100 -100 200 200');
    svg.setAttribute('aria-hidden', 'true');
    const point = (deg, r) => { const a = (deg - 90) * Math.PI / 180; return [r * Math.cos(a), r * Math.sin(a)]; };
    if (!n) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', '100'); c.setAttribute('fill', '#2a1710');
      svg.append(c);
    } else {
      const colors = ['#b3261e', '#f6e6c6', '#1a110c', '#f6e6c6', '#1f5fb3', '#f6e6c6'];
      const seg = 360 / n;
      for (let i = 0; i < n; i++) {
        let fill = colors[i % colors.length];
        if (i === n - 1 && n % 2 === 1 && fill === colors[0]) fill = '#7a3a12';
        const [x0, y0] = point(i * seg, 100), [x1, y1] = point((i + 1) * seg, 100);
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', n === 1 ? 'M0,-100A100,100 0 1 1 -0.01,-100Z' : `M0,0L${x0},${y0}A100,100 0 ${seg > 180 ? 1 : 0} 1 ${x1},${y1}Z`);
        path.setAttribute('fill', fill);
        path.setAttribute('stroke', '#e9b95c'); path.setAttribute('stroke-width', '1.4');
        svg.append(path);
        const [sx, sy] = point(i * seg + seg / 2, 74);
        const star = document.createElementNS(NS, 'text');
        star.setAttribute('x', sx); star.setAttribute('y', sy + 4);
        star.setAttribute('text-anchor', 'middle'); star.setAttribute('font-size', '12');
        star.setAttribute('fill', fill === '#f6e6c6' ? '#b3772e' : '#ffd98a');
        star.textContent = '✦';
        svg.append(star);
      }
    }
    wheel.replaceChildren(svg);
  }

  function renderTicketWins() {
    setText('#ticketWinCount', ticketWins);
    $('#ticketWinProgress').style.width = Math.min(100, ticketWins / TICKET_LIMIT * 100) + '%';
    setText('#totalGiftCount', totalWins);
    $('#totalGiftProgress').style.width = Math.min(100, totalWins / TOTAL_GIFTS_LIMIT * 100) + '%';
  }

  function syncSpin() {
    const allGone = totalWins >= TOTAL_GIFTS_LIMIT;
    spin.disabled = !selected || played || allGone;
    spin.textContent = allGone ? 'Все подарки разыграны' : played ? 'Попытка использована' : selected ? 'Крутить барабан' : 'Сначала проголосуй ↑';
    hint.textContent = allGone ? 'Все 50 подарков уже разыграны.'
      : played ? 'Ты уже крутила барабан на этом устройстве.'
      : selected ? 'Жми — посмотрим, что выпадет!' : 'Барабан откроется после голосования.';
  }

  spin.addEventListener('click', () => {
    if (!selected || played) return;
    const active = availablePrizes();
    if (!active.length) return;
    played = true;
    ls.set(KEY.played, 'yes');
    syncSpin();
    spin.textContent = 'Барабан крутится…';
    hint.textContent = 'Удачи!';
    haptic(30);
    const index = Math.floor(Math.random() * active.length);
    const segment = 360 / active.length;
    const target = ((360 - (index * segment + segment / 2)) % 360 + 360) % 360;
    wheelRotation = Math.ceil(wheelRotation / 360) * 360 + 360 * 6 + target;
    wheel.style.transform = 'rotate(' + wheelRotation + 'deg)';
    setTimeout(() => showPrize(active[index]), reduceMotion ? 1300 : 5100);
  });

  function showPrize(prize) {
    totalWins = Math.min(TOTAL_GIFTS_LIMIT, totalWins + 1);
    ls.set(KEY.totalWins, String(totalWins));
    if (prize.id === 'show-ticket' && ticketWins < TICKET_LIMIT) prizeWins['show-ticket'] = ++ticketWins;
    if (prize.id === 'phoenix-month' && phoenixWins < PHOENIX_LIMIT) prizeWins['phoenix-month'] = ++phoenixWins;
    if (prize.id === 'show-ticket' || prize.id === 'phoenix-month') ls.set(KEY.wins, JSON.stringify(prizeWins));
    renderTicketWins();
    syncSpin();
    $('#ticketArt').classList.toggle('show', prize.id === 'show-ticket');
    $('#prizeTitle').textContent = prize.name;
    $('#prizeText').textContent = 'Поздравляем! Этот подарок — твой.';
    const links = $('#links');
    links.replaceChildren();
    (prize.links || []).forEach(([label, url], i) => {
      if (!url) return;
      const a = document.createElement('a');
      a.className = 'btn claim ' + (i ? 'btn-light' : 'btn-gold');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = label;
      links.append(a);
    });
    modal.classList.add('show');
    haptic([40, 60, 40, 60, 120]);
    if (!reduceMotion) celebrate($('.wheel-shell'));
    $('#close').focus();
  }
  $('#close').addEventListener('click', () => { modal.classList.remove('show'); renderWheel(); });
  modal.addEventListener('click', e => { if (e.target === modal) { modal.classList.remove('show'); renderWheel(); } });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (modal.classList.contains('show')) { modal.classList.remove('show'); renderWheel(); }
    closeOwn(); hideVoted();
  });

  // ---------------------------------------------------------------- пульт
  function adminFeedback(message) { setText('#adminActionFeedback', message); }

  function showAdminLogin(message = '') {
    if (MODE !== 'admin') return;
    $('#adminLoginOverlay').classList.add('show');
    setText('#adminLoginFeedback', message);
    $('#adminPin').focus();
  }
  function hideAdminLogin() { $('#adminLoginOverlay').classList.remove('show'); setText('#adminLoginFeedback', ''); }
  function dropSession(msg) { adminToken = ''; ss.del(KEY.adminToken); showAdminLogin(msg); }

  async function verifyAdminSession() {
    if (!adminToken) { showAdminLogin(); return; }
    try { await api('session', undefined, true); hideAdminLogin(); }
    catch (e) { if (e.status === 401) dropSession('Сеанс закончился. Введи код ведущих ещё раз.'); else showAdminLogin('Нет связи с сервером. Проверь интернет.'); }
  }

  $('#adminLoginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const pin = $('#adminPin').value;
    const button = $('#adminLoginButton');
    if (!pin) { setText('#adminLoginFeedback', 'Введи код ведущих.'); return; }
    button.disabled = true;
    setText('#adminLoginFeedback', 'Проверяю код…');
    try {
      const data = await api('login', { pin });
      adminToken = data.token; ss.set(KEY.adminToken, adminToken);
      $('#adminPin').value = '';
      hideAdminLogin();
      poll();
      adminFeedback('Пульт открыт. Изменения сразу видны на общем табло.');
    } catch (err) {
      setText('#adminLoginFeedback', err.status === 429 ? 'Слишком много попыток. Подожди 15 минут и попробуй снова.'
        : err.status === 503 ? 'Вход ведущего ещё не настроен (нет кода в api/config.php).'
        : err.status === 401 ? 'Код не подошёл. Проверь его и попробуй снова.'
        : 'Не удалось связаться с сервером. Проверь интернет.');
    } finally { button.disabled = false; }
  });

  async function saveAdminControl(patch, successMessage) {
    if (!adminToken) { showAdminLogin('Введи код ведущих, чтобы изменить табло.'); return false; }
    try {
      const data = await api('control', patch, true);
      applyState(data.state, true);
      adminFeedback(successMessage);
      return true;
    } catch (e) {
      if (e.status === 401) dropSession('Сеанс закончился. Введи код ведущих ещё раз.');
      else adminFeedback('Не удалось сохранить. Проверь связь и повтори.');
      return false;
    }
  }

  function renderOwnEntries() {
    const box = $('#ownResponses');
    if (!box || MODE !== 'admin') return;
    box.replaceChildren();
    setText('#ownResponseCount', '(' + suggestions.length + ')');
    if (!suggestions.length) {
      const empty = document.createElement('div');
      empty.className = 'own-empty'; empty.textContent = 'Пока никто не предложил свой вариант.';
      box.append(empty);
      return;
    }
    suggestions.forEach(text => { const item = document.createElement('div'); item.className = 'own-response'; item.textContent = text; box.append(item); });
  }

  function drawPrizeRows() {
    const list = $('#prizeList');
    list.replaceChildren();
    prizes.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'prize-row';
      row.dataset.prizeId = p.id || '';
      row.innerHTML = '<label>Название<input data-field="name"></label><label>Количество / лимит<input data-field="qty"></label><label>Ссылка кнопки<input data-field="link1" inputmode="url"></label><label>Вторая ссылка<input data-field="link2" inputmode="url"></label><button type="button" class="btn btn-danger">Удалить</button>';
      const links = p.links || [];
      row.querySelector('[data-field=name]').value = p.name || '';
      row.querySelector('[data-field=qty]').value = p.qty || '';
      row.querySelector('[data-field=link1]').value = (links[0] || [])[1] || '';
      row.querySelector('[data-field=link2]').value = (links[1] || [])[1] || '';
      row.querySelector('button').onclick = () => { prizes.splice(i, 1); drawPrizeRows(); };
      list.append(row);
    });
  }

  function collectPrizes() {
    const old = new Map(prizes.map(p => [p.id, p]));
    prizes = $$('.prize-row').map(row => {
      const val = f => row.querySelector('[data-field=' + f + ']').value.trim();
      const a = val('link1'), b = val('link2');
      const id = row.dataset.prizeId || 'gift-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const prev = old.get(row.dataset.prizeId);
      const label1 = prev && prev.links && prev.links[0] ? prev.links[0][0] : 'Забрать подарок';
      const label2 = prev && prev.links && prev.links[1] ? prev.links[1][0] : 'Открыть ссылку';
      return { id, name: val('name') || 'Новый подарок', qty: val('qty') || 'не указано', links: [[a ? label1 : 'Уточнить подарок', a], ...(b ? [[label2, b]] : [])] };
    });
    ls.set(KEY.prizes, JSON.stringify(prizes));
    drawPrizeRows();
    renderWheel();
    adminFeedback('Подарки сохранены в этом браузере.');
  }

  if (MODE === 'admin') {
    $('#addPrize').onclick = () => { prizes.push({ id: 'gift-' + Date.now(), name: 'Новый подарок', qty: 'без ограничений', links: [['Забрать подарок', '']] }); drawPrizeRows(); };
    $('#savePrizes').onclick = collectPrizes;
    let gaugeSaveTimer;
    $('#gaugeControl').addEventListener('input', e => {
      gaugeOverride = Number(e.target.value);
      renderGauge();
      clearTimeout(gaugeSaveTimer);
      gaugeSaveTimer = setTimeout(() => saveAdminControl({ gaugeOverride }, 'Стрелка обновлена на табло.'), 250);
    });
    $('#saveExpectedVotes').onclick = () => {
      expectedVotes = clampInt($('#expectedVotes').value, 1, 10000, 50);
      renderGauge();
      saveAdminControl({ expectedVotes }, 'Количество гостей сохранено.');
    };
    $('#followVotes').onclick = () => {
      displayOverride = null; gaugeOverride = null; renderGauge();
      saveAdminControl({ display: null, gaugeOverride: null }, 'Табло снова показывает реальные голоса.');
    };
    $('#saveVotes').onclick = () => {
      displayOverride = {
        psychology: clampInt($('#editPsych').value, 0, 100000, 0),
        numerology: clampInt($('#editNumer').value, 0, 100000, 0),
        abstain: clampInt($('#editAbstain').value, 0, 100000, 0)
      };
      gaugeOverride = null; renderGauge();
      saveAdminControl({ display: displayOverride, gaugeOverride: null }, 'Цифры показаны на табло. Голоса зрителей не менялись.');
    };
    $('#resetAttempts').onclick = () => { ls.del(KEY.played); played = false; syncSpin(); adminFeedback('Право крутить возвращено в этом браузере.'); };
    $('#resetVotes').onclick = async () => {
      if (!adminToken) { showAdminLogin('Введи код ведущих, чтобы удалить голоса.'); return; }
      if (!confirm('Удалить все голоса зрителей? Табло обнулится.')) return;
      const button = $('#resetVotes');
      button.disabled = true;
      adminFeedback('Удаляем голоса…');
      try {
        const data = await api('reset', {}, true);
        applyState(data.state, true);
        adminFeedback('Все голоса удалены. Новые голоса появятся на табло сразу.');
      } catch (e) {
        if (e.status === 401) dropSession('Сеанс закончился. Введи код ведущих ещё раз.');
        else adminFeedback('Не удалось удалить голоса. Проверь связь и попробуй ещё раз.');
      } finally { button.disabled = false; }
    };
    $('#openScreen').addEventListener('click', () => adminFeedback('Табло открыто в новой вкладке — перетащи её на экран и нажми F11.'));
  }

  // ---------------------------------------------------------------- табло на экране
  if (MODE === 'screen') {
    const qrOn = q.get('qr') !== '0';
    const box = $('#screenQr');
    if (!qrOn || typeof window.qrcode !== 'function') box.classList.add('off');
    else {
      const url = location.origin + location.pathname.replace(/index\.html$/, '');
      const qr = window.qrcode(0, 'M');
      qr.addData(url); qr.make();
      $('#qrBox').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      setText('#qrHost', location.host);
    }
    let uiTimer = 0;
    const wake = () => { document.body.classList.add('show-ui'); clearTimeout(uiTimer); uiTimer = setTimeout(() => document.body.classList.remove('show-ui'), 2500); };
    ['mousemove', 'touchstart', 'keydown'].forEach(ev => document.addEventListener(ev, wake, { passive: true }));
  }

  // ---------------------------------------------------------------- синхронизация вкладок
  window.addEventListener('storage', e => {
    if (e.key === KEY.played) { played = e.newValue === 'yes'; syncSpin(); }
    if (e.key === KEY.myVote) { selected = CHOICES[e.newValue] ? e.newValue : ''; renderChoices(); syncSpin(); }
    if (e.key === KEY.prizes) { prizes = safe(() => JSON.parse(e.newValue), null) || defaultPrizes; renderWheel(); if (MODE === 'admin') drawPrizeRows(); }
    if (e.key === KEY.wins) { prizeWins = safe(() => JSON.parse(e.newValue), {}) || {}; ticketWins = Number(prizeWins['show-ticket']) || 0; phoenixWins = Number(prizeWins['phoenix-month']) || 0; renderTicketWins(); renderWheel(); }
    if (e.key === KEY.totalWins) { totalWins = Number(e.newValue) || 0; renderTicketWins(); renderWheel(); syncSpin(); }
  });

  // ---------------------------------------------------------------- старт
  renderTicketWins();
  renderGauge();
  renderWheel();
  renderChoices();
  syncSpin();
  if (MODE === 'viewer') introReels();
  if (MODE === 'admin') { drawPrizeRows(); renderOwnEntries(); verifyAdminSession(); }
  poll();
})();
