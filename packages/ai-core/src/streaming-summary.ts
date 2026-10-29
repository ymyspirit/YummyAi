/** A draft preview of the root summary only. Never executes or adopts partial JSON. */
export function createStreamingSummary(onDelta: (text: string) => void | Promise<void>) {
  let buffer = "",
    emitted = "",
    disabled = false;
  return async (delta: string) => {
    if (disabled) return;
    buffer += delta;
    if (buffer.length > 4 * 1024 * 1024) {
      disabled = true;
      return;
    }
    const prefix = rootStringPrefix(buffer, "summary");
    if (prefix === null || prefix === emitted) return;
    if (!prefix.startsWith(emitted)) {
      disabled = true;
      return;
    }
    const fresh = prefix.slice(emitted.length);
    emitted = prefix;
    for (let index = 0; index < fresh.length;) {
      let end = Math.min(index + 4096, fresh.length);
      if (end < fresh.length && /[\uD800-\uDBFF]/.test(fresh[end - 1]!)) end--;
      await onDelta(fresh.slice(index, end));
      index = end;
    }
  };
}

function quoted(text: string, start: number) {
  let end = start + 1;
  for (; end < text.length; end++) {
    if (text[end] === "\\") {
      end++;
      continue;
    }
    if (text[end] === '"') return end;
  }
  return -1;
}

export function rootStringPrefix(text: string, key: string): string | null {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "{" || char === "[") {
      depth++;
      continue;
    }
    if (char === "}" || char === "]") {
      depth--;
      continue;
    }
    if (char !== '"') continue;
    const end = quoted(text, index);
    if (end < 0) return null;
    let cursor = end + 1;
    while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
    if (depth !== 1 || text[cursor] !== ":" || JSON.parse(text.slice(index, end + 1)) !== key) {
      index = end;
      continue;
    }
    cursor++;
    while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
    if (text[cursor] !== '"') return null;
    const valueEnd = quoted(text, cursor);
    if (valueEnd >= 0) return JSON.parse(text.slice(cursor, valueEnd + 1)) as string;
    let safe = cursor + 1;
    for (let value = safe; value < text.length; value++) {
      if (text[value] === "\\") {
        if (value + 1 >= text.length) break;
        if (text[value + 1] === "u") {
          if (!/^[a-fA-F0-9]{4}$/.test(text.slice(value + 2, value + 6))) break;
          value += 5;
        } else value++;
      }
      safe = value + 1;
    }
    try {
      let result = JSON.parse(text.slice(cursor, safe) + '"') as string;
      if (/[\uD800-\uDBFF]/.test(result.at(-1) ?? "")) result = result.slice(0, -1);
      return result;
    } catch {
      return null;
    }
  }
  return null;
}
