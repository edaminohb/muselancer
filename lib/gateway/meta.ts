import { canonicalModel, conversationModel, museModel } from "./models";

export type GatewayBudget = {
  remainingCalls: number;
  remainingTokens: number;
};

export type ModelRequest = {
  model: string;
  input: string;
  taskId: string;
  agentId: string;
  longHorizon: boolean;
};

type ModelResponse = {
  id?: string;
  output_text?: string;
  output?: unknown[];
  usage?: { total_tokens?: number };
};

/** The responses API puts the reply on the message output, not always in output_text. */
export function responseText(json: ModelResponse): string {
  if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text;
  const parts: string[] = [];
  for (const item of json.output ?? []) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; content?: unknown };
    if (record.type !== "message" || !Array.isArray(record.content)) continue;
    for (const part of record.content) {
      if (!part || typeof part !== "object") continue;
      const piece = part as { type?: unknown; text?: unknown };
      if (piece.type === "output_text" && typeof piece.text === "string") parts.push(piece.text);
    }
  }
  return parts.join("\n");
}

/** The image model returns the picture on an image_generation_call, not in the text. */
export function generatedImage(output: unknown[] | undefined): string {
  for (const item of output ?? []) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; result?: unknown };
    if (record.type !== "image_generation_call" || typeof record.result !== "string" || !record.result.trim()) continue;
    if (record.result.startsWith("data:image/")) return record.result;
    return `data:image/png;base64,${record.result}`;
  }
  return "";
}

export function assertModel(model: string, _longHorizon: boolean): string {
  const id = canonicalModel(model);
  if (!museModel(id)) throw new Error("Model is not on the allowlist.");
  return id;
}

const workerTools = [
  { type: "tool_search" },
  {
    type: "function",
    name: "checkpoint_note",
    description: "Record a short note at a task boundary.",
    defer_loading: true,
    parameters: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    },
  },
];

