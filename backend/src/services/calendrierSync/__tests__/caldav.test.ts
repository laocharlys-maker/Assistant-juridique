import { describe, it, expect } from "vitest";
import { buildICalendarEvent } from "../caldav";

describe("buildICalendarEvent", () => {
  it("génère un VEVENT complet pour un événement avec heure précise", () => {
    const ical = buildICalendarEvent("aurore-abc123", {
      titre: "RDV client Koffi",
      description: "Point sur le dossier",
      lieu: "Cabinet, salle 2",
      dateDebut: new Date("2026-08-10T09:00:00.000Z"),
      dateFin: new Date("2026-08-10T10:00:00.000Z"),
      touteLaJournee: false,
    });

    expect(ical).toContain("BEGIN:VCALENDAR");
    expect(ical).toContain("BEGIN:VEVENT");
    expect(ical).toContain("UID:aurore-abc123");
    expect(ical).toContain("DTSTART:20260810T090000Z");
    expect(ical).toContain("DTEND:20260810T100000Z");
    expect(ical).toContain("SUMMARY:RDV client Koffi");
    expect(ical).toContain("DESCRIPTION:Point sur le dossier");
    expect(ical).toContain("LOCATION:Cabinet, salle 2".replace(",", "\\,"));
    expect(ical).toContain("END:VEVENT");
    expect(ical).toContain("END:VCALENDAR");
  });

  it("utilise DTSTART/DTEND;VALUE=DATE pour un événement toute la journée", () => {
    const ical = buildICalendarEvent("aurore-jour", {
      titre: "Échéance — Appel",
      dateDebut: new Date("2026-09-15T00:00:00.000Z"),
      touteLaJournee: true,
    });

    expect(ical).toContain("DTSTART;VALUE=DATE:20260915");
    expect(ical).toContain("DTEND;VALUE=DATE:20260916");
    expect(ical).not.toContain("DTSTART:2026");
  });

  it("échappe les caractères spéciaux (virgule, point-virgule, retour à la ligne) selon RFC 5545", () => {
    const ical = buildICalendarEvent("aurore-echap", {
      titre: "Titre, avec; des\ncaractères",
      dateDebut: new Date("2026-08-10T09:00:00.000Z"),
      touteLaJournee: false,
    });

    expect(ical).toContain("SUMMARY:Titre\\, avec\\; des\\ncaractères");
  });

  it("omet DESCRIPTION/LOCATION quand absents (pas de ligne vide)", () => {
    const ical = buildICalendarEvent("aurore-minimal", {
      titre: "Tâche",
      dateDebut: new Date("2026-08-10T09:00:00.000Z"),
      touteLaJournee: false,
    });

    expect(ical).not.toMatch(/DESCRIPTION:/);
    expect(ical).not.toMatch(/LOCATION:/);
  });

  it("utilise une durée par défaut d'1h quand aucune dateFin n'est fournie (événement horodaté)", () => {
    const ical = buildICalendarEvent("aurore-defaut", {
      titre: "Appel",
      dateDebut: new Date("2026-08-10T09:00:00.000Z"),
      touteLaJournee: false,
    });

    expect(ical).toContain("DTSTART:20260810T090000Z");
    expect(ical).toContain("DTEND:20260810T100000Z");
  });
});
