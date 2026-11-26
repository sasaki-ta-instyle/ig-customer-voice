// 顧客ボイス — 画面側
const $ = (sel) => document.querySelector(sel);
const state = {
  personas: [],
  persona: null,
  style: "persona",
  history: [], // {role: "user"|"customer", text}
  mode: "single", // "single" | "panel"
  panel: new Set(), // パネルで聞く人の slug
  panelHistory: {}, // slug → 会話（パネルでも人ごとに前の質問を踏まえる）
  weights: loadWeights(), // slug → 構成比（%）
  busy: false,
  audio: null,
};

function loadWeights() {
  try {
    return JSON.parse(localStorage.getItem("cv-weights") || "{}") || {};
  } catch {
    return {};
  }
}
function saveWeights() {
  try {
    localStorage.setItem("cv-weights", JSON.stringify(state.weights));
  } catch {}
}

// BudouX（読み込めなければ素のテキストで表示する）
let budoux = null;
import("https://esm.sh/budoux@0.7.0")
  .then((m) => (budoux = m.loadDefaultJapaneseParser()))
  .catch(() => {});

/** テキストを BudouX の区切りで <wbr> 入りの子要素として入れる（innerHTML は使わない） */
function setText(el, text) {
  el.textContent = "";
  const chunks = budoux ? budoux.parse(text) : [text];
  chunks.forEach((c, i) => {
    if (i) el.appendChild(document.createElement("wbr"));
    el.appendChild(document.createTextNode(c));
  });
  return el;
}

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) setText(el, text);
  return el;
}

// ---------- ペルソナ ----------
function iconButton(icon, label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-btn";
  b.title = label;
  b.setAttribute("aria-label", label);
  const i = document.createElement("i");
  i.className = `ph ${icon}`;
  b.appendChild(i);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

async function loadPersonas(keepSlug = state.persona) {
  const res = await fetch("api/personas");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  state.personas = await res.json();
  const box = $("#personas");
  box.textContent = "";
  let lastGroup = null;
  for (const p of state.personas) {
    // 見出し: ブランド顧客は group 名（例: メビウス製薬）、それ以外は置き場所
    const group = p.group || (p.source === "shared" ? "共有（設計ペルソナ）" : state.team ? "チーム作成" : "自分用");
    if (group !== lastGroup) {
      const head = h("div", "p-group", group);
      head.setAttribute("role", "presentation");
      box.appendChild(head);
      lastGroup = group;
    }
    const item = h("div", "persona");
    item.tabIndex = 0;
    const check = document.createElement("i");
    check.className = "ph p-check";
    item.appendChild(check);
    item.setAttribute("role", "radio");
    item.dataset.slug = p.slug;
    const text = h("div", "p-text");
    const name = h("span", "p-name", p.name);
    if (p.critical) name.appendChild(h("span", "p-badge", "主力"));
    text.append(name);
    if (p.brand || p.segment) text.appendChild(h("span", "p-seg", [p.brand, p.segment].filter(Boolean).join("・")));
    text.append(h("span", "p-meta", p.who), h("span", "p-meta", p.job));
    if (p.source === "own" && p.items) text.appendChild(h("span", "p-ground", groundLabel(p)));
    const weight = h("label", "p-weight");
    const wi = document.createElement("input");
    wi.type = "number";
    wi.min = "0";
    wi.max = "100";
    wi.inputMode = "numeric";
    wi.value = state.weights[p.slug] ?? "";
    wi.setAttribute("aria-label", `${p.name} の構成比`);
    wi.addEventListener("click", (e) => e.stopPropagation());
    wi.addEventListener("keydown", (e) => e.stopPropagation());
    wi.addEventListener("input", () => {
      if (wi.value === "") delete state.weights[p.slug];
      else state.weights[p.slug] = Number(wi.value);
      saveWeights();
    });
    weight.append(document.createTextNode("構成比"), wi, document.createTextNode("%"));
    text.appendChild(weight);
    item.appendChild(text);
    if (p.source === "own") {
      const actions = h("div", "p-actions");
      actions.append(
        iconButton("ph-pencil-simple", "編集", () => openEditor(p)),
        iconButton("ph-trash", "削除", () => removePersona(p))
      );
      item.appendChild(actions);
    }
    const choose = () => (state.mode === "panel" ? togglePanel(p.slug) : selectPersona(p.slug));
    item.addEventListener("click", choose);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose();
      }
    });
    item.addEventListener("mouseenter", () => showProfile(p, item));
    item.addEventListener("focus", () => showProfile(p, item));
    item.addEventListener("mouseleave", hideProfile);
    item.addEventListener("blur", hideProfile);
    box.appendChild(item);
  }
  // 選んでいたペルソナが残っていれば会話ごと維持、消えていれば会話をリセットして先頭を選ぶ
  const kept = state.personas.find((p) => p.slug === keepSlug);
  if (!kept) {
    resetLog();
    state.persona = null;
  }
  const target = kept ?? state.personas[0];
  if (target) selectPersona(target.slug);
  // 消えたペルソナはパネルからも外す
  const alive = new Set(state.personas.map((p) => p.slug));
  state.panel.forEach((s) => !alive.has(s) && state.panel.delete(s));
  renderPanelState();
}

