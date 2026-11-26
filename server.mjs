// 顧客ボイス — サーバ（この Mac のローカル版と、mb.instyle.group のチーム版を同じコードで動かす）
//   ローカル: CV_LLM=cli（claude CLI）+ VOICEVOX で読み上げ、認証なし
//   チーム版: CV_LLM=api（Claude API）・CV_VOICE=off（文字だけ）・CV_PASSWORD で入口に共通パスワード
//   GET  /api/personas  ペルソナ一覧（ブランド顧客 → 自分用 → 共有の順）
//   POST /api/personas/draft {description} → Markdown 下書き
//   POST /api/personas  {markdown, originalSlug?} → 自分用に保存
//   DELETE /api/personas/:slug → 自分用を _trash へ
//   POST /api/ask       {persona, question, history, style, samples} → 回答 JSON（samples 回の多数決）
//   POST /api/panel     {personas[], question, histories, style, samples, weights?} → 複数人の回答と分布
//   POST /api/speak     {text} → wav（VOICEVOX）
//   GET  /api/health    読み上げの可否（VOICEVOX の稼働確認）
//   GET  /api/healthz   死活確認（パスワード不要・デプロイの確認用）
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askCustomer, draftPersona, LLM } from "./lib/ask-claude.mjs";
import { listPersonas, findPersona, readSchema, savePersona, deletePersona, validatePersona, SHARED_DIR, OWN_DIR, BRAND_DIR } from "./lib/personas.mjs";
import { synthesize, engineVersion } from "./lib/voicevox.mjs";
import { newsItems, pickNews, newsBlock, NEWS_ENABLED } from "./lib/news.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CV_PORT || process.env.PORT || 4780);
// 公開パス（nginx の location と同じ。例 /ig-customer-voice）。ローカルは空
const BASE = (process.env.CV_BASE_PATH || "").replace(/\/+$/, "");
if (BASE && !/^\/[a-z][a-z0-9-]*$/.test(BASE)) throw new Error(`CV_BASE_PATH が不正です: ${BASE}`);
// 読み上げ。サーバに VOICEVOX は無いので off にして文字だけで使う
const VOICE = (process.env.CV_VOICE || "on") === "on";
if (!["on", "off"].includes(process.env.CV_VOICE || "on")) throw new Error("CV_VOICE は on か off");
// 共通パスワード（Basic 認証）。API で動かすとき（＝外から届く）は必須にする
const PASSWORD = process.env.CV_PASSWORD || "";
if (LLM === "api" && !PASSWORD) throw new Error("CV_LLM=api のときは CV_PASSWORD が要ります（公開のままにしない）");
const MAX_HISTORY = 12;

const STATIC = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["public/style.css", "text/css; charset=utf-8"],
};

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw Object.assign(new Error("body too large"), { status: 413 });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h) => h && (h.role === "user" || h.role === "customer") && typeof h.text === "string")
    .slice(-MAX_HISTORY)
    .map((h) => ({ role: h.role, text: h.text.slice(0, 1000) }));
}

// 追加画面の選択肢 → 下書き AI への依頼文。知らない値は既定値で埋めず 400 にする
const DOMAIN_LABEL = { cosme: "コスメ・スキンケア", food: "食品・飲食", fashion: "ファッション", recruit: "採用（就職・転職）" };
const GENDERS = new Set(["女性", "男性"]);
const PYRAMIDS = new Set(["未認知", "認知・未購買", "一般", "ロイヤル", "離反"]);
function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function buildBrief(description, fields = {}, facts) {
  if (fields === null || typeof fields !== "object") throw bad("fields が不正です");
  const lines = [];
  const { domain, gender, age, pyramid } = fields;
  if (domain !== undefined) {
    if (!Object.hasOwn(DOMAIN_LABEL, domain)) throw bad(`領域が不正です: ${domain}`);
    lines.push(`- 領域: ${DOMAIN_LABEL[domain]}（domains に ${domain} を入れる）`);
  }
  if (gender !== undefined) {
    if (!GENDERS.has(gender)) throw bad(`性別が不正です: ${gender}`);
    lines.push(`- 性別: ${gender}`);
  }
  if (age !== undefined) {
    if (!Number.isInteger(age) || age < 15 || age > 90) throw bad("年齢は 15〜90 の数字 1 つで入れてください");
    lines.push(`- 年齢: ${age} 歳`);
  }
  if (pyramid !== undefined) {
    if (!PYRAMIDS.has(pyramid)) throw bad(`段階が不正です: ${pyramid}`);
    lines.push(`- 段階（pyramid）: ${pyramid}`);
  }
  if (description !== undefined && typeof description !== "string") throw bad("ひとことが不正です");
  const memo = (description ?? "").trim().slice(0, 2000);
  if (memo) lines.push(`- ひとこと（作り手のメモ）: ${memo}`);
  if (facts !== undefined && typeof facts !== "string") throw bad("事実が不正です");
  const factText = (facts ?? "").trim().slice(0, 20000);
  if (factText) lines.push(`- 事実（購買データ・インタビュー・レビューなど。最優先で使い、ここから書いた項目には（仮）を付けない）:\n${factText}`);
  if (!lines.length) throw bad("どれか 1 つ選ぶか、ひとこと書いてください");
  lines.push("- 選ばれていない項目は、選ばれた項目と矛盾しない範囲で 1 人に決めて補い「（仮）」を付ける");
  return lines.join("\n");
}

