function isTransientStatus(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 503 || status === 429;
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  // 3s de base (donc 3s puis 6s d'attente entre les tentatives) plutot que
  // 1s : un 429 "rate_limit_exceeded" de Groq indique typiquement un delai
  // de reessai de l'ordre de 5s, un delai plus court ne laisse pas le temps
  // au quota de se liberer et fait echouer la derniere tentative pour rien.
  const delayMs = options.delayMs ?? 3000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientStatus(error) || attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}
