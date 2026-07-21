import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config/env";
import { actionOutputSchema, actionOutputJsonSchema, ActionOutput } from "../../schemas/action";
import { LEGAL_ASSISTANT_SYSTEM_PROMPT, buildUserPrompt } from "../../prompts/legalAssistant";
import { LlmProvider, LlmOutputError } from "./types";

const EXTRACT_TOOL_NAME = "extraire_action_juridique";

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async extractAction(rawInput: string): Promise<ActionOutput> {
    const message = await this.client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      system: LEGAL_ASSISTANT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(rawInput) }],
      tools: [
        {
          name: EXTRACT_TOOL_NAME,
          description: "Enregistre le resultat structure de l'extraction/redaction juridique.",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input_schema: actionOutputJsonSchema as any,
        },
      ],
      tool_choice: { type: "tool", name: EXTRACT_TOOL_NAME },
    });

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (!toolUse) {
      throw new LlmOutputError(
        "Claude n'a pas retourne d'appel d'outil structure",
        JSON.stringify(message.content)
      );
    }

    const validated = actionOutputSchema.safeParse(toolUse.input);
    if (!validated.success) {
      throw new LlmOutputError(
        `Sortie Claude non conforme au schema : ${validated.error.message}`,
        JSON.stringify(toolUse.input)
      );
    }

    return validated.data;
  }

  async redact(systemPrompt: string, userPrompt: string): Promise<string> {
    const message = await this.client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = message.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );
    return textBlock?.text ?? "";
  }
}

export function createAnthropicProvider(): AnthropicProvider {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY manquant");
  }
  return new AnthropicProvider(env.ANTHROPIC_API_KEY);
}
