// Gemini プロキシ：英作文を添削（自然な書き換え・詳しい解説・関連時のみイディオム）
// APIキーは Supabase のシークレット GEMINI_API_KEY に保持（クライアント／公開リポジトリには出さない）。
// モデルは複数候補を順に試し、通ったものを使う（提供終了モデル対策）。GEMINI_MODEL で先頭候補を上書き可。

const KEY = Deno.env.get("GEMINI_API_KEY");
const MODELS = ((Deno.env.get("GEMINI_MODEL") ? [Deno.env.get("GEMINI_MODEL") as string] : []) as string[]).concat([
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.5-flash-latest",
  "gemini-2.0-flash-001",
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SCHEMA = {
  type: "OBJECT",
  properties: {
    corrected: { type: "STRING" },
    praise: { type: "STRING" },
    summary: { type: "STRING" },
    issues: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["grammar", "spelling", "usage", "naturalness"] },
          from: { type: "STRING" },
          to: { type: "STRING" },
          ex: { type: "STRING" },
        },
        required: ["type", "from", "to", "ex"],
      },
    },
    suggestions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { expression: { type: "STRING" }, note: { type: "STRING" } },
        required: ["expression", "note"],
      },
    },
    vocab: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { word: { type: "STRING" }, meaning: { type: "STRING" }, example: { type: "STRING" } },
        required: ["word", "meaning", "example"],
      },
    },
    region_idiom: {
      type: "OBJECT",
      nullable: true,
      properties: {
        region: { type: "STRING" },
        expression: { type: "STRING" },
        meaning: { type: "STRING" },
        example: { type: "STRING" },
      },
    },
  },
  required: ["corrected", "praise", "summary", "issues", "suggestions", "vocab"],
};

function buildPrompt(question: string, answer: string, level: string, regions: string[]) {
  const regs = (Array.isArray(regions) && regions.length ? regions : ["US", "CA", "UK", "AU"]).join(", ");
  return [
    "あなたは日本人の英語学習者を指導する、経験豊富で親切な英語の先生です。",
    `学習者のレベルは「${level}」です。やさしく具体的に、でも妥協せず添削してください。`,
    "",
    `【質問】${question}`,
    `【学習者の回答（英語）】${answer}`,
    "",
    "この回答を添削し、必ず指定のJSON形式で出力してください。解説は日本語、英語の修正文・例文・表現は英語で書きます。",
    "",
    "各フィールドの指示:",
    "- corrected: 回答を『ネイティブが書くような自然な英語』に書き換える。文法的に正しくても、より自然な語彙・言い回しに改善する。意味と事実は変えず、長さは元と同程度。元の文と全く同じものを返さないこと（最低でも自然さを磨く）。ただし元が既に十分自然なら大きくは変えない。",
    "- praise: 一言の励まし（日本語、20〜40字程度）。",
    "- issues: 具体的な誤りを列挙。中心は ①文法 ②スペル。各項目は { type(grammar/spelling/usage/naturalness), from(誤りの箇所・英語), to(修正・英語), ex(なぜそうなるかの『詳しく丁寧な日本語解説』。ルールや理由を2〜3文で具体的に) }。誤りが無ければ空配列 [] にする。",
    "- summary: 全体を踏まえた『詳しい日本語の総合解説』。一言で済ませず、(1)良かった点 (2)特に直すべき点とその理由 (3)次に意識すること、を数文で丁寧に書く。",
    "- suggestions: この回答に関連する自然な言い回し・レベルアップ表現を1〜3個。{ expression(英語), note(日本語の説明) }。無ければ []。",
    "- vocab: この話題で実際に役立つ単語/熟語を1〜3個。{ word(英語), meaning(日本語), example(英語の例文) }。",
    `- region_idiom: 今回の回答テーマに『本当に自然に合う』イディオムがある場合のみ、次の地域から1つ出す: ${regs}。region は US/CA/UK/AU のいずれかのコード。テーマに合うものが無ければ必ず null にする。無理に出さないこと。`,
    "",
    "学習者を励ましつつ、具体的で実用的なフィードバックにしてください。",
  ].join("\n");
}

async function callGemini(prompt: string) {
  let lastErr: unknown = null;
  for (const model of MODELS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000); // モデル毎に20秒で打ち切り→次へ
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: SCHEMA,
              temperature: 0.4,
              thinkingConfig: { thinkingBudget: 0 }, // 思考モードOFFで高速化
            },
          }),
        },
      );
      if (res.ok) return { ok: true as const, model, data: await res.json() };
      const detail = (await res.text()).slice(0, 400);
      lastErr = { model, status: res.status, detail };
      if (res.status !== 404) break; // 404=モデル無し→次を試す。それ以外は中断
    } catch (e) {
      lastErr = { model, status: "timeout", detail: String(e) };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false as const, error: lastErr };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!KEY) return json({ error: "GEMINI_API_KEY_not_set" });
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    if ((body as any)._listModels) {
      const lm = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${KEY}`);
      const j = await lm.json();
      const names = (j.models || [])
        .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m: any) => m.name);
      return json({ models: names });
    }
    const question = String((body as any).question || "");
    const answer = String((body as any).answer || "").trim();
    const level = String((body as any).level || "A2");
    const regions = (body as any).regions;
    if (!answer) return json({ error: "empty_answer" });

    const r = await callGemini(buildPrompt(question, answer, level, regions));
    if (!r.ok) return json({ error: "gemini_error", ...(r.error as object) });
    const text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return json({ error: "no_text", detail: JSON.stringify(r.data).slice(0, 500) });
    let fb: any;
    try { fb = JSON.parse(text); } catch { return json({ error: "parse_error", detail: String(text).slice(0, 500) }); }
    fb._model = r.model;
    return json(fb);
  } catch (e) {
    return json({ error: "exception", detail: String(e) });
  }
});
