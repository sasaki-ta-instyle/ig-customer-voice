// 顧客役の回答とペルソナの下書きを作る。呼び出し先は CV_LLM で切り替える（入出力は同じ）。
//   cli（既定・この Mac）: Claude Code CLI を --print で呼ぶ（サブスク枠）
//   api（サーバ）       : Claude API（従量課金、ANTHROPIC_API_KEY）
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

const BACKENDS = new Set(["cli", "api"]);
export const LLM = process.env.CV_LLM || "cli";
if (!BACKENDS.has(LLM)) throw new Error(`CV_LLM は cli か api: ${LLM}`);
if (LLM === "api" && !process.env.ANTHROPIC_API_KEY) throw new Error("CV_LLM=api には ANTHROPIC_API_KEY が要ります");

const CLAUDE_BIN = process.env.CV_CLAUDE_BIN || "claude";
const MODEL = process.env.CV_MODEL || "sonnet"; // cli 用の別名
const API_MODEL = process.env.CV_API_MODEL || "claude-sonnet-5-5";
// 短い会話の返答なので effort は low（速く・安く）。深くしたいときは medium / high
const API_EFFORT = process.env.CV_API_EFFORT || "low";
const TIMEOUT_MS = Number(process.env.CV_TIMEOUT_MS || 90_000);
const STYLES = new Set(["persona", "zundamon"]);
// この話への気持ちの向き。主力顧客（critical）が negative なら「クリティカル」として画面に出す
const STANCES = new Set(["positive", "conditional", "negative"]);
const api = LLM === "api" ? new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 2 }) : null;

/**
 * @param {object} args
 * @param {string} args.rules       prompt.md の本文
 * @param {string} args.personaBody ペルソナファイルの本文
 * @param {{role:"user"|"customer", text:string}[]} args.history これまでの会話
 * @param {string} args.question    今回の質問
 * @param {"persona"|"zundamon"} args.style 現在の口調
 * @param {string} [args.news]      最近の業界ニュースの節（lib/news.mjs の newsBlock）
 * @returns {Promise<{choice:string, spoken:string, marketing_note:string[], style:string, stance:string, tookMs:number}>}
 */
export async function askCustomer({ rules, personaBody, history, question, style, news = "" }) {
  if (!STYLES.has(style)) throw new Error(`unknown style: ${style}`);
  const system = `${rules}\n\n---\n\n# ペルソナ\n\n${personaBody}`;
  const transcript = history
    .map((h) => `${h.role === "user" ? "質問者" : "あなた"}: ${h.text}`)
    .join("\n");
  const userMessage = [
    transcript ? `## これまでの会話\n${transcript}\n` : "",
    news, // 化粧品ニュース朝報から選んだ記事（無ければ空）。lib/news.mjs の newsBlock()
    `## 現在の口調\n${style}\n`,
    `## 今回の質問\n${question}\n`,
    "JSON オブジェクト 1 つだけで答えてください。",
  ].join("\n");

  const startedAt = Date.now();
  const raw = await runModel(system, userMessage, 4000);
  const parsed = parseAnswer(raw);
  return { ...parsed, tookMs: Date.now() - startedAt };
}

/**
 * 1 行の説明から、_schema.md の書式でペルソナの Markdown 下書きを作る。
 * @returns {Promise<string>} Markdown（保存はしない。画面で確認・編集してから保存する）
 */
