// ペルソナの置き場所は 2 つ（チーム版は 3 つ）。
//   shared: customer-panel Skill 同梱（チーム配布）。この画面からは読むだけ
//   own:    ~/Workspace/_outputs/customer-panel/personas/（自分用・クライアント専用）。追加・編集・削除できる
//   brand:  チーム版だけ。sasaki の own にあるブランド顧客（group 付き）を scripts/sync-personas.sh で配ったもの。読むだけ
// group（例: メビウス製薬）が付いたペルソナは一覧の先頭にまとめ、order 順に並べる。
// critical: true は「主力顧客」= この人に嫌がられる企画・施策は売上の土台を削る、という印
// own は customer-panel を Workspace で使うときの「案件専用ペルソナ」の置き場と同じなので、
// ここで作ったペルソナは文章版の customer-panel からも使える。
import { readFile, readdir, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const HOME = homedir();
export const SHARED_DIR =
  process.env.CV_PERSONA_DIR || path.join(HOME, ".claude/skills/customer-panel/personas");
export const OWN_DIR =
  process.env.CV_OWN_PERSONA_DIR || path.join(HOME, "Workspace/_outputs/customer-panel/personas");
// チーム版のブランド顧客の置き場所（ローカルでは使わない。own が正本）
export const BRAND_DIR = process.env.CV_BRAND_PERSONA_DIR || "";
const TRASH_DIR = path.join(OWN_DIR, "_trash");
const SLUG_RE = /^[a-z][a-z0-9-]{1,60}$/;
const REQUIRED_SECTIONS = ["## 属性", "## 前提", "## 購買行動", "## 口調"];

function meta(body, slug, source) {
  const pick = (re) => body.match(re)?.[1]?.trim() ?? "";
  // ブランド顧客の設定は先頭の --- 内だけから読む（本文の文章に反応しないように）
  const fm = body.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const fmPick = (key) => fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  const order = Number(fmPick("order"));
  return {
    slug,
    source,
    name: pick(/^name:\s*(.+)$/m) || slug,
    who: pick(/性別 \/ 年齢:\s*(.+)$/m),
    job: pick(/仕事:\s*(.+)$/m),
    pyramid: pick(/^pyramid:\s*(.+)$/m),
    domains: (pick(/^domains:\s*\[(.*)\]/m) || "").split(",").map((d) => d.trim()).filter(Boolean),
    group: fmPick("group"),
    brand: fmPick("brand"),
    segment: fmPick("segment"),
    critical: fmPick("critical") === "true",
    order: Number.isInteger(order) && order > 0 ? order : 999,
    ...grounding(body),
    body,
  };
}

/** 属性・前提・購買行動の箇条書きのうち、AI が補った（仮）の数。データで確かめた割合の目安にする */
export function grounding(body) {
  let section = "";
  let items = 0;
  let tentative = 0;
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3).trim();
    else if (/^(属性|前提|購買行動)/.test(section) && /^-\s*\S+.*:\s*\S/.test(line)) {
      items++;
      if (line.includes("（仮）")) tentative++;
    }
  }
  return { items, tentative };
}

async function readDir(dir, source) {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort();
  return Promise.all(
    files.map(async (f) => meta(await readFile(path.join(dir, f), "utf8"), f.slice(0, -3), source))
  );
}

/** 毎回ファイルを読む（他で編集されても即反映） */
export async function listPersonas() {
  const all = [
    ...(await readDir(OWN_DIR, "own")),
    ...(BRAND_DIR ? await readDir(BRAND_DIR, "brand") : []),
    ...(await readDir(SHARED_DIR, "shared")),
  ];
  // group 付き（ブランド顧客）を先頭に group → order 順。それ以外は元の順（自分用 → 共有）
  const rank = (p) => (p.group ? 0 : 1);
  return all
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || (a.p.group && b.p.group ? a.p.group.localeCompare(b.p.group) || a.p.order - b.p.order : 0) || a.i - b.i)
    .map(({ p }) => p);
}

