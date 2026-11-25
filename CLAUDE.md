# ig-customer-voice（顧客ボイス）

## プロジェクト概要

**目的**: 擬似顧客ペルソナにマイクで質問し、「どっちを買うか」と理由を顧客の言葉で聞く。理由の中身はマーケ目線の厳しい分析で、画面に根拠タグ付きで出す。声はずんだもん（VOICEVOX）
**対象ユーザー**: sasaki（企画・商品開発の壁打ち）
**制作物タイプ**: Web アプリ。同じコードを 2 つの形で動かす
- **ローカル版**（sasaki の Mac `http://localhost:4780/`）: 回答は claude CLI（サブスク枠）、VOICEVOX で読み上げ、マイク入力
- **チーム版**（`https://mb.instyle.group/ig-customer-voice/`）: 回答は Claude API（従量課金）、読み上げなし（文字だけ）、マイク入力は Chrome なら使える。共通パスワード（Basic 認証）+ noindex で社内利用のみ
**デザイン系統**: **メビウスのリキッド**（`~/Workspace/design-system/design-system_mebius/design.md` と `PRINCIPLES.md` に準拠。cool neutral + teal `#00ABBF`。teal はマイクと主ボタンの 2 か所だけ）

## 本番（チーム版）

| 項目 | 値 |
|---|---|
| CATEGORY | `mb` |
| APP_NAME | `ig-customer-voice` |
| PORT | `3301` |
| HEALTHCHECK_PATH | `/ig-customer-voice/api/healthz` |
| USE_DB | `false` |
| 公開URL | `https://mb.instyle.group/ig-customer-voice/` |
| PM2 名 | `mb-ig-customer-voice` |

- 設定は `ecosystem.config.cjs`（CV_LLM=api / CV_VOICE=off / CV_BASE_PATH）。秘密の値（`ANTHROPIC_API_KEY` / `CV_PASSWORD`）はサーバの `/var/www/_shared/apps/mb-ig-customer-voice.env` だけに置き、リポジトリに入れない
- `CV_LLM=api` なのに `ANTHROPIC_API_KEY` か `CV_PASSWORD` が無いと起動しない（公開のまま動かさない）
- ペルソナはリリースをまたいで `/var/www/mb/ig-customer-voice/shared/personas/` に置く。`shared/` = customer-panel 同梱の共有ペルソナ（`scripts/sync-personas.sh` で配る。sasaki の自分用は送らない）、`own/` = チームが画面で作ったもの
- デプロイは `gh workflow run deploy-prod.yml --ref main`（Next.js ではないのでビルドせず、依存だけ入れて送る）
- 費用の目安（Claude Sonnet 5.5・effort low）: 1 人に 5 回の多数決で 1 問 数円〜十数円、8 人パネルで 1 問 数十円〜百円程度。API キーは mebius 系アプリと同じものを使う

## 仕組み

```
ブラウザ（public/）── マイク → 文字起こし
   │ POST /api/ask {persona, question, history, style}
   ▼
server.mjs（依存なし・127.0.0.1 のみ）
   ├─ lib/ask-claude.mjs  claude --print（sonnet / ツールなし / MCP なし / user hooks なし）
   │     system = prompt.md + ペルソナ本文 → JSON {choice, spoken, marketing_note[], style}
   └─ lib/voicevox.mjs    localhost:50021 → wav（speaker 3 = ずんだもん / speed 1.35）
```

- ペルソナの置き場所は 2 つ（`lib/personas.mjs`）。どちらもこのフォルダにはコピーせず、毎回ファイルを読む
  - **共有**: `~/.claude/skills/customer-panel/personas/`。チーム配布物なので、この画面からは読むだけ（編集・削除不可）
  - **自分用**: `~/Workspace/_outputs/customer-panel/personas/`。画面から追加・編集・削除できる。customer-panel を Workspace で使うときの「案件専用ペルソナ」の置き場と同じなので、文章版のパネルからも使える。クライアント名を入れてよいのはこちらだけ
