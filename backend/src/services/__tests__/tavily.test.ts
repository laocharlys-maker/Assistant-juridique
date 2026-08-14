import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchWeb } from "../tavily";

// Verifie uniquement que searchWeb() transmet correctement topic/days a
// l'API Tavily (voir services/veilleJuridique.ts, qui utilise topic:"news"
// + days:7 pour une fraicheur fiable) - jamais le comportement reel de
// l'API Tavily elle-meme (fetch mocke).
describe("searchWeb - transmission de topic/days a l'API Tavily", () => {
  const ancienneCle = process.env.TAVILY_API_KEY;

  beforeEach(() => {
    process.env.TAVILY_API_KEY = "test-cle-tavily";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ancienneCle === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = ancienneCle;
  });

  function mockerFetch() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("inclut topic et days dans la requête quand fournis", async () => {
    const fetchMock = mockerFetch();

    await searchWeb("actualite juridique bail Bénin", 8, undefined, undefined, { topic: "news", days: 7 });

    const corps = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(corps.topic).toBe("news");
    expect(corps.days).toBe(7);
  });

  it("n'inclut ni topic ni days quand absents (comportement inchangé pour les autres appelants)", async () => {
    const fetchMock = mockerFetch();

    await searchWeb("bail commercial jurisprudence", 5, ["coursupreme.bj"]);

    const corps = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(corps.topic).toBeUndefined();
    expect(corps.days).toBeUndefined();
    expect(corps.include_domains).toEqual(["coursupreme.bj"]);
  });
});
