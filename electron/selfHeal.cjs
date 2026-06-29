// =============================================================================
// OpenClaw 自己修復フォールバック (Claude Computer-Use 方式)
// -----------------------------------------------------------------------------
// 目的: SalonBoard の HTML 構造が変わって Playwright の固定セレクタが壊れても、
//   Claude にページ(スクリーンショット+アクセシビリティツリー)を "見せて" タスクを
//   自律実行させ、同期を継続する。通常スクレイパが失敗した時のフォールバック層。
//
// 設計: 観測(screenshot+a11y) → Claude が次アクションを tool_use で返す →
//   Playwright で実行 → 再観測 … を done/fail/max_steps まで反復する agent loop。
//
// 使い方:
//   const { selfHealTask } = require('./selfHeal.cjs');
//   const r = await selfHealTask(page, {
//     task: '予約登録フォームで 担当=チェカ, 日時=2026-07-01 12:00 を入力し「登録」を押す',
//     apiKey: process.env.ANTHROPIC_API_KEY,
//     successCheck: async (page) => (await page.locator('text=登録しました').count()) > 0,
//   });
//
// 環境変数:
//   ANTHROPIC_API_KEY     : Claude APIキー (SSM /kireidot/worker/anthropic/api_key から注入)
//   SELFHEAL_MODEL        : 既定 'claude-sonnet-4-6' (vision対応・高速)
//   SELFHEAL_MAX_STEPS    : 既定 14
// =============================================================================

const DEFAULT_MODEL = process.env.SELFHEAL_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = [
  "あなたは SalonBoard(美容室予約管理) を操作するブラウザ自動化エージェントです。",
  "目的は与えられたタスクを、画面(スクリーンショット)とアクセシビリティツリーを根拠に、",
  "提供されたツールだけで完了させることです。SalonBoard の DOM 構造は予告なく変わるため、",
  "固定セレクタに頼らず『今見えている要素』に対して操作してください。",
  "規則:",
  "- 1ステップにつき必ず1つのツールを呼ぶ。推測でフォームを送信しない(値が入ったことを次の観測で確認)。",
  "- 要素は安定する方を優先: aria/name/ラベル文字列 > 一意なCSS > 最後の手段で座標。",
  "- 破壊的操作(削除/キャンセル/送信)はタスクが明示的に要求した時のみ。",
  "- 入力値はタスク記載のものを正確に。曖昧なら fail で理由を返す。",
  "- タスク完了の確証が得られたら done を呼ぶ。不可能/危険なら fail を呼ぶ。",
].join("\n");

function actionTools() {
  return [
    {
      name: "click",
      description: "要素をクリックする。css(CSSセレクタ) か text(可視テキスト)のどちらかを指定。",
      input_schema: {
        type: "object",
        properties: {
          css: { type: "string", description: "クリックする要素のCSSセレクタ" },
          text: { type: "string", description: "クリックする要素の可視テキスト(完全/部分)" },
          reason: { type: "string", description: "なぜこの操作か(短く)" },
        },
      },
    },
    {
      name: "type",
      description: "テキスト入力欄に値を入力する。css か label(近傍ラベル文字列)で対象を指定。",
      input_schema: {
        type: "object",
        properties: {
          css: { type: "string" },
          label: { type: "string", description: "入力欄を特定するラベル/プレースホルダ文字列" },
          value: { type: "string", description: "入力する値" },
          reason: { type: "string" },
        },
        required: ["value"],
      },
    },
    {
      name: "select",
      description: "プルダウン(select)で選択肢を選ぶ。css で対象、label か value で選択肢を指定。",
      input_schema: {
        type: "object",
        properties: {
          css: { type: "string" },
          label: { type: "string", description: "選択肢の表示文字列" },
          value: { type: "string", description: "選択肢の value 属性" },
          reason: { type: "string" },
        },
      },
    },
    {
      name: "done",
      description: "タスク完了。success と根拠(note)を返す。",
      input_schema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["success"],
      },
    },
    {
      name: "fail",
      description: "タスク続行不能。reason を返す。",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  ];
}

// ページの観測: スクリーンショット(base64 png) + アクセシビリティツリー(条件付き縮約)。
async function captureState(page) {
  let screenshot = null;
  try {
    const buf = await page.screenshot({ type: "png", fullPage: false, timeout: 8000 });
    screenshot = buf.toString("base64");
  } catch {
    /* スクショ失敗時は a11y のみで継続 */
  }
  let a11yText = "";
  try {
    const snap = await page.accessibility.snapshot({ interestingOnly: true });
    a11yText = JSON.stringify(snap).slice(0, 7000);
  } catch {
    /* best-effort */
  }
  let url = "";
  try {
    url = page.url();
  } catch {
    /* ignore */
  }
  return { screenshot, a11yText, url };
}

