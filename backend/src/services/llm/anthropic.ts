import Anthropic from "@anthropic-ai/sdk";
import { actionOutputSchema, actionOutputJsonSchema, ActionOutput } from "../../schemas/action";
import { LEGAL_ASSISTANT_SYSTEM_PROMPT, buildUserPrompt } from "../../prompts/legalAssistant";
import { LlmProvider, LlmOutputError } from "./types";
import { MissingConfigurationError } from "../../lib/configurationError";

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

  async redact(systemPrompt: string, userPrompt: string, options?: { maxTokens?: number }): Promise<string> {
    const message = await this.client.messages.create({
      model: "claude-sonnet-5",
      // 8192 par defaut plutot que 4096 : certaines redactions (recherche
      // de jurisprudence approfondie) visent jusqu'a 3000 mots, ce qui
      // approche voire depasse 4096 tokens de sortie une fois les tableaux
      // comparatifs inclus. Les appels intermediaires (ex: resume d'un
      // extrait de PDF avant combinaison finale) peuvent demander une
      // limite plus basse pour rester sous le quota de tokens/minute des
      // fournisseurs a plan gratuit.
      max_tokens: options?.maxTokens ?? 8192,
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
  // process.env directement, pas env.ANTHROPIC_API_KEY (config/env.ts) -
  // voir services/llm/index.ts, resolveLlmProvider() pour le detail.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new MissingConfigurationError("ANTHROPIC_API_KEY manquant");
  }
  return new AnthropicProvider(apiKey);
}
