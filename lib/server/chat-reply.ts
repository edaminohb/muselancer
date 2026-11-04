import { randomBytes } from "node:crypto";
import { compileOwnerPrefix, preferredModel } from "../agent/profile";
import { OWNER_PLATFORM } from "../agent/platform";
import { attachmentKind, attachmentName, MAX_ATTACHMENTS } from "../gateway/attachment-kind";
import { readImageDataUrl, readVoiceWav } from "../gateway/attachments";
import { scanPlaintext } from "../gateway/llama";
import { conversationModel, museModel } from "../gateway/models";
import { ownerModelStep, transcribeWav, type GatewayBudget } from "../gateway/meta";
import { ownerAskKey, parseOwnerAsk, readStoredAsk, type OwnerAsk } from "../chat/ask";
import { readDocument, writeDocument } from "../db";
import { namespaceTools } from "../mcp/bridge";
import type { ToolGrant } from "../tools/catalog";
import { executeOwnerLoop, type ExtraTool } from "../tools/loop";
import { loadOwnerContext } from "../workspace/context";
import {
  buildChatInput,
  draftsFromTranscript,
  isSaveConfirmation,
  readChatDrafts,
  readChatTranscript,
  sanitizeHistory,
  stageOwnerDraft,
  writeChatDrafts,
  writeChatTranscript,
  type ChatTurn,
  type StagedFile,
} from "./chat-thread";
import { readOwnedProfile } from "./teach";
import { currentHireBrief } from "./hire-status";
import { continueOpenHire, DealError, ownerHireTool } from "./deal";
import { callConnectedTool, readConnections } from "./connections";
import { webEnabled } from "./web-access";
import { ensureWorkspace } from "./workspace";
import { saveOwnerFiles } from "./workspace-edit";
import { activeSkills, addGuidanceSkill, chatSkillGrants } from "./skills";

export class ChatReplyError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const CHAT_RULES = `Conversation:
The earlier turns are this owner thread. Read them before answering.
To propose a complete new text for a file the owner edits, call stage_owner_file with the path and the full text. Staging does not save the file.
The owner saves staged files by saying "confirm save". Do not say a file was saved unless this turn says Saved.
Money movement stays with the owner. A sentence does not install a skill or change the registry. When the owner asks to add a skill, call add_skill with the name, what it is for, and the instructions.
An attached .md, .txt, .csv, image, or voice file is for this turn. It is not a workspace file.
When you need the owner to pick one choice, more than one choice, or to type a short fact before you can continue, call ask_owner. The screen shows those buttons and always adds Other for a choice you did not list. Do not add Other yourself. Wait for their answer.
On every task, read what is known and what is still missing. Keep asking the next fact that would change the work until nothing material is unclear. One question at a time, in your own words. Do not invent the missing part. Do not recite a list of questions.`;

function savedLine(paths: string[]): string {
  return paths.length > 0 ? `Saved ${paths.join(", ")}.` : "";
}

const IMAGE_MODEL = "muse-image-1.0";
const VOICE_MODEL = "muse-voice-transcribe-1.0";
const SAM_MODEL = "sam-3.1";

export type Specialty = "voice" | "image" | "sam";

export function specialtyOf(model: string): Specialty | null {
  if (model === VOICE_MODEL) return "voice";
  if (model === IMAGE_MODEL) return "image";
  if (model === SAM_MODEL) return "sam";
  return null;
}

/** Text chat uses a conversation model. Image, voice, and segmentation run only from a tool the owner asked for. */
export function planOwnerTurn(model: string, input: { confirmation: boolean; voiceFiles: number; imageFiles: number }): {
  chatModel: string;
  specialty: Specialty | null;
  doesTasks: boolean;
  transcribeBeforeReply: boolean;
  seeImages: boolean;
  tools: string[];
} {
  const specialty = specialtyOf(model);
  const tools: string[] = [];
  if (specialty === "voice" && input.voiceFiles > 0) tools.push("transcribe_voice");
  if (specialty === "image") tools.push("make_image");
  if (specialty === "sam" && input.imageFiles > 0) tools.push("segment_image");
  return {
    chatModel: conversationModel(model),
    specialty,
    doesTasks: specialty === null,
    transcribeBeforeReply: !input.confirmation && !specialty && input.voiceFiles > 0,
    seeImages: !input.confirmation && !specialty && input.imageFiles > 0,
    tools,
  };
}