// Claude が返したアクションを Playwright で実行。
async function execAction(page, name, input) {
  const timeout = 8000;
  if (name === "click") {
    if (input.css) {
      await page.locator(input.css).first().click({ timeout });
    } else if (input.text) {
      await page.getByText(input.text, { exact: false }).first().click({ timeout });
    } else {
      throw new Error("click: css も text も無し");
    }
    return `clicked ${input.css || input.text}`;
  }
  if (name === "type") {
    let loc;
    if (input.css) loc = page.locator(input.css).first();
    else if (input.label)
      loc = page
        .getByLabel(input.label, { exact: false })
        .or(page.getByPlaceholder(input.label, { exact: false }))
        .first();
    else throw new Error("type: css も label も無し");
    await loc.fill(String(input.value ?? ""), { timeout });
    return `typed "${input.value}" into ${input.css || input.label}`;
  }
  if (name === "select") {
    const loc = page.locator(input.css || "select").first();
    if (input.value != null && input.value !== "")
      await loc.selectOption({ value: String(input.value) }, { timeout });
    else if (input.label)
      await loc.selectOption({ label: String(input.label) }, { timeout });
    else throw new Error("select: value も label も無し");
    return `selected ${input.value || input.label}`;
  }
  throw new Error(`未知のアクション: ${name}`);
}

// Anthropic Messages API 呼び出し (SDK不要・fetch直)。
async function callClaude(apiKey, body) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`anthropic ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

function buildObservationContent(state, taskOrFeedback) {
  const content = [];
  if (state.screenshot) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: state.screenshot },
    });
  }
  content.push({
    type: "text",
    text:
      `${taskOrFeedback}\n\n` +
      `現在URL: ${state.url}\n` +
      `アクセシビリティツリー(縮約):\n${state.a11yText || "(取得不可)"}`,
  });
  return content;
}

/**
 * 自己修復タスク実行。Claude にページを見せてタスクを完了させる。
 * @returns {Promise<{success:boolean, note?:string, reason?:string, steps:number}>}
 */
async function selfHealTask(page, opts) {
  const {
    task,
    apiKey = process.env.ANTHROPIC_API_KEY,
    model = DEFAULT_MODEL,
    maxSteps = Number(process.env.SELFHEAL_MAX_STEPS) || 14,
    successCheck = null, // async (page) => boolean : done主張の客観検証
    log = (m) => console.log(`[selfHeal] ${m}`),
  } = opts || {};

  if (!apiKey) return { success: false, reason: "ANTHROPIC_API_KEY 未設定", steps: 0 };

  const tools = actionTools();
  const messages = [];
  let firstTurn = true;

  for (let step = 1; step <= maxSteps; step++) {
    const state = await captureState(page);
    const intro = firstTurn
      ? `タスク: ${task}\n上記タスクを達成してください。`
      : `直前アクションの結果を反映した現在の画面です。タスクの達成に向け次の1手を選んでください。`;
    messages.push({ role: "user", content: buildObservationContent(state, intro) });
    firstTurn = false;

    let data;
    try {
      data = await callClaude(apiKey, {
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        tool_choice: { type: "any" },
        messages,
      });
    } catch (e) {
      log(`Claude呼び出し失敗(step ${step}): ${e.message}`);
      return { success: false, reason: `claude_error: ${e.message}`, steps: step };
    }

    const toolUse = (data.content || []).find((b) => b.type === "tool_use");
    // assistant の応答を会話に積む(tool_result と対応させるため)。
    messages.push({ role: "assistant", content: data.content || [] });

    if (!toolUse) {
      log(`tool_use 無し(step ${step}) → 中断`);
      return { success: false, reason: "no_tool_use", steps: step };
    }

    const { name, input, id } = toolUse;
    log(`step ${step}: ${name} ${JSON.stringify(input).slice(0, 120)}`);

    if (name === "done") {
      let ok = !!input.success;
      if (ok && typeof successCheck === "function") {
        ok = await successCheck(page).catch(() => false);
        if (!ok) {
          // done を主張したが客観検証で未達 → フィードバックして続行。
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                content: "done と判定されましたが完了の客観確認が取れませんでした。画面を再確認し操作を続けてください。",
                is_error: true,
              },
            ],
          });
          continue;
        }
      }
      return { success: ok, note: input.note, steps: step };
    }
    if (name === "fail") {
      return { success: false, reason: input.reason || "agent_fail", steps: step };
    }

    // 実アクション実行 → 結果を tool_result で返す。
    let resultText;
    try {
      resultText = await execAction(page, name, input);
      await page.waitForTimeout(900).catch(() => {});
    } catch (e) {
      resultText = `操作失敗: ${e.message}`;
    }
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: resultText }],
    });
  }

  return { success: false, reason: "max_steps", steps: maxSteps };
}

module.exports = { selfHealTask, DEFAULT_MODEL };
