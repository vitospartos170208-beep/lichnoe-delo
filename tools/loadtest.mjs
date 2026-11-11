// Нагрузочная проверка перед шоу: N зрителей открывают сайт, опрашивают табло и голосуют.
//
//   node tools/loadtest.mjs https://<домен>/ --viewers 300 --seconds 60 --pin <код ведущих>
//
// Что делает:
//   - каждый «зритель» опрашивает api/state.json раз в 2,5 с (как настоящий телефон);
//   - за первые 2/3 времени каждый голосует один раз, четверть зрителей потом передумывает;
//   - в конце сверяет: голосов на сервере ровно столько, сколько зрителей (ни один не потерян, нет дублей);
//   - с --pin удаляет все голоса после проверки (НЕ запускать во время шоу — сотрёт и настоящие голоса).
// Нужен Node.js 18+.

const args = process.argv.slice(2);
const base = (args.find(a => !a.startsWith('--')) || '').replace(/\/?$/, '/');
const opt = (name, d) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : d; };
const VIEWERS = Number(opt('viewers', 200));
const SECONDS = Number(opt('seconds', 45));
const PIN = opt('pin', '');
if (!/^https?:\/\//.test(base)) {
  console.error('Укажите адрес сайта: node tools/loadtest.mjs https://<домен>/ --viewers 300 --seconds 60 --pin 1234');
  process.exit(1);
}

const API = base + 'api/index.php';
const choices = ['psychology', 'numerology', 'custom'];
const stats = { poll: [], vote: [], pollErr: 0, voteErr: 0, errCodes: {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]); };

async function timed(fn, bucket, errKey) {
  const t = performance.now();
  try {
    const r = await fn();
    if (!r.ok) { stats[errKey]++; stats.errCodes[r.status] = (stats.errCodes[r.status] || 0) + 1; return null; }
    stats[bucket].push(performance.now() - t);
    return r;
  } catch (e) {
    stats[errKey]++; stats.errCodes[e.code || e.name] = (stats.errCodes[e.code || e.name] || 0) + 1; return null;
  }
}

async function state() {
  const r = await fetch(API + '?a=state', { cache: 'no-store' });
  return r.json();
}

async function login() {
  const r = await fetch(API + '?a=login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
  if (!r.ok) throw new Error('вход в пульт: HTTP ' + r.status);
  return (await r.json()).token;
}

async function viewer(i, until) {
  const voterId = 'loadtest-' + process.pid + '-' + i;
  const voteAt = Date.now() + Math.random() * SECONDS * 1000 * 0.66;
  const changes = Math.random() < 0.25;
  let voted = 0;
  await sleep(Math.random() * 2500);
  while (Date.now() < until) {
    await timed(() => fetch(base + 'api/state.json?t=' + Date.now(), { cache: 'no-store' }), 'poll', 'pollErr');
    if (voted === 0 && Date.now() >= voteAt) voted = 1;
    if (voted === 1 || (voted === 2 && changes && Math.random() < 0.3)) {
      const choice = choices[Math.floor(Math.random() * 3)];
      const ok = await timed(() => fetch(API + '?a=vote', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ voterId, choice, suggestion: choice === 'custom' ? 'Нагрузочный тест' : '' })
      }), 'vote', 'voteErr');
      voted = ok ? (voted === 1 ? 2 : 3) : voted;
    }
    await sleep(2500);
  }
  return voted >= 2;
}

const before = await state();
const beforeTotal = before.votes.psychology + before.votes.numerology + before.votes.custom;
console.log(`Сайт: ${base}\nЗрителей: ${VIEWERS}, длительность: ${SECONDS} с. Голосов на сервере до теста: ${beforeTotal}\n`);

const until = Date.now() + SECONDS * 1000;
const ticker = setInterval(() => process.stdout.write(`\r  опросов: ${stats.poll.length}, голосов: ${stats.vote.length}, ошибок: ${stats.pollErr + stats.voteErr}   `), 1000);
const results = await Promise.all(Array.from({ length: VIEWERS }, (_, i) => viewer(i, until)));
clearInterval(ticker);

const after = await state();
const afterTotal = after.votes.psychology + after.votes.numerology + after.votes.custom;
const votedViewers = results.filter(Boolean).length;
const added = afterTotal - beforeTotal;

console.log('\n\nРезультат');
console.log(`  Опрос табло (state.json): ${stats.poll.length} запросов, ошибок ${stats.pollErr}, медиана ${pct(stats.poll, .5)} мс, 95% быстрее ${pct(stats.poll, .95)} мс`);
console.log(`  Голоса:                   ${stats.vote.length} запросов, ошибок ${stats.voteErr}, медиана ${pct(stats.vote, .5)} мс, 95% быстрее ${pct(stats.vote, .95)} мс`);
if (Object.keys(stats.errCodes).length) console.log('  Коды ошибок:', stats.errCodes);
console.log(`  Проголосовало зрителей: ${votedViewers}, прибавилось голосов на сервере: ${added}`);
const pass = added === votedViewers && stats.voteErr === 0 && pct(stats.vote, .95) < 2000;
console.log(pass ? '\n  ✓ Всё в порядке: голоса не потерялись, сервер отвечает быстро.'
  : '\n  ✗ Есть проблемы — см. цифры выше (потерянные голоса, ошибки или ответы дольше 2 с).');

if (PIN) {
  const token = await login();
  const r = await fetch(API + '?a=reset', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-admin-token': token } });
  console.log(r.ok ? '\n  Тестовые голоса удалены (табло обнулено).' : '\n  Не удалось удалить голоса: HTTP ' + r.status);
} else {
  console.log('\n  Тестовые голоса остались на сервере — удалите их в пульте кнопкой «Удалить все голоса».');
}
process.exit(pass ? 0 : 2);
