const https = require("https");

const MAX_MSGS_NORMAL = 20;
const TAIL_NORMAL     = 12;
const HEAD_KEEP       = 1;
const MAX_RETRIES     = 3;
const MAX_WAIT_MS     = 15000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterMs(message) {
  const match = message && message.match(/try again in ([0-9.]+)s/);
  if (match) return Math.min(Math.ceil(parseFloat(match[1]) * 1000) + 500, MAX_WAIT_MS);
  return 5000;
}

function estimateTokens(str) { return Math.ceil((str || "").length / 4); }

function trimMessages(messages) {
  if (!messages || messages.length <= HEAD_KEEP + TAIL_NORMAL) return messages;
  const head   = messages.slice(0, HEAD_KEEP);
  const tail   = messages.slice(-TAIL_NORMAL);
  const middle = messages.slice(HEAD_KEEP, -TAIL_NORMAL);
  const extras = middle.filter(m => Array.isArray(m.content) && m.content.some(c => c.type === "image"));
  return [...head, ...extras, ...tail];
}

function convertMessages(msgs, systemPrompt) {
  const converted = [];
  if (systemPrompt) converted.push({ role: "system", content: systemPrompt });
  for (const m of msgs) {
    if (typeof m.content === "string") {
      converted.push({ role: m.role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const parts = [];
      for (const c of m.content) {
        if (c.type === "text") parts.push({ type: "text", text: c.text });
        else if (c.type === "image") {
          parts.push({ type: "image_url", image_url: { url: `data:${c.source?.media_type||"image/jpeg"};base64,${c.source?.data||""}` } });
        }
      }
      if (parts.length > 0) converted.push({ role: m.role, content: parts });
    }
  }
  return converted;
}

function callOpenAI(payload, apiKey) {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ ok: false, status: 500, data: { error: { message: "Parse error: " + e.message } } }); }
      });
    });
    req.on("error", (e) => resolve({ ok: false, status: 500, data: { error: { message: e.message } } }));
    req.setTimeout(24000, () => { req.destroy(); resolve({ ok: false, status: 504, data: { error: { message: "OpenAI timeout after 24s" } } }); });
    req.write(payload);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" }, body: "" };
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: "API key not configured" }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  let messages = body.messages || [];
  if (messages.length > MAX_MSGS_NORMAL) messages = trimMessages(messages);

  const openaiMessages = convertMessages(messages, body.system);
  console.log(`[claude.js] msgs=${messages.length} systemTokens≈${estimateTokens(body.system)}`);

  const payload = JSON.stringify({
    model: "gpt-4o",
    max_tokens: body.max_tokens || 2500,
    messages: openaiMessages
  });

  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    const result = await callOpenAI(payload, OPENAI_API_KEY);

    if (result.data.choices && result.data.choices[0]) {
      const text = result.data.choices[0].message?.content || "";
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ content: [{ type: "text", text }], model: "gpt-4o", role: "assistant", stop_reason: result.data.choices[0].finish_reason || "end_turn" })
      };
    }

    const errMsg = result.data?.error?.message || "Unknown OpenAI error";
    const isRateLimit = result.status === 429 || errMsg.includes("rate_limit_exceeded") || errMsg.includes("Rate limit");

    if (isRateLimit && attempt < MAX_RETRIES) {
      const waitMs = parseRetryAfterMs(errMsg);
      console.log(`[claude.js] Rate limit — attempt ${attempt + 1}/${MAX_RETRIES}, waiting ${waitMs}ms`);
      await sleep(waitMs);
      attempt++;
      continue;
    }

    console.error(`[claude.js] OpenAI error (attempt ${attempt + 1}): ${errMsg}`);
    return {
      statusCode: result.status || 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: errMsg })
    };
  }
};
