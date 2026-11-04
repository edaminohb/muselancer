/** Model ids and wording from Meta's Models page: https://dev.meta.ai/docs/models */

export type MuseModel = {
  id: string;
  name: string;
  description: string;
};

export const DEFAULT_ORDINARY = "muse-spark-1.3";
export const DEFAULT_LONG_HORIZON = "muse-wonder-1.0";

const SPARK = "Muse Spark is Meta's model for agentic and coding work, such as multi-step tool loops, software engineering assistants, and long-context reasoning.";
const CONTRIBUTOR = "In Contributor mode, your content may be used to train future Meta models, in exchange for a lower price.";

export const MUSE_MODELS: MuseModel[] = [
  {
    id: "muse-wonder-1.0",
    name: "Muse Wonder",
    description: "Muse Wonder is Meta's most capable model, built for complex software engineering and long-horizon agentic work.",
  },
  {
    id: "muse-spark-1.3",
    name: "Muse Spark 1.3",
    description: `${SPARK} the latest version, tuned for agentic workflows (multi-step tool, browser, and long-horizon tasks) with improved coding over 1.2. Supports all reasoning effort levels, including the "max" level for extended reasoning (not available with muse-spark-1.3-contributor). Recommended for new work.`,
  },
  {
    id: "muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    description: `${SPARK} ${CONTRIBUTOR}`,
  },
  {
    id: "muse-image-1.0",
    name: "Muse Image",
    description: "Muse Image is Meta's image generation model line. Send a text prompt (and optional reference images) and get an image back, or send an image with an instruction to edit it.",
  },
  {
    id: "muse-voice-transcribe-1.0",
    name: "Muse Voice Transcribe",
    description: "Muse Voice Transcribe is Meta's speech-to-text model on Meta Model API. Use it to transcribe live audio streams or supported audio files.",
  },
  {
    id: "sam-3.1",
    name: "Segment Anything Model",
    description: "SAM 3.1 is Meta's segmentation model on Meta Model API. Give it a short noun phrase such as \"yellow school bus\" with an image or video, and it returns every match as a box and a pixel-accurate mask.",
  },
];

const ALIASES: Record<string, string> = { "muse-wonder": DEFAULT_LONG_HORIZON };

export function canonicalModel(model: string): string {
  const trimmed = typeof model === "string" ? model.trim() : "";
  return ALIASES[trimmed] ?? trimmed;
}

export function performsTasks(registered: string): boolean {
  const id = canonicalModel(registered);
  return id === "muse-wonder-1.0" || id === "muse-spark-1.3" || id === "muse-spark-1.3-contributor";
}

/** Text and structured calls use a conversation model. Voice, image, and segmentation stay for that work. */
export function conversationModel(registered: string): string {
  const id = canonicalModel(registered);
  if (performsTasks(id)) return id;
  return DEFAULT_ORDINARY;
}

/** A specialty model does not hand the task to the text model. */
export function taskRefusal(registered: string): string | null {
  if (performsTasks(registered)) return null;
  return "This agent does not do that task. The text model does not do the work.";
}

export function museModel(model: string): MuseModel | undefined {
  const id = canonicalModel(model);
  return MUSE_MODELS.find((item) => item.id === id);
}
