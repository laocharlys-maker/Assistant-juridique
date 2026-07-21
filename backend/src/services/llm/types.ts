import { ActionOutput } from "../../schemas/action";

export interface LlmProvider {
  extractAction(rawInput: string): Promise<ActionOutput>;
}

export class LlmOutputError extends Error {
  constructor(message: string, public readonly rawResponse: string) {
    super(message);
    this.name = "LlmOutputError";
  }
}