- 追加は手数を最小にする：領域・性別・年齢・段階をタップで選び、任意で「ひとこと」（声でも入る）→ server.mjs の `buildBrief` が依頼文に組み立て（知らない値は 400）→ `claude --print` が `_schema.md` の書式で下書き（補った項目に「（仮）」）→ プレビューで確認して「保存して話す」。Markdown は開かなくても保存でき、直したいときだけ開く。保存時に slug・name・必須見出しを検査し、slug の重複は拒否する
- 削除は完全には消さず `自分用/_trash/<slug>__<日時>.md` に移す。戻すときはファイルを元のフォルダに戻すだけ
- ペルソナは集団（ターゲット）ではなく 1 人。下書きは集団の説明を渡されても 1 人に絞り、保存時は年齢が「42 歳」のような 1 つの数字でないと止める（幅や「〜代」は集団になるため）。回答も「〜な人は多い」のような一般論を使わず、その人の事情で答える（`prompt.md`）
- 精度の考え方: 1 回の回答は「たまたま」があるので、既定で同じ質問を 5 回並列に聞いて多数決（`/api/ask` の `samples` は 1 か 5。`choice_key` で集計し、表記ゆれは server.mjs の `normKey` / `tally` で寄せる）。6 割以下は「割れている」と表示する
- 精度の上限はペルソナの材料で決まる。追加画面の「事実」（購買データ・インタビュー・レビュー）から書いた項目は（仮）が外れ、`## 根拠` 節に出典が残る。一覧には自分用ペルソナの「仮 n / 13 項目」を出し、回答の根拠タグも（仮）の項目に乗っていればオレンジ枠で出す。共有ペルソナは設計上の人物像なので「データの裏付けなし」と表示する
- パネルで聞く（`/api/panel`）: 2〜8 人に同じ質問を、1 人あたり 5 回の多数決で聞き、各人の答えを 1 票として分布を出す。構成比（実際の顧客のうち何割がこの人に近いか）が全員分あれば重み付き、無ければ 1 人 1 票。一部だけの構成比は混ぜずに 400。会話履歴は人ごとに持つ。claude の同時起動は `CV_CONCURRENCY`（既定 10）で抑える。集計結果には「共有の設計ペルソナ」「（仮）が半分以上」「本人の中で割れた」「構成比なし」の注意を出す（割合をそのまま市場の数字として読ませないため）
- 回答ルールの正本は `prompt.md`。口調は `persona`（ペルソナの「口調」節・属性どおり）と `zundamon`（中身はペルソナのまま話し方だけ「〜なのだ」）
- 回答 JSON が欠けていたら例外にしてエラー表示する（既定値で埋めない）
- 回答の呼び出し先は `lib/ask-claude.mjs` が `CV_LLM` で切り替える（`cli` = claude CLI / `api` = Claude API、モデル `CV_API_MODEL` 既定 `claude-sonnet-5-5`、`CV_API_EFFORT` 既定 `low`）。API では同じペルソナへの 5 回をプロンプトキャッシュで安くし、安全側の判定で断られたときはサーバ側の fallback で別モデルに回す
- チーム版では `/api/health` が `{voice:false, team:true}` を返し、画面は読み上げのボタンを隠し、「自分用」を「チーム作成」と表示する

## 設定（環境変数・すべて任意）

| 変数 | 既定 | 内容 |
|---|---|---|
| `CV_PORT` | 4780 | サーバのポート |
| `CV_MODEL` | sonnet | 回答に使うモデル（opus にすると遅くなる代わりに深くなる） |
| `CV_SPEAKER` / `CV_SPEED` | 3 / 1.35 | VOICEVOX の話者と速さ |
| `CV_PERSONA_DIR` | customer-panel/personas | 共有ペルソナの置き場 |
| `CV_OWN_PERSONA_DIR` | `_outputs/customer-panel/personas` | 画面で作るペルソナの置き場 |
| `CV_LLM` | cli | `cli`（claude CLI）/ `api`（Claude API） |
| `CV_API_MODEL` / `CV_API_EFFORT` | claude-sonnet-5-5 / low | API のモデルと effort |
| `CV_VOICE` | on | `off` で読み上げなし |
| `CV_BASE_PATH` | （空） | 公開パス（例 `/ig-customer-voice`） |
| `CV_PASSWORD` | （空） | 共通パスワード。`CV_LLM=api` では必須 |

## デザインルール

メビウスのリキッド（`design-system_mebius`）に従う。トークンは本番リキッドと同じ変数名で値が違うので、色は必ず mebius 側から取る（warm の色を混ぜない、dark glass は steel blue、teal は CTA だけで 1 画面 2〜3 か所まで）。glass 4 点セット・scene-bg・`--color-*` 変数・Gen Interface JP・8px グリッド・superellipse 角丸・backdrop-filter の fallback は共通。詳細は `~/Workspace/design-system/design-system_mebius/design.md`。アイコンは Phosphor（regular / webfont）、日本語は BudouX（動的テキストは `setText()` で `<wbr>` を入れる）。

## 注意

- Claude Code の実況と同じ VOICEVOX エンジンを使うので、同時に喋ると声が重なる
- マイクは Chrome 専用（Safari は Web Speech API の挙動が不安定）
- マイクを押すとボットの声を止めてから聞く（自分の声を拾わないため）
