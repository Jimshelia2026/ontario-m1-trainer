/* Ontario M1 Trainer v6.3 — симуляция «M1 — 64 вопроса» (тренировочная модель, не официальный экзамен).
 * Движок — чистые функции (браузер и Node): пул, генератор, проверка плана и сессии, отпечаток банка,
 * подсчёт, хранение. Интерфейс — во второй части файла (только браузер).
 * localStorage: пространство m1trainer.v63.exam64.* ; данные v6.2 (m1trainer.v3 и др.) не затрагиваются.
 *
 * ФАКТИЧЕСКИЙ АЛГОРИТМ ВЫБОРА (generateExam):
 *  1. Пул (isEligible): examEligible, не needsReview, статус проверки из EXAM_STATUSES, корректная структура.
 *  2. Общие концепции между разделами (sign.key-stop, blind-spot-check) получают одного владельца. Перебираются
 *     все назначения; допустимо назначение, при котором каждому разделу хватает концепций (для знаков — с учётом
 *     предела семейства, см. capacityOf). Из допустимых назначений одно выбирается по seed.
 *  3. Внутри раздела — взвешенная выборка без возвращения. Вес концепции = PEN^n, где n — число уже выбранных
 *     концепций той же темы topicL2 (правила, мотоцикл) или того же signFamily (знаки). PEN = 0.75 — мягкое
 *     предпочтение разнообразия; отбор пересчитывает веса после каждого выбора.
 *  4. Для знаков — жёсткий предел SIGN_FAMILY_CAP = 2 знака одного семейства в экзамене. Предел не приводит к
 *     ложному INSUFFICIENT_POOL: допустимость проверяется по capacityOf() (сумма min(2, знаков в семействе)),
 *     а жадный отбор, пропускающий насыщенные семейства, не застревает, пока capacityOf() ≥ квоты.
 *  5. Из каждой выбранной концепции берётся один вопрос (случайно). Порядок вопросов и вариантов — по seed.
 */