// ---------- 聞き方（1 人 / パネル） ----------
const PANEL_MAX = 8;
function setMode(mode) {
  if (state.busy || mode === state.mode) return;
  state.mode = mode;
  document.querySelectorAll('.segmented[data-group="mode"] button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });
  if (mode === "panel" && !state.panel.size) {
    // 最初は、いま選んでいる人と同じグループ（例: メビウス製薬の顧客）、グループが無ければ同じ領域の人をまとめて入れる
    const cur = currentPersona();
    const domain = cur?.domains?.[0];
    const same = cur?.group ? (p) => p.group === cur.group : (p) => !domain || p.domains.includes(domain);
    state.panel = new Set(state.personas.filter(same).slice(0, PANEL_MAX).map((p) => p.slug));
    if (cur) state.panel.add(cur.slug);
  }
  resetLog();
  renderPanelState();
}
document.querySelectorAll('.segmented[data-group="mode"] button').forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

function togglePanel(slug) {
  if (state.busy) return;
  if (state.panel.has(slug)) state.panel.delete(slug);
  else if (state.panel.size >= PANEL_MAX) return ($("#mic-note").textContent = `パネルは ${PANEL_MAX} 人までです`);
  else state.panel.add(slug);
  delete state.panelHistory[slug];
  renderPanelState();
}

function renderPanelState() {
  const panel = state.mode === "panel";
  $("#panel-note").hidden = !panel;
  $("#panel-count").textContent = `${state.panel.size} 人`;
  document.querySelectorAll(".persona").forEach((el) => {
    const picked = panel && state.panel.has(el.dataset.slug);
    el.classList.toggle("is-picked", picked);
    el.classList.toggle("is-active", panel ? picked : el.dataset.slug === state.persona);
    el.setAttribute("aria-checked", String(panel ? picked : el.dataset.slug === state.persona));
    el.querySelector(".p-check").className = `ph p-check ${panel ? (picked ? "ph-check-square" : "ph-square") : ""}`;
    el.querySelector(".p-check").hidden = !panel;
    el.querySelector(".p-weight").hidden = !picked;
  });
}

/** 「仮 9 / 14 項目」— AI が補っただけでデータの裏付けがない項目の数 */
function groundLabel(p) {
  return p.tentative ? `仮 ${p.tentative} / ${p.items} 項目` : `全 ${p.items} 項目が事実ベース`;
}

// ---------- プロフィール（ホバーで全文・追加画面のプレビュー） ----------
/** ペルソナ本文を見出し・箇条書きに組み立てて container に入れる。「（仮）」の行は is-tentative を付ける */
function renderProfile(container, { name, who, pyramid, body, source = "own" }) {
  container.textContent = "";
  // 共有ペルソナは設計上の人物像で（仮）を付けていないため、事実ベースとは表示しない
  const g = source === "own" ? countTentative(body) : { items: 0 };
  container.append(
    h("h3", null, name || "（名前なし）"),
    h("p", "pp-sub", [who, pyramid && `段階：${pyramid}`, g.items ? groundLabel(g) : source === "shared" && "共有の設計ペルソナ（データの裏付けなし）"].filter(Boolean).join(" ／ "))
  );
  let ul = null;
  for (const raw of body.replace(/^---[\s\S]*?\n---\n?/, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let el;
    if (line.startsWith("## ")) {
      ul = null;
      el = container.appendChild(h("h4", null, line.slice(3)));
    } else if (line.startsWith("- ")) {
      if (!ul) ul = container.appendChild(document.createElement("ul"));
      el = ul.appendChild(h("li", null, line.slice(2)));
    } else {
      ul = null;
      el = container.appendChild(h("p", null, line));
    }
    if (line.includes("（仮）")) el.classList.add("is-tentative");
  }
}

/** lib/personas.mjs の grounding() と同じ数え方（プレビューで保存前に見せるため） */
function countTentative(body) {
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

/** Markdown から name / 性別・年齢 / 段階 を拾う（プレビュー用。保存時の検査はサーバ側） */
function summarize(markdown) {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  return {
    name: fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "",
    pyramid: fm.match(/^pyramid:\s*(.+)$/m)?.[1]?.trim() ?? "",
    who: markdown.match(/^-\s*性別\s*\/\s*年齢:\s*(.+)$/m)?.[1]?.trim() ?? "",
    body: markdown,
  };
}

function showProfile(p, anchor) {
  const pop = $("#profile-pop");
  renderProfile(pop, p);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const top = Math.min(Math.max(16, r.top), window.innerHeight - pop.offsetHeight - 16);
  const sideRight = anchor.closest(".side")?.getBoundingClientRect().right ?? r.right;
  pop.style.left = `${sideRight + 12}px`;
  pop.style.top = `${Math.max(16, top)}px`;
}
function hideProfile() {
  $("#profile-pop").hidden = true;
}

// ---------- ペルソナの追加・編集・削除 ----------
// 追加は「選ぶ → 作る → プレビューを見て保存して話す」。Markdown は開かなくても保存できる
let editing = null; // 編集中の slug（追加なら null）

function editorMsg(text, kind = "") {
  const m = $("#editor-msg");
  m.textContent = text;
  m.className = `editor-msg ${kind}`;
}

function setChip(group, value) {
  group.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.v === value;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });
  group.dataset.value = value ?? "";
}
document.querySelectorAll(".chips").forEach((group) => {
  group.querySelectorAll("button").forEach((b) => {
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => setChip(group, group.dataset.value === b.dataset.v ? null : b.dataset.v)); // もう一度押すと外す
  });
});

