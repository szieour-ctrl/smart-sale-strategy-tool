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

// Convert Anthropic-style messages → Op