export async function completeModel(input: ModelRequest, budget: GatewayBudget): Promise<{ text: string; tokens: number; model: string }> {
  const model = assertModel(input.model, input.longHorizon);
  if (budget.remainingCalls <= 0 || budget.remainingTokens <= 0) throw new Error("Agent budget is exhausted.");
  const key = process.env.MODEL_API_KEY?.trim();
  if (!key) throw new Error("Set MODEL_API_KEY.");
  const response = await fetch("https://api.meta.ai/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: input.input,
      tools: workerTools,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Meta gateway failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const json = (await response.json()) as ModelResponse;
  const tokens = json.usage?.total_tokens ?? 32;
  budget.remainingCalls -= 1;
  budget.remainingTokens -= tokens;
  return { model, tokens, text: responseText(json) };
}

/** Structured reply from the model the owner chose. This call does not hire and does not send a transaction. */
export async function sparkStructured(input: { model: string; name: string; instruction: string; schema: Record<string, unknown> }): Promise<unknown> {
  if (typeof input.model !== "string" || !input.model.trim()) throw new Error("Choose a model.");
  const model = assertModel(input.model, true);
  const key = process.env.MODEL_API_KEY?.trim();
  if (!key) throw new Error("The model key is missing. I cannot search or negotiate.");
  const response = await fetch("https://api.meta.ai/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: input.instruction,
      text: {
        format: {
          type: "json_schema",
          name: input.name,
          strict: true,
          schema: input.schema,
        },
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Meta gateway failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const json = (await response.json()) as ModelResponse;
  return JSON.parse(responseText(json) || "{}") as unknown;
}

export type OwnerModelStep = {
  responseId: string;
  text: string;
  image: string;
  calls: { callId: string; name: string; namespace: string; arguments: Record<string, unknown> }[];
};

function readArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function callsFromOutput(output: unknown): { callId: string; name: string; namespace: string; arguments: Record<string, unknown> }[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (record.type !== "function_call" && record.type !== "tool_search_call") return [];
    const name = record.type === "tool_search_call" ? "tool_search" : typeof record.name === "string" ? record.name : "";
    const callId = typeof record.call_id === "string" ? record.call_id : typeof record.id === "string" ? record.id : "";
    const namespace = typeof record.namespace === "string" ? record.namespace : "";
    if (!name || !callId) return [];
    return [{ callId, name, namespace, arguments: readArguments(record.arguments) }];
  });
}

function stepFromResponse(json: ModelResponse, budget: GatewayBudget): OwnerModelStep {
  const tokens = json.usage?.total_tokens ?? 32;
  budget.remainingTokens -= tokens;
  return { responseId: json.id ?? "", text: responseText(json), image: generatedImage(json.output), calls: callsFromOutput(json.output) };
}

/** Owner work only. Hire calls stay on completeModel and receive task text. */
export async function ownerModelStep(input: {
  model: string;
  longHorizon: boolean;
  instructions: string;
  input: unknown;
  tools: Record<string, unknown>[];
  previousResponseId?: string;
  budget: GatewayBudget;
}): Promise<OwnerModelStep> {
  const model = assertModel(input.model, input.longHorizon);
  if (input.budget.remainingCalls <= 0 || input.budget.remainingTokens <= 0) throw new Error("Agent budget is exhausted.");
  const key = process.env.MODEL_API_KEY?.trim();
  if (!key) throw new Error("The model key is missing. I cannot run this turn.");
  const body: Record<string, unknown> = {
    model,
    instructions: input.instructions,
    input: input.input,
  };
  if (input.tools.length) {
    body.tools = input.tools;
    body.tool_choice = "auto";
  }
  if (input.previousResponseId) body.previous_response_id = input.previousResponseId;
  const response = await fetch("https://api.meta.ai/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Meta gateway failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const json = (await response.json()) as ModelResponse;
  return stepFromResponse(json, input.budget);
}

/** A voice message is transcribed here. The bytes are not written into the workspace. */
export async function transcribeWav(wav: Uint8Array, budget: GatewayBudget): Promise<string> {
  if (budget.remainingCalls <= 0 || budget.remainingTokens <= 0) throw new Error("Agent budget is exhausted.");
  const key = process.env.MODEL_API_KEY?.trim();
  if (!key) throw new Error("The model key is missing. I cannot run this turn.");
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify({
    model: "muse-voice-transcribe-1.0",
    audioEncoding: "WAV",
    mode: "PUSH_TO_TALK",
  })], { type: "application/json" }));
  const audio = new Uint8Array(wav.byteLength);
  audio.set(wav);
  form.append("audio", new Blob([audio], { type: "audio/wav" }), "message.wav");
  const response = await fetch("https://api.meta.ai/v1/asr/transcribe", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    body: form,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Meta gateway failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const json = (await response.json()) as { transcript?: unknown };
  budget.remainingCalls -= 1;
  budget.remainingTokens -= 32;
  return typeof json.transcript === "string" ? json.transcript.trim() : "";
}

/** Supervisor description and advice. Both are checked before the hirer sees them. */
export async function describeDelivery(instruction: string, modelId: string): Promise<{ summary: string; suggestion: string }> {
  const model = assertModel(conversationModel(modelId), true);
  const key = process.env.MODEL_API_KEY?.trim();
  if (!key) throw new Error("The model key is missing. USDC stays locked.");
  const response = await fetch("https://api.meta.ai/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: instruction,
      text: {
        format: {
          type: "json_schema",
          name: "delivery_report",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              suggestion: { type: "string", enum: ["confirm", "revise", "reject"] },
            },
            required: ["summary", "suggestion"],
          },
        },
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Meta gateway failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const json = (await response.json()) as ModelResponse;
  const parsed = JSON.parse(responseText(json) || "{}") as { summary?: unknown; suggestion?: unknown };
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    suggestion: typeof parsed.suggestion === "string" ? parsed.suggestion : "",
  };
}
