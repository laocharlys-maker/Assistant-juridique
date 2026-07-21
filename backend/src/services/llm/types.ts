import { ActionOutput } from "../../schemas/action";

export interface LlmProvider {
  extractAction(rawInput: string): Promise<ActionOutput>;
  /**
   * Redaction pure a partir de faits deja structures (formulaire web) :
   * pas d'extraction, juste transformer les faits fournis en texte redige.
   */
  redact(systemPrompt: string, userPrompt: string): Promise<string>;
}

export class LlmOutputError extends Error {
  constructor(message: string, public readonly rawResponse: string) {
    super(message);
    this.name = "LlmOutputError";
  }
}