function quickFields() {
  const v = (f) => document.querySelector(`.chips[data-field="${f}"]`).dataset.value || undefined;
  const age = $("#q-age").value.trim();
  return { domain: v("domain"), gender: v("gender"), pyramid: v("pyramid"), age: age ? Number(age) : undefined };
}

function updatePreview() {
  const md = $("#persona-md").value;
  const pv = $("#preview");
  pv.hidden = !md.trim();
  if (md.trim()) renderProfile(pv, summarize(md));
  $("#editor-save").hidden = !md.trim();
}
$("#persona-md").addEventListener("input", updatePreview);

function openEditor(p = null) {
  hideProfile();
  editing = p ? p.slug : null;
  $("#editor-eyebrow").textContent = p ? "ペルソナを編集" : "ペルソナを追加";
  $("#editor-title").textContent = p ? p.name : "どんな人ですか？";
  $("#quick-area").hidden = !!p;
  $("#draft-btn").hidden = !!p;
  $("#draft-btn").lastChild.textContent = "作る";
  $("#editor-save").lastChild.textContent = p ? "保存" : "保存して話す";
  document.querySelectorAll(".chips").forEach((g) => setChip(g, null));
  $("#q-age").value = "";
  $("#draft-input").value = "";
  $("#facts-input").value = "";
  $("#persona-md").value = p ? p.body : "";
  $("#md-details").open = !!p;
  updatePreview();
  $("#editor-save").firstElementChild.className = `ph ${p ? "ph-floppy-disk" : "ph-chat-circle-text"}`;
  editorMsg("");
  $("#editor").showModal();
  $(".editor-inner").scrollTop = 0;
}

$("#add-persona").addEventListener("click", () => openEditor());
$("#editor-cancel").addEventListener("click", () => {
  dictation?.stop();
  $("#editor").close();
});

