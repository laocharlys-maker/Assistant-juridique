import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MissingConfigurationError } from "../../../lib/configurationError";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { connexionCalendrierExterne: { update: vi.fn() } },
}));
vi.mock("../../../lib/prisma", () => ({ prisma: prismaMock }));

import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  assurerAccessTokenValide,
  googleCalendarAdapter,
} from "../googleCalendar";

const ENV_KEYS = [
  "GOOGLE_CALENDAR_OAUTH_CLIENT_ID",
  "GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET",
  "GOOGLE_CALENDAR_OAUTH_REDIRECT_URI",
] as const;
let envBackup: Record<string, string | undefined> = {};

describe("googleCalendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envBackup = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID = "client-id-test";
    process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET = "client-secret-test";
    process.env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI = "http://127.0.0.1:3000/api/calendrier-externe/google/callback";
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
    vi.unstubAllGlobals();
  });

  describe("buildGoogleAuthUrl", () => {
    it("lève MissingConfigurationError si les credentials OAuth ne sont pas configurés", () => {
      delete process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID;
      expect(() => buildGoogleAuthUrl("state-1")).toThrow(MissingConfigurationError);
    });

    it("construit une URL de consentement Google avec le state et le scope minimal", () => {
      const url = buildGoogleAuthUrl("state-abc");
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(parsed.searchParams.get("client_id")).toBe("client-id-test");
      expect(parsed.searchParams.get("state")).toBe("state-abc");
      expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events");
      expect(parsed.searchParams.get("access_type")).toBe("offline");
    });
  });

  describe("exchangeCodeForTokens", () => {
    it("échange le code contre des tokens", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const tokens = await exchangeCodeForTokens("code-1");
      expect(tokens.accessToken).toBe("at-1");
      expect(tokens.refreshToken).toBe("rt-1");
      expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(fetchMock).toHaveBeenCalledWith(
        "https://oauth2.googleapis.com/token",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("échoue explicitement si Google ne renvoie aucun refresh_token", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ access_token: "at-1", expires_in: 3600 }) })
      );
      await expect(exchangeCodeForTokens("code-1")).rejects.toThrow(/refresh_token/);
    });
  });

  describe("assurerAccessTokenValide", () => {
    it("renvoie le token existant s'il n'expire pas bientôt (aucun appel réseau)", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const token = await assurerAccessTokenValide({
        id: "c1",
        accessToken: "at-valide",
        refreshToken: "rt-1",
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      } as never);
      expect(token).toBe("at-valide");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("renouvelle et persiste le token quand il est expiré, sans redemander la connexion", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ access_token: "at-nouveau", expires_in: 3600 }) })
      );
      const token = await assurerAccessTokenValide({
        id: "c1",
        accessToken: "at-perime",
        refreshToken: "rt-1",
        tokenExpiresAt: new Date(Date.now() - 1000),
      } as never);
      expect(token).toBe("at-nouveau");
      expect(prismaMock.connexionCalendrierExterne.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "c1" }, data: expect.objectContaining({ accessToken: "at-nouveau" }) })
      );
    });
  });

  describe("googleCalendarAdapter", () => {
    const connexion = {
      id: "c1",
      accessToken: "at-valide",
      refreshToken: "rt-1",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      calendrierUrl: "primary",
    } as never;

    it("creerEvenement : POST vers /calendars/primary/events, renvoie l'id externe", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "google-evt-1" }) });
      vi.stubGlobal("fetch", fetchMock);

      const id = await googleCalendarAdapter.creerEvenement(connexion, {
        titre: "RDV",
        dateDebut: new Date(),
        touteLaJournee: false,
      });
      expect(id).toBe("google-evt-1");
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/calendars/primary/events"),
        expect.objectContaining({ method: "POST" })
      );
    });

    it("supprimerEvenement : un 404 (déjà supprimé côté Google) n'est jamais une erreur", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
      await expect(googleCalendarAdapter.supprimerEvenement(connexion, "google-evt-1")).resolves.toBeUndefined();
    });

    it("modifierEvenement : propage une vraie erreur HTTP (500)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      await expect(
        googleCalendarAdapter.modifierEvenement(connexion, "google-evt-1", {
          titre: "RDV modifié",
          dateDebut: new Date(),
          touteLaJournee: false,
        })
      ).rejects.toThrow();
    });
  });
});
