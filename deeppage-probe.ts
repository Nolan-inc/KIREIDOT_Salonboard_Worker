import { chromium } from "playwright";
const server = process.env.SB_PROXY_SERVER!;
const proxy = { server: /:\/\//.test(server) ? server : `http://${server}`, username: process.env.SB_PROXY_USERNAME, password: process.env.SB_PROXY_PASSWORD };
const urls = ["https://salonboard.com/login/", "https://salonboard.com/KLP/reserve/reserveList/init"];
const headless = process.env.SB_HEADLESS !== "0";
(async () => {
  console.log(`proxy=${proxy.server} channel=${process.env.SB_BROWSER_CHANNEL||"chromium"} headless=${headless}`);
  let browser:any;
  try { browser = await chromium.launch({ headless, channel: process.env.SB_BROWSER_CHANNEL || undefined, proxy }); }
  catch (e:any) { console.log(`LAUNCH_FAIL ${e.message}`); process.exit(1); }
  const ctx = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  await ctx.route("**/*", (r:any) => { const t = r.request().resourceType(); return (t==="image"||t==="media"||t==="font") ? r.abort() : r.continue(); });
  const page = await ctx.newPage();
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      const title = await page.title().catch(()=>"" );
      console.log(`REACH ${Date.now()-t0}ms status=${resp?.status()} title="${title.slice(0,45)}" ${url}`);
    } catch (e:any) {
      console.log(`TARPIT/FAIL ${Date.now()-t0}ms ${(e.message||"").split("\n")[0].slice(0,120)} ${url}`);
    }
  }
  await browser.close();
})();