$("#draft-btn").addEventListener("click", async () => {
  const fields = quickFields();
  const description = $("#draft-input").value.trim();
  if (!description && !$("#facts-input").value.trim() && !Object.values(fields).some((x) => x !== undefined)) return editorMsg("どれか 1 つ選ぶか、ひとこと書いてください", "ng");
  if (fields.age !== undefined && !(Number.isInteger(fields.age) && fields.age >= 15 && fields.age <= 90)) return editorMsg("年齢は 15〜90 の数字 1 つで入れてください", "ng");
  const btn = $("#draft-btn");
  btn.disabled = true;
  $("#editor-save").disabled = true;
  editorMsg("作っています…（15〜20 秒）");
  try {
    const res = await fetch("api/personas/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, fields, facts: $("#facts-input").value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    $("#persona-md").value = body.markdown;
    updatePreview();
    $("#preview").scrollIntoView({ block: "start", behavior: "smooth" });
    btn.lastChild.textContent = "作り直す";
    editorMsg(
      body.warning ? `下書きに不足があります：${body.warning}（「Markdown で直す」で直せます）` : "できました。薄い色の行は AI が補った「（仮）」です。気になれば作り直すか、Markdown で直してください。",
      body.warning ? "ng" : "ok"
    );
  } catch (e) {
    editorMsg(`作れませんでした：${e.message}`, "ng");
  } finally {
    btn.disabled = false;
    $("#editor-save").disabled = false;
  }
});

$("#editor-save").addEventListener("click", async () => {
  try {
    const res = await fetch("api/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: $("#persona-md").value, originalSlug: editing }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    $("#editor").close();
    await loadPersonas(body.slug);
    if (state.mode === "panel" && state.panel.size < PANEL_MAX) state.panel.add(body.slug); // パネル中に作った人はそのまま入れる
    selectPersona(body.slug);
    $("#question").focus();
  } catch (e) {
    editorMsg(`保存できませんでした：${e.message}`, "ng");
  }
});

// 「ひとこと」を声で入れる（送信はしない）
let dictation = null;
(function setupDictation() {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("#draft-mic");
  if (!Rec) return (btn.hidden = true);
  let on = false;
  btn.addEventListener("click", () => {
    if (on) return dictation.stop();
    const input = $("#draft-input");
    const base = input.value ? input.value.replace(/\s*$/, "") + " " : "";
    dictation = new Rec();
    dictation.lang = "ja-JP";
    dictation.interimResults = true;
    dictation.onstart = () => {
      on = true;
      btn.classList.add("is-listening");
    };
    dictation.onresult = (e) => {
      input.value = base + Array.from(e.results, (r) => r[0].transcript).join("");
    };
    dictation.onerror = (e) => editorMsg(`音声入力エラー：${e.error}`, "ng");
    dictation.onend = () => {
      on = false;
      btn.classList.remove("is-listening");
    };
    dictation.start();
  });
})();

async function removePersona(p) {
  if (state.busy) return;
  if (!confirm(`「${p.name}」を削除しますか？\n（ファイルは _trash/ に移すので、あとで戻せます）`)) return;
  const res = await fetch(`api/personas/${encodeURIComponent(p.slug)}`, { method: "DELETE" });
  const body = await res.json();
  if (!res.ok) return alert(`削除できませんでした：${body.error}`);
  hideProfile();
  await loadPersonas(state.persona === p.slug ? null : state.persona);
}

function selectPersona(slug) {
  if (state.busy) return;
  if (state.persona && state.persona !== slug) resetLog();
  state.persona = slug;
  renderPanelState();
}

function currentPersona() {
  return state.personas.find((p) => p.slug === state.persona);
}

// ---------- 口調 ----------
function setStyle(style) {
  state.style = style;
  document.querySelectorAll('.segmented[data-group="style"] button').forEach((b) => {
    const on = b.dataset.style === style;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });
}
document.querySelectorAll('.segmented[data-group="style"] button').forEach((b) => b.addEventListener("click", () => setStyle(b.dataset.style)));

// ---------- 会話 ----------
function resetLog() {
  state.history = [];
  state.panelHistory = {};
  const log = $("#log");
  log.textContent = "";
  const empty = h("div", "empty");
  const icon = document.createElement("i");
  icon.className = "ph ph-microphone";
  empty.append(icon, h("p", null, "マイクを押して話しかけてください。"), h("p", "hint", "例：「ヒアルロン酸とプラセンタ、どっちが入ってたら買う？」"));
  log.appendChild(empty);
}
$("#reset").addEventListener("click", () => !state.busy && resetLog());

function append(el) {
  const log = $("#log");
  log.querySelector(".empty")?.remove();
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

/** 根拠タグを札にする。[市場: N3] は朝報の記事へのリンクにする（news = 回答で使われた記事） */
function renderNote(text, news = []) {
  const li = document.createElement("li");
  const re = /\[(前提|属性|行動|段階|市場)(（仮）)?[:：][^\]]*\]/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) li.appendChild(setText(document.createElement("span"), text.slice(last, m.index)));
    const item = m[1] === "市場" ? news.find((n) => new RegExp(`\\b${n.id}\\b`).test(m[0])) : null;
    if (item) {
      const a = h("a", "tag is-news", `朝報 ${item.date.slice(5).replace("-", "/")} ${item.media}`);
      a.href = item.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.title = item.title;
      li.appendChild(a);
    } else li.appendChild(h("span", m[2] ? "tag is-tentative" : "tag", m[0].slice(1, -1)));
    last = m.index + m[0].length;
  }
  if (last < text.length) li.appendChild(setText(document.createElement("span"), text.slice(last)));
  return li;
}