function specialtyRules(kind: Specialty, modelName: string): string {
  const work = kind === "voice"
    ? "Call transcribe_voice only when the owner asks you to transcribe an attached voice file."
    : kind === "image"
      ? "Call make_image only when the owner asks for a new image or an edit. If the tool returns an [[image:...]] marker, copy that marker into the reply unchanged."
      : "Call segment_image only when the owner asks you to segment an object in an attached image. Pass one short noun phrase, such as \"yellow school bus\".";
  return `Your model is ${modelName}. ${work}
Muse Spark writes this conversation and does not do the task. Do not write HTML or code. Do not say you created that work.
If the owner asks you to do that work yourself, say this agent does not do that task.
stage_owner_file is granted. When the owner asks to change or save a workspace file, call stage_owner_file with the path and the full text in this turn. A workspace note about transcription, images, or segmentation does not remove that tool. Do not paste the file as the only reply, and do not ask for the tool to be granted.
add_skill is granted. When the owner asks to add a skill, call it in this turn. Do not say the tool is missing.
Call run_hire only when the owner asks to hire another agent. If the owner says not to use a worker, do not call run_hire.`;
}

function segmentSummary(phrase: string, raw: string): string {
  const boxes = raw.match(/<\|box;/g)?.length ?? 0;
  if (boxes === 0) return `No match for ${phrase}.`;
  return boxes === 1 ? `Found 1 match for ${phrase}.` : `Found ${boxes} matches for ${phrase}.`;
}

const TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
} as const;

export type ChatAttachment =
  | { kind: "text"; name: string; text: string }
  | { kind: "image"; name?: string; dataUrl: string }
  | { kind: "voice"; name?: string; wavBase64: string };

export type AgentReply = { text: string; ownerText: string; ask: OwnerAsk | null };

async function storeAsk(agentId: string, ask: OwnerAsk | null): Promise<void> {
  await writeDocument(ownerAskKey(agentId), ask ? JSON.stringify(ask) : "");
}

export async function readOwnerAsk(agentId: string): Promise<OwnerAsk | null> {
  return readStoredAsk(await readDocument(ownerAskKey(agentId)));
}

function imageResponseKey(agentId: string): string {
  return `chat-image-response:${agentId}`;
}

async function rememberImage(agentId: string, dataUrl: string): Promise<string> {
  if (!dataUrl) return "";
  const id = randomBytes(9).toString("hex");
  await writeDocument(`chat-image:${agentId}:${id}`, dataUrl);
  return `[[image:${id}]]`;
}

/** The model was told to end idle turns with this. Drop it when it is only the ending. */
export function dropWaitingLine(text: string): string {
  return text.replace(/\s*No file text is waiting\.?\s*$/i, "").trim();
}

function acceptReply(text: string): string {
  const markers = text.match(/\[\[image:[a-f0-9]+\]\]/g) ?? [];
  const prose = text.replace(/\[\[image:[a-f0-9]+\]\]/g, "").trim();
  if (!prose) return markers.join("\n\n");
  const scan = scanPlaintext(prose, "text");
  if (!scan.allow) return markers.join("\n\n");
  return [prose, ...markers].filter(Boolean).join("\n\n");
}

