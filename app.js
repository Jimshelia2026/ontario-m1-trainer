(function () {
  "use strict";

  // ---------- Данные ----------
  const ALL = window.M1_QUESTIONS || [];
  const Q = ALL.filter(q => q.status !== "QUARANTINED");           // только проверенные вопросы
  const QUAR = ALL.length - Q.length;
  const byId = Object.fromEntries(Q.map(q => [q.id, q]));
  const QV = Object.fromEntries(ALL.map(q => [q.id, q.v || 1]));
  const SIGNS = window.M1_SIGNS || [];
  const sigById = Object.fromEntries(SIGNS.map(s => [s.id, s]));
  const CATS = window.M1_CATEGORIES || {};
  const LESSONS = window.M1_LESSONS || [];
  const TOPICS = [...new Set(Q.map(q => q.topic))];
  const L = ["A", "B", "C", "D"];
  const DIFF = { easy: "Лёгкий", medium: "Средний", hard: "Сложный" };
  const INTERVALS = [0, 1, 3, 7, 14, 30];
  const KEY = "m1trainer.v3", OLD = "m1trainer.v2", FORMAT = "m1-progress";

  // ---------- Утилиты ----------
  const dayNow = () => Math.floor(Date.now() / 864e5);
  const dayStr = d => new Date(d * 864e5).toLocaleDateString("ru-RU");
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shuffle = a => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
  const $ = s => document.querySelector(s);

  // ---------- Хранилище: версия 3, миграция с версии 2, защита от сбоев ----------
  let storageOk = true, storageMsg = "";
  let S;
  function blank() {
    return {
      v: 3,
      ui: { mode: "learn", scope: "all", sscope: "all", idx: 0, sidx: 0, lesson: 0, signSub: "learn", pracMode: "seq" },
      stats: {}, sbm: {}, sstats: {}, lessonsDone: {}, signsSeen: {}, lorder: {},
      pr: null, exam: null, examHistory: [], sq: null, sqOk: 0, sqN: 0,
      session: { n: 0, ok: 0 }, fs: 18, dark: false, lastMistakeReview: null, notice: ""
    };
  }
  function save() {
    if (!storageOk) return;
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { storageOk = false; storageMsg = "Не удаётся сохранить прогресс (мало места или приватный режим). Ответы не сохранятся после закрытия страницы."; }
  }
  function load() {
    S = blank();
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { storageOk = false; storageMsg = "Хранилище браузера недоступно: прогресс не сохраняется."; return; }
    if (raw) {
      try {
        const d = JSON.parse(raw);
        S = Object.assign(blank(), d);
        S.ui = Object.assign(blank().ui, d.ui || {});
      } catch (e) {
        try { localStorage.setItem(KEY + ".broken." + Date.now(), raw); } catch (_) {}
        S = blank();
        storageMsg = "Сохранённые данные повреждены. Копия сохранена, начат новый файл прогресса.";
      }
    } else {
      // миграция из версии 2
      try {
        const old = localStorage.getItem(OLD);
        if (old) {
          const o = JSON.parse(old);
          S.stats = o.stats || {}; S.sbm = o.sbm || {}; S.sstats = o.sstats || {};
          S.fs = typeof o.fs === "number" ? o.fs : 18; S.dark = !!o.dark;
          S.lastMistakeReview = o.lastMistakeReview || null;
          S.notice = "Прогресс перенесён из предыдущей версии. Старые данные не удалены.";
        }
      } catch (e) { storageMsg = "Старые данные не удалось прочитать; начат новый прогресс."; }
    }
    // версии вопросов: при существенном изменении сбрасываем только признаки освоения
    Object.keys(S.stats).forEach(id => {
      const s = S.stats[id];
      if (s.qv === undefined) s.qv = 1;
      const cur = QV[id];
      if (cur !== undefined && s.qv < cur) { s.streak = 0; s.rightDays = []; s.lvl = 0; s.due = dayNow(); s.qv = cur; }
    });
    save();
  }
  load();

  // ---------- Статистика и расписание ----------
  function rd(id) { return S.stats[id] || { seen: false, c: 0, w: 0, streak: 0, lvl: 0, due: 0, rightDays: [], lastWrong: null, bm: false, mark: null }; }
  function wr(id) { return S.stats[id] || (S.stats[id] = { qv: QV[id] || 1, seen: false, c: 0, w: 0, streak: 0, lvl: 0, due: 0, rightDays: [], lastWrong: null, bm: false, mark: null }); }
  function answeredOnce(id) { const s = S.stats[id]; return !!s && (s.c + s.w) > 0; }
  function mastered(id) { const s = S.stats[id]; return !!s && s.streak >= 3 && new Set(s.rightDays).size >= 2; }
  function isMistake(id) { const s = S.stats[id]; return !!s && s.lastWrong !== null && !mastered(id); }
  function isDue(id) { const s = S.stats[id]; return !!s && s.seen && s.due <= dayNow(); }
  // Состояния: новый (не открывался) / изучается (открывался или отвечал) / нужно повторить / освоен
  function statusOf(id) {
    const s = S.stats[id];
    if (!s || !s.seen) return "new";
    if (mastered(id)) return "mastered";
    if (isDue(id) || s.lastWrong !== null) return "review";
    return "learning";
  }
  const STATUS_LABEL = { new: "Новый", learning: "Изучается", review: "Нужно повторить", mastered: "Освоен" };
  function statusReason(id) {
    const st = statusOf(id), s = rd(id);
    if (st === "new") return "Вопрос ещё не открывался.";
    if (st === "mastered") return "Освоен: 3 верных ответа подряд в минимум двух разных днях. История ошибок сохранена.";
    if (s.lastWrong !== null && s.streak < 3) return "Последний ответ был неверным (ошибок всего: " + s.w + "). Остаётся в очереди, пока не будет 3 верных ответа подряд в разные дни.";
    if (isDue(id)) return "Пора повторить по расписанию.";
    return "Ответы верные, но освоение ещё не завершено.";
  }
  function recordAnswer(id, ok) {
    const s = wr(id), t = dayNow();
    s.seen = true;
    if (ok) { s.c++; s.streak++; s.lvl = Math.min(s.lvl + 1, INTERVALS.length - 1); s.due = t + INTERVALS[s.lvl]; if (!s.rightDays.includes(t)) s.rightDays.push(t); s.rightDays = s.rightDays.slice(-6); }
    else { s.w++; s.streak = 0; s.lvl = 0; s.due = t; s.lastWrong = t; }
    save();
  }
  function weight(id) {
    const s = rd(id), t = dayNow();
    let w = !s.seen ? 0.6 : (s.due <= t ? 1.0 : 0.15);
    if (s.lastWrong !== null && t - s.lastWrong <= 1) w *= 2.5;
    if (mastered(id)) w *= 0.3;
    if (s.mark === "difficult") w *= 1.8;
    if (s.mark === "easy") w *= 0.5;
    return Math.max(w, 0.02);
  }
  function pickWeighted(list, exclude) {
    const cand = list.length > 1 ? list.filter(i => i !== exclude) : list;
    const total = cand.reduce((a, id) => a + weight(id), 0);
    let r = Math.random() * total;
    for (const id of cand) { r -= weight(id); if (r <= 0) return id; }
    return cand[cand.length - 1];
  }

  // ---------- Выборки ----------
  function scopeIds() {
    let l = Q.map(q => q.id);
    const sc = S.ui.scope;
    if (sc.startsWith("topic:")) { const t = sc.slice(6); l = l.filter(id => byId[id].topic === t); }
    else if (sc === "due") l = l.filter(isDue);
    else if (sc === "bookmark") l = l.filter(id => rd(id).bm);
    else if (sc === "difficult") l = l.filter(id => rd(id).mark === "difficult");
    else if (sc === "review") l = l.filter(id => rd(id).mark === "review");
    else if (sc === "mistake") l = l.filter(isMistake);
    return l;
  }
  function signIds() {
    let l = SIGNS.map(s => s.id);
    if (S.ui.sscope.startsWith("cat:")) { const c = S.ui.sscope.slice(4); l = l.filter(id => sigById[id].category === c); }
    else if (S.ui.sscope === "bookmark") l = l.filter(id => S.sbm[id]);
    return l;
  }

  // ---------- Общие фрагменты ----------
  function imgFor(q) {
    if (!q.signId) return "";
    return `<div class="signbox"><img src="assets/signs/${esc(q.signId)}.jpg" alt="Дорожный знак, изображённый в вопросе"></div>`;
  }
  function meta(q, extra) {
    return `<div class="meta"><span class="badge">${esc(q.topic)}</span><span class="badge">${DIFF[q.difficulty] || ""}</span><span class="badge">${STATUS_LABEL[statusOf(q.id)]}</span>${extra ? `<span>${extra}</span>` : ""}</div>`;
  }
  function emptyCard(text) { return `<div class="card"><p>${esc(text || "В этом разделе пока нет проверенных материалов.")}</p></div>`; }
  function activeNote() {
    return `<p class="note">В тренировке используются только проверенные вопросы: ${Q.length} из ${ALL.length}. Остальные временно отключены и не показываются.</p>`;
  }

  // ---------- Обучение ----------
  function renderLearn() {
    const l = scopeIds(), el = $("#stage");
    if (!l.length) { el.innerHTML = emptyCard(S.ui.scope === "due" ? "На сегодня повторов нет." : undefined); return; }
    S.ui.idx = Math.min(Math.max(0, S.ui.idx), l.length - 1);
    const id = l[S.ui.idx], q = byId[id], s = rd(id);
    if (!s.seen) { wr(id).seen = true; save(); }
    const ord = learnOrder(id);
    el.innerHTML = `<div class="card">
      ${meta(q, `Вопрос ${S.ui.idx + 1} из ${l.length}`)}
      <div class="q">${esc(q.q)}</div>${imgFor(q)}
      ${ord.map((oi, i) => `<div class="opt ${oi === q.correct ? "correct" : ""}"><span class="letter">${L[i]}</span><span>${esc(q.options[oi])}</span>${oi === q.correct ? '<span class="mark">✓ Правильный ответ</span>' : ""}</div>`).join("")}
      <div class="expl"><strong>Почему:</strong> ${esc(q.explanation)}${q.misconception ? `<br><strong>Частое заблуждение:</strong> ${esc(q.misconception)}` : ""}</div>
      <div class="src">Источник: ${esc(q.source)} · ID: ${esc(q.id)}</div>
      <div class="row">
        <button class="btn" data-act="prev" ${S.ui.idx === 0 ? "disabled" : ""}>← Назад</button>
        <div class="toolbar">
          <button class="btn ${s.bm ? "primary" : ""}" data-act="bm" data-id="${id}">⭐ Закладка</button>
          <button class="btn ${s.mark === "difficult" ? "primary" : ""}" data-act="mark" data-v="difficult" data-id="${id}">Трудный</button>
          <button class="btn ${s.mark === "review" ? "primary" : ""}" data-act="mark" data-v="review" data-id="${id}">Повторить</button>
        </div>
        <button class="btn primary" data-act="next" ${S.ui.idx >= l.length - 1 ? "disabled" : ""}>Далее →</button>
      </div>
      ${activeNote()}</div>`;
  }
  // Порядок вариантов в обучении сохраняется в состоянии: после перезагрузки он не меняется
  function learnOrder(id) {
    if (!S.lorder) S.lorder = {};
    if (!S.lorder[id] || S.lorder[id].length !== byId[id].options.length) {
      S.lorder[id] = shuffle([...Array(byId[id].options.length).keys()]);
      save();
    }
    return S.lorder[id];
  }
  // Порядок вариантов в обучении стабилен на протяжении сессии и сохраняется в состоянии
  const orderCache = {};
  function shuffleOnce(key, n) {
    if (!orderCache[key]) orderCache[key] = shuffle([...Array(n).keys()]);
    return orderCache[key];
  }

  // ---------- Практика ----------
  function seqNext(l) { return l.find(id => !answeredOnce(id)) || null; }
  function ensurePr(l) {
    const p = S.pr;
    if (p && l.includes(p.id)) return;                 // текущий вопрос сохраняется до перехода «Далее»
    const id = S.ui.pracMode === "seq" ? seqNext(l) : pickWeighted(l, p ? p.id : null);
    S.pr = id ? { id, order: shuffle([...Array(byId[id].options.length).keys()]), done: false, last: null, ok: null } : null;
    save();
  }
  function pick(v) {
    const p = S.pr;
    if (!p || p.done) return;
    const q = byId[p.id], ok = p.order[v] === q.correct;
    p.done = true; p.last = v; p.ok = ok;
    S.session.n++; if (ok) S.session.ok++;
    recordAnswer(q.id, ok);
    render();
  }
  function nextPractice() { S.pr = null; render(); }
  function renderPractice() {
    const l = scopeIds(), el = $("#stage");
    if (!l.length) { el.innerHTML = emptyCard(S.ui.scope === "due" ? "На сегодня повторов нет." : undefined); return; }
    ensurePr(l);
    const modeBtn = `<div class="row" style="margin-top:0"><span class="note">Порядок: ${S.ui.pracMode === "seq" ? "по порядку (новые вопросы сначала)" : "повтор (с учётом расписания)"}</span>
      <button class="btn" data-act="pracmode">${S.ui.pracMode === "seq" ? "Включить повтор" : "Вернуться к порядку"}</button></div>`;
    if (!S.pr) {
      el.innerHTML = `<div class="card"><p>Последовательный просмотр этой группы завершён: все вопросы хотя бы раз отвечены.</p><p class="note">Можно продолжить в режиме повтора.</p>${modeBtn}</div>`;
      return;
    }
    const p = S.pr, q = byId[p.id];
    el.innerHTML = `<div class="card">
      <div class="meta"><span>Сессия: верно ${S.session.ok} из ${S.session.n}</span></div>${modeBtn}
      ${meta(q, "")}<div class="q">${esc(q.q)}</div>${imgFor(q)}
      ${p.order.map((oi, i) => {
        let cls = "", mk = "";
        if (p.done) {
          if (oi === q.correct) { cls = "correct"; mk = '<span class="mark">✓ Верно</span>'; }
          else if (i === p.last) { cls = "wrong"; mk = '<span class="mark">✗ Ваш ответ</span>'; }
        }
        return `<button class="opt ${cls}" data-act="pick" data-v="${i}" ${p.done ? "disabled" : ""}><span class="letter">${L[i]}</span><span>${esc(q.options[oi])}</span>${mk}</button>`;
      }).join("")}
      ${p.done ? `<div class="expl"><strong>${p.ok ? "Верно." : "Неверно."}</strong> ${esc(q.explanation)}${q.misconception ? `<br><strong>Частое заблуждение:</strong> ${esc(q.misconception)}` : ""}</div>
        <div class="src">Источник: ${esc(q.source)}</div>
        <div class="row"><span></span><button class="btn primary" data-act="pnext">Далее →</button></div>`
        : `<p class="note">Выберите вариант. Клавиши 1–4 тоже работают.</p>`}
      ${activeNote()}</div>`;
  }

  // ---------- Симуляция ----------
  function examSize(size) { return size === "short" ? Math.min(10, Q.length) : size === "medium" ? Math.min(20, Q.length) : Q.length; }
  function startExam(size) {
    if (S.exam && !S.exam.submitted) {
      if (!window.confirm("Есть незавершённая симуляция. Начать новую? Незавершённая будет сохранена в истории как прерванная.")) return;
      S.examHistory.push({ ...S.exam, abandoned: true });
    }
    const ids = shuffle(Q.map(q => q.id)).slice(0, examSize(size));
    const order = {};
    ids.forEach(id => { order[id] = shuffle([...Array(byId[id].options.length).keys()]); });
    S.exam = { size, ids, order, ans: {}, i: 0, submitted: false, recorded: false, started: dayNow() };
    save(); render();
  }
  function renderExam() {
    const el = $("#stage");
    if (!S.exam) {
      el.innerHTML = `<div class="card"><h2>Практическая симуляция M1</h2>
        <p><strong>ПРАКТИЧЕСКАЯ СИМУЛЯЦИЯ M1.</strong> Не официальный экзамен и не настоящие экзаменационные билеты. Количество вопросов, время и проходной балл официального экзамена не заданы и не проверены.</p>
        <div class="toolbar" style="margin:14px 0">
          <button class="btn" data-act="exam-start" data-v="short">Короткая (10)</button>
          <button class="btn" data-act="exam-start" data-v="medium">Средняя (20)</button>
          <button class="btn" data-act="exam-start" data-v="full">Все проверенные (${Q.length})</button></div>
        ${activeNote()}</div>`;
      return;
    }
    if (S.exam.submitted) { renderExamResults(); return; }
    const e = S.exam, n = e.ids.length, id = e.ids[e.i], q = byId[id];
    const answered = Object.keys(e.ans).length, sel = e.ans[id];
    el.innerHTML = `<div class="card">
      <div class="meta"><span>Вопрос ${e.i + 1} из ${n}</span><span>Отвечено: ${answered} из ${n}</span><span>Сохраняется автоматически</span></div>
      <div class="progress"><div style="width:${Math.round(100 * answered / n)}%"></div></div>
      <div class="q">${esc(q.q)}</div>${imgFor(q)}
      ${e.order[id].map((oi, k) => `<button class="opt ${sel === k ? "selected" : ""}" data-act="exam-pick" data-v="${k}"><span class="letter">${L[k]}</span><span>${esc(q.options[oi])}</span></button>`).join("")}
      <div class="grid">${e.ids.map((x, i) => `<button class="${e.ans[x] !== undefined ? "answered" : ""} ${i === e.i ? "cur" : ""}" data-act="exam-goto" data-v="${i}">${i + 1}</button>`).join("")}</div>
      <div class="row">
        <button class="btn" data-act="exam-prev" ${e.i === 0 ? "disabled" : ""}>← Назад</button>
        <button class="btn primary" data-act="exam-submit">Отправить тест</button>
        <button class="btn" data-act="exam-next" ${e.i >= n - 1 ? "disabled" : ""}>Далее →</button></div>
      <p class="note">Если вы закроете страницу, симуляция продолжится с этого же вопроса.
        <button class="btn" data-act="exam-restart" style="margin-left:8px">Начать заново (прерванная сохранится в истории)</button></p></div>`;
  }
  function submitExam() {
    const e = S.exam;
    if (!e || e.submitted) return;
    const n = e.ids.length, answered = Object.keys(e.ans).length;
    if (!window.confirm(`Отправить тест? Отвечено ${answered} из ${n}. После отправки ответы изменить нельзя.`)) return;
    e.submitted = true;
    if (!e.recorded) {           // запись результатов только один раз, даже после перезагрузки
      e.ids.forEach(id => { if (e.ans[id] !== undefined) recordAnswer(id, e.order[id][e.ans[id]] === byId[id].correct); });
      e.recorded = true;
    }
    S.examHistory.push({ ...e, abandoned: false });
    save(); render();
  }
  function renderExamResults() {
    const e = S.exam, ids = e.ids;
    let ok = 0, wrong = 0, skipped = 0; const perTopic = {};
    ids.forEach(id => {
      const q = byId[id]; perTopic[q.topic] = perTopic[q.topic] || { n: 0, ok: 0 }; perTopic[q.topic].n++;
      if (e.ans[id] === undefined) { skipped++; return; }
      if (e.order[id][e.ans[id]] === q.correct) { ok++; perTopic[q.topic].ok++; } else wrong++;
    });
    const pct = Math.round(100 * ok / ids.length);
    const rows = Object.entries(perTopic).map(([t, v]) => `<tr><td>${esc(t)}</td><td>${v.ok} из ${v.n}</td></tr>`).join("");
    const bad = ids.filter(id => e.ans[id] === undefined || e.order[id][e.ans[id]] !== byId[id].correct);
    const review = bad.map(id => { const q = byId[id], a = e.ans[id];
      return `<div class="card" style="margin:12px 0"><div class="q">${esc(q.q)}</div>${imgFor(q)}<p>Ваш ответ: ${a === undefined ? "не выбран" : esc(q.options[e.order[id][a]])}</p>
        <div class="opt correct"><span class="letter">✓</span><span>Правильно: ${esc(q.options[q.correct])}</span></div>
        <div class="expl">${esc(q.explanation)}</div><div class="src">Источник: ${esc(q.source)}</div></div>`; }).join("");
    $("#stage").innerHTML = `<div class="card"><h2>Результаты: практическая симуляция M1</h2>
      <p>Верно: <strong>${ok}</strong> из ${ids.length} (${pct}%). Неверно: ${wrong}. Без ответа: ${skipped}.</p>
      <p class="note">Проходной балл официального экзамена в приложении не задан.</p>
      <table><tr><th>Тема</th><th>Верно</th></tr>${rows}</table>
      <h3>Разбор ошибок</h3>${review || "<p>Ошибок нет.</p>"}
      <div class="row"><span></span><button class="btn primary" data-act="exam-reset">Новая симуляция</button></div></div>`;
  }

  // ---------- Ошибки ----------
  function renderMistakes() {
    const l = Q.map(q => q.id).filter(isMistake), el = $("#stage");
    if (!l.length) { el.innerHTML = `<div class="card"><p>Ошибок, которые нужно закрепить, нет.</p><p class="note">Вопрос попадает сюда после неверного ответа и выходит, когда освоен.</p></div>`; return; }
    el.innerHTML = `<div class="card"><div class="row" style="margin-top:0"><span class="note">К проработке: ${l.length}. Последний просмотр: ${esc(S.lastMistakeReview || "—")}</span>
      <div class="toolbar"><button class="btn primary" data-act="mistake-practice">Практиковать ошибки</button><button class="btn" data-act="mistake-reviewed">Отметить просмотр</button></div></div></div>` +
      l.map(id => { const q = byId[id], s = rd(id);
        return `<div class="card" style="margin-top:12px"><p class="note">${esc(statusReason(id))}</p>
          <div class="meta"><span class="badge">${esc(q.topic)}</span><span>Ошибок всего: ${s.w}</span><span>Последняя: ${s.lastWrong !== null ? dayStr(s.lastWrong) : "—"}</span></div>
          <div class="q">${esc(q.q)}</div>${imgFor(q)}<div class="opt correct"><span class="letter">✓</span><span>${esc(q.options[q.correct])}</span></div>
          <div class="expl">${esc(q.explanation)}</div><div class="src">Источник: ${esc(q.source)}</div></div>`; }).join("");
  }

  // ---------- Уроки ----------
  function renderLessons() {
    const el = $("#stage");
    if (!LESSONS.length) { el.innerHTML = emptyCard("Уроки не загружены."); return; }
    S.ui.lesson = Math.min(Math.max(0, S.ui.lesson), LESSONS.length - 1);
    const l = LESSONS[S.ui.lesson], done = !!S.lessonsDone[l.id];
    const doneCount = Object.keys(S.lessonsDone).filter(k => S.lessonsDone[k]).length;
    el.innerHTML = `<div class="card">
      <div class="meta"><span>Урок ${S.ui.lesson + 1} из ${LESSONS.length}</span><span>Пройдено уроков: ${doneCount} из ${LESSONS.length}</span></div>
      <h2>${esc(l.title)}</h2>
      <p><strong>Правило:</strong> ${esc(l.rule)}</p>
      ${l.diagram ? `<div class="signbox"><img src="${esc(l.diagram)}" alt="Схема к уроку: ${esc(l.title)}"></div>` : ""}
      <p>${esc(l.body)}</p>
      ${l.example ? `<div class="expl"><strong>Пример на дороге:</strong> ${esc(l.example)}</div>` : ""}
      ${l.mistake ? `<div class="expl plain"><strong>Частая ошибка:</strong> ${esc(l.mistake)}</div>` : ""}
      <div class="src">Источник: ${esc(l.source)}</div>
      <div class="row">
        <button class="btn" data-act="lprev" ${S.ui.lesson === 0 ? "disabled" : ""}>← Назад</button>
        <button class="btn ${done ? "primary" : ""}" data-act="ldone" data-id="${l.id}">${done ? "✓ Пройден" : "Отметить как пройденный"}</button>
        <button class="btn primary" data-act="lnext" ${S.ui.lesson >= LESSONS.length - 1 ? "disabled" : ""}>Далее →</button></div>
      <p class="note">Уроки не содержат проверочных вопросов. Для проверки знаний используйте «Практику» и «Симуляцию».</p></div>`;
  }

  // ---------- Знаки ----------
  function renderSignLearn() {
    const l = signIds(), el = $("#stage");
    if (!l.length) { el.innerHTML = emptyCard("В этой категории нет знаков или закладок."); return; }
    S.ui.sidx = Math.min(Math.max(0, S.ui.sidx), l.length - 1);
    const s = sigById[l[S.ui.sidx]];
    if (!S.signsSeen[s.id]) { S.signsSeen[s.id] = true; save(); }
    el.innerHTML = `<div class="card">
      <div class="meta"><span class="badge">${esc(CATS[s.category])}</span><span>Знак ${S.ui.sidx + 1} из ${l.length}</span></div>
      <div class="signbox"><img src="assets/signs/${esc(s.id)}.jpg" alt="${esc(s.en)}"></div>
      <div class="sign-ru">✓ ${esc(s.ru)}</div><div class="sign-en">${esc(s.en)}</div>
      <div class="expl"><strong>Реакция водителя:</strong> ${esc(s.response)}</div>
      ${s.note ? `<div class="expl plain"><strong>Пояснение:</strong> ${esc(s.note)}</div>` : ""}
      <div class="src">Источник: ${esc(s.source)}</div>
      <div class="row">
        <button class="btn" data-act="sprev" ${S.ui.sidx === 0 ? "disabled" : ""}>← Назад</button>
        <button class="btn ${S.sbm[s.id] ? "primary" : ""}" data-act="sbm" data-id="${s.id}">⭐ Закладка</button>
        <button class="btn primary" data-act="snext" ${S.ui.sidx >= l.length - 1 ? "disabled" : ""}>Далее →</button></div></div>`;
  }
  function makeSignQuiz(pool) {
    const s = pool[Math.floor(Math.random() * pool.length)];
    const same = shuffle(SIGNS.filter(x => x.id !== s.id && x.category === s.category && x.ru !== s.ru));
    const other = shuffle(SIGNS.filter(x => x.id !== s.id && x.category !== s.category && x.ru !== s.ru));
    const seen = new Set([s.ru]), picks = [];
    for (const d of same.concat(other)) { if (picks.length === 3) break; if (seen.has(d.ru)) continue; seen.add(d.ru); picks.push(d.ru); }
    return { id: s.id, opts: shuffle([s.ru, ...picks]).map(ru => ({ ru, isCorrect: ru === s.ru })), done: false, pick: null };
  }
  function renderSignQuiz() {
    const l = signIds(), el = $("#stage");
    if (l.length < 4) { el.innerHTML = emptyCard("Для викторины нужно минимум 4 знака в выбранной категории."); return; }
    const pool = l.map(id => sigById[id]);
    if (!S.sq || !pool.some(s => s.id === S.sq.id)) { S.sq = makeSignQuiz(pool); save(); }
    const sq = S.sq, s = sigById[sq.id];
    el.innerHTML = `<div class="card">
      <div class="meta"><span>Викторина: верно ${S.sqOk} из ${S.sqN}</span><span class="badge">${esc(CATS[s.category])}</span></div>
      <div class="signbox"><img src="assets/signs/${esc(s.id)}.jpg" alt="Дорожный знак для викторины"></div>
      <div class="q">Что означает этот знак?</div>
      ${sq.opts.map((o, i) => { let cls = "", mk = "";
        if (sq.done) { if (o.isCorrect) { cls = "correct"; mk = '<span class="mark">✓ Верно</span>'; } else if (i === sq.pick) { cls = "wrong"; mk = '<span class="mark">✗ Ваш ответ</span>'; } }
        return `<button class="opt ${cls}" data-act="squiz-pick" data-v="${i}" ${sq.done ? "disabled" : ""}><span class="letter">${L[i]}</span><span>${esc(o.ru)}</span>${mk}</button>`; }).join("")}
      ${sq.done ? `<div class="expl"><strong>Реакция водителя:</strong> ${esc(s.response)}</div><div class="src">Источник: ${esc(s.source)}</div>
        <div class="row"><span></span><button class="btn primary" data-act="squiz-next">Далее →</button></div>`
        : `<p class="note">Выберите значение знака. Клавиши 1–4 тоже работают.</p>`}</div>`;
  }
  function signPick(v) {
    const sq = S.sq;
    if (!sq || sq.done) return;
    const ok = sq.opts[v].isCorrect;
    sq.done = true; sq.pick = v; S.sqN++; if (ok) S.sqOk++;
    const st = S.sstats[sq.id] || (S.sstats[sq.id] = { c: 0, w: 0 });
    if (ok) st.c++; else st.w++;
    save(); render();
  }

  // ---------- Прогресс ----------
  function summary() {
    const seen = Q.filter(q => rd(q.id).seen).length;
    const mast = Q.filter(q => mastered(q.id)).length;
    const due = Q.filter(isDue).length;
    const hist = Object.values(S.stats).reduce((a, x) => a + (x.w || 0), 0);
    const lessonsDone = Object.keys(S.lessonsDone).filter(k => S.lessonsDone[k]).length;
    const examsDone = S.examHistory.filter(e => !e.abandoned).length;
    return { seen, mast, due, mist: Q.filter(isMistake).length, hist, lessonsDone, examsDone };
  }
  function renderProgress() {
    const s = summary();
    const rows = TOPICS.map(t => {
      const ids = Q.filter(q => q.topic === t).map(q => q.id);
      let c = 0, w = 0; ids.forEach(id => { const x = rd(id); c += x.c; w += x.w; });
      return `<tr><td>${esc(t)}</td><td>${ids.length}</td><td>${ids.filter(id => rd(id).seen).length}</td><td>${ids.filter(mastered).length}</td><td>${c + w ? Math.round(100 * c / (c + w)) + "%" : "—"}</td></tr>`;
    }).join("");
    const cont = S.ui.mode === "lessons" ? `Урок ${S.ui.lesson + 1}` : S.ui.mode === "signs" ? `Знак ${S.ui.sidx + 1}` : S.ui.mode === "exam" ? (S.exam && !S.exam.submitted ? "незавершённая симуляция" : "симуляция") : `вопрос ${S.ui.idx + 1}`;
    $("#stage").innerHTML = `<div class="card"><h2>Прогресс</h2>
      <div class="grid3">
        <div class="stat"><span>Проверенных вопросов</span><strong>${Q.length}</strong><small>отключено до проверки: ${QUAR}</small></div>
        <div class="stat"><span>Изучено</span><strong>${s.seen}</strong><small>открывались или отвечались</small></div>
        <div class="stat"><span>Освоено</span><strong>${s.mast}</strong><small>3 верных подряд в двух разных днях</small></div>
        <div class="stat"><span>Повторить сегодня</span><strong>${s.due}</strong></div>
        <div class="stat"><span>Ошибок не закреплено</span><strong>${s.mist}</strong></div>
        <div class="stat"><span>Всего ошибок (история)</span><strong>${s.hist}</strong><small>не удаляется после освоения</small></div>
        <div class="stat"><span>Уроков пройдено</span><strong>${s.lessonsDone}</strong><small>из ${LESSONS.length}</small></div>
        <div class="stat"><span>Знаков просмотрено</span><strong>${Object.keys(S.signsSeen).length}</strong><small>из ${SIGNS.length}</small></div>
        <div class="stat"><span>Завершённых симуляций</span><strong>${s.examsDone}</strong></div>
      </div>
      <div class="row" style="justify-content:flex-start">
        <button class="btn primary" data-act="continue">Продолжить: ${esc(cont)}</button>
        <button class="btn" data-act="start-due">Повтор на сегодня</button>
        <button class="btn" data-act="export">Экспорт прогресса (JSON)</button>
        <label class="btn" style="cursor:pointer">Импорт прогресса<input type="file" id="importFile" accept="application/json" style="display:none"></label></div>
      <p class="note">Экспорт и импорт — ручная резервная копия файла. Автоматической синхронизации между устройствами нет.</p>
      <h3>По темам</h3>
      <table><tr><th>Тема</th><th>Вопросов</th><th>Изучено</th><th>Освоено</th><th>Точность</th></tr>${rows}</table></div>`;
  }
  function exportProgress() {
    const blob = new Blob([JSON.stringify({ format: FORMAT, version: 3, savedAt: new Date().toISOString(), data: S }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "m1-progress-" + dayNow() + ".json";
    document.body.appendChild(a); a.click(); a.remove();
  }
  function importProgress(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        if (d.format !== FORMAT || d.version !== 3 || !d.data || typeof d.data !== "object") throw new Error("формат");
        if (!window.confirm("Заменить текущий прогресс данными из файла?")) return;
        S = Object.assign(blank(), d.data);
        S.ui = Object.assign(blank().ui, d.data.ui || {});
        save(); render();
      } catch (e) { window.alert("Файл не подходит: нужен экспорт прогресса этой версии."); }
    };
    fr.readAsText(file);
  }

  // ---------- Управление ----------
  function act(a, id, v) {
    const ui = S.ui;
    switch (a) {
      case "prev": ui.idx--; break;
      case "next": ui.idx++; break;
      case "bm": { const s = wr(id); s.bm = !s.bm; save(); break; }
      case "mark": { const s = wr(id); s.mark = s.mark === v ? null : v; save(); break; }
      case "pick": pick(+v); return;
      case "pnext": nextPractice(); return;
      case "pracmode": ui.pracMode = ui.pracMode === "seq" ? "rand" : "seq"; S.pr = null; break;
      case "exam-start": startExam(v); return;
      case "exam-pick": if (S.exam && !S.exam.submitted) { S.exam.ans[S.exam.ids[S.exam.i]] = +v; } break;
      case "exam-goto": if (S.exam) S.exam.i = +v; break;
      case "exam-prev": if (S.exam) S.exam.i--; break;
      case "exam-next": if (S.exam) S.exam.i++; break;
      case "exam-submit": submitExam(); return;
      case "exam-reset": S.exam = null; break;
      case "exam-restart": if (S.exam && !S.exam.submitted) startExam(S.exam.size); return;
      case "mistake-practice": ui.scope = "mistake"; ui.mode = "practice"; S.pr = null; break;
      case "mistake-reviewed": S.lastMistakeReview = dayStr(dayNow()); break;
      case "start-due": ui.scope = "due"; ui.mode = "practice"; S.pr = null; break;
      case "continue": break;
      case "export": exportProgress(); return;
      case "lprev": ui.lesson--; break;
      case "lnext": ui.lesson++; break;
      case "ldone": { const k = id; if (S.lessonsDone[k]) delete S.lessonsDone[k]; else S.lessonsDone[k] = true; break; }
      case "sprev": ui.sidx--; break;
      case "snext": ui.sidx++; break;
      case "sbm": { if (S.sbm[id]) delete S.sbm[id]; else S.sbm[id] = true; break; }
      case "squiz-pick": signPick(+v); return;
      case "squiz-next": S.sq = null; break;
      case "fs": S.fs = Math.min(26, Math.max(14, S.fs + 2 * (+v))); applyTheme(); save(); return;
      case "dark": S.dark = !S.dark; applyTheme(); save(); return;
    }
    save(); render();
  }
  function applyTheme() {
    document.documentElement.style.setProperty("--fs", S.fs + "px");
    document.body.classList.toggle("dark", !!S.dark);
  }
  function banners() {
    const parts = [];
    if (!storageOk || storageMsg) parts.push(`<div class="banner warn">${esc(storageMsg)}</div>`);
    if (S.notice) parts.push(`<div class="banner">${esc(S.notice)}</div>`);
    $("#banner").innerHTML = parts.join("");
  }
  function render() {
    banners();
    document.querySelectorAll("nav button[data-mode]").forEach(b => b.classList.toggle("active", b.dataset.mode === S.ui.mode));
    if (S.ui.mode === "exam64") { $("#scopeBar").classList.add("hidden"); $("#signBar").classList.add("hidden"); return; }  // v6.3: режим симуляции 64 рендерит exam64.js
    const mode = S.ui.mode, isQ = mode === "learn" || mode === "practice", isSigns = mode === "signs";
    $("#scopeBar").classList.toggle("hidden", !isQ);
    $("#signBar").classList.toggle("hidden", !isSigns);
    if (isQ) $("#scope").innerHTML = scopeOptions();
    if (isSigns) $("#sscope").innerHTML = signScopeOptions();
    if (isSigns) { $("#signSub").value = S.ui.signSub; if (S.ui.signSub === "quiz") renderSignQuiz(); else renderSignLearn(); return; }
    ({ learn: renderLearn, practice: renderPractice, exam: renderExam, mistakes: renderMistakes, progress: renderProgress, lessons: renderLessons })[mode]();
  }
  function scopeOptions() {
    const base = [["all", "Все вопросы"], ["due", "Повтор сегодня"], ["bookmark", "Закладки"], ["difficult", "Трудные"], ["review", "Отмечены для повтора"], ["mistake", "Ошибки (не закреплены)"]];
    return [...base, ...TOPICS.map(t => ["topic:" + t, "Тема: " + t])].map(([v, t]) => `<option value="${esc(v)}" ${v === S.ui.scope ? "selected" : ""}>${esc(t)}</option>`).join("");
  }
  function signScopeOptions() {
    return [["all", "Все знаки"], ["bookmark", "Закладки"], ...Object.entries(CATS).map(([k, v]) => ["cat:" + k, v])]
      .map(([v, t]) => `<option value="${esc(v)}" ${v === S.ui.sscope ? "selected" : ""}>${esc(t)}</option>`).join("");
  }

  document.addEventListener("click", e => {
    const m = e.target.closest("nav button[data-mode]");
    if (m && !m.disabled) { S.ui.mode = m.dataset.mode; save(); render(); return; }
    const b = e.target.closest("[data-act]");
    if (b && !b.disabled) act(b.dataset.act, b.dataset.id, b.dataset.v);
  });
  document.addEventListener("change", e => {
    if (e.target.id === "scope") { S.ui.scope = e.target.value; S.ui.idx = 0; S.pr = null; save(); render(); }
    else if (e.target.id === "sscope") { S.ui.sscope = e.target.value; S.ui.sidx = 0; S.sq = null; save(); render(); }
    else if (e.target.id === "signSub") { S.ui.signSub = e.target.value; S.sq = null; save(); render(); }
    else if (e.target.id === "importFile" && e.target.files && e.target.files[0]) { importProgress(e.target.files[0]); e.target.value = ""; }
  });
  document.addEventListener("keydown", e => {
    if (e.target.tagName === "SELECT" || e.ctrlKey || e.metaKey || e.altKey) return;
    const mode = S.ui.mode;
    if (mode === "learn") {
      const n = scopeIds().length;
      if (e.key === "ArrowRight" && S.ui.idx < n - 1) { S.ui.idx++; save(); render(); }
      if (e.key === "ArrowLeft" && S.ui.idx > 0) { S.ui.idx--; save(); render(); }
    } else if (mode === "practice") {
      if (/^[1-4]$/.test(e.key) && S.pr && !S.pr.done) pick(+e.key - 1);
      else if (e.key === "Enter" && S.pr && S.pr.done) nextPractice();
    } else if (mode === "exam" && S.exam && !S.exam.submitted) {
      if (/^[1-4]$/.test(e.key)) act("exam-pick", null, +e.key - 1);
      if (e.key === "ArrowRight" && S.exam.i < S.exam.ids.length - 1) act("exam-next");
      if (e.key === "ArrowLeft" && S.exam.i > 0) act("exam-prev");
    } else if (mode === "signs") {
      if (S.ui.signSub === "quiz") { if (/^[1-4]$/.test(e.key) && S.sq && !S.sq.done) signPick(+e.key - 1); else if (e.key === "Enter" && S.sq && S.sq.done) act("squiz-next"); }
      else { const n = signIds().length; if (e.key === "ArrowRight" && S.ui.sidx < n - 1) { S.ui.sidx++; save(); render(); } if (e.key === "ArrowLeft" && S.ui.sidx > 0) { S.ui.sidx--; save(); render(); } }
    }
  });

  // Если в сохранённой позиции стоит вопрос, которого больше нет в активном банке, позиция сбрасывается без потери статистики
  if (S.ui.mode === "practice") S.pr = S.pr && byId[S.pr.id] ? S.pr : null;
  if (S.exam && !S.exam.submitted) S.exam.ids = S.exam.ids.filter(id => byId[id]);
  applyTheme();
  render();
})();