export async function findPersona(slug) {
  return (await listPersonas()).find((p) => p.slug === slug) ?? null;
}

export async function readSchema() {
  return readFile(path.join(SHARED_DIR, "_schema.md"), "utf8");
}

/** 書式チェック。問題があれば日本語の理由を返す（黙って直さない） */
export function validatePersona(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return { error: "中身が空です" };
  const fm = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { error: "先頭の --- で囲んだ設定（slug / name など）がありません" };
  const slug = fm[1].match(/^slug:\s*(.+)$/m)?.[1]?.trim();
  if (!slug || !SLUG_RE.test(slug)) return { error: `slug は小文字英数字とハイフンで書いてください（いま: ${slug ?? "なし"}）` };
  if (!/^name:\s*\S/m.test(fm[1])) return { error: "name がありません" };
  // ブランド顧客の設定（任意）。書いてあるなら値が正しいこと
  const critical = fm[1].match(/^critical:\s*(.*)$/m)?.[1]?.trim();
  if (critical !== undefined && !["true", "false"].includes(critical)) return { error: `critical は true か false で書いてください（いま: ${critical}）` };
  const order = fm[1].match(/^order:\s*(.*)$/m)?.[1]?.trim();
  if (order !== undefined && !/^[1-9]\d{0,2}$/.test(order)) return { error: `order は 1 以上の数字で書いてください（いま: ${order}）` };
  if (/^(brand|segment|critical|order):/m.test(fm[1]) && !/^group:\s*\S/m.test(fm[1])) return { error: "brand / segment / critical / order を使うときは group（例: メビウス製薬）も書いてください" };
  const missing = REQUIRED_SECTIONS.filter((s) => !markdown.includes(s));
  if (missing.length) return { error: `見出しが足りません: ${missing.join(" / ")}` };
  // ペルソナは「集団（ターゲット）」ではなく「1 人」。年齢は幅や年代でなく 1 つの数字にする
  const age = markdown.match(/^-\s*性別\s*\/\s*年齢:(.*)$/m)?.[1] ?? "";
  if (!/\d+\s*歳/.test(age) || /[〜~～－-]|代/.test(age)) {
    return { error: `年齢は「42 歳」のように 1 人分の数字で書いてください（いま: ${age.trim() || "なし"}）。「30〜40 代」のような幅は集団（ターゲット）になります` };
  }
  return { slug };
}

/** 追加（originalSlug なし）または自分用ペルソナの上書き（originalSlug あり） */
export async function savePersona(markdown, originalSlug = null) {
  const v = validatePersona(markdown);
  if (v.error) throw Object.assign(new Error(v.error), { status: 400 });
  const all = await listPersonas();
  if (originalSlug) {
    const cur = all.find((p) => p.slug === originalSlug);
    if (!cur || cur.source !== "own") throw Object.assign(new Error("共有・配布のペルソナはここでは編集できません"), { status: 403 });
  }
  const clash = all.find((p) => p.slug === v.slug && p.slug !== originalSlug);
  if (clash) throw Object.assign(new Error(`slug「${v.slug}」はもう使われています`), { status: 409 });
  await mkdir(OWN_DIR, { recursive: true });
  await writeFile(path.join(OWN_DIR, `${v.slug}.md`), markdown.trimEnd() + "\n", "utf8");
  if (originalSlug && originalSlug !== v.slug) {
    await moveToTrash(originalSlug); // slug を変えた編集は旧ファイルを _trash へ
  }
  return v.slug;
}

/** 削除は完全には消さず _trash/ に移す（戻せるように） */
export async function deletePersona(slug) {
  const cur = await findPersona(slug);
  if (!cur) throw Object.assign(new Error("見つかりません"), { status: 404 });
  if (cur.source !== "own") throw Object.assign(new Error("共有・配布のペルソナはここでは削除できません"), { status: 403 });
  await moveToTrash(slug);
}

async function moveToTrash(slug) {
  await mkdir(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await rename(path.join(OWN_DIR, `${slug}.md`), path.join(TRASH_DIR, `${slug}__${stamp}.md`));
}