function renderAnswer(ans) {
  const p = currentPersona();
  const card = h("article", "msg-customer");
  const head = h("div", "msg-head");
  head.appendChild(h("span", "who", `${p?.name ?? ""}（${ans.style === "zundamon" ? "ずんだもん口調" : "ペルソナの口調"}・${(ans.tookMs / 1000).toFixed(1)} 秒）`));
  const replay = h("button", "btn btn-secondary replay");
  replay.type = "button";
  const ri = document.createElement("i");
  ri.className = "ph ph-speaker-high";
  replay.append(ri, document.createTextNode("もう一度聞く"));
  replay.addEventListener("click", () => speak(ans.spoken));
  head.appendChild(replay);
  card.append(head, h("p", "choice", ans.choice), stanceChip(ans.stance));
  const flag = criticalFlag(p ? [{ ...p, stance: ans.stance }] : []);
  if (flag) card.appendChild(flag);
  if (ans.vote && ans.vote.total > 1) card.appendChild(renderVote(ans.vote));
  card.appendChild(h("p", "spoken", ans.spoken));
  if (ans.marketing_note.length) {
    const note = h("div", "note");
    note.appendChild(h("p", "eyebrow", "マーケ目線の理由"));
    const ul = document.createElement("ul");
    ans.marketing_note.forEach((n) => ul.appendChild(renderNote(n, ans.news)));
    note.appendChild(ul);
    card.appendChild(note);
  }
  const src = renderNewsSources(ans);
  if (src) card.appendChild(src);
  append(card);
}

// ---------- 化粧品ニュース朝報（市場の根拠） ----------
/** 回答が根拠に使った朝報の記事一覧。読めなかったときはその旨を出す（根拠なしで答えたことを隠さない） */
function renderNewsSources(body) {
  const st = body.newsStatus;
  if (!st?.enabled) return null;
  const box = h("div", "news-src");
  if (st.error && !st.total) {
    box.appendChild(h("p", "r-flag", `化粧品ニュース朝報を読めなかったため、業界の動きは踏まえていません（${st.error}）`));
    return box;
  }
  if (!body.news?.length) {
    box.appendChild(h("p", "news-none", st.picked ? `化粧品ニュース朝報から近い記事を ${st.picked} 件渡しましたが、根拠には使われませんでした` : "化粧品ニュース朝報に、この質問に近い記事はありませんでした"));
    return box;
  }
  box.appendChild(h("p", "eyebrow", "根拠にした化粧品ニュース朝報"));
  const ul = document.createElement("ul");
  for (const n of body.news) {
    const li = document.createElement("li");
    const a = h("a", null, n.title);
    a.href = n.url;
    a.target = "_blank";
    a.rel = "noopener";
    li.append(h("span", "news-meta", `${n.date} ${n.media}`), a);
    ul.appendChild(li);
  }
  box.appendChild(ul);
  return box;
}

// ---------- 気持ちの向き・主力顧客 ----------
const STANCE_LABEL = { positive: "前向き", conditional: "条件しだい", negative: "後ろ向き" };
function stanceChip(stance) {
  return h("span", `stance is-${stance}`, STANCE_LABEL[stance] ?? stance);
}
function segLabel(p) {
  return [p.brand, p.segment].filter(Boolean).join("・") || p.name;
}
/**
 * 主力顧客（critical）の反応から、企画・施策がクリティカルかを出す。
 * 1 人でも後ろ向きならクリティカル、条件しだいなら要注意、全員前向きなら OK。主力顧客がいなければ何も出さない
 */
