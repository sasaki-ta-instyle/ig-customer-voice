// PM2（ConoHa 本番）。current シンボリックリンク経由で最新リリースを読む
const fs = require("fs");

const SERVER_DIR = "/var/www/mb/ig-customer-voice/current";
const DATA_DIR = "/var/www/mb/ig-customer-voice/shared/personas";

function loadEnvFile(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

module.exports = {
  apps: [
    {
      name: "mb-ig-customer-voice",
      script: SERVER_DIR + "/server.mjs",
      cwd: SERVER_DIR,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "256M",
      env: {
        ...loadEnvFile(SERVER_DIR + "/.env.base"),
        ...loadEnvFile(SERVER_DIR + "/.env.app"), // ANTHROPIC_API_KEY / CV_PASSWORD はここ（リポジトリに入れない）
        NODE_ENV: "production",
        CV_PORT: "3301",
        CV_BASE_PATH: "/ig-customer-voice",
        CV_LLM: "api",
        CV_VOICE: "off",
        // ペルソナはリリースをまたいで残す。共有 = customer-panel 同梱 / ブランド顧客 = sasaki の自分用のうち group 付き
        // （どちらも scripts/sync-personas.sh で配る。画面からは読むだけ）/ 自分用 = チームが画面で作る
        CV_PERSONA_DIR: DATA_DIR + "/shared",
        CV_BRAND_PERSONA_DIR: DATA_DIR + "/brand",
        CV_OWN_PERSONA_DIR: DATA_DIR + "/own",
      },
    },
  ],
};