const SAMPLES = new Set([1, 5]);
const PANEL_MIN = 2;
const PANEL_MAX = 8;
// claude の同時起動数の上限（パネル 8 人 × 5 回 = 40 本を一度に起こさない）
const CONCURRENCY = Number(process.env.CV_CONCURRENCY || 10);
let running = 0;
const waiting = [];
async function limited(fn) {
  if (running >= CONCURRENCY) await new Promise((r) => waiting.push(r)); // 空いた枠をそのまま受け取る
  else running++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/** 質問（と直前に聞いたこと）に近い朝報の記事。読めていないときは理由を返す（回答は止めない） */
async function relatedNews(question, history) {
  if (!NEWS_ENABLED) return { picked: [], status: { enabled: false } };
  const { items, error } = await newsItems();
  const lastAsked = history.filter((h) => h.role === "user").slice(-1).map((h) => h.text);
  const picked = pickNews(items, [question, ...lastAsked].join(" "));
  return { picked, status: { enabled: true, total: items.length, error } };
}
/** 回答で [市場: N3] と書いた記事だけを返す（画面でリンクにする） */
function citedNews(picked, answers) {
  const text = answers.flatMap((a) => a.marketing_note).join(" ");
  return picked.filter((n) => new RegExp(`\\[市場[:：][^\\]]*\\b${n.id}\\b`).test(text)).map(({ id, date, media, title, url }) => ({ id, date, media, title, url }));
}

function normStyle(style) {
  return style === "zundamon" ? "zundamon" : "persona";
}
function checkQuestion(question, samples) {
  if (typeof question !== "string" || !question.trim()) throw bad("question is empty");
  if (!SAMPLES.has(samples)) throw bad(`samples は ${[...SAMPLES].join(" / ")} のどれか`);
  return question.trim().slice(0, 1000);
}
/** 構成比（実際の顧客のうち何割がこの人に近いか）。全員分そろっていれば重み付き、無ければ全員同じ重み */
function checkWeights(weights, slugs) {
  const out = {};
  const given = weights && typeof weights === "object" ? slugs.filter((s) => Object.hasOwn(weights, s) && weights[s] !== null && weights[s] !== "") : [];
  if (given.length && given.length !== slugs.length) throw bad("構成比は全員分入れるか、全員空にしてください");
  for (const s of slugs) {
    const v = given.length ? Number(weights[s]) : 1;
    if (!Number.isFinite(v) || v < 0 || v > 100) throw bad(`構成比は 0〜100 の数字で入れてください（${s}）`);
    out[s] = v;
  }
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (sum <= 0) throw bad("構成比の合計が 0 です");
  for (const s of slugs) out[s] = out[s] / sum;
  Object.defineProperty(out, "__weighted", { value: given.length > 0, enumerable: false });
  return out;
}

/** 1 人に samples 回聞いて多数決。代表の回答 + 票の内訳を返す */
async function askMajority(target, args, samples) {
  const settled = await Promise.allSettled(
    Array.from({ length: samples }, () => limited(() => askCustomer({ ...args, personaBody: target.body })))
  );
  const ok = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const failed = settled.length - ok.length;
  if (!ok.length || ok.length < Math.ceil(samples / 2)) {
    throw new Error(`回答を ${samples} 回中 ${ok.length} 回しか作れませんでした: ${settled.find((r) => r.status === "rejected")?.reason?.message}`);
  }
  const vote = tally(ok);
  const answer = ok.find((a) => vote.canon(normKey(a.choice_key)) === vote.counts[0].key);
  return { ...answer, stance: stanceOf(ok), vote: { total: vote.total, counts: vote.counts, agreement: vote.agreement, failed } };
}

/** 気持ちの向きは選んだものとは別に多数決。同数なら悪いほうを取る（主力顧客の離反を見落とさないため） */
const STANCE_ORDER = ["negative", "conditional", "positive"];
function stanceOf(answers) {
  const n = Object.fromEntries(STANCE_ORDER.map((s) => [s, 0]));
  for (const a of answers) n[a.stance]++;
  return STANCE_ORDER.reduce((best, s) => (n[s] > n[best] ? s : best), STANCE_ORDER[0]);
}

/** パネル全体の集計。各人の多数決の答えを 1 票とし、人数と構成比の重み付き割合の両方を出す */
function panelSummary(results) {
  const keys = [...new Set(results.map((r) => normKey(r.choice_key)))].sort((x, y) => x.length - y.length);
  const canon = (k) => keys.find((c) => c && k.includes(c)) ?? k;
  const map = new Map();
  for (const r of results) {
    const key = canon(normKey(r.choice_key));
    const cur = map.get(key) ?? { key, label: r.choice_key, people: 0, share: 0, names: [] };
    cur.people++;
    cur.share += r.weight;
    cur.names.push(r.name);
    map.set(key, cur);
    r.panelKey = key;
  }
  const total = results.reduce((a, r) => a + r.weight, 0);
  const counts = [...map.values()].map((c) => ({ ...c, share: c.share / total })).sort((x, y) => y.share - x.share || y.people - x.people);
  return { people: results.length, counts };
}
/** 「プラセンタのほう」「プラセンタ」を同じ票にまとめる */
function normKey(key) {
  return key
    .replace(/[\s　。、「」]/g, "")
    .replace(/[\d,，]+円の?/g, "") // 「2,480円の共用ジェル」→「共用ジェル」
    .replace(/(のほう|の方|が入ってる方|が入っている方)$/, "");
}
function tally(answers) {
  const map = new Map();
  // 先に全キーを集め、一方が他方を含むときは短いほうにまとめる（表記ゆれで票が割れないように）
  const keys = [...new Set(answers.map((a) => normKey(a.choice_key)))].sort((x, y) => x.length - y.length);
  const canon = (k) => keys.find((c) => c && k.includes(c)) ?? k;
  for (const a of answers) {
    const key = canon(normKey(a.choice_key));
    const cur = map.get(key) ?? { key, label: a.choice_key, n: 0 };
    cur.n++;
    map.set(key, cur);
  }
  const counts = [...map.values()].sort((x, y) => y.n - x.n);
  const result = { total: answers.length, counts, agreement: counts[0].n / answers.length };
  Object.defineProperty(result, "canon", { value: canon }); // 返却 JSON には載せない
  return result;
}

/** Basic 認証。ユーザー名は何でもよく、パスワードだけを見る */
function authorized(req) {
  if (!PASSWORD) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
  const want = Buffer.from(PASSWORD);
  return given.length === want.length && timingSafeEqual(given, want);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (BASE) {
    if (url.pathname === BASE) {
      res.writeHead(301, { Location: `${BASE}/${url.search}` }); // 相対パスで読むので末尾の / をそろえる
      return res.end();
    }
    if (!url.pathname.startsWith(`${BASE}/`)) return send(res, 404, { error: "not found" });
    url.pathname = url.pathname.slice(BASE.length);
  }
  if (req.method === "GET" && url.pathname === "/api/healthz") return send(res, 200, { ok: true });
  if (!authorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="customer-voice", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow" });
    return res.end("パスワードが必要です");
  }
  try {
    if (req.method === "GET" && Object.hasOwn(STATIC, url.pathname)) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, await readFile(path.join(ROOT, file)), type);
    }
    if (req.method === "GET" && url.pathname === "/api/personas") {
      return send(res, 200, await listPersonas());
    }
    if (req.method === "POST" && url.pathname === "/api/personas/draft") {
      const { description, fields, facts } = await readJson(req);
      const brief = buildBrief(description, fields, facts);
      const markdown = await draftPersona({ description: brief, schema: await readSchema() });
      const v = validatePersona(markdown);
      return send(res, 200, { markdown, warning: v.error ?? null });
    }
    if (req.method === "POST" && url.pathname === "/api/personas") {
      const { markdown, originalSlug } = await readJson(req);
      const slug = await savePersona(markdown, typeof originalSlug === "string" ? originalSlug : null);
      console.log(`[persona] saved ${slug}`);
      return send(res, 200, { slug });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/personas/")) {
      const slug = decodeURIComponent(url.pathname.slice("/api/personas/".length));
      await deletePersona(slug);
      console.log(`[persona] trashed ${slug}`);
      return send(res, 200, { slug });
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      if (!VOICE) return send(res, 200, { voice: false, team: LLM === "api" });
      try {
        return send(res, 200, { voice: true, team: LLM === "api", voicevox: await engineVersion() });
      } catch (e) {
        return send(res, 503, { voicevox: null, error: e.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/ask") {
      const { persona, question, history, style, samples } = await readJson(req);
      const q = checkQuestion(question, samples);
      const target = await findPersona(persona);
      if (!target) return send(res, 400, { error: `unknown persona: ${persona}` });
      const rules = await readFile(path.join(ROOT, "prompt.md"), "utf8");
      const startedAt = Date.now();
      const hist = sanitizeHistory(history);
      const { picked, status } = await relatedNews(q, hist);
      const r = await askMajority(target, { rules, history: hist, question: q, style: normStyle(style), news: newsBlock(picked) }, samples);
      console.log(`[ask] ${persona} ${Date.now() - startedAt}ms ${r.vote.counts.map((c) => `${c.label}=${c.n}`).join(" ")} stance=${r.stance}`);
      return send(res, 200, { ...r, news: citedNews(picked, [r]), newsStatus: { ...status, picked: picked.length }, tookMs: Date.now() - startedAt });
    }
    if (req.method === "POST" && url.pathname === "/api/panel") {
      const { personas, question, histories, style, samples, weights } = await readJson(req);
      const q = checkQuestion(question, samples);
      if (!Array.isArray(personas) || personas.length < PANEL_MIN || personas.length > PANEL_MAX || new Set(personas).size !== personas.length) {
        return send(res, 400, { error: `パネルは ${PANEL_MIN}〜${PANEL_MAX} 人を重複なしで選んでください` });
      }
      const all = await listPersonas();
      const targets = personas.map((slug) => all.find((p) => p.slug === slug));
      const missing = personas.filter((_, i) => !targets[i]);
      if (missing.length) return send(res, 400, { error: `unknown persona: ${missing.join(", ")}` });
      const w = checkWeights(weights, personas);
      const rules = await readFile(path.join(ROOT, "prompt.md"), "utf8");
      const hist = histories && typeof histories === "object" ? histories : {};
      const startedAt = Date.now();
      const { picked, status } = await relatedNews(q, []); // 全員に同じ記事を渡す（人ごとに市場の前提を変えない）
      const news = newsBlock(picked);
      const settled = await Promise.allSettled(
        targets.map((t) =>
          askMajority(t, { rules, history: sanitizeHistory(Object.hasOwn(hist, t.slug) ? hist[t.slug] : []), question: q, style: normStyle(style), news }, samples)
        )
      );
      const results = [];
      const failures = [];
      settled.forEach((r, i) => {
        const t = targets[i];
        if (r.status === "fulfilled") {
          results.push({ slug: t.slug, name: t.name, who: t.who, source: t.source, items: t.items, tentative: t.tentative, group: t.group, brand: t.brand, segment: t.segment, critical: t.critical, weight: w[t.slug], ...r.value });
        } else failures.push({ slug: t.slug, name: t.name, error: r.reason?.message ?? String(r.reason) });
      });
      if (results.length < PANEL_MIN) throw new Error(`回答できたのが ${results.length} 人だけでした: ${failures.map((f) => `${f.name}（${f.error}）`).join(" / ")}`);
      const summary = panelSummary(results);
      console.log(`[panel] ${results.length}人 ${Date.now() - startedAt}ms ${summary.counts.map((c) => `${c.label}=${c.people}人/${Math.round(c.share * 100)}%`).join(" ")}`);
      return send(res, 200, { summary, results, failures, weighted: w.__weighted, news: citedNews(picked, results), newsStatus: { ...status, picked: picked.length }, tookMs: Date.now() - startedAt });
    }
    if (req.method === "POST" && url.pathname === "/api/speak") {
      if (!VOICE) return send(res, 404, { error: "このサーバでは読み上げを使いません" });
      const { text } = await readJson(req);
      const wav = await synthesize(String(text ?? "").slice(0, 400));
      return send(res, 200, wav, "audio/wav");
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(`[error] ${req.method} ${url.pathname}: ${e.message}`);
    return send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`顧客ボイス: http://localhost:${PORT}${BASE}/  (回答: ${LLM} / 読み上げ: ${VOICE ? "on" : "off"} / パスワード: ${PASSWORD ? "あり" : "なし"})\n  共有ペルソナ: ${SHARED_DIR}\n  自分用ペルソナ: ${OWN_DIR}${BRAND_DIR ? `\n  配布ペルソナ: ${BRAND_DIR}` : ""}`);
});