export async function draftPersona({ description, schema }) {
  const system = [
    "あなたは顧客ペルソナを設計するマーケターです。",
    "以下の書式定義に従い、ペルソナ 1 体の Markdown ファイルの中身だけを出力してください。前後に説明やコードフェンスを付けないでください。",
    "- 依頼文に書かれたことはそのまま使う。書かれていない項目は依頼文と矛盾しない範囲で具体的に補い、補った値の末尾に「（仮）」を付ける",
    "- 属性だけで作らず、前提（3 要素）を具体的な生活の言葉で書く。前提が購買行動と口調につながるようにする",
    "- 作るのは集団（ターゲット）ではなく、実在しそうな 1 人。依頼文が「30〜40 代女性」「品質重視の層」のような集団なら、その中の 1 人に絞る",
    "  - 年齢は幅や年代でなく 1 つの数字（例: 38 歳）。住まい・仕事・家族は 1 つに決める",
    "  - 最近買ったもの・やめたものは、その人にしか起きていない具体的な出来事として書く（「保湿重視」のような傾向の言い換えにしない）",
    "  - 同じ集団の誰にでも当てはまる文（「忙しい」「品質を重視する」だけ）で終わらせず、なぜそうなのかをその人の事情で書く",
    "- 依頼文の「事実」（購買データ・インタビュー・レビュー・問い合わせなど）は最優先の材料。事実から書いた項目には（仮）を付けない。事実と矛盾する補完はしない",
    "- 事実が渡されたときは、末尾に「## 根拠」節を作り、どの事実から何を決めたかを箇条書きで短く残す（例: - 定期購入者インタビュー → 前提「迷わずに済むことに価値」）",
    "- 事実が無い項目は、選ばれた項目と矛盾しない範囲で補い、必ず（仮）を付ける。（仮）を省いて事実のように見せない",
    "- name は架空の日本人フルネーム。実在の個人名は使わない",
    "- slug は書式定義の命名規則（<領域>-<特徴>-<年代>、小文字英数字とハイフン）に従う",
    "",
    "# 書式定義",
    schema,
  ].join("\n");
  const raw = await runModel(system, `## 作りたいペルソナ\n${description}`, 8000);
  const start = raw.indexOf("---");
  if (start < 0) throw new Error("ペルソナの下書きを作れませんでした（書式が崩れています）");
  return raw.slice(start).replace(/\n?```\s*$/, "").trim();
}

function runModel(system, userMessage, maxTokens) {
  return LLM === "api" ? runApi(system, userMessage, maxTokens) : runCli(system, userMessage);
}

async function runApi(system, userMessage, maxTokens) {
  const res = await api.beta.messages.create({
    model: API_MODEL,
    max_tokens: maxTokens,
    output_config: { effort: API_EFFORT },
    // 安全側の判定で断られたときは、サーバ側で別モデルに回して答えを返す
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // 同じペルソナに 5 回聞くので、ルール + ペルソナ本文（system）をキャッシュする
    cache_control: { type: "ephemeral" },
    system,
    messages: [{ role: "user", content: userMessage }],
  });
  if (res.stop_reason === "refusal") throw new Error(`回答を断られました（${res.stop_details?.category ?? "理由不明"}）`);
  if (res.stop_reason === "max_tokens") throw new Error("回答が長すぎて途中で切れました");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!text.trim()) throw new Error(`回答が空でした（stop_reason: ${res.stop_reason}）`);
  return text;
}

function runCli(system, userMessage) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      CLAUDE_BIN,
      [
        "--print",
        "--model", MODEL,
        "--system-prompt", system,
        "--tools", "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        // user 設定の hooks（実況・Telegram 通知・学習抽出）を走らせない
        "--setting-sources", "local",
        "--no-session-persistence",
        "--output-format", "json",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`claude timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`));
        return;
      }
      try {
        const envelope = JSON.parse(out);
        if (envelope.is_error) throw new Error(String(envelope.result).slice(0, 300));
        resolve(String(envelope.result ?? ""));
      } catch (e) {
        reject(new Error(`claude output unreadable: ${e.message}`));
      }
    });
    proc.stdin.end(userMessage);
  });
}

/** モデル出力から JSON を取り出して検証する。欠けていれば例外（黙って既定値で埋めない）。 */
export function parseAnswer(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`no JSON in answer: ${text.slice(0, 200)}`);
  const obj = JSON.parse(text.slice(start, end + 1));
  const { choice, choice_key, spoken, marketing_note, style, stance } = obj;
  if (typeof choice !== "string" || !choice.trim()) throw new Error("answer.choice missing");
  if (typeof choice_key !== "string" || !choice_key.trim()) throw new Error("answer.choice_key missing");
  if (typeof spoken !== "string" || !spoken.trim()) throw new Error("answer.spoken missing");
  if (!Array.isArray(marketing_note) || marketing_note.some((n) => typeof n !== "string")) {
    throw new Error("answer.marketing_note must be string[]");
  }
  if (!STYLES.has(style)) throw new Error(`answer.style invalid: ${style}`);
  if (!STANCES.has(stance)) throw new Error(`answer.stance invalid: ${stance}`);
  return { choice: choice.trim(), choice_key: choice_key.trim(), spoken: spoken.trim(), marketing_note, style, stance };
}
