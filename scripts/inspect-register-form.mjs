/**
 * 新規予約登録フォームの実 DOM (capture した page.html) を解析し、
 * REGISTER_FORM 用のセレクタ候補を提案するヘルパ。
 *
 * Playwright/Chromium で file:// として読み込み、worker.ts と同じ DOM クエリで
 * 候補を抽出する (= 実際に worker が掴めるセレクタを確認できる)。
 *
 * 使い方:
 *   node scripts/inspect-register-form.mjs <path-to-page.html>
 *   例: node scripts/inspect-register-form.mjs salonboard_code/register_form_opened.html
 *
 * 出力: 各フォーム項目の候補セレクタと、全 input/select/textarea/button の一覧。
 * このスクリプトは読み取り専用 (SalonBoard には一切アクセスしない)。
 */
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/inspect-register-form.mjs <page.html>");
  process.exit(1);
}
const file = resolve(process.cwd(), arg);
if (!existsSync(file)) {
  console.error(`file not found: ${file}`);
  process.exit(1);
}

// 各 REGISTER_FORM 項目を推定するためのキーワード (name/id/placeholder/近傍ラベル)。
const FIELD_HINTS = {
  customerName: ["customername", "custname", "顧客名", "お名前", "氏名", "name"],
  customerPhone: ["tel", "phone", "電話", "携帯"],
  customerEmail: ["mail", "email", "メール"],
  staffSelect: ["staff", "staffer", "スタッフ", "担当"],
  menuSelect: ["menu", "coupon", "メニュー", "クーポン", "コース"],
  date: ["date", "rsvdate", "日付", "来店日", "予約日"],
  time: ["time", "rsvtime", "時刻", "時間", "開始"],
  amount: ["amount", "price", "kingaku", "金額", "料金", "会計"],
  memo: ["memo", "note", "remark", "備考", "メモ"],
  proceedToConfirm: ["確認", "confirm", "次へ", "進む"],
  registerButton: ["登録", "予約する", "確定", "regist"],
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(pathToFileURL(file).href, { waitUntil: "domcontentloaded" });

// 全フォーム要素を素の属性付きで取得。
const controls = await page.evaluate(() => {
  const out = [];
  const labelFor = (el) => {
    // 1) <label for=id> 2) 祖先 <label> 3) 直前テキスト
    let lbl = "";
    if (el.id) {
      const l = document.querySelector(`label[for="${el.id}"]`);
      if (l) lbl = (l.textContent || "").trim();
    }
    if (!lbl) {
      const anc = el.closest("label");
      if (anc) lbl = (anc.textContent || "").trim();
    }
    if (!lbl) {
      const prev = el.previousElementSibling;
      if (prev && /^(label|span|p|th|dt)$/i.test(prev.tagName))
        lbl = (prev.textContent || "").trim();
    }
    return lbl.slice(0, 40);
  };
  document.querySelectorAll("input,select,textarea,button,a").forEach((el, idx) => {
    const a = (n) => el.getAttribute(n) || undefined;
    out.push({
      idx,
      tag: el.tagName.toLowerCase(),
      type: a("type"),
      name: a("name"),
      id: a("id"),
      class: a("class")?.slice(0, 80),
      placeholder: a("placeholder"),
      href: el.tagName.toLowerCase() === "a" ? a("href")?.slice(0, 120) : undefined,
      text: (el.textContent || "").trim().slice(0, 50) || undefined,
      label: labelFor(el),
      optionCount:
        el.tagName.toLowerCase() === "select" ? el.querySelectorAll("option").length : undefined,
      sampleOptions:
        el.tagName.toLowerCase() === "select"
          ? Array.from(el.querySelectorAll("option"))
              .slice(0, 8)
              .map((o) => ({ value: o.value?.slice(0, 60), label: (o.textContent || "").trim().slice(0, 60) }))
          : undefined,
    });
  });
  return out;
});

// 各項目にスコアリングして候補を出す。
function score(ctrl, hints) {
  const hay = [ctrl.name, ctrl.id, ctrl.placeholder, ctrl.label, ctrl.text, ctrl.class]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hints.reduce((s, h) => (hay.includes(h.toLowerCase()) ? s + 1 : s), 0);
}
function buildSelector(ctrl) {
  if (ctrl.id) return `#${cssEscape(ctrl.id)}`;
  if (ctrl.name) return `${ctrl.tag}[name="${ctrl.name}"]`;
  if (ctrl.placeholder) return `${ctrl.tag}[placeholder="${ctrl.placeholder}"]`;
  if (ctrl.tag === "button" && ctrl.text) return `button:has-text("${ctrl.text}")`;
  return `${ctrl.tag}` + (ctrl.class ? `.${ctrl.class.split(/\s+/)[0]}` : "");
}
function cssEscape(s) {
  return s.replace(/([ #;?%&,.+*~':"!^$\[\]()=>|/@])/g, "\\$1");
}

console.log(`\n=== inspecting: ${file} ===`);
console.log(`form controls found: ${controls.length}\n`);

console.log("=== REGISTER_FORM セレクタ候補 (スコア順 top3) ===");
for (const [field, hints] of Object.entries(FIELD_HINTS)) {
  const ranked = controls
    .map((c) => ({ c, s: score(c, hints) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  if (ranked.length === 0) {
    console.log(`\n[${field}]  ⚠️ 候補なし — 手動確認 / manual_required 対象`);
    continue;
  }
  console.log(`\n[${field}]`);
  for (const { c, s } of ranked) {
    const sel = buildSelector(c);
    const extra =
      c.optionCount != null
        ? ` options=${c.optionCount} e.g.${JSON.stringify(c.sampleOptions?.slice(0, 3))}`
        : "";
    console.log(`  score=${s}  ${c.tag}${c.type ? `[${c.type}]` : ""} name=${c.name ?? "-"} id=${c.id ?? "-"} label="${c.label ?? ""}"`);
    console.log(`     -> selector: ${sel}${extra}`);
  }
}

console.log("\n=== 全フォーム要素 (生) ===");
for (const c of controls) {
  console.log(
    `#${c.idx} ${c.tag}${c.type ? `[${c.type}]` : ""} name=${c.name ?? "-"} id=${c.id ?? "-"} ph=${c.placeholder ?? "-"} label="${c.label ?? ""}" text="${c.text ?? ""}"${c.optionCount != null ? ` opts=${c.optionCount}` : ""}`,
  );
}

await browser.close();