function criticalFlag(people) {
  const core = people.filter((p) => p.critical);
  if (!core.length) return null;
  const neg = core.filter((p) => p.stance === "negative");
  const cond = core.filter((p) => p.stance === "conditional");
  const names = (list) => list.map((p) => `${p.name}（${segLabel(p)}）`).join("、");
  const [level, text] = neg.length
    ? ["is-critical", `クリティカル：主力顧客の ${names(neg)} が後ろ向きです。今の売上の土台を削るおそれがあります`]
    : cond.length
      ? ["is-caution", `要注意：主力顧客の ${names(cond)} は条件しだいです。条件を満たせないと離れるおそれがあります`]
      : ["is-ok", `主力顧客の ${names(core)} は前向きです`];
  return h("p", `critical-flag ${level}`, text);
}

/** 「5 回中 4 回：プラセンタ ／ 1 回：ヒアルロン酸」と割合バー。6 割以下なら「割れている」 */
function renderVote(vote) {
  const split = vote.agreement <= 0.6;
  const box = h("div", split ? "vote is-split" : "vote");
  const bar = h("div", "vote-bar");
  vote.counts.forEach((c) => {
    const s = document.createElement("span");
    s.style.width = `${(c.n / vote.total) * 100}%`;
    bar.appendChild(s);
  });
  const text = `${vote.total} 回中 ` + vote.counts.map((c) => `${c.n} 回：${c.label}`).join(" ／ ");
  box.append(bar, h("span", null, split ? `${text} — 割れています。この人にとって決め手が弱い質問です` : text));
  if (vote.failed) box.appendChild(h("span", null, `（${vote.failed} 回は回答の形式が崩れたため集計から外しました）`));
  return box;
}

function setBusy(on) {
  state.busy = on;
  $("#send").disabled = on;
  $("#mic").disabled = on;
}

