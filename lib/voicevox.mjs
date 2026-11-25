// VOICEVOX エンジン（VOICEVOX.app が立てる localhost:50021）で音声を作る。
// Claude Code の実況（voicevox MCP）と同じエンジンを使う。
const ENGINE = process.env.CV_VOICEVOX_URL || "http://127.0.0.1:50021";
const SPEAKER = Number(process.env.CV_SPEAKER || 3); // ずんだもん ノーマル
const SPEED = Number(process.env.CV_SPEED || 1.35);

export async function engineVersion() {
  const res = await fetch(`${ENGINE}/version`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`VOICEVOX /version ${res.status}`);
  return (await res.text()).replaceAll('"', "");
}

/** @returns {Promise<Buffer>} wav */
export async function synthesize(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("text is empty");
  const q = new URLSearchParams({ text, speaker: String(SPEAKER) });
  const queryRes = await fetch(`${ENGINE}/audio_query?${q}`, { method: "POST" });
  if (!queryRes.ok) throw new Error(`VOICEVOX audio_query ${queryRes.status}`);
  const query = await queryRes.json();
  query.speedScale = SPEED;
  const synthRes = await fetch(`${ENGINE}/synthesis?speaker=${SPEAKER}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!synthRes.ok) throw new Error(`VOICEVOX synthesis ${synthRes.status}`);
  return Buffer.from(await synthRes.arrayBuffer());
}
