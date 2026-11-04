export type ChatLine = { role: string; text: string };

function sameLine(left: ChatLine, right: ChatLine): boolean {
  return left.role === right.role && left.text === right.text;
}

function signature(row: ChatLine): string {
  return `${row.role}\n${row.text}`;
}

function containsSlice<T extends ChatLine>(rows: T[], slice: T[]): boolean {
  if (slice.length === 0 || slice.length > rows.length) return false;
  for (let start = 0; start <= rows.length - slice.length; start += 1) {
    if (slice.every((row, index) => sameLine(row, rows[start + index]))) return true;
  }
  return false;
}

function isReverseOf<T extends ChatLine>(left: T[], right: T[]): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  return left.every((row, index) => sameLine(row, right[right.length - 1 - index]));
}

/** XMTP often returns newest-first. Paint oldest-first using the saved thread as a hint. */
export function oldestFirst<T extends ChatLine>(incoming: T[], current: T[] = []): T[] {
  if (incoming.length < 2) return incoming;
  const reversed = [...incoming].reverse();
  if (current.length >= 2) {
    if (isReverseOf(incoming, current)) return reversed;
    if (containsSlice(current, reversed) || containsSlice(reversed, current)) return reversed;
    if (sameLine(incoming[0], current[current.length - 1]) && sameLine(incoming[incoming.length - 1], current[0])) return reversed;
  }
  return incoming;
}

/** Keep every saved line. A live sync can add the tail. A reversed or older window cannot replace a longer chronological thread. */
export function mergeChatRows<T extends ChatLine>(current: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return current;
  const ordered = oldestFirst(incoming, current);
  if (current.length === 0) return ordered;
  if (containsSlice(ordered, current) && ordered.length >= current.length) return ordered;
  if (containsSlice(current, ordered)) return current;
  const seen = new Set(current.map(signature));
  const extra = ordered.filter((row) => !seen.has(signature(row)));
  return extra.length > 0 ? [...current, ...extra] : current;
}

function sharesStart(left: string, right: string): boolean {
  const a = left.trim();
  const b = right.trim();
  if (a.length < 24 || b.length < 24) return a === b;
  return a.includes(b.slice(0, 48)) || b.includes(a.slice(0, 48));
}

/** Deal lines that never made it into the saved chat, in their original order. */
export function missingDealLines<T extends ChatLine>(transcript: T[], dealTurns: ChatLine[], asTurn: (role: string, text: string) => T): T[] {
  const known = transcript.map((row) => row.text);
  const missing: T[] = [];
  for (const turn of dealTurns) {
    const text = turn.text.trim();
    if (!text || known.some((line) => sharesStart(line, text))) continue;
    const role = turn.role === "human" || turn.role === "owner" ? "owner" : "agent";
    missing.push(asTurn(role, text));
  }
  return missing;
}

/** Adds the turn that was just saved when the live sync has not caught up. */
export function appendChatTurn<T extends ChatLine>(rows: T[], owner: T, agent: T): T[] {
  const before = rows[rows.length - 2];
  const last = rows[rows.length - 1];
  if (before && last && sameLine(before, owner) && sameLine(last, agent)) return rows;
  return [...rows, owner, agent];
}
