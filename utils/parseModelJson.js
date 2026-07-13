// parseModelJson — tolerant JSON parse for LLM extractor output.
//
// Models are asked to "respond ONLY with valid JSON, no markdown", but they
// intermittently wrap the object in a ```json … ``` fence or add a sentence of
// prose around it — which made a raw JSON.parse throw and silently drop the
// extractor result (e.g. classification), blocking IG lead creation.
//
// Strategy, in order:
//   1. parse the trimmed text as-is,
//   2. strip a leading/trailing markdown code fence (```json … ``` or ``` … ```),
//   3. fall back to the substring from the first "{" to the last "}".
// Returns the parsed object, or null if genuinely unparseable.

const tryParse = (s) => {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
};

const parseModelJson = (text) => {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. straight parse
  let parsed = tryParse(trimmed);
  if (parsed !== null) return parsed;

  // 2. strip a wrapping markdown code fence: ```json\n…\n``` or ```\n…\n```
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    parsed = tryParse(fenced[1].trim());
    if (parsed !== null) return parsed;
  }

  // 3. last resort: grab from the first "{" to the last "}" (drops surrounding prose)
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    parsed = tryParse(trimmed.slice(first, last + 1));
    if (parsed !== null) return parsed;
  }

  // 4. TRUNCATED output (max_tokens cut mid-object): balance-close the open
  //    braces/brackets; if the tail is a dangling fragment (half a key, a key
  //    with no value, a cut string), back off to the previous comma and retry —
  //    each backoff drops one incomplete pair. Best-effort; null if hopeless.
  if (first !== -1) {
    const balanceClose = (s) => {
      const stack = [];
      let inString = false;
      let escaped = false;
      for (const ch of s) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{" || ch === "[") stack.push(ch);
        else if (ch === "}" || ch === "]") stack.pop();
      }
      let out = s;
      if (inString) out += '"';
      while (stack.length) out += stack.pop() === "{" ? "}" : "]";
      return out;
    };
    let body = trimmed.slice(first).replace(/,\s*$/, "");
    for (let i = 0; i < 8 && body.length > 1; i++) {
      parsed = tryParse(balanceClose(body));
      if (parsed !== null) return parsed;
      const lastComma = body.lastIndexOf(",");
      if (lastComma <= 0) break;
      body = body.slice(0, lastComma);
    }
  }

  return null;
};

module.exports = parseModelJson;
