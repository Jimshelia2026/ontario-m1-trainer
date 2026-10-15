import json, sys
from playwright.sync_api import sync_playwright
URL="http://localhost:8787/ontario-m1-trainer/index.html"
R=[]
def check(n,ok,d=""): R.append((n,bool(ok),str(d)))
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={"width":1280,"height":900}); pg=ctx.new_page()
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e))); pg.on("console",lambda m: errs.append(m.text) if m.type=="error" else None)
    pg.on("dialog",lambda d:d.accept())
    pg.goto(URL); pg.evaluate("()=>localStorage.clear()"); pg.reload(); pg.wait_for_selector(".card")
    navs=pg.evaluate("()=>Array.from(document.querySelectorAll('nav button')).map(b=>b.textContent.trim()+'|'+(b.dataset.mode||''))")
    check("Вкладки навигации присутствуют", len(navs)>=5, navs)
    for m in [x.split('|')[1] for x in navs if x.split('|')[1]]:
        pg.click(f"nav button[data-mode='{m}']"); pg.wait_for_timeout(120)
        check(f"Вкладка {m} открывается без пустого экрана", pg.locator("#stage").inner_text().strip()!="")
    # Сверка: все варианты у вопросов о знаках на русском
    qcount=pg.evaluate("()=>(window.M1_QUESTIONS||[]).length")
    check("Вопросы загружены в приложение", qcount==299, qcount)
    eng=pg.evaluate("()=>(window.M1_QUESTIONS||[]).filter(q=>q.options.some(o=>/[A-Za-z]{4,}/.test(o)&&!/[А-Яа-я]/.test(o))).length")
    check("Ни одного вопроса с английскими вариантами ответа", eng==0, eng)
    # Изображения знаков
    pg.click("nav button[data-mode='signs']"); pg.select_option("#signSub","learn"); pg.select_option("#sscope","all")
    pg.wait_for_selector(".signbox img")
    broken=0
    for k in range(48):
        pg.wait_for_function("()=>{const i=document.querySelector('.signbox img');return i&&i.complete}")
        if not pg.evaluate("()=>document.querySelector('.signbox img').naturalWidth>0"): broken+=1
        if k<47: pg.click("[data-act='snext']")
    check("Все 48 изображений знаков загружаются", broken==0, f"broken={broken}")
    # Практика: ответ неверный -> красный, верный -> зелёный
    pg.click("nav button[data-mode='practice']"); pg.wait_for_selector("#stage .opt")
    check("Практика: до ответа подсветки нет", pg.locator(".opt.correct,.opt.wrong").count()==0)
    pg.click("#stage .opt >> nth=0")
    check("Практика: после ответа есть зелёный вариант", pg.locator(".opt.correct").count()==1)
    # Симуляция: без подсказок до отправки
    pg.click("nav button[data-mode='exam']"); pg.click("[data-act='exam-start'][data-v='short']"); pg.wait_for_selector("#stage .opt")
    check("Симуляция: до отправки нет зелёного и объяснений", pg.locator(".opt.correct").count()==0 and pg.locator(".expl").count()==0)
    # Уроки (если вкладка есть)
    has_less = pg.locator("nav button:has-text('Урок')").count()
    check("Вкладка уроков присутствует", has_less>=1, has_less)
    check("Нет ошибок JavaScript", not errs, errs[:5])
    # Мобильный экран
    ctx2=b.new_context(viewport={"width":390,"height":844}); p2=ctx2.new_page(); p2.goto(URL); p2.wait_for_selector(".card")
    over=p2.evaluate("()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1")
    check("Мобильный экран 390 px: нет горизонтальной прокрутки на главной", not over)
    b.close()
passed=sum(1 for _,o,_ in R if o)
for n,o,d in R: print(("PASS " if o else "FAIL ")+n+("" if o else f"  [{d}]"))
print(f"\nИТОГО: {passed} из {len(R)}")
