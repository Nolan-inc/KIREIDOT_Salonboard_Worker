import { chromium } from "playwright";
const server = process.env.SB_PROXY_SERVER!;
const proxy = { server: /:\/\//.test(server) ? server : `http://${server}`, username: process.env.SB_PROXY_USERNAME, password: process.env.SB_PROXY_PASSWORD };
const ID = process.env.SB_LOGIN_ID!, PW = process.env.SB_LOGIN_PW!;
const headless = process.env.SB_HEADLESS !== "0";
const BASE = "https://salonboard.com";
const log = (s:string)=>console.log(`[+${(((Date.now()/1000)%10000)).toFixed(0)}] ${s}`);
(async () => {
  const browser = await chromium.launch({ headless, channel: "chrome", proxy });
  const ctx = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  await ctx.route("**/*", (r:any)=>{const t=r.request().resourceType();return (t==="image"||t==="media"||t==="font")?r.abort():r.continue();});
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/login/`, { waitUntil:"domcontentloaded", timeout:30000 });
    log(`login page: "${await page.title()}"`);
    await page.locator('input[name="userId"]').fill(ID);
    const pw = page.locator('input[name="password"]');
    await pw.click().catch(()=>{}); await pw.pressSequentially(PW,{delay:80}).catch(()=>pw.fill(PW));
    log("filled, click dologin, waiting up to 60s for redirect away from login...");
    await page.locator('a.common-CNCcommon__primaryBtn').first().click({timeout:8000}).catch((e)=>log("click: "+e.message?.slice(0,40)));
    const t0=Date.now();
    await page.waitForURL((u)=>!/login/i.test(u.toString()),{timeout:60000}).catch((e)=>log("redirect-wait timeout: "+(e.message||"").split("\n")[0].slice(0,50)));
    log(`after ${((Date.now()-t0)/1000).toFixed(1)}s: url=${page.url().slice(0,60)} title="${await page.title().catch(()=>"")}"`);
    await page.waitForTimeout(2000);
    const resp = await page.goto(`${BASE}/KLP/reserve/reserveList/init`,{waitUntil:"domcontentloaded",timeout:30000}).catch(()=>null);
    const title = await page.title().catch(()=>"" );
    const body = await page.evaluate(()=>document.body?.innerText?.replace(/\s+/g," ")?.slice(0,250)||"").catch(()=>"");
    const expired = /有効期限|再度ログイン|システムエラー|ログイン：SALON/.test(body+title);
    log(`reserveList: status=${resp?.status()} title="${title}" expired=${expired}`);
    log(`body: ${body.slice(0,160)}`);
    log(expired ? "=> ❌ ログイン未成立" : "=> ✅ 認証済み深層ページ取得成功");
  } catch (e:any) { log(`ERROR ${(e.message||"").split("\n")[0].slice(0,150)}`); }
  finally { await browser.close(); }
})();
