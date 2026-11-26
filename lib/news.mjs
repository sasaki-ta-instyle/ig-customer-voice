// 化粧品ニュース朝報（mb-cosme-news がシロコ名義で平日朝に Slack へ流しているダイジェスト）を、
// 回答の「市場の根拠」として読む。
//   正本: GitHub sasaki-ta-instyle/mb-cosme-news の state/trends/YYYY-MM.md（配信のたびに追記される・public）
//   1 記事 = 「### [媒体] タイトル」+ URL / angle / published / summary / whyForMebius
// 質問に近い記事だけを数件選んで渡す（全部渡すと長すぎ、関係の薄い記事に引っ張られるため）。
// 取れないときは回答を止めず、画面に「朝報を読めていない」と出す（黙って根拠なしにしない）。

const BASE_URL = process.env.CV_NEWS_URL || "https://raw.githubusercontent.com/sasaki-ta-instyle/mb-cosme-news/main/state/trends";
export const NEWS_ENABLED = (process.env.CV_NEWS || "on") === "on";
if (!["on", "off"].includes(process.env.CV_NEWS || "on")) throw new Error("CV_NEWS は on か off");
const MONTHS = 3; // 今月を含めて 3 か月分（約 90 日）
const TTL_MS = 60 * 60 * 1000; // 朝に 1 回増えるだけなので 1 時間ごとに読み直せば足りる
const PICK = 6;

// 一般の人が目にしうる媒体（顧客役が「見たことがある」と言ってよいのはここだけ）。業界紙は作り手側の情報
const CONSUMER_MEDIA = new Set(["美的", "VOCE", "@cosme", "FASHIONSNAP", "PR TIMES"]);

let cache = { at: 0, items: [], error: null, months: [] };
let loading = null;

function monthKeys(now = new Date()) {
  const keys = [];
  for (let i = 0; i < MONTHS; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return keys;
}

/** trends/YYYY-MM.md → 記事の配列 */
export function parseTrends(markdown) {
  const items = [];
  let date = "";
  let cur = null;
  const push = () => cur && cur.url && items.push(cur);
  for (const line of markdown.split("\n")) {
    const d = line.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (d) {
      push();
      cur = null;
      date = d[1];
      continue;
    }
    const h = line.match(/^### \[([^\]]+)\]\s*(.+)$/);
    if (h) {
      push();
      cur = { date, media: h[1].trim(), title: h[2].trim(), url: "", angle: "", summary: "", why: "" };
      continue;
    }
    if (!cur) continue;
    const f = line.match(/^- (URL|angle|summary|whyForMebius):\s*(.*)$/);
    if (!f) continue;
    const [, key, value] = f;
    if (key === "URL") cur.url = /^https?:\/\//.test(value.trim()) ? value.trim() : "";
    else if (key === "whyForMebius") cur.why = value.trim();
    else cur[key] = value.trim();
  }
  push();
  return items;
}

async function load() {
  const months = monthKeys();
  const settled = await Promise.allSettled(
    months.map(async (m) => {
      const res = await fetch(`${BASE_URL}/${m}.md`, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) return []; // まだ配信の無い月
      if (!res.ok) throw new Error(`${m}: HTTP ${res.status}`);
      return parseTrends(await res.text());
    })
  );
  const failed = settled.filter((r) => r.status === "rejected").map((r) => r.reason?.message ?? String(r.reason));
  const items = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (failed.length === months.length) throw new Error(failed.join(" / "));
  if (failed.length) console.warn(`[news] 一部の月を読めませんでした: ${failed.join(" / ")}`);
  // 同じ URL は新しい日付を残す。新しい順
  const byUrl = new Map();
  for (const it of items) if (!byUrl.has(it.url) || byUrl.get(it.url).date < it.date) byUrl.set(it.url, it);
  return [...byUrl.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** 最新の記事一覧（1 時間キャッシュ）。取れなければ前回分を使い、error に理由を残す */
export async function newsItems() {
  if (!NEWS_ENABLED) return { items: [], error: null, at: 0 };
  if (Date.now() - cache.at < TTL_MS) return cache;
  loading ??= load()
    .then((items) => {
      cache = { at: Date.now(), items, error: null };
      console.log(`[news] 朝報 ${items.length} 件（${items[items.length - 1]?.date ?? "-"}〜${items[0]?.date ?? "-"}）`);
    })
    .catch((e) => {
      // 失敗しても 10 分は再取得しない（毎回の質問を待たせない）。前回の記事があればそれを使う
      cache = { ...cache, at: Date.now() - TTL_MS + 10 * 60 * 1000, error: e.message };
      console.warn(`[news] 朝報を読めませんでした: ${e.message}`);
    })
    .finally(() => (loading = null));
  await loading;
  return cache;
}

// ---------- 質問に近い記事を選ぶ ----------
// 日本語は単語に区切らず、文字の 2 字ずつ（バイグラム）で重なりを見る。どの記事にも出る 2 字（「化粧」など）は効かないよう重みを下げる
// （意味検索ほど賢くないので、最後に「関係があるときだけ使う」を回答 AI に任せる）
function grams(text) {
  const out = new Set();
  const clean = text.toLowerCase().replace(/[\s\p{P}\p{S}0-9０-９]+/gu, " ");
  for (const word of clean.split(" ")) {
    if (word.length === 1) continue;
    for (let i = 0; i < word.length - 1; i++) {
      const g = word.slice(i, i + 2);
      if (!/^[\p{Script=Hiragana}ー]+$/u.test(g)) out.add(g); // ひらがなだけの 2 字（「どっち」「たら」）は内容を表さないので使わない
    }
  }
  return out;
}

/**
 * @param {string} query 質問（と直前の会話）
 * @returns {{id:string, date:string, media:string, title:string, url:string, summary:string, why:string, consumer:boolean}[]}
 */
export function pickNews(items, query, limit = PICK) {
  const q = grams(query);
  if (!q.size || !items.length) return [];
  const docs = items.map((it) => ({ it, g: grams(`${it.title} ${it.summary} ${it.why}`) }));
  const df = new Map();
  for (const { g } of docs) for (const x of g) df.set(x, (df.get(x) ?? 0) + 1);
  const n = docs.length;
  const scored = docs
    .map(({ it, g }) => {
      let score = 0;
      for (const x of q) if (g.has(x)) score += Math.log(1 + n / df.get(x));
      return { it, score };
    })
    .filter((s) => s.score >= 6) // 2 字が 1〜2 個かぶっただけの記事は外す
    .sort((a, b) => b.score - a.score || b.it.date.localeCompare(a.it.date))
    .slice(0, limit);
  return scored.map(({ it }, i) => ({ id: `N${i + 1}`, ...it, consumer: CONSUMER_MEDIA.has(it.media) }));
}

/** 回答 AI に渡す節 */
export function newsBlock(picked) {
  if (!picked.length) return "";
  const lines = picked.map(
    (n) => `- ${n.id}｜${n.date}｜${n.media}${n.consumer ? "（一般向け媒体）" : "（業界向け媒体）"}｜${n.title}\n  要旨: ${n.summary}${n.why ? `\n  メビウスから見た点: ${n.why}` : ""}`
  );
  return `## 最近の業界ニュース（化粧品ニュース朝報から、今回の質問に近いもの）\n${lines.join("\n")}\n`;
}
