(function () {
  "use strict";

  const Q = window.M1_QUESTIONS || [];
  const SIGNS = window.M1_SIGNS || [];
  const CATS = window.M1_CATEGORIES || {};
  const byId = Object.fromEntries(Q.map(q => [q.id, q]));
  const sigById = Object.fromEntries(SIGNS.map(s => [s.id, s]));
  const TOPICS = [...new Set(Q.map(q => q.topic))];
  const L = ["A", "B", "C", "D"];
  const DIFF = { easy: "Лёгкий", medium: "Средний", hard: "Сложный" };
  const INTERVALS = [0, 1, 3, 7, 14, 30];   // дни до следующего показа по уровню
  const NEW_PER_DAY = 5;                    // рекомендуемое число новых вопросов в день
  const KEY = "m1trainer.v2";

  // ---------- Хранилище ----------
  let store;
  try { store = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { store = {}; }
  store.stats = store.stats || {};
  store.sbm = store.sbm || {};
  store.sstats = store.sstats || {};
  if (typeof store.fs !== "number") store.fs = 18;
  store.dark = !!store.dark;

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* хранилище недоступно */ }
  }

  const dayNow = () => Math.floor(Date.now() / 864e5);
  const dayStr = d => new Date(d * 864e5).toLocaleDateString("ru-RU");
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const shuffle = a => {
    const r = a.slice();
    for (let i = r.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [r[i], r[j]] = [r[j], r[i]];
    }
    return r;
  };

  // Версии вопросов: если текст существенно изменён, мастерство сбрасывается, история ошибок остаётся
  const QV = Object.fromEntries(Q.map(q => [q.id, q.v || 1]));

  // Миграция данных версии 1: сохраняем счётчики, добавляем поля интервалов
  Object.values(store.stats).forEach(s => {
    if (s.lvl === undefined) {
      s.lvl = Math.min(s.streak || 0, INTERVALS.length - 1);
      s.due = dayNow();
      s.rightDays = [];
      s.seen = (s.c || 0) + (s.w || 0) > 0;
    }
  });

  // Синхронизация версий: если вопрос изменён, сбрасываем только признаки освоения
  Object.keys(store.stats).forEach(id => {
    const s = store.stats[id];
    if (s.qv === undefined) s.qv = 1;
    const cur = QV[id];
    if (cur !== undefined && s.qv < cur) {
      s.streak = 0; s.rightDays = []; s.lvl = 0; s.due = dayNow(); s.qv = cur;
    }
  });
  save();

  function rd(id) {
    return store.stats[id] || { seen: false, c: 0, w: 0, streak: 0, lvl: 0, due: 0, rightDays: [], lastWrong: null, bm: false, mark: null };
  }
  function wr(id) {
    return store.stats[id] || (store.stats[id] = { qv: QV[id] || 1, seen: false, c: 0, w: 0, streak: 0, lvl: 0, due: 0, rightDays: [], lastWrong: null, bm: false, mark: null });
  }

  // Освоено: 3 верных подряд и верные ответы минимум в двух разных днях
  function mastered(id) {
    const s = store.stats[id];
    return !!s && s.streak >= 3 && new Set(s.rightDays).size >= 2;
  }
  // Ошибка, которую ещё не закрепили
  function isMistake(id) {
    const s = store.stats[id];
    return !!s && s.lastWrong != null && !mastered(id);
  }
  function isDue(id) {
    const s = store.stats[id];
    return !!s && (s.c + s.w > 0) && s.due <= dayNow();
  }

  // Состояния: новый / изучается / нужно повторить / освоен
  function statusOf(id) {
    const s = store.stats[id];
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
    if (s.lastWrong !== null && s.streak < 3) return "Последний ответ был неверным (ошибок всего: " + s.w + "). Вопрос остаётся в очереди, пока не будет 3 верных ответов подряд в разные дни.";
    if (isDue(id)) return "Пора повторить по расписанию.";
    return "Ответы верные, но освоение ещё не завершено.";
  }

  function recordAnswer(id, ok) {
    const s = wr(id);
    const t = dayNow();
    s.seen = true;
    if (ok) {
      s.c++;
      s.streak++;
      s.lvl = Math.min(s.lvl + 1, INTERVALS.length - 1);
      s.due = t + INTERVALS[s.lvl];
      if (!s.rightDays.includes(t)) s.rightDays.push(t);
      s.rightDays = s.rightDays.slice(-6);
    } else {
      s.w++;
      s.streak = 0;
      s.lvl = 0;
      s.due = t;            // вернуть в очередь сегодня
      s.lastWrong = t;
    }
    save();
  }

  // Вес выбора: недавние ошибки и «пора повторить» — выше; освоенные — ниже.
  // Старые ошибки сами по себе вес не повышают.
  function weight(id) {
    const s = rd(id);
    const t = dayNow();
    let w;
    if (!s.seen) w = 0.6;
    else if (s.due <= t) w = 1.0;
    else w = 0.15;
    if (s.lastWrong != null && t - s.lastWrong <= 1) w *= 2.5;
    if (mastered(id)) w *= 0.3;
    if (s.mark === "difficult") w *= 1.8;
    if (s.mark === "easy") w *= 0.5;
    return Math.max(w, 0.02);
  }
  function pickWeighted(list, exclude) {
    const cand = list.length > 1 ? list.filter(i => i !== exclude) : list;
    const total = cand.reduce((a, id) => a + weight(id), 0);
    let r = Math.random() * total;
    for (const id of cand) {
      r -= weight(id);
      if (r <= 0) return id;
    }
    return cand[cand.length - 1];
  }

  // Порядок вариантов в режиме обучения: случайный, но стабильный на время открытой страницы
  const sessionOrder = {};
  function learnOrder(id) {
    if (!sessionOrder[id]) sessionOrder[id] = shuffle(byId[id].options.map((_, i) => i));
    return sessionOrder[id];
  }

  // ---------- Состояние ----------
  let mode = "learn";
  let lessonIndex = 0;
  let scope = "all";
  let sscope = "all";
  let idx = 0;
  let sidx = 0;
  let pr = { id: null, order: [], done: false, ok: 0, n: 0, last: null };
  let exam = null;
  let sq = null;             // викторина по знакам
  let sqOk = 0, sqN = 0;

  const $ = s => document.querySelector(s);

  // ---------- Выборки ----------
  function scopeIds() {
    let l = Q.map(q => q.id);
    if (scope.startsWith("topic:")) { const t = scope.slice(6); l = l.filter(id => byId[id].topic === t); }
    else if (scope === "due") l = l.filter(isDue);
    else if (scope === "bookmark") l = l.filter(id => rd(id).bm);
    else if (scope === "difficult") l = l.filter(id => rd(id).mark === "difficult");
    else if (scope === "review") l = l.filter(id => rd(id).mark === "review");
    else if (scope === "mistake") l = l.filter(isMistake);
    return l;
  }
  function signIds() {
    let l = SIGNS.map(s => s.id);
    if (sscope.startsWith("cat:")) { const c = sscope.slice(4); l = l.filter(id => sigById[id].category === c); }
    else if (sscope === "bookmark") l = l.filter(id => store.sbm[id]);
    return l;
  }

  function scopeOptions() {
    const base = [
      ["all", "Все вопросы"], ["due", "Повтор сегодня"], ["bookmark", "Закладки"],
      ["difficult", "Трудные"], ["review", "Отмечены для повтора"], ["mistake", "Ошибки (не закреплены)"]
    ];
    const topics = TOPICS.map(t => ["topic:" + t, "Тема: " + t]);
    return [...base, ...topics].map(([v, t]) =>
      `<option value="${esc(v)}" ${v === scope ? "selected" : ""}>${esc(t)}</option>`).join("");
  }
  function signScopeOptions() {
    const base = [["all", "Все знаки"], ["bookmark", "Закладки"]];
    const cats = Object.entries(CATS).map(([k, v]) => ["cat:" + k, v]);
    return [...base, ...cats].map(([v, t]) =>
      `<option value="${esc(v)}" ${v === sscope ? "selected" : ""}>${esc(t)}</option>`).join("");
  }

  function meta(q, extra) {
    return `<div class="meta">
      <span class="badge">${esc(q.topic)}</span>
      <span class="badge">${STATUS_LABEL[statusOf(q.id)]}</span>
      <span class="badge">${DIFF[q.difficulty] || ""}</span>
      ${extra ? `<span>${extra}</span>` : ""}
    </div>`;
  }
  function emptyCard(text) {
    return `<div class="card"><p>${esc(text || "В этом разделе пока нет материалов.")}</p></div>`;
  }

  // ---------- Режим: Обучение ----------
  function renderLearn() {
    const l = scopeIds();
    const el = $("#stage");
    if (!l.length) {
      el.innerHTML = emptyCard(scope === "due" ? "На сегодня повторов нет. Изучите новые вопросы или вернитесь завтра." : undefined);
      return;
    }
    idx = Math.min(idx, l.length - 1);
    const id = l[idx];
    const q = byId[id];
    const s = rd(id);
    if (!s.seen) { wr(id).seen = true; save(); }   // просмотр = «изучено», не «освоено»
    const ord = learnOrder(id);
    el.innerHTML = `<div class="card">
      ${meta(q, `Вопрос ${idx + 1} из ${l.length}`)}
      <div class="q">${esc(q.q)}</div>
      ${ord.map((oi, i) => `
        <div class="opt ${oi === q.correct ? "correct" : ""}">
          <span class="letter">${L[i]}</span><span>${esc(q.options[oi])}</span>
          ${oi === q.correct ? '<span class="mark">✓ Правильный ответ</span>' : ""}
        </div>`).join("")}
      <div class="expl"><strong>Почему:</strong> ${esc(q.explanation)}
        ${q.misconception ? `<br><strong>Частое заблуждение:</strong> ${esc(q.misconception)}` : ""}</div>
      <div class="src">Источник: ${esc(q.source)} · ID: ${esc(q.id)}</div>
      <div class="row">
        <button class="btn" data-act="prev" ${idx === 0 ? "disabled" : ""}>← Назад</button>
        <div class="toolbar">
          <button class="btn ${s.bm ? "primary" : ""}" data-act="bm" data-id="${id}">⭐ Закладка</button>
          <button class="btn ${s.mark === "difficult" ? "primary" : ""}" data-act="mark" data-v="difficult" data-id="${id}">Трудный</button>
          <button class="btn ${s.mark === "easy" ? "primary" : ""}" data-act="mark" data-v="easy" data-id="${id}">Легко</button>
          <button class="btn ${s.mark === "review" ? "primary" : ""}" data-act="mark" data-v="review" data-id="${id}">Повторить</button>
        </div>
        <button class="btn primary" data-act="next" ${idx >= l.length - 1 ? "disabled" : ""}>Далее →</button>
      </div>
      <p class="note">Обучение не влияет на статус «освоено». Освоение фиксируется в практике и симуляции.</p>
    </div>`;
  }

  // ---------- Режим: Практика ----------
  function createPr(l, exclude) {
    const id = pickWeighted(l, exclude);
    return { id, order: shuffle(byId[id].options.map((_, i) => i)), done: false, last: null, ok: pr.ok, n: pr.n };
  }
  function pick(v) {
    if (pr.done || !pr.id) return;
    const q = byId[pr.id];
    const ok = pr.order[v] === q.correct;
    pr.done = true; pr.last = v; pr.n++;
    if (ok) pr.ok++;
    recordAnswer(q.id, ok);
    render();
  }
  function nextPractice() { pr = createPr(scopeIds(), pr.id); render(); }

  function renderPractice() {
    const l = scopeIds();
    const el = $("#stage");
    if (!l.length) { el.innerHTML = emptyCard(scope === "due" ? "На сегодня повторов нет." : undefined); return; }
    if (!pr.id || !l.includes(pr.id)) pr = createPr(l, null);
    const q = byId[pr.id];
    const ansOk = pr.done && pr.order[pr.last] === q.correct;
    el.innerHTML = `<div class="card">
      <div class="meta"><span>Сессия: верно ${pr.ok} из ${pr.n}</span></div>
      ${meta(q, "")}
      <div class="q">${esc(q.q)}</div>
      ${pr.order.map((oi, i) => {
        let cls = "", mk = "";
        if (pr.done) {
          if (oi === q.correct) { cls = "correct"; mk = '<span class="mark">✓ Верно</span>'; }
          else if (i === pr.last) { cls = "wrong"; mk = '<span class="mark">✗ Ваш ответ</span>'; }
        }
        return `<button class="opt ${cls}" data-act="pick" data-v="${i}" ${pr.done ? "disabled" : ""}>
          <span class="letter">${L[i]}</span><span>${esc(q.options[oi])}</span>${mk}</button>`;
      }).join("")}
      ${pr.done ? `
        <div class="expl"><strong>${ansOk ? "Верно." : "Неверно."}</strong> ${esc(q.explanation)}
          ${q.misconception ? `<br><strong>Частое заблуждение:</strong> ${esc(q.misconception)}` : ""}</div>
        <div class="src">Источник: ${esc(q.source)}</div>
        <div class="row"><span></span><button class="btn primary" data-act="pnext">Далее →</button></div>`
        : `<p class="note">Выберите вариант. Клавиши 1–4 тоже работают.</p>`}
    </div>${dashboardCompact()}`;
  }

  // ---------- Режим: Симуляция ----------
  function startExam(size) {
    const n = size === "short" ? Math.min(10, Q.length) : size === "medium" ? Math.min(20, Q.length) : Q.length;
    const ids = shuffle(Q.map(q => q.id)).slice(0, n);
    exam = { ids, ans: {}, order: {}, i: 0, submitted: false };
    ids.forEach(id => { exam.order[id] = shuffle(byId[id].options.map((_, k) => k)); });
    render();
  }
  function renderExam() {
    const el = $("#stage");
    if (!exam) {
      el.innerHTML = `<div class="card">
        <h2>Практическая симуляция M1</h2>
        <p><strong>ПРАКТИЧЕСКАЯ СИМУЛЯЦИЯ M1.</strong> Вопросы составлены по материалам Official MTO Motorcycle Handbook. Это не официальный экзамен и не настоящие экзаменационные билеты.</p>
        <p class="note">Количество вопросов, время и проходной балл официального экзамена в приложении не заданы и не проверены. Размеры ниже — настройки приложения.</p>
        <div class="toolbar" style="margin:14px 0">
          <button class="btn" data-act="exam-start" data-v="short">Короткая (10)</button>
          <button class="btn" data-act="exam-start" data-v="medium">Средняя (20)</button>
          <button class="btn" data-act="exam-start" data-v="full">Полный банк (${Q.length})</button>
        </div>
        <p>Правильные ответы не показываются до отправки. Ответы можно менять до отправки.</p>
      </div>`;
      return;
    }
    if (exam.submitted) { renderExamResults(); return; }
    const n = exam.ids.length, id = exam.ids[exam.i], q = byId[id];
    const answered = Object.keys(exam.ans).length, sel = exam.ans[id];
    el.innerHTML = `<div class="card">
      <div class="meta"><span>Вопрос ${exam.i + 1} из ${n}</span><span>Отвечено: ${answered} из ${n}</span></div>
      <div class="progress"><div style="width:${Math.round(100 * answered / n)}%"></div></div>
      <div class="q">${esc(q.q)}</div>
      ${exam.order[id].map((oi, k) => `
        <button class="opt ${sel === k ? "selected" : ""}" data-act="exam-pick" data-v="${k}">
          <span class="letter">${L[k]}</span><span>${esc(q.options[oi])}</span></button>`).join("")}
      <div class="grid">${exam.ids.map((x, i) =>
        `<button class="${exam.ans[x] !== undefined ? "answered" : ""} ${i === exam.i ? "cur" : ""}" data-act="exam-goto" data-v="${i}">${i + 1}</button>`).join("")}</div>
      <div class="row">
        <button class="btn" data-act="exam-prev" ${exam.i === 0 ? "disabled" : ""}>← Назад</button>
        <button class="btn primary" data-act="exam-submit">Отправить тест</button>
        <button class="btn" data-act="exam-next" ${exam.i >= n - 1 ? "disabled" : ""}>Далее →</button>
      </div></div>`;
  }
  function submitExam() {
    const n = exam.ids.length, answered = Object.keys(exam.ans).length;
    if (!window.confirm(`Отправить тест? Отвечено ${answered} из ${n}. После отправки ответы изменить нельзя.`)) return;
    exam.submitted = true;
    exam.ids.forEach(id => {
      if (exam.ans[id] !== undefined) recordAnswer(id, exam.order[id][exam.ans[id]] === byId[id].correct);
    });
    render();
  }
  function renderExamResults() {
    const ids = exam.ids;
    let ok = 0, wrong = 0, skipped = 0;
    const perTopic = {};
    ids.forEach(id => {
      const q = byId[id];
      perTopic[q.topic] = perTopic[q.topic] || { n: 0, ok: 0 };
      perTopic[q.topic].n++;
      if (exam.ans[id] === undefined) { skipped++; return; }
      if (exam.order[id][exam.ans[id]] === q.correct) { ok++; perTopic[q.topic].ok++; }
      else wrong++;
    });
    const pct = Math.round(100 * ok / ids.length);
    const rows = Object.entries(perTopic).map(([t, v]) => `<tr><td>${esc(t)}</td><td>${v.ok} из ${v.n}</td></tr>`).join("");
    const mistakes = ids.filter(id => exam.ans[id] === undefined || exam.order[id][exam.ans[id]] !== byId[id].correct);
    const review = mistakes.map(id => {
      const q = byId[id], a = exam.ans[id];
      const chosen = a === undefined ? "не выбран" : esc(q.options[exam.order[id][a]]);
      return `<div class="card" style="margin:12px 0">
        <div class="q">${esc(q.q)}</div>
        <p>Ваш ответ: ${chosen}</p>
        <div class="opt correct"><span class="letter">✓</span><span>Правильно: ${esc(q.options[q.correct])}</span></div>
        <div class="expl">${esc(q.explanation)}</div>
        <div class="src">Источник: ${esc(q.source)}</div></div>`;
    }).join("");
    $("#stage").innerHTML = `<div class="card">
      <h2>Результаты: практическая симуляция M1</h2>
      <p>Верно: <strong>${ok}</strong> из ${ids.length} (${pct}%). Неверно: ${wrong}. Без ответа: ${skipped}.</p>
      <p class="note">Проходной балл официального экзамена в приложении не задан и не проверен.</p>
      <table><tr><th>Тема</th><th>Верно</th></tr>${rows}</table>
      <h3>Разбор ошибок</h3>${review || "<p>Ошибок нет.</p>"}
      <div class="row"><span></span><button class="btn primary" data-act="exam-reset">Новая симуляция</button></div></div>`;
  }

  // ---------- Режим: Ошибки ----------
  function renderMistakes() {
    const l = Q.map(q => q.id).filter(isMistake);
    const el = $("#stage");
    if (!l.length) {
      el.innerHTML = `<div class="card"><p>Ошибок, которые нужно закрепить, нет.</p>
        <p class="note">Вопрос попадает сюда после неверного ответа и выходит из списка, когда освоен (3 верных подряд в минимум двух разных днях).</p></div>`;
      return;
    }
    const head = `<div class="card"><div class="row" style="margin-top:0">
      <span class="note">К проработке: ${l.length}. Последний просмотр: ${esc(store.lastMistakeReview || "—")}</span>
      <div class="toolbar">
        <button class="btn primary" data-act="mistake-practice">Практиковать ошибки</button>
        <button class="btn" data-act="mistake-reviewed">Отметить просмотр</button></div></div></div>`;
    const items = l.map(id => {
      const q = byId[id], s = rd(id);
      return `<div class="card" style="margin-top:12px">
        <p class="note">${esc(statusReason(id))}</p>
        <div class="meta"><span class="badge">${esc(q.topic)}</span><span>Ошибок всего: ${s.w}</span>
          <span>Последняя ошибка: ${s.lastWrong != null ? dayStr(s.lastWrong) : "—"}</span>
          <span>Верных подряд: ${s.streak} из 3</span></div>
        <div class="q">${esc(q.q)}</div>
        <div class="opt correct"><span class="letter">✓</span><span>${esc(q.options[q.correct])}</span></div>
        <div class="expl">${esc(q.explanation)}</div>
        <div class="src">Источник: ${esc(q.source)}</div></div>`;
    }).join("");
    el.innerHTML = head + items;
  }

  // ---------- Режим: Прогресс ----------
  function summary() {
    const seen = Q.filter(q => rd(q.id).seen).length;
    const mast = Q.filter(q => mastered(q.id)).length;
    const due = Q.filter(isDue).length;
    const newAvail = Q.filter(q => !rd(q.id).seen).length;
    const hist = Object.values(store.stats).reduce((a, x) => a + (x.w || 0), 0);
    return { seen, mast, due, newAvail, mist: Q.filter(isMistake).length, hist };
  }
  function dashboardCompact() {
    const s = summary();
    return `<div class="card" style="margin-top:16px">
      <p class="note">Всего вопросов: ${Q.length} · Изучено: ${s.seen} · Освоено: ${s.mast} · К повтору сегодня: ${s.due} · Ошибок не закреплено: ${s.mist}</p>
      <button class="btn" data-act="goto-progress">Полный прогресс</button></div>`;
  }
  function renderProgress() {
    const s = summary();
    const rows = TOPICS.map(t => {
      const ids = Q.filter(q => q.topic === t).map(q => q.id);
      const seen = ids.filter(id => rd(id).seen).length;
      const mast = ids.filter(mastered).length;
      let c = 0, w = 0;
      ids.forEach(id => { const x = rd(id); c += x.c; w += x.w; });
      const acc = c + w ? Math.round(100 * c / (c + w)) + "%" : "—";
      return `<tr><td>${esc(t)}</td><td>${ids.length}</td><td>${seen}</td><td>${mast}</td><td>${acc}</td></tr>`;
    }).join("");
    const sSeen = Object.values(store.sstats).filter(x => x.c + x.w > 0).length;
    $("#stage").innerHTML = `<div class="card">
      <h2>Прогресс</h2>
      <div class="grid3">
        <div class="stat"><span>Всего вопросов</span><strong>${Q.length}</strong></div>
        <div class="stat"><span>Изучено</span><strong>${s.seen}</strong><small>просмотрены в обучении или отвечены</small></div>
        <div class="stat"><span>Освоено</span><strong>${s.mast}</strong><small>3 верных подряд, в двух разных днях</small></div>
        <div class="stat"><span>Повторить сегодня</span><strong>${s.due}</strong></div>
        <div class="stat"><span>Ошибок не закреплено</span><strong>${s.mist}</strong></div>
        <div class="stat"><span>Всего ошибок (история)</span><strong>${s.hist}</strong><small>сохраняется даже после освоения</small></div>
        <div class="stat"><span>Знаков в тренажёре</span><strong>${SIGNS.length}</strong><small>в викторине отвечено: ${sSeen}</small></div>
      </div>
      <div class="row" style="justify-content:flex-start">
        <button class="btn primary" data-act="start-due">Начать повтор сегодня</button>
        <span class="note">Новых вопросов доступно: ${s.newAvail}. Рекомендуется не больше ${NEW_PER_DAY} в день.</span>
      </div>
      <h3>По темам</h3>
      <table><tr><th>Тема</th><th>Вопросов</th><th>Изучено</th><th>Освоено</th><th>Точность</th></tr>${rows}</table>
      <p class="note">Точность — доля верных ответов в практике и симуляции. Обучение её не меняет.</p>
    </div>`;
  }

  // ---------- Знаки: обучение ----------
  function renderSignLearn() {
    const l = signIds();
    const el = $("#stage");
    if (!l.length) { el.innerHTML = emptyCard("В этой категории нет знаков или закладок."); return; }
    sidx = Math.min(sidx, l.length - 1);
    const s = sigById[l[sidx]];
    el.innerHTML = `<div class="card">
      <div class="meta"><span class="badge">${esc(CATS[s.category])}</span><span>Знак ${sidx + 1} из ${l.length}</span></div>
      <div class="signbox"><img src="assets/signs/${esc(s.id)}.jpg" alt="${esc(s.en)}"></div>
      <div class="sign-ru">✓ ${esc(s.ru)}</div>
      <div class="sign-en">${esc(s.en)}</div>
      <div class="expl"><strong>Реакция водителя:</strong> ${esc(s.response)}</div>
      ${s.note ? `<div class="expl plain"><strong>Пояснение:</strong> ${esc(s.note)}</div>` : ""}
      <div class="src">Источник: ${esc(s.source)}</div>
      <div class="row">
        <button class="btn" data-act="sprev" ${sidx === 0 ? "disabled" : ""}>← Назад</button>
        <button class="btn ${store.sbm[s.id] ? "primary" : ""}" data-act="sbm" data-id="${s.id}">⭐ Закладка</button>
        <button class="btn primary" data-act="snext" ${sidx >= l.length - 1 ? "disabled" : ""}>Далее →</button>
      </div></div>`;
  }

  // ---------- Знаки: викторина ----------
  function makeSignQuiz(pool) {
    const s = pool[Math.floor(Math.random() * pool.length)];
    const sameCat = shuffle(SIGNS.filter(x => x.id !== s.id && x.category === s.category && x.ru !== s.ru));
    const others = shuffle(SIGNS.filter(x => x.id !== s.id && x.category !== s.category && x.ru !== s.ru));
    const seen = new Set([s.ru]);
    const picks = [];
    for (const d of sameCat.concat(others)) {
      if (picks.length === 3) break;
      if (seen.has(d.ru)) continue;
      seen.add(d.ru);
      picks.push(d.ru);
    }
    const opts = shuffle([s.ru, ...picks]).map(ru => ({ ru, isCorrect: ru === s.ru }));
    return { id: s.id, opts, done: false, pick: null };
  }
  function renderSignQuiz() {
    const l = signIds();
    const el = $("#stage");
    if (l.length < 4) { el.innerHTML = emptyCard("Для викторины нужно минимум 4 знака в выбранной категории."); return; }
    const pool = l.map(id => sigById[id]);
    if (!sq || !pool.some(s => s.id === sq.id)) sq = makeSignQuiz(pool);
    const s = sigById[sq.id];
    el.innerHTML = `<div class="card">
      <div class="meta"><span>Викторина: верно ${sqOk} из ${sqN}</span><span class="badge">${esc(CATS[s.category])}</span></div>
      <div class="signbox"><img src="assets/signs/${esc(s.id)}.jpg" alt="Дорожный знак"></div>
      <div class="q">Что означает этот знак?</div>
      ${sq.opts.map((o, i) => {
        let cls = "", mk = "";
        if (sq.done) {
          if (o.isCorrect) { cls = "correct"; mk = '<span class="mark">✓ Верно</span>'; }
          else if (i === sq.pick) { cls = "wrong"; mk = '<span class="mark">✗ Ваш ответ</span>'; }
        }
        return `<button class="opt ${cls}" data-act="squiz-pick" data-v="${i}" ${sq.done ? "disabled" : ""}>
          <span class="letter">${L[i]}</span><span>${esc(o.ru)}</span>${mk}</button>`;
      }).join("")}
      ${sq.done ? `
        <div class="expl"><strong>Реакция водителя:</strong> ${esc(s.response)}</div>
        <div class="src">Источник: ${esc(s.source)} · ${esc(s.en)}</div>
        <div class="row"><span></span><button class="btn primary" data-act="squiz-next">Далее →</button></div>`
        : `<p class="note">Выберите значение знака. Клавиши 1–4 тоже работают.</p>`}
    </div>`;
  }
  function signPick(v) {
    if (!sq || sq.done) return;
    const ok = sq.opts[v].isCorrect;
    sq.done = true; sq.pick = v; sqN++;
    if (ok) sqOk++;
    const st = store.sstats[sq.id] || (store.sstats[sq.id] = { c: 0, w: 0 });
    if (ok) st.c++; else st.w++;
    save();
    render();
  }

  // ---------- Визуальные уроки ----------
  function renderLessons() {
    const lessons = window.M1_LESSONS || [];
    if (!lessons.length) { $("#stage").innerHTML = '<div class="card">Уроки пока недоступны.</div>'; return; }
    lessonIndex = Math.max(0, Math.min(lessons.length - 1, lessonIndex));
    const x = lessons[lessonIndex];
    const lessonList = lessons.map((l, i) => `<button data-act="lesson-open" data-v="${i}" class="${i === lessonIndex ? 'active' : ''}">${i+1}. ${esc(l.title)}</button>`).join('');
    const topicQuestions = Q.filter(q => q.topic === x.title || q.topic.includes(x.title) || x.title.includes(q.topic)).slice(0, 3);
    const checks = topicQuestions.length ? topicQuestions.map(q => `<div class="lesson-block"><strong>${esc(q.q)}</strong><details><summary>Показать правильный ответ</summary><p>${esc(q.options[q.correct])}</p><p class="note">${esc(q.explanation || '')}</p></details><div class="src">${esc(q.source || '')}</div></div>`).join('') : '<p class="note">Для проверки знаний перейдите в режим «Практика».</p>';
    $("#stage").innerHTML = `<div class="card"><h2>Визуальные уроки · ${lessonIndex+1} / ${lessons.length}</h2><div class="lesson-list">${lessonList}</div><h2>${esc(x.title)}</h2><p><strong>${esc(x.rule)}</strong></p><img class="lesson-img" src="${esc(x.diagram)}" alt="Учебная иллюстрация: ${esc(x.title)}" loading="lazy"><div class="lesson-block"><h3>Объяснение</h3><p>${esc(x.body)}</p></div><div class="lesson-block"><h3>Практический пример</h3><p>${esc(x.example)}</p></div><div class="lesson-block"><h3>Распространённая ошибка</h3><p>${esc(x.mistake)}</p></div><h3>Контрольные вопросы</h3>${checks}<div class="src">Источник: ${esc(x.source)}. Схема учебная, упрощённая.</div><div class="row"><button class="btn" data-act="lesson-prev" ${lessonIndex===0?'disabled':''}>← Предыдущий урок</button><button class="btn primary" data-act="lesson-next" ${lessonIndex===lessons.length-1?'disabled':''}>Следующий урок →</button></div></div>`;
  }

  // ---------- Управление ----------
  function act(a, id, v) {
    switch (a) {
      case "lesson-open": lessonIndex = +v; break;
      case "lesson-prev": lessonIndex--; break;
      case "lesson-next": lessonIndex++; break;
      case "prev": idx--; break;
      case "next": idx++; break;
      case "bm": { const s = wr(id); s.bm = !s.bm; save(); break; }
      case "mark": { const s = wr(id); s.mark = s.mark === v ? null : v; save(); break; }
      case "pick": pick(+v); return;
      case "pnext": nextPractice(); return;
      case "exam-start": startExam(v); return;
      case "exam-pick": exam.ans[exam.ids[exam.i]] = +v; break;
      case "exam-goto": exam.i = +v; break;
      case "exam-prev": exam.i--; break;
      case "exam-next": exam.i++; break;
      case "exam-submit": submitExam(); return;
      case "exam-reset": exam = null; break;
      case "mistake-practice":
        scope = "mistake"; mode = "practice"; pr = { id: null, order: [], done: false, ok: 0, n: 0, last: null }; break;
      case "mistake-reviewed": store.lastMistakeReview = dayStr(dayNow()); save(); break;
      case "start-due":
        scope = "due"; mode = "practice"; pr = { id: null, order: [], done: false, ok: 0, n: 0, last: null }; break;
      case "goto-progress": mode = "progress"; break;
      case "sprev": sidx--; break;
      case "snext": sidx++; break;
      case "sbm": { if (store.sbm[id]) delete store.sbm[id]; else store.sbm[id] = true; save(); break; }
      case "squiz-pick": signPick(+v); return;
      case "squiz-next": sq = null; break;
      case "fs": store.fs = Math.min(26, Math.max(14, store.fs + 2 * (+v))); save(); applyTheme(); return;
      case "dark": store.dark = !store.dark; save(); applyTheme(); return;
    }
    render();
  }

  function applyTheme() {
    document.documentElement.style.setProperty("--fs", store.fs + "px");
    document.body.classList.toggle("dark", store.dark);
  }

  function render() {
    document.querySelectorAll("nav button[data-mode]").forEach(b =>
      b.classList.toggle("active", b.dataset.mode === mode));
    const isSigns = mode === "signs";
    const isQ = mode === "learn" || mode === "practice";
    $("#scopeBar").classList.toggle("hidden", !isQ);
    $("#signBar").classList.toggle("hidden", !isSigns);
    if (isQ) $("#scope").innerHTML = scopeOptions();
    if (isSigns) $("#sscope").innerHTML = signScopeOptions();
    if (isSigns) {
      if ($("#signSub").value === "quiz") renderSignQuiz(); else renderSignLearn();
      return;
    }
    ({ learn: renderLearn, practice: renderPractice, exam: renderExam, mistakes: renderMistakes, progress: renderProgress, lessons: renderLessons })[mode]();
  }

  document.addEventListener("click", e => {
    const m = e.target.closest("nav button[data-mode]");
    if (m && !m.disabled) { mode = m.dataset.mode; idx = 0; sq = null; render(); return; }
    const b = e.target.closest("[data-act]");
    if (b && !b.disabled) act(b.dataset.act, b.dataset.id, b.dataset.v);
  });

  document.addEventListener("change", e => {
    if (e.target.id === "scope") {
      scope = e.target.value; idx = 0;
      pr = { id: null, order: [], done: false, ok: 0, n: pr.n, last: null };
      render();
    } else if (e.target.id === "sscope") {
      sscope = e.target.value; sidx = 0; sq = null; render();
    } else if (e.target.id === "signSub") {
      sq = null; render();
    }
  });

  document.addEventListener("keydown", e => {
    if (e.target.tagName === "SELECT" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (mode === "learn") {
      const n = scopeIds().length;
      if (e.key === "ArrowRight" && idx < n - 1) { idx++; render(); }
      if (e.key === "ArrowLeft" && idx > 0) { idx--; render(); }
    } else if (mode === "practice") {
      if (/^[1-4]$/.test(e.key) && pr.id && !pr.done) pick(+e.key - 1);
      else if (e.key === "Enter" && pr.done) nextPractice();
    } else if (mode === "exam" && exam && !exam.submitted) {
      if (/^[1-4]$/.test(e.key)) act("exam-pick", null, +e.key - 1);
      if (e.key === "ArrowRight" && exam.i < exam.ids.length - 1) act("exam-next");
      if (e.key === "ArrowLeft" && exam.i > 0) act("exam-prev");
    } else if (mode === "signs") {
      if ($("#signSub").value === "quiz") {
        if (/^[1-4]$/.test(e.key) && sq && !sq.done) signPick(+e.key - 1);
        else if (e.key === "Enter" && sq && sq.done) act("squiz-next");
      } else {
        const n = signIds().length;
        if (e.key === "ArrowRight" && sidx < n - 1) { sidx++; render(); }
        if (e.key === "ArrowLeft" && sidx > 0) { sidx--; render(); }
      }
    }
  });

  applyTheme();
  render();
})();
