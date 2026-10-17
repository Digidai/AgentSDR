// Ported from Kandid-ai/AgentSDR bdbf5ef under the root MIT license.
/**
 * Workspace-written instructions for the CRM's AI (crm_settings.draft_instructions
 * and .classification_instructions, edited on CRM Settings).
 *
 * Each is a list of titled blocks ("Tone", "Who we are", "Pricing rules"),
 * stored as jsonb and rendered into one Markdown section per block.
 *
 * They go into the system prompt, after the fixed rules, because they come from
 * the people running the CRM — unlike profile, message and Knowledge text, which
 * the prompts treat as untrusted data. The fixed rules still win: instructions
 * shape tone and judgement, they cannot make the model send, invent facts,
 * leave the taxonomy or break the output format.
 *
 * Kept free of runtime imports so the settings UI can share the types and caps.
 */
export type AiInstructionBlock = {
  id: string;
  title: string;
  content: string;
};

export const MAX_AI_INSTRUCTION_BLOCKS = 50;
export const MAX_AI_INSTRUCTION_TITLE_LENGTH = 200;
export const MAX_AI_INSTRUCTION_CONTENT_LENGTH = 8_000;
/** Across every block of one list, as rendered into the prompt. */
export const MAX_AI_INSTRUCTIONS_TOTAL_LENGTH = 20_000;

export type AiInstructionsPurpose = "draft" | "classification";

const PREAMBLES: Record<AiInstructionsPurpose, string> = {
  draft: [
    "Operator instructions follow, written by the team that runs this CRM.",
    "Follow them for tone, style, length, wording, positioning and what to offer or avoid.",
    "They do not override the rules above: never send anything, never claim facts absent from the supplied context, and keep to the channel constraints and the structured output.",
  ].join(" "),
  classification: [
    "Operator instructions follow, written by the team that runs this CRM.",
    "Use them when judging which category and subcategory a reply belongs to.",
    "They do not override the rules above: use only the supplied taxonomy keys and answer only through the structured result function.",
  ].join(" "),
};

/**
 * Stored blocks → the full text they render to, or null when no block has
 * content. Tolerates anything jsonb can hold; malformed entries are skipped.
 */
export function renderAiInstructions(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const sections: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const { title, content } = block as Partial<AiInstructionBlock>;
    const body = typeof content === "string" ? content.trim() : "";
    if (!body) continue;
    const heading = typeof title === "string" ? title.trim() : "";
    sections.push(heading ? `## ${heading}\n${body}` : body);
  }
  return sections.length ? sections.join("\n\n") : null;
}

/** What the prompt receives: the rendered blocks, capped as a last resort (the API already enforces the cap). */
export function formatAiInstructions(blocks: unknown): string | null {
  const text = renderAiInstructions(blocks);
  if (!text) return null;
  return text.length > MAX_AI_INSTRUCTIONS_TOTAL_LENGTH
    ? text.slice(0, MAX_AI_INSTRUCTIONS_TOTAL_LENGTH)
    : text;
}

/** The system prompt, unchanged when there are no instructions. */
export function withAiInstructions(
  systemPrompt: string,
  purpose: AiInstructionsPurpose,
  instructions: string | null | undefined,
): string {
  const clean = instructions?.trim();
  if (!clean) return systemPrompt;
  return [
    systemPrompt,
    "",
    PREAMBLES[purpose],
    "<operator_instructions>",
    clean,
    "</operator_instructions>",
  ].join("\n");
}