(function (root) {
  'use strict';
  var SECTIONS = ['signs', 'rules', 'motorcycle'];
  var QUOTAS = { signs: 20, rules: 20, motorcycle: 24 };
  var TOTAL = 64, PASS = 52, SCHEMA = 1;
  var PEN = 0.75;               // мягкий штраф за повтор темы/семейства (см. пункт 3 алгоритма)
  var SIGN_FAMILY_CAP = 2;      // жёсткий предел знаков одного семейства (пункт 4)
  var EXAM_STATUSES = ['VERIFIED', 'CORRECTED_AND_VERIFIED', 'VERIFIED_WITH_LIMITATIONS'];
  var SEC_RU = { signs: 'Дорожные знаки', rules: 'Правила движения', motorcycle: 'Управление мотоциклом' };
  var KEY = 'm1trainer.v63.exam64.session', HIST = 'm1trainer.v63.exam64.history';
  var BROKEN = 'm1trainer.v63.exam64.broken.', STALE = 'm1trainer.v63.exam64.stale.';
  // Поля банка, входящие в отпечаток: всё, что влияет на экзамен и на показываемый разбор
  var FP_FIELDS = ['id', 'q', 'options', 'correct', 'explanation', 'source', 'examSection', 'conceptId', 'signId',
    'signFamily', 'topicL2', 'examEligible', 'needsReview', 'verificationStatus', 'status'];

  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  // Единый предикат пригодности: используется и для пула, и для проверки сохранённой сессии
  function isEligible(q) {
    return !!q && q.examEligible === true && q.needsReview !== true
      && EXAM_STATUSES.indexOf(q.verificationStatus || q.status) >= 0
      && Array.isArray(q.options) && q.options.length === 4
      && Number.isInteger(q.correct) && q.correct >= 0 && q.correct <= 3
      && SECTIONS.indexOf(q.examSection) >= 0
      && typeof q.conceptId === 'string' && q.conceptId.length > 0
      && (q.examSection !== 'signs' || (typeof q.signId === 'string' && q.signId.length > 0
        && typeof q.signFamily === 'string' && q.signFamily.length > 0));
  }
  function buildPool(questions) { return (questions || []).filter(isEligible); }
  // Детерминированный 64-битный хеш (cyrb53); работает одинаково в браузере и в Node
  function cyrb53(str) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }
  // Отпечаток содержимого банка: меняется при изменении текста, вариантов, ключа, классификации или статуса проверки
  function bankFingerprint(questions) {
    var list = (questions || []).slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    var text = list.map(function (q) {
      return JSON.stringify(FP_FIELDS.map(function (f) { return q[f] === undefined ? null : q[f]; }));
    }).join('\n');
    return 'b' + list.length + '-' + cyrb53(text);
  }
  function analyse(pool) {
    var bySec = { signs: new Map(), rules: new Map(), motorcycle: new Map() };
    pool.forEach(function (q) {
      if (!bySec[q.examSection]) return;
      var m = bySec[q.examSection];
      if (!m.has(q.conceptId)) m.set(q.conceptId, []);
      m.get(q.conceptId).push(q);
    });
    var sectionsOf = new Map();
    SECTIONS.forEach(function (s) { bySec[s].forEach(function (_, c) { if (!sectionsOf.has(c)) sectionsOf.set(c, []); sectionsOf.get(c).push(s); }); });
    var shared = [];
    sectionsOf.forEach(function (secs, c) { if (secs.length > 1) shared.push({ concept: c, sections: secs.slice().sort() }); });
    shared.sort(function (a, b) { return a.concept < b.concept ? -1 : a.concept > b.concept ? 1 : 0; });
    return { bySec: bySec, sectionsOf: sectionsOf, shared: shared };
  }
  function availableConcepts(an, owner, sec) {
    var res = [];
    an.bySec[sec].forEach(function (_, c) { if (an.sectionsOf.get(c).length === 1 || owner[c] === sec) res.push(c); });
    return res.sort();
  }
  // Максимальное число концепций, которое раздел может дать при данном назначении владельцев
  function capacityOf(an, owner, sec) {
    var avail = availableConcepts(an, owner, sec);
    if (sec !== 'signs') return avail.length;
    var fam = new Map();
    avail.forEach(function (c) { var f = an.bySec[sec].get(c)[0].signFamily; fam.set(f, (fam.get(f) || 0) + 1); });
    var total = 0;
    fam.forEach(function (n) { total += Math.min(SIGN_FAMILY_CAP, n); });
    return total;
  }
  function feasibleOwners(an) {
    if (an.shared.length > 16) throw new Error('слишком много общих концепций: ' + an.shared.length);
    var total = an.shared.reduce(function (p, s) { return p * s.sections.length; }, 1), out = [];
    for (var n = 0; n < total; n++) {
      var owner = {}, t = n;
      an.shared.forEach(function (s) { owner[s.concept] = s.sections[t % s.sections.length]; t = Math.floor(t / s.sections.length); });
      var ok = SECTIONS.every(function (sec) { return capacityOf(an, owner, sec) >= QUOTAS[sec]; });
      if (ok) out.push(owner);
    }
    return out;
  }
  function ownerAll(an, sec) {
    var o = {};
    an.shared.forEach(function (s) { o[s.concept] = s.sections.indexOf(sec) >= 0 ? sec : s.sections[0]; });
    return o;
  }
  function maxCap(an, sec) {
    return sec === 'signs' ? capacityOf(an, ownerAll(an, sec), sec) : availableConcepts(an, ownerAll(an, sec), sec).length;
  }
  function shortfall(an) {
    var rep = SECTIONS.map(function (sec) { return { section: sec, quota: QUOTAS[sec], maxAvailable: maxCap(an, sec) }; });
    var short = rep.filter(function (r) { return r.maxAvailable < r.quota; });
    var reason = short.length
      ? 'недостаточно различных концепций: ' + short.map(function (r) {
          return SEC_RU[r.section] + ' (можно собрать ' + r.maxAvailable + ' из ' + r.quota
            + (r.section === 'signs' ? ', не более ' + SIGN_FAMILY_CAP + ' знаков одного семейства' : '') + ')';
        }).join('; ')
      : 'разделы конфликтуют по общим концепциям: допустимого распределения нет';
    return { sections: rep, reason: reason };
  }
  function generateExam(questions, seed) {
    var pool = buildPool(questions), an = analyse(pool), owners = feasibleOwners(an);
    var fp = bankFingerprint(questions);
    if (!owners.length) return { ok: false, error: 'INSUFFICIENT_POOL', shortfall: shortfall(an), bankFingerprint: fp };
    var rng = mulberry32(seed >>> 0);
    var owner = owners[Math.floor(rng() * owners.length)];
    var chosen = { signs: [], rules: [], motorcycle: [] };
    for (var si = 0; si < SECTIONS.length; si++) {
      var sec = SECTIONS[si], need = QUOTAS[sec];
      var remain = shuffle(availableConcepts(an, owner, sec), rng);
      var pick = [], groupCount = new Map(), usedSign = new Set();
      while (pick.length < need && remain.length) {
        var best = -1, bestKey = Infinity;
        for (var k = 0; k < remain.length; k++) {
          var rq = an.bySec[sec].get(remain[k])[0];
          var g = sec === 'signs' ? rq.signFamily : rq.topicL2;
          var n = groupCount.get(g) || 0;
          if (sec === 'signs' && (n >= SIGN_FAMILY_CAP || usedSign.has(rq.signId))) continue;
          var key = -Math.log(rng() + 1e-12) / Math.pow(PEN, n);
          if (key < bestKey) { bestKey = key; best = k; }
        }
        if (best < 0) break;
        var cpick = remain.splice(best, 1)[0], pq = an.bySec[sec].get(cpick)[0];
        var pg = sec === 'signs' ? pq.signFamily : pq.topicL2;
        groupCount.set(pg, (groupCount.get(pg) || 0) + 1);
        if (sec === 'signs') usedSign.add(pq.signId);
        pick.push(cpick);
      }
      if (pick.length < need) return { ok: false, error: 'INSUFFICIENT_POOL', shortfall: shortfall(an), bankFingerprint: fp };
      for (var pi = 0; pi < pick.length; pi++) {
        var list = an.bySec[sec].get(pick[pi]);
        chosen[sec].push(list[Math.floor(rng() * list.length)]);
      }
    }
    var all = [].concat(chosen.signs, chosen.rules, chosen.motorcycle);
    var order = shuffle(all.map(function (q) { return q.id; }), rng);
    var sectionOf = {}, perms = {};
    SECTIONS.forEach(function (s) { chosen[s].forEach(function (q) { sectionOf[q.id] = s; }); });
    all.forEach(function (q) { perms[q.id] = shuffle([0, 1, 2, 3], rng); });
    var check = validatePlan({ order: order, sectionOf: sectionOf, perms: perms }, questions);
    if (!check.ok) return { ok: false, error: 'INTERNAL', reason: check.reason, bankFingerprint: fp };
    return { ok: true, seed: seed >>> 0, order: order, sectionOf: sectionOf, perms: perms, bankFingerprint: fp };
  }
  // Единая проверка плана экзамена: используется генератором и при восстановлении сессии (одни и те же правила)
  function validatePlan(ex, questions) {
    var fail = function (r) { return { ok: false, reason: r }; };
    if (!ex || typeof ex !== 'object') return fail('данные не являются симуляцией');
    if (!Array.isArray(ex.order) || ex.order.length !== TOTAL) return fail('в симуляции не 64 вопроса');
    if (!ex.sectionOf || typeof ex.sectionOf !== 'object') return fail('нет сведений о разделах');
    if (!ex.perms || typeof ex.perms !== 'object') return fail('нет перестановок вариантов');
    var byId = new Map((questions || []).map(function (q) { return [q.id, q]; }));
    var seenId = new Set(), concepts = new Set(), signIds = new Set(), famCount = new Map();
    var counts = { signs: 0, rules: 0, motorcycle: 0 };
    for (var i = 0; i < ex.order.length; i++) {
      var id = ex.order[i];
      if (typeof id !== 'string') return fail('идентификатор вопроса не является строкой');
      if (seenId.has(id)) return fail('повторяется вопрос «' + id + '»');
      seenId.add(id);
      var q = byId.get(id);
      if (!q) return fail('вопрос «' + id + '» отсутствует в банке');
      if (!isEligible(q)) return fail('вопрос «' + id + '» больше не допускается в экзамен (изменились статус или метки)');
      var sec = ex.sectionOf[id];
      if (sec !== q.examSection) return fail('раздел вопроса «' + id + '» не совпадает с банком');
      if (concepts.has(q.conceptId)) return fail('повторяется тема «' + q.conceptId + '»');
      concepts.add(q.conceptId);
      if (sec === 'signs') {
        if (signIds.has(q.signId)) return fail('повторяется знак «' + q.signId + '»');
        signIds.add(q.signId);
        var f = q.signFamily;
        famCount.set(f, (famCount.get(f) || 0) + 1);
        if (famCount.get(f) > SIGN_FAMILY_CAP) return fail('знаков одного семейства («' + f + '») больше ' + SIGN_FAMILY_CAP);
      }
      counts[sec]++;
      var p = ex.perms[id];
      if (!Array.isArray(p) || p.length !== 4 || p.slice().sort().join('') !== '0123') return fail('перестановка вариантов вопроса «' + id + '» неверна');
    }
    for (var s = 0; s < SECTIONS.length; s++) {
      var name = SECTIONS[s];
      if (counts[name] !== QUOTAS[name]) return fail('раздел «' + SEC_RU[name] + '»: ' + counts[name] + ' вместо ' + QUOTAS[name]);
    }
    return { ok: true };
  }
  function validateSession(ex, questions) {
    if (!ex || typeof ex !== 'object') return { ok: false, reason: 'данные повреждены' };
    if (ex.schema !== SCHEMA) return { ok: false, reason: 'устаревший формат (схема ' + ex.schema + ')' };
    var plan = validatePlan(ex, questions);
    if (!plan.ok) return plan;
    if (typeof ex.startedAt !== 'number') return { ok: false, reason: 'нет времени начала' };
    if (!Number.isInteger(ex.seed) || ex.seed < 0) return { ok: false, reason: 'неверный seed' };
    if (typeof ex.submitted !== 'boolean') return { ok: false, reason: 'нет признака отправки' };
    if (!Number.isInteger(ex.cursor) || ex.cursor < 0 || ex.cursor >= TOTAL) return { ok: false, reason: 'неверная позиция в симуляции' };
    if (!ex.answers || typeof ex.answers !== 'object' || Array.isArray(ex.answers)) return { ok: false, reason: 'нет корректных ответов' };
    var idset = new Set(ex.order);
    var keys = Object.keys(ex.answers);
    for (var k = 0; k < keys.length; k++) {
      var a = ex.answers[keys[k]];
      if (!idset.has(keys[k]) || !(Number.isInteger(a) && a >= 0 && a <= 3)) return { ok: false, reason: 'сохранённый ответ не соответствует вопросу' };
    }
    return { ok: true };
  }
  function score(ex, questions) {
    var byId = new Map((questions || []).map(function (q) { return [q.id, q]; }));
    var correct = 0, answered = 0, bySec = { signs: 0, rules: 0, motorcycle: 0 }, rows = [];
    ex.order.forEach(function (id, idx) {
      var q = byId.get(id), a = ex.answers ? ex.answers[id] : undefined, ok = false;
      if (a !== undefined && a !== null) { answered++; ok = ex.perms[id][a] === q.correct; }
      if (ok) { correct++; bySec[ex.sectionOf[id]]++; }
      rows.push({ n: idx + 1, id: id, section: ex.sectionOf[id], answered: a !== undefined && a !== null, ok: ok });
    });
    return { correct: correct, answered: answered, percent: Math.round(correct * 100 / TOTAL), passed: correct >= PASS, bySection: bySec, rows: rows };
  }
  // Хранение. Повреждённые и несовместимые данные не удаляются без резервной копии.
  function discard(storage, raw, status, reason, wasSubmitted) {
    var key = (status === 'bank-changed' ? STALE : BROKEN) + Date.now();
    var backedUp = false;
    try { storage.setItem(key, raw); backedUp = true; } catch (e) {}
    if (backedUp) { try { storage.removeItem(KEY); } catch (e) {} }   // без копии активный ключ не трогаем
    return { status: status, reason: reason, backupKey: backedUp ? key : null, backedUp: backedUp, wasSubmitted: !!wasSubmitted };
  }
  function readSession(storage, questions) {
    var raw = null;
    try { raw = storage.getItem(KEY); } catch (e) { return { status: 'unavailable', reason: 'хранилище недоступно', backedUp: false }; }
    if (!raw) return { status: 'none' };
    var ex = null;
    try { ex = JSON.parse(raw); } catch (e) { return discard(storage, raw, 'invalid', 'данные повреждены (JSON не читается)', false); }
    try {
      if (ex && typeof ex === 'object' && ex.schema === SCHEMA) {
        if (typeof ex.bankFingerprint !== 'string') return discard(storage, raw, 'invalid', 'нет отпечатка банка вопросов', false);
        if (ex.bankFingerprint !== bankFingerprint(questions)) return discard(storage, raw, 'bank-changed', 'банк вопросов изменился', ex.submitted === true);
      }
      var v = validateSession(ex, questions);
      if (!v.ok) return discard(storage, raw, 'invalid', v.reason, false);
      return { status: 'ok', session: ex };
    } catch (e) {
      return discard(storage, raw, 'invalid', 'структура данных неверна', false);
    }
  }
  function writeSession(storage, ex) {
    try { storage.setItem(KEY, JSON.stringify(Object.assign({ schema: SCHEMA }, ex))); return true; } catch (e) { return false; }
  }
  function clearSession(storage) { try { storage.removeItem(KEY); } catch (e) {} }
  function addHistory(storage, entry) {
    try {
      var h = JSON.parse(storage.getItem(HIST) || '[]'); if (!Array.isArray(h)) h = [];
      h.unshift(entry); storage.setItem(HIST, JSON.stringify(h.slice(0, 10)));
    } catch (e) {}
  }
  // Русские сообщения о состоянии сохранённой симуляции
  function messageFor(st) {
    if (!st) return '';
    if (st.status === 'unavailable') return 'Хранилище браузера недоступно: симуляция не будет сохраняться.';
    var back = st.backedUp ? 'Данные сохранены в резервной копии. ' : 'Резервную копию сохранить не удалось. ';
    if (st.status === 'invalid') return 'Сохранённая симуляция не прошла проверку: ' + st.reason + '. ' + back + 'Можно начать новую симуляцию.';
    if (st.status === 'bank-changed') {
      if (st.wasSubmitted) return 'Банк вопросов изменился после завершённой симуляции. Результат сохранён в истории; разбор по прежним данным недоступен. ' + back;
      return 'Банк вопросов изменился после начала симуляции, поэтому незавершённую симуляцию нельзя продолжить. ' + back + 'Можно начать новую симуляцию.';
    }
    return '';
  }
  // Статус проверки для показа в разборе (различает официальное руководство и вторичные источники)
  function statusLabelRu(q) {
    var s = q.verificationStatus || q.status;
    if (s === 'VERIFIED') return 'проверено по официальному руководству MTO';
    if (s === 'CORRECTED_AND_VERIFIED') return 'исправлено и проверено по официальному руководству MTO';
    if (s === 'VERIFIED_WITH_LIMITATIONS') return 'проверено с ограничениями: нормативные ссылки взяты из вторичных источников, первичный текст e-Laws не проверен';
    return 'статус проверки не определён';
  }
  var api = { SECTIONS: SECTIONS, QUOTAS: QUOTAS, TOTAL: TOTAL, PASS: PASS, EXAM_STATUSES: EXAM_STATUSES, SEC_RU: SEC_RU,
    KEY: KEY, HIST: HIST, PEN: PEN, SIGN_FAMILY_CAP: SIGN_FAMILY_CAP,
    mulberry32: mulberry32, isEligible: isEligible, buildPool: buildPool, bankFingerprint: bankFingerprint,
    analyse: analyse, feasibleOwners: feasibleOwners, capacityOf: capacityOf, generateExam: generateExam,
    validatePlan: validatePlan, checkExam: validatePlan, validateSession: validateSession, score: score,
    readSession: readSession, writeSession: writeSession, clearSession: clearSession, addHistory: addHistory,
    shortfall: shortfall, messageFor: messageFor, statusLabelRu: statusLabelRu };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) { root.M1Exam64 = api; }
})(typeof window !== 'undefined' ? window : globalThis);

