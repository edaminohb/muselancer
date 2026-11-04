const RESERVED = new Set(["browser.search", "browser.open", "browser.find"]);

/** Meta's hosted web search. Present only when the owner has enabled web for this agent. */
export function withWebAccess(tools: Record<string, unknown>[], enabled: boolean): Record<string, unknown>[] {
  const kept = tools.filter((tool) => {
    if (tool.type === "web_search") return false;
    if (!enabled) return true;
    return !(tool.type === "function" && RESERVED.has(String(tool.name ?? "")));
  });
  if (!enabled) return kept;
  return [...kept, { type: "web_search" }];
}