async function ask(question) {
  question = question.trim();
  if (state.mode === "panel") return askPanel(question);
  if (!question || state.busy || !state.persona) return;
  stopAudio();
  setBusy(true);
  append(h("div", "msg-user", question));
  const thinking = h("div", "thinking");
  const ti = document.createElement("i");
  ti.className = "ph ph-circle-notch";
  thinking.append(ti, document.createTextNode($("#precise").checked ? "5 回聞いて集計中…" : "考え中…"));
  append(thinking);
  try {
    const res = await fetch("api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: state.persona, question, history: state.history, style: state.style, samples: $("#precise").checked ? 5 : 1 }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    thinking.remove();
    state.history.push({ role: "user", text: question }, { role: "customer", text: body.spoken });
    if (body.style !== state.style) setStyle(body.style); // 「ずんだもんで話して」を会話で頼んだとき
    renderAnswer(body);
    if ($("#auto-speak").checked) speak(body.spoken);
  } catch (e) {
    thinking.remove();
    append(h("div", "msg-error", `回答を作れませんでした：${e.message}`));
  } finally {
    setBusy(false);
  }
}

// ---------- パネルで聞く ----------
const PANEL_COLORS = ["var(--color-text)", "var(--color-info)", "var(--color-warning)", "var(--color-success)", "var(--color-text-muted)"];

/** 構成比が全員分あれば送る。一部だけなら止める（1 人 1 票と混ぜると割合の意味が崩れるため） */
function panelWeights(slugs) {
  const given = slugs.filter((s) => state.weights[s] !== undefined);
  if (!given.length) return { weights: null };
  if (given.length !== slugs.length) return { error: "構成比は全員分入れるか、全員空にしてください" };
  return { weights: Object.fromEntries(slugs.map((s) => [s, state.weights[s]])) };
}

async function askPanel(question) {
  if (!question || state.busy) return;
  const slugs = [...state.panel];
  if (slugs.length < 2) return append(h("div", "msg-error", "パネルは 2 人以上選んでください"));
  const w = panelWeights(slugs);
  if (w.error) return append(h("div", "msg-error", w.error));
  stopAudio();
  setBusy(true);
  append(h("div", "msg-user", question));
  const samples = $("#precise").checked ? 5 : 1;
  const thinking = h("div", "thinking");
  const ti = document.createElement("i");
  ti.className = "ph ph-circle-notch";
  thinking.append(ti, document.createTextNode(`${slugs.length} 人に${samples > 1 ? ` ${samples} 回ずつ` : ""}聞いて集計中…（15〜30 秒）`));
  append(thinking);
  try {
    const res = await fetch("api/panel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personas: slugs, question, histories: state.panelHistory, style: state.style, samples, weights: w.weights }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    thinking.remove();
    for (const r of body.results) {
      (state.panelHistory[r.slug] ??= []).push({ role: "user", text: question }, { role: "customer", text: r.spoken });
    }
    renderPanel(body);
    if ($("#auto-speak").checked) speak(panelSpeech(body));
  } catch (e) {
    thinking.remove();
    append(h("div", "msg-error", `回答を作れませんでした：${e.message}`));
  } finally {
    setBusy(false);
  }
}

const pct = (x) => `${Math.round(x * 100)}%`;

/** 読み上げ用の要約（記号を使わない） */
function panelSpeech(body) {
  const n = body.summary.people;
  const parts = body.summary.counts.map((c) => (body.weighted ? `${c.label}が${Math.round(c.share * 100)}パーセント` : `${c.label}が${c.people}人`));
  const core = body.results.filter((r) => r.critical);
  const coreText = core.some((r) => r.stance === "negative") ? "主力のお客さんが後ろ向きです。" : core.some((r) => r.stance === "conditional") ? "主力のお客さんは条件しだいです。" : "";
  return `${n}人に聞きました。${body.weighted ? "構成比で見ると、" : ""}${parts.join("、")}です。${coreText}`;
}

function renderPanel(body) {
  const card = h("article", "msg-customer");
  const head = h("div", "msg-head");
  head.appendChild(h("span", "who", `パネル ${body.summary.people} 人・${body.weighted ? "構成比で集計" : "1 人 1 票"}・${(body.tookMs / 1000).toFixed(1)} 秒`));
  const replay = h("button", "btn btn-secondary replay");
  replay.type = "button";
  const ri = document.createElement("i");
  ri.className = "ph ph-speaker-high";
  replay.append(ri, document.createTextNode("要約を聞く"));
  replay.addEventListener("click", () => speak(panelSpeech(body)));
  head.appendChild(replay);
  card.appendChild(head);

  const top = body.summary.counts[0];
  card.appendChild(h("p", "choice", body.weighted ? `${top.label}（${pct(top.share)}）` : `${top.label}（${body.summary.people} 人中 ${top.people} 人）`));

  const sum = h("div", "panel-sum");
  const bar = h("div", "panel-bar");
  const legend = h("ul", "panel-legend");
  body.summary.counts.forEach((c, i) => {
    const color = PANEL_COLORS[i % PANEL_COLORS.length];
    const seg = document.createElement("span");
    seg.style.width = pct(c.share);
    seg.style.background = color;
    bar.appendChild(seg);
    const li = document.createElement("li");
    const sw = h("span", "sw");
    sw.style.background = color;
    li.append(sw, h("span", "pct", pct(c.share)), h("span", null, `${c.label}（${c.people} 人）`), h("span", "names", c.names.join("、")));
    legend.appendChild(li);
  });
  sum.append(bar, legend);
  card.appendChild(sum);
  const flag = criticalFlag(body.results);
  if (flag) card.appendChild(flag);

  // 割合の信頼度に関わる注意（設計ペルソナ・仮の多い人・票が割れた人）
  const shared = body.results.filter((r) => r.source === "shared").length;
  const shaky = body.results.filter((r) => r.source === "own" && r.items && r.tentative / r.items > 0.5).length;
  const split = body.results.filter((r) => r.vote.total > 1 && r.vote.agreement <= 0.6).length;
  const cautions = [
    shared && `${shared} 人は共有の設計ペルソナ（データの裏付けなし）`,
    shaky && `${shaky} 人は項目の半分以上が（仮）`,
    split && `${split} 人は自分の中でも答えが割れた`,
    !body.weighted && "構成比が無いので、市場の割合ではなく人数の割合",
  ].filter(Boolean);
  if (cautions.length) card.appendChild(h("p", "r-flag", `注意：${cautions.join(" ／ ")}`));
  if (body.failures.length) card.appendChild(h("p", "msg-error", `答えられなかった人：${body.failures.map((f) => `${f.name}（${f.error}）`).join(" ／ ")}`));

  const rows = h("div", "panel-rows");
  for (const r of body.results) {
    const row = h("div", "panel-row");
    const top = h("div", "row-top");
    top.append(
      h("span", "r-name", r.critical ? `${r.name}・主力` : r.name),
      h("span", "r-meta", [r.brand || r.segment ? segLabel(r) : "", r.who, body.weighted && `構成比 ${pct(r.weight)}`, r.source === "shared" ? "共有・設計" : r.items ? groundLabel(r) : ""].filter(Boolean).join(" ／ ")),
      h("span", "r-choice", `→ ${r.choice}`),
      stanceChip(r.stance),
      h("span", "r-meta", r.vote.total > 1 ? `${r.vote.total} 回中 ${r.vote.counts[0].n} 回` : "")
    );
    const det = document.createElement("details");
    det.appendChild(h("summary", null, "マーケ目線の理由"));
    const ul = document.createElement("ul");
    r.marketing_note.forEach((n) => ul.appendChild(renderNote(n, body.news)));
    det.appendChild(ul);
    const play = h("button", "btn btn-secondary replay");
    play.type = "button";
    const pi = document.createElement("i");
    pi.className = "ph ph-speaker-high";
    play.append(pi, document.createTextNode("この人の声"));
    play.addEventListener("click", () => speak(r.spoken));
    row.append(top, h("p", "r-spoken", r.spoken), det, play);
    rows.appendChild(row);
  }
  card.appendChild(rows);
  const src = renderNewsSources(body);
  if (src) card.appendChild(src);
  append(card);
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#question");
  const q = input.value;
  input.value = "";
  ask(q);
});

// ---------- 読み上げ（VOICEVOX） ----------
function stopAudio() {
  if (state.audio) {
    state.audio.pause();
    URL.revokeObjectURL(state.audio.src);
    state.audio = null;
  }
}

async function speak(text) {
  if (state.noVoice) return;
  stopAudio();
  try {
    const res = await fetch("api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    const url = URL.createObjectURL(await res.blob());
    state.audio = new Audio(url);
    await state.audio.play();
  } catch (e) {
    $("#mic-note").textContent = `読み上げできませんでした：${e.message}（VOICEVOX を起動してください）`;
    checkVoicevox();
  }
}

async function checkVoicevox() {
  const badge = $("#vv-status");
  try {
    const res = await fetch("api/health");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    if (body.team) {
      // チーム版（サーバ）: 自分用ペルソナはチームで共有される
      state.team = true;
      document.body.classList.add("is-team");
    }
    if (body.voice === false) {
      // チーム版（サーバ）は読み上げなし。読み上げのボタン・表示を隠して文字だけで使う
      state.noVoice = true;
      document.body.classList.add("no-voice");
      return;
    }
    badge.className = "badge ok";
    badge.lastChild.textContent = `VOICEVOX ${body.voicevox}`;
  } catch {
    badge.className = "badge ng";
    badge.lastChild.textContent = "VOICEVOX 未起動";
  }
}

// ---------- マイク（Web Speech API） ----------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let listening = false;

function setupMic() {
  const mic = $("#mic");
  const note = $("#mic-note");
  if (!Recognition) {
    mic.disabled = true;
    note.textContent = "このブラウザは音声入力に対応していません。Chrome で開いてください。";
    return;
  }
  recog = new Recognition();
  recog.lang = "ja-JP";
  recog.interimResults = true;
  recog.continuous = false;
  let finalText = "";

  recog.onstart = () => {
    listening = true;
    finalText = "";
    mic.classList.add("is-listening");
    note.textContent = "聞いています…（話し終えると自動で送ります）";
  };
  recog.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    $("#question").value = finalText + interim;
  };
  recog.onerror = (e) => {
    note.textContent = e.error === "not-allowed" ? "マイクの使用が許可されていません。アドレスバーの設定から許可してください。" : `音声入力エラー：${e.error}`;
  };
  recog.onend = () => {
    listening = false;
    mic.classList.remove("is-listening");
    const q = finalText.trim();
    if (q) {
      note.textContent = "";
      $("#question").value = "";
      ask(q);
    } else if (!note.textContent.startsWith("音声入力エラー") && !note.textContent.startsWith("マイクの使用")) {
      note.textContent = "聞き取れませんでした。もう一度どうぞ。";
    }
  };

  mic.addEventListener("click", () => {
    if (state.busy) return;
    if (listening) return recog.stop();
    stopAudio(); // ボットの声を拾わないように止めてから聞く
    note.textContent = "";
    recog.start();
  });
}

setupMic();
// 先にサーバの種類（ローカル / チーム版）を確かめてから一覧を描く（ペルソナの表記が変わるため）
checkVoicevox().finally(() => loadPersonas().catch((e) => append(h("div", "msg-error", `ペルソナを読み込めませんでした：${e.message}`))));
