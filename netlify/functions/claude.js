const https = require("https");

// ─── Token budget constants ────────────────────────────────────────────────
// GPT-4o context window: 128k tokens. We stay well under 30k to avoid the
// error Sam's clients were hitting. The JSON assembly turn is the killer —
// it arrives with a full 20+ turn history + a 6,300-token system prompt.

const MAX_MSGS_NORMAL   = 20;  // trim threshold for regular turns
const TAIL_NORMAL       = 12;  // keep last N messages normally
const TAIL_JSON_TURN    = 6;   // keep only last N on JSON assembly turn
const HEAD_KEEP         = 1;   // always keep first message (seller intro)

// Detect the JSON assembly turn: index.html sends this as the final user msg
// when seller clicks Confirm / "B) I'm Ready"
function isJsonAssemblyTurn(messages) {
  if (!messages || messages.length === 0) return false;
  const last = messages[messages.length - 1];
  const text = typeof last.content === "string"
    ? last.content
    : (Array.isArray(last.content)
        ? last.content.filter(c => c.type === "text").map(c => c.text).join(" ")
        : "");
  // Matches the Confirm button press, "B) I'm Ready", or silent JSON recovery call
  return /i.?m\s+ready|confirm|authorize delivery|output the complete.*json|start immediately with \{/i.test(text)
      || /^b\)?$/i.test(text.trim());
}

// Rough token estimator — 1 token ≈ 4 chars (conservative for English prose)
function estimateTokens(str) {
  return Math.ceil((str || "").length / 4);
}

function trimMessages(messages, isJsonTurn) {
  if (!messages || messages.length === 0) return messages;

  const tailSize = isJsonTurn ? TAIL_JSON_TURN : TAIL_NORMAL;

  if (messages.length <= tailSize + HEAD_KEEP) return messages;

  const head   = messages.slice(0, HEAD_KEEP);
  const tail   = messages.slice(-tailSize);
  const middle = messages.slice(HEAD_KEEP, -tailSize);

  // On a normal turn: preserve any image messages from the middle so photos survive
  // On the JSON turn: drop images entirely — GPT only needs the data fields
  const extras = isJsonTurn
    ? []
    : middle.filter(m =>
        Array.isArray(m.content) && m.content.some(c => c.type === "image")
      );

  return [...head, ...extras, ...tail];
}

// Convert Anthropic-style messages → OpenAI format.
// index.html was written for the Anthropic SDK so messages may carry
// { type:"image", source:{ type:"base64", media_type, data } } blocks.
function convertMessages(msgs, systemPrompt) {
  const converted = [];
  if (systemPrompt) {
    converted.push({ role: "system", content: systemPrompt });
  }
  for (const m of msgs) {
    if (typeof m.content === "string") {
      converted.push({ role: m.role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const parts = [];
      for (const c of m.content) {
        if (c.type === "text") {
          parts.push({ type: "text", text: c.text });
        } else if (c.type === "image") {
          const mediaType = c.source?.media_type || "image/jpeg";
          const data      = c.source?.data || "";
          parts.push({
            type: "image_url",
            image_url: { url: `data:${mediaType};base64,${data}` }
          });
        }
      }
      if (parts.length > 0) {
        converted.push({ role: m.role, content: parts });
      }
    }
  }
  return converted;
}

exports.handler = async function(event) {
  // ── CORS preflight ────────────────────────────────────────────────────────
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "API key not configured" })
    };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  let messages = body.messages || [];

  // ── Detect JSON assembly turn BEFORE trimming ─────────────────────────────
  const jsonTurn = isJsonAssemblyTurn(messages);

  // ── Trim conversation history to stay under token budget ──────────────────
  messages = trimMessages(messages, jsonTurn);

  // Log for Netlify function logs (visible in dashboard → Functions tab)
  console.log(`[claude.js] msgs=${messages.length} jsonTurn=${jsonTurn} systemTokens≈${estimateTokens(body.system)}`);

  const openaiMessages = convertMessages(messages, body.system);

  // On the JSON assembly turn raise max_tokens to give GPT-4o room to output
  // the full 60-field JSON without getting cut off mid-object.
  const maxTokens = jsonTurn ? 4000 : (body.max_tokens || 2500);

  const payload = JSON.stringify({
    model:      "gpt-4o",
    max_tokens: maxTokens,
    messages:   openaiMessages
  });

  return new Promise((resolve) => {
    const options = {
      hostname: "api.openai.com",
      path:     "/v1/chat/completions",
      method:   "POST",
      headers: {
        "Authorization":  `Bearer ${OPENAI_API_KEY}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const openaiResp = JSON.parse(data);

          // Surface OpenAI error details clearly in Netlify logs
          if (openaiResp.error) {
            console.error("[claude.js] OpenAI error:", JSON.stringify(openaiResp.error));
            return resolve({
              statusCode: 500,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
              body: JSON.stringify({ error: openaiResp.error.message || "OpenAI API error" })
            });
          }

          if (openaiResp.choices && openaiResp.choices[0]) {
            const text = openaiResp.choices[0].message?.content || "";
            // Return in Anthropic-compatible format — index.html expects this shape
            const anthropicFormat = JSON.stringify({
              content:     [{ type: "text", text }],
              model:       "gpt-4o",
              role:        "assistant",
              stop_reason: openaiResp.choices[0].finish_reason || "end_turn"
            });
            resolve({
              statusCode: 200,
              headers: {
                "Content-Type":                "application/json",
                "Access-Control-Allow-Origin": "*"
              },
              body: anthropicFormat
            });
          } else {
            resolve({
              statusCode: res.statusCode,
              headers: {
                "Content-Type":                "application/json",
                "Access-Control-Allow-Origin": "*"
              },
              body: data
            });
          }
        } catch(e) {
          console.error("[claude.js] parse error:", e.message);
          resolve({
            statusCode: 500,
            body: JSON.stringify({ error: "Response parse error: " + e.message })
          });
        }
      });
    });

    req.on("error", (e) => {
      console.error("[claude.js] request error:", e.message);
      resolve({
        statusCode: 500,
        body: JSON.stringify({ error: e.message })
      });
    });

    // Netlify Pro gives you 26s. OpenAI typically responds in 8–15s.
    // Set our timeout to 24s so we return a clean error instead of Netlify
    // killing the function mid-response.
    req.setTimeout(24000, () => {
      req.destroy(new Error("OpenAI API timeout after 24s"));
    });

    req.write(payload);
    req.end();
  });
};