/* ---------- Интерфейс (только браузер) ---------- */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !window.M1Exam64) return;
  var E = window.M1Exam64, Q = window.M1_QUESTIONS || [], byId = {};
  Q.forEach(function (q) { byId[q.id] = q; });
  var store;
  try { store = window.localStorage; store.getItem('__probe__'); } catch (e) { store = null; }
  if (!store) store = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
  var active = false, view = 'home', lastStatus = null;
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function stage() { return document.getElementById('stage'); }
  function sessionOk() {
    var st = E.readSession(store, Q);
    if (st.status === 'ok') { lastStatus = null; return st.session; }
    if (st.status !== 'none') lastStatus = st;
    return null;
  }

  function renderHome(msg) {
    active = true; view = 'home';
    var st = E.readSession(store, Q), sess = st.status === 'ok' ? st.session : null;
    var pool = E.buildPool(Q), an = E.analyse(pool), owners = E.feasibleOwners(an);
    var counts = {}; E.SECTIONS.forEach(function (s) { counts[s] = pool.filter(function (q) { return q.examSection === s; }).length; });
    var html = '<div class="card" data-e64="root"><h2>Симуляция M1 — 64 вопроса</h2>'
      + '<div class="banner warn"><strong>Тренировочная модель.</strong> Распределение 20 / 20 / 24 и порог 52 из 64 — структура для тренировки. На официальной странице DriveTest такая структура не указана; общий порог DriveTest — 80 %. Официальный экзамен может отличаться.</div>'
      + '<table><tr><th>Раздел</th><th>Вопросов</th></tr>'
      + E.SECTIONS.map(function (s) { return '<tr><td>' + esc(E.SEC_RU[s]) + '</td><td>' + E.QUOTAS[s] + '</td></tr>'; }).join('')
      + '<tr><th>Всего</th><th>64</th></tr></table>'
      + '<p>Порог модели: не менее <strong>52</strong> правильных ответов из 64 (81 %). Баллы по разделам — только для информации.</p>'
      + '<p class="note">В пуле экзамена: знаки ' + counts.signs + ', правила ' + counts.rules + ', мотоцикл ' + counts.motorcycle + '. В экзамен попадают только вопросы с допустимым статусом проверки; статус каждого вопроса показан в разборе.</p>';
    if (msg) html += '<div class="banner warn">' + esc(msg) + '</div>';
    var notice = (st.status === 'none' || st.status === 'ok') ? lastStatus : st;
    lastStatus = null;
    var noticeText = E.messageFor(notice);
    if (noticeText) html += '<div class="banner warn">' + esc(noticeText) + '</div>';
    if (owners.length === 0) {
      var sf = E.shortfall(an);
      html += '<div class="banner warn"><strong>Недостаточно вопросов для сборки экзамена.</strong> ' + esc(sf.reason) + '</div>';
    } else {
      if (sess && !sess.submitted) html += '<button class="btn primary" data-e64="resume">Продолжить незавершённую</button> ';
      if (sess && sess.submitted) html += '<button class="btn" data-e64="review">Показать результат последней симуляции</button> ';
      html += '<button class="btn primary" data-e64="new">' + (sess && !sess.submitted ? 'Начать новую' : 'Начать симуляцию') + '</button>';
    }
    html += '</div>';
    stage().innerHTML = html;
  }

  function renderExam() {
    var ex = sessionOk();
    if (!ex) { renderHome(); return; }
    active = true; view = 'exam';
    var n = E.TOTAL, idx = Math.min(Math.max(0, ex.cursor), n - 1), id = ex.order[idx], q = byId[id], sec = ex.sectionOf[id];
    var answered = Object.keys(ex.answers).length, sel = ex.answers[id];
    var grid = ex.order.map(function (x, i) {
      var cls = (ex.answers[x] !== undefined ? 'answered ' : '') + (i === idx ? 'cur' : '');
      return '<button class="' + cls.trim() + '" data-e64="goto" data-v="' + i + '" aria-label="Вопрос ' + (i + 1) + '">' + (i + 1) + '</button>';
    }).join('');
    var img = q.signId ? '<div class="signbox"><img src="assets/signs/' + esc(q.signId) + '.jpg" alt="Дорожный знак из вопроса"></div>' : '';
    var opts = ex.perms[id].map(function (orig, d) {
      return '<button class="opt ' + (sel === d ? 'selected' : '') + '" data-e64="pick" data-v="' + d + '"><span class="letter">' + 'ABCD'.charAt(d) + '</span><span>' + esc(q.options[orig]) + '</span></button>';
    }).join('');
    stage().innerHTML = '<div class="card" data-e64="root">'
      + '<div class="meta"><span>Вопрос ' + (idx + 1) + ' из 64</span><span class="badge">' + esc(E.SEC_RU[sec]) + '</span><span>Отвечено: ' + answered + ' из 64</span></div>'
      + '<div class="progress"><div style="width:' + Math.round(100 * answered / n) + '%"></div></div>'
      + '<div class="q">' + esc(q.q) + '</div>' + img + opts
      + '<div class="grid">' + grid + '</div>'
      + '<div class="row"><button class="btn" data-e64="prev" ' + (idx === 0 ? 'disabled' : '') + '>← Назад</button>'
      + '<button class="btn" data-e64="home">На главную</button>'
      + '<button class="btn primary" data-e64="submit">Отправить тест</button>'
      + '<button class="btn" data-e64="next" ' + (idx >= n - 1 ? 'disabled' : '') + '>Далее →</button></div>'
      + '<p class="note">Не отвечено: ' + (n - answered) + '. Ответы можно менять до отправки. Правильные ответы не показываются до отправки. Прогресс сохраняется автоматически.</p></div>';
  }

  function renderReview() {
    var ex = sessionOk();
    if (!ex || !ex.submitted) { renderHome('Нет завершённой симуляции.'); return; }
    active = true; view = 'review';
    var sc = E.score(ex, Q);
    var secRows = E.SECTIONS.map(function (s) { return '<tr><td>' + esc(E.SEC_RU[s]) + '</td><td>' + sc.bySection[s] + ' из ' + E.QUOTAS[s] + '</td></tr>'; }).join('');
    var items = ex.order.map(function (id, i) {
      var q = byId[id], a = ex.answers[id], ok = sc.rows[i].ok;
      var userTxt = (a === undefined) ? 'не отвечено' : q.options[ex.perms[id][a]];
      return '<div class="card" style="margin-top:12px"><div class="meta"><span>' + (i + 1) + '. ' + esc(E.SEC_RU[ex.sectionOf[id]]) + '</span><span class="badge">' + (ok ? 'верно' : 'неверно') + '</span></div>'
        + (q.signId ? '<div class="signbox"><img src="assets/signs/' + esc(q.signId) + '.jpg" alt="Дорожный знак"></div>' : '')
        + '<div class="q">' + esc(q.q) + '</div><p>Ваш ответ: ' + esc(userTxt) + '</p>'
        + '<div class="opt correct"><span class="letter">✓</span><span>Правильный ответ: ' + esc(q.options[q.correct]) + '</span></div>'
        + '<div class="expl">' + esc(q.explanation) + '</div><div class="src">Источник: ' + esc(q.source) + ' · ID: ' + esc(id) + '</div><div class="src">Статус проверки: ' + esc(E.statusLabelRu(q)) + '</div></div>';
    }).join('');
    stage().innerHTML = '<div class="card" data-e64="root"><h2>Результат: симуляция M1 — 64 вопроса</h2>'
      + '<div class="banner warn">Тренировочная модель, не официальный экзамен.</div>'
      + '<p>Верно: <strong>' + sc.correct + '</strong> из 64 (' + sc.percent + '%).</p>'
      + '<p>Результат модели: <strong>' + (sc.passed ? 'порог 52 выполнен' : 'порог 52 не выполнен') + '</strong>. Баллы по разделам — информационные.</p>'
      + '<table><tr><th>Раздел</th><th>Верно</th></tr>' + secRows + '</table>'
      + '<div class="row"><button class="btn primary" data-e64="new">Новая симуляция</button><button class="btn" data-e64="home">На главную</button></div>'
      + '<h3>Разбор ответов</h3>' + items + '</div>';
  }

  function startNew() {
    var prev = sessionOk();
    if (prev && !prev.submitted && !window.confirm('Начать новую симуляцию? Незавершённая сессия будет сохранена в истории как прерванная.')) return;
    if (prev && !prev.submitted) E.addHistory(store, { date: new Date().toISOString(), abandoned: true, answered: Object.keys(prev.answers).length });
    var seed = Math.floor(Math.random() * 4294967296) >>> 0;
    var gen = E.generateExam(Q, seed);
    if (!gen.ok) { renderHome(gen.error === 'INSUFFICIENT_POOL' ? 'Недостаточно вопросов: ' + gen.shortfall.reason : 'Внутренняя ошибка сборки: ' + (gen.reason || gen.error)); return; }
    E.writeSession(store, { startedAt: Date.now(), seed: gen.seed, order: gen.order, sectionOf: gen.sectionOf, perms: gen.perms, bankFingerprint: gen.bankFingerprint, answers: {}, cursor: 0, submitted: false });
    renderExam();
  }
  function save(ex) { E.writeSession(store, ex); }
  function submit() {
    var ex = sessionOk(); if (!ex) return;
    var n = Object.keys(ex.answers).length;
    if (!window.confirm('Отправить тест? Отвечено ' + n + ' из 64. После отправки ответы изменить нельзя.')) return;
    ex.submitted = true; save(ex);
    var sc = E.score(ex, Q);
    E.addHistory(store, { date: new Date().toISOString(), abandoned: false, correct: sc.correct, passed: sc.passed, bankFingerprint: ex.bankFingerprint });
    renderReview();
  }

  function handle(action, v) {
    if (action === 'new') return startNew();
    if (action === 'resume') return renderExam();
    if (action === 'review') return renderReview();
    if (action === 'home') return renderHome();
    var ex = sessionOk(); if (!ex || ex.submitted) return renderHome();
    if (action === 'pick') { ex.answers[ex.order[ex.cursor]] = v; save(ex); return renderExam(); }
    if (action === 'next') { ex.cursor = Math.min(E.TOTAL - 1, ex.cursor + 1); save(ex); return renderExam(); }
    if (action === 'prev') { ex.cursor = Math.max(0, ex.cursor - 1); save(ex); return renderExam(); }
    if (action === 'goto') { ex.cursor = v; save(ex); return renderExam(); }
    if (action === 'submit') return submit();
  }

  document.addEventListener('click', function (e) {
    var nav = e.target.closest && e.target.closest('nav button[data-mode]');
    if (nav) { if (nav.dataset.mode === 'exam64') renderHome(); else active = false; return; }
    var b = e.target.closest && e.target.closest('[data-e64]');
    if (!b || b.disabled) return;
    handle(b.dataset.e64, +b.dataset.v);
  });
  document.addEventListener('keydown', function (e) {
    if (!active || view !== 'exam' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[1-4]$/.test(e.key)) handle('pick', +e.key - 1);
    else if (e.key === 'ArrowRight') handle('next');
    else if (e.key === 'ArrowLeft') handle('prev');
  });
  try {
    var d = JSON.parse(store.getItem('m1trainer.v3') || 'null');
    if (d && d.ui && d.ui.mode === 'exam64') renderHome();
  } catch (e) {}
})();
