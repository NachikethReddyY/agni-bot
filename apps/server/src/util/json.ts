/**
 * The JSON object inside a model's answer. Models wrap JSON in ```json
 * fences or a sentence of preamble; the object is the span from the first
 * `{` to the last `}`. Null when there is no object or it does not parse.
 */
export function extractJSONObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