/** The agent's next line in the owner thread. An image or voice stays with the turn, not the workspace. */
export async function agentReply(
  owner: string,
  agentId: string,
  message: string,
  budget: GatewayBudget,
  options?: { startup?: boolean; name?: string; description?: string; history?: unknown; attachments?: ChatAttachment[]; onActivity?: (label: string) => void },
): Promise<AgentReply> {
  const attachments = options?.attachments ?? [];
  if (attachments.length > MAX_ATTACHMENTS) throw new ChatReplyError("Attach up to 8 files.", 400);
  if (!message && attachments.length === 0) throw new ChatReplyError("Say what to send.", 400);
  if (!options?.startup) await storeAsk(agentId, null);
  if (message) {
    const scan = scanPlaintext(message, "text");
    if (!scan.allow) throw new ChatReplyError(scan.reason, 400);
  }
  const profile = await readOwnedProfile(owner, agentId);
  const model = preferredModel(profile.models, false);
  const textBlocks: string[] = [];
  const imageUrls: string[] = [];
  const voiceFiles: { name: string; wav: Uint8Array }[] = [];
  const ownerBits: string[] = [];
  if (message) ownerBits.push(message);
  const heardParts: string[] = [];
  for (const item of attachments) {
    if (item.kind === "text") {
      const name = attachmentName(item.name || "notes.md");
      if (attachmentKind(name) !== "text") throw new ChatReplyError("Attach a .md, .txt, or .csv file.", 400);
      if (typeof item.text !== "string" || !item.text.trim()) throw new ChatReplyError("That file is empty.", 400);
      if (item.text.length > 64_000) throw new ChatReplyError("That file is too large.", 400);
      const fileScan = scanPlaintext(item.text, "text");
      if (!fileScan.allow) throw new ChatReplyError(fileScan.reason, 400);
      const block = `# ${name}\n${item.text}`;
      textBlocks.push(block);
      ownerBits.push(block);
    } else if (item.kind === "image") {
      const parsed = readImageDataUrl(item.dataUrl);
      imageUrls.push(parsed.dataUrl);
      ownerBits.push(await rememberImage(agentId, parsed.dataUrl));
    } else if (item.kind === "voice") {
      const name = attachmentName(item.name || "voice.wav");
      voiceFiles.push({ name, wav: readVoiceWav(item.wavBase64) });
      ownerBits.push(name);
    } else {
      throw new ChatReplyError("Attach a .md, .txt, .csv, image, or voice file.", 400);
    }
  }
  const confirmation = isSaveConfirmation(message);
  const plan = planOwnerTurn(model, { confirmation, voiceFiles: voiceFiles.length, imageFiles: imageUrls.length });
  const activity = options?.onActivity;
  activity?.("Thinking");
  if (plan.transcribeBeforeReply) {
    activity?.("Transcribing");
    for (const file of voiceFiles) {
      const transcript = await transcribeWav(file.wav, budget);
      if (!transcript) throw new ChatReplyError("The voice file had no words.", 502);
      const heardScan = scanPlaintext(transcript, "text");
      if (!heardScan.allow) throw new ChatReplyError(heardScan.reason, 400);
      heardParts.push(`${file.name}: ${transcript}`);
    }
  }
  const heard = heardParts.join("\n");
  const ownerText = ownerBits.filter(Boolean).join("\n\n") || message || "Attached files.";
  const waiting: string[] = [];
  if (plan.specialty && voiceFiles.length > 0) waiting.push(`Voice file attached: ${voiceFiles.map((file) => file.name).join(", ")}. It is not transcribed until the owner asks.`);
  if (plan.specialty && imageUrls.length > 0) waiting.push("An image is attached with this message.");
  const words = [message, ...textBlocks, heard, ...waiting].filter(Boolean).join("\n\n");
  const seeded = await ensureWorkspace(agentId, {
    name: options?.name || profile.identity.displayName || "Agent",
    description: options?.description || profile.identity.description,
  });
  const context = loadOwnerContext(seeded.tree.files, {
    startup: options?.startup === true,
    bootstrapComplete: seeded.pointer.bootstrapComplete,
    query: words || message,
  });
  const stored = await readChatTranscript(agentId);
  const seededTurns = stored.length > 0 ? stored : sanitizeHistory(options?.history);
  const prior = seededTurns[seededTurns.length - 1]?.role === "owner" && seededTurns[seededTurns.length - 1]?.text.trim() === ownerText.trim()
    ? seededTurns.slice(0, -1)
    : seededTurns;
  const hireBrief = options?.startup ? "" : await currentHireBrief(owner, agentId);
  if (!options?.startup && message.trim()) {
    const earlier = prior.filter((turn) => turn.role === "owner").map((turn) => turn.text).join("\n");
    activity?.("Hiring");
    const continued = await continueOpenHire(owner, agentId, message, earlier);
    if (continued) {
      const cleaned = dropWaitingLine(continued);
      await writeChatTranscript(agentId, [...prior, { role: "owner", text: ownerText }, { role: "agent", text: cleaned }]);
      await storeAsk(agentId, null);
      return { text: cleaned, ownerText, ask: null };
    }
    activity?.("Thinking");
  }
  const stagedNow = new Map<string, StagedFile>();
  let savedPaths: string[] = [];
  if (confirmation) {
    const waiting = await readChatDrafts(agentId);
    const drafts = waiting.length > 0 ? waiting : draftsFromTranscript(prior);
    if (drafts.length > 0) {
      savedPaths = await saveOwnerFiles(owner, agentId, drafts);
      await writeChatDrafts(agentId, []);
    }
  }
  const modelName = museModel(model)?.name ?? model;
  const instructions = `${context}\n\n${compileOwnerPrefix(profile)}\n${CHAT_RULES}\n${OWNER_PLATFORM}${plan.specialty ? `\n${specialtyRules(plan.specialty, modelName)}` : ""}${hireBrief ? `\n${hireBrief}\nThis hire record is what you can see now. Older messages can be behind it. Read it and decide what to say and what to do. Answer in your own words.` : ""}`;
  const input = buildChatInput(prior, words || message, savedPaths);
  if (plan.seeImages) {
    const prompt = input || "Use this image.";
    const priorResponse = imageUrls.length > 0 ? null : await readDocument(imageResponseKey(agentId));
    const content: Record<string, unknown>[] = [{ type: "input_text", text: prompt }];
    for (const dataUrl of imageUrls) content.push({ type: "input_image", image_url: dataUrl });
    const ask = (previousResponseId?: string) => ownerModelStep({
      model: plan.chatModel,
      longHorizon: false,
      instructions,
      input: [{ role: "user", content }],
      tools: [],
      previousResponseId,
      budget,
    });
    let step = await ask(priorResponse || undefined).catch((error: unknown) => {
      if (!priorResponse) throw error;
      return ask(undefined);
    });
    budget.remainingCalls -= 1;
    if (step.responseId) await writeDocument(imageResponseKey(agentId), step.responseId);
    const marker = await rememberImage(agentId, step.image);
    const spoken = dropWaitingLine(acceptReply([step.text.trim(), marker].filter(Boolean).join("\n\n")));
    if (!spoken) throw new ChatReplyError("The model returned no reply.", 502);
    await writeChatTranscript(agentId, [...prior, { role: "owner", text: ownerText }, { role: "agent", text: spoken }]);
    if (!options?.startup) await storeAsk(agentId, null);
    return { text: spoken, ownerText, ask: options?.startup ? await readOwnerAsk(agentId) : null };
  }
  const grants: ToolGrant[] = [
    { name: "read_workspace", approval: "preapproved" },
    { name: "search_workspace", approval: "preapproved" },
    { name: "list_workspace", approval: "preapproved" },
  ];
  grants.push({ name: "stage_owner_file", approval: "preapproved" });
  grants.push({ name: "read_skill", approval: "preapproved" });
  grants.push({ name: "read_skill_file", approval: "preapproved" });
  for (const grant of await chatSkillGrants(agentId, plan.doesTasks)) {
    if (!grants.some((item) => item.name === grant.name)) grants.push(grant);
  }
  const installedSkills = await activeSkills(agentId);
  const produced: string[] = [];
  let asked: OwnerAsk | null = null;
  let stopForAsk = false;
  const extraTools: ExtraTool[] = [{
    name: "ask_owner",
    description: "Show the owner buttons, a multiple choice, or a short text field when you need their choice or a typed fact before you can continue. The screen adds an Other button and a text field. Do not put Other in choices. Accept, reject, the budget, the delivery day, and Confirm and lock USDC already have controls. Do not ask for those here.",
    parameters: {
      ...TOOL_SCHEMA,
      properties: {
        prompt: { type: "string" },
        choices: { type: "array", items: { type: "string" } },
        multiple: { type: "boolean" },
        input: { type: "string" },
      },
      required: ["prompt"],
    },
    run: async (args) => {
      const parsed = parseOwnerAsk(args);
      if (typeof parsed === "string") return parsed;
      asked = parsed;
      stopForAsk = true;
      return "The owner sees the buttons and the field. Wait for their answer. Do not invent it.";
    },
  }, {
    name: "add_skill",
    description: "Add a guidance skill the owner asked for. The name is short. The description says when to use it. The instructions are the full skill text. This activates the skill and grants no script.",
    parameters: {
      ...TOOL_SCHEMA,
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        instructions: { type: "string" },
      },
      required: ["name", "description", "instructions"],
    },
    run: async (args) => {
      try {
        const added = await addGuidanceSkill(owner, agentId, {
          name: typeof args.name === "string" ? args.name : "",
          description: typeof args.description === "string" ? args.description : "",
          instructions: typeof args.instructions === "string" ? args.instructions : "",
        });
        produced.push(added);
        return added;
      } catch (error) {
        return error instanceof Error ? error.message : "That skill was not added.";
      }
    },
  }];
  if (plan.tools.includes("transcribe_voice")) {
    extraTools.push({
      name: "transcribe_voice",
      description: "Transcribe the voice file the owner attached. Call this only when the owner asks for a transcript.",
      parameters: { ...TOOL_SCHEMA, properties: {}, required: [] },
      run: async () => {
        const lines: string[] = [];
        for (const file of voiceFiles) {
          const transcript = await transcribeWav(file.wav, budget);
          if (!transcript) throw new ChatReplyError("The voice file had no words.", 502);
          const heardScan = scanPlaintext(transcript, "text");
          if (!heardScan.allow) throw new ChatReplyError(heardScan.reason, 400);
          lines.push(`${file.name}: ${transcript}`);
        }
        const transcript = lines.join("\n");
        produced.push(transcript);
        return transcript;
      },
    });
  }
  if (plan.tools.includes("make_image")) {
    extraTools.push({
      name: "make_image",
      description: "Make or edit an image with the owner's image model. Call this only when the owner asks for a picture or an edit.",
      parameters: { ...TOOL_SCHEMA, properties: { prompt: { type: "string" } }, required: ["prompt"] },
      run: async (args) => {
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) return "Say what the image should show.";
        if (prompt.length > 4_000) return "That image request is too long.";
        const scan = scanPlaintext(prompt, "text");
        if (!scan.allow) return scan.reason;
        const priorResponse = imageUrls.length > 0 ? null : await readDocument(imageResponseKey(agentId));
        const content: Record<string, unknown>[] = [{ type: "input_text", text: prompt }];
        for (const dataUrl of imageUrls) content.push({ type: "input_image", image_url: dataUrl });
        const ask = (previousResponseId?: string) => ownerModelStep({
          model,
          longHorizon: false,
          instructions: "Make or edit the image the owner asked for.",
          input: [{ role: "user", content }],
          tools: [],
          previousResponseId,
          budget,
        });
        const step = await ask(priorResponse || undefined).catch((error: unknown) => {
          if (!priorResponse) throw error;
          return ask(undefined);
        });
        budget.remainingCalls -= 1;
        if (step.responseId) await writeDocument(imageResponseKey(agentId), step.responseId);
        const marker = await rememberImage(agentId, step.image);
        if (!marker) throw new ChatReplyError("The model returned no image.", 502);
        produced.push(marker);
        return marker;
      },
    });
  }
  if (plan.tools.includes("segment_image")) {
    extraTools.push({
      name: "segment_image",
      description: "Segment one object in the attached image. The phrase is a short noun phrase. Call this only when the owner asks you to segment.",
      parameters: { ...TOOL_SCHEMA, properties: { phrase: { type: "string" } }, required: ["phrase"] },
      run: async (args) => {
        const phrase = typeof args.phrase === "string" ? args.phrase.trim() : "";
        if (!phrase || phrase.length > 120) return "Name one object in a few words, such as yellow school bus.";
        const scan = scanPlaintext(phrase, "text");
        if (!scan.allow) return scan.reason;
        const image = imageUrls[0];
        if (!image) return "Attach an image to segment.";
        const step = await ownerModelStep({
          model,
          longHorizon: false,
          instructions: phrase,
          input: [{ role: "user", content: [{ type: "input_text", text: phrase }, { type: "input_image", image_url: image }] }],
          tools: [],
          budget,
        });
        budget.remainingCalls -= 1;
        const summary = segmentSummary(phrase, step.text);
        produced.push(summary);
        return summary;
      },
    });
  }
  const hire = ownerHireTool(owner, agentId);
  extraTools.push({
    ...hire,
    run: async (args) => {
      try {
        const result = await hire.run(args);
        produced.push(result);
        return result;
      } catch (error) {
        if (error instanceof DealError) return error.message;
        throw error;
      }
    },
  });
  const hireGrant = plan.doesTasks
    ? "run_hire is granted. When the owner asks to hire, call run_hire in this turn with action brief and the work they already described. Do not say the tool is missing or unavailable."
    : "run_hire is granted. Call it only when the owner asks to hire another agent.";
  const grantedLine = `Granted this turn: ${[...grants.map((grant) => grant.name), ...extraTools.map((tool) => tool.name)].join(", ")}. ${hireGrant}`;
  const opening = plan.specialty && imageUrls.length > 0
    ? [{ role: "user", content: [{ type: "input_text", text: input }, ...imageUrls.map((dataUrl) => ({ type: "input_image", image_url: dataUrl }))] }]
    : undefined;
  let text = "";
  try {
    if (savedPaths.length > 0) {
      activity?.("Replying");
      const step = await ownerModelStep({
        model: plan.chatModel,
        longHorizon: false,
        instructions: `${instructions}\n${grantedLine}`,
        input,
        tools: [],
        budget,
      });
      budget.remainingCalls -= 1;
      text = step.text.trim();
    } else {
      const loop = await executeOwnerLoop({
        message: input,
        opening,
        prefix: `${instructions}\n${grantedLine}`,
        skills: installedSkills,
        grants,
        approvedTools: [],
        workspace: seeded.tree,
        budget,
        extraTools,
        mcpNamespaces: namespaceTools(await readConnections(agentId)),
        web: await webEnabled(agentId),
        callMcp: (namespace, name, args) => callConnectedTool(agentId, namespace, name, args),
        callModel: (step) => ownerModelStep({
          model: plan.chatModel,
          longHorizon: false,
          budget,
          ...step,
        }),
        stopWhen: () => stopForAsk,
        onActivity: activity,
        runEntry: async () => {
          throw new ChatReplyError("This conversation does not run scripts.", 400);
        },
        stageOwnerFile: async (path, fileText) => {
          try {
            const staged = stageOwnerDraft(path, fileText);
            stagedNow.set(staged.path, staged);
            return `Staged ${staged.path}. It is not saved until the owner says confirm save.`;
          } catch (error) {
            return error instanceof Error ? error.message : "That file was not staged.";
          }
        },
      });
      text = loop.text.trim();
      if (confirmation && stagedNow.size > 0) {
        savedPaths = await saveOwnerFiles(owner, agentId, [...stagedNow.values()]);
        await writeChatDrafts(agentId, []);
      } else if (stagedNow.size > 0) {
        const existing = await readChatDrafts(agentId);
        const merged = new Map(existing.map((file) => [file.path, file]));
        for (const file of stagedNow.values()) merged.set(file.path, file);
        await writeChatDrafts(agentId, [...merged.values()]);
      }
    }
  } catch (error) {
    if (savedPaths.length === 0) throw error;
    text = "";
  }
  if (!text.trim() && asked) text = asked.prompt;
  const fact = savedLine(savedPaths);
  const missing = produced.filter((item) => item.startsWith("[[image:") && !text.includes(item));
  if (missing.length > 0) text = [text.trim(), ...missing].filter(Boolean).join("\n\n");
  if (!text.trim() && produced.length > 0) text = produced.join("\n\n");
  if (heard) text = [`Heard: ${heard}`, text.trim()].filter(Boolean).join("\n\n");
  const prose = text.replace(/\[\[image:[a-f0-9]+\]\]/g, "").trim();
  const replyScan = prose ? scanPlaintext(prose, "text") : { allow: true, reason: "" };
  const modelText = dropWaitingLine(acceptReply(replyScan.allow ? text : text.replace(prose, "")));
  if (!modelText && !fact) throw new ChatReplyError(prose && !replyScan.allow ? replyScan.reason : "The model returned no reply.", prose && !replyScan.allow ? 400 : 502);
  const spoken = fact && !modelText.startsWith("Saved ") ? `${fact}${modelText ? `\n\n${modelText}` : ""}` : modelText;
  const next: ChatTurn[] = [...prior, { role: "owner", text: ownerText }, { role: "agent", text: spoken }];
  await writeChatTranscript(agentId, next);
  const ask = asked ?? (options?.startup ? await readOwnerAsk(agentId) : null);
  if (!options?.startup || asked) await storeAsk(agentId, asked);
  return { text: spoken, ownerText, ask };
}
