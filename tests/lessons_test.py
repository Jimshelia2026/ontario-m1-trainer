from playwright.sync_api import sync_playwright
URL="http://localhost:8787/ontario-m1-trainer/index.html"
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1280,"height":900})
    errs=[]; pg.on("pageerror",lambda e: errs.append(str(e))); pg.on("console",lambda m: errs.append(m.text) if m.type=="error" else None)
    pg.goto(URL); pg.evaluate("()=>localStorage.clear()"); pg.reload(); pg.wait_for_selector(".card")
    pg.click("nav button:has-text('Урок')"); pg.wait_for_timeout(200)
    print("lessons tab text sample:", pg.locator("#stage").inner_text()[:160].replace("\n"," | "))
    imgs=pg.locator("#stage img")
    print("imgs on first lesson view:", imgs.count())
    results=[]
    for i in range(15):
        pg.wait_for_timeout(120)
        n=pg.locator("#stage img").count()
        if n:
            ok=pg.evaluate("()=>{const i=document.querySelector('#stage img');return i.complete&&i.naturalWidth>0}")
            src=pg.evaluate("()=>document.querySelector('#stage img').getAttribute('src')")
            results.append((i+1,src,ok))
        nxt=pg.locator("#stage button:has-text('Следующ'), #stage button:has-text('Далее')")
        if nxt.count()==0 or nxt.first.is_disabled(): break
        nxt.first.click()
    for r in results: print("lesson view",r)
    print("lessons with a loaded image:", sum(1 for r in results if r[2]), "of", len(results))
    print("JS errors:", errs or "none")
    b.close()
