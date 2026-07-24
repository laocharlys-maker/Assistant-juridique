function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface AudienceFacts {
  dateAudience: Date;
  juridiction: string;
  chambre: string | null;
  procedureNumero: string | null;
  parties: string;
  qualiteProcedurale: string | null;
  objetProcedure: string | null;
  dernierMotif: string | null;
  diligences: string | null;
  dossier: { numeroDossier: string; nomAffaire: string } | null;
}

function formatJourHeure(date: Date): string {
  const jour = date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Porto-Novo" });
  const heure = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Porto-Novo" });
  return `${jour} — ${heure}`;
}

export function buildRoleSemaineRecapEmailHtml(facts: {
  cabinetNom: string;
  periode: string;
  destinataireNom: string;
  audiences: AudienceFacts[];
}): string {
  const lignes = facts.audiences
    .map(
      (a) => `
      <tr>
        <td style="padding:10px 8px; border-bottom:1px solid #e2e0da; font-size:14px; vertical-align:top;">${escapeHtml(formatJourHeure(a.dateAudience))}</td>
        <td style="padding:10px 8px; border-bottom:1px solid #e2e0da; font-size:14px; vertical-align:top;">
          <strong>${escapeHtml(a.parties)}</strong><br/>
          ${escapeHtml(a.juridiction)}${a.chambre ? " — " + escapeHtml(a.chambre) : ""}${a.procedureNumero ? " · " + escapeHtml(a.procedureNumero) : ""}
          ${a.qualiteProcedurale ? `<br/>Qualité : ${escapeHtml(a.qualiteProcedurale)}` : ""}
          ${a.objetProcedure ? `<br/>Objet : ${escapeHtml(a.objetProcedure)}` : ""}
          ${a.dossier ? `<br/>Dossier lié : ${escapeHtml(a.dossier.numeroDossier)} — ${escapeHtml(a.dossier.nomAffaire)}` : ""}
          ${a.dernierMotif ? `<br/>Dernier motif : ${escapeHtml(a.dernierMotif)}` : ""}
          ${a.diligences ? `<br/>Diligences : ${escapeHtml(a.diligences)}` : ""}
        </td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="fr">
  <body style="margin:0; padding:24px; background-color:#f5f3ee;">
    <div style="font-family:Georgia,'Times New Roman',serif; color:#2b2b28; line-height:1.6; max-width:680px; margin:0 auto; background:#ffffff; border-radius:8px; padding:32px; border:1px solid #e2e0da;">
      <h1 style="font-size:20px; margin:0 0 4px;">Rôle de la semaine</h1>
      <p style="margin:0 0 24px; color:#6b6a64; font-size:14px;">${escapeHtml(facts.cabinetNom)} — semaine du ${escapeHtml(facts.periode)}</p>
      <p>Bonjour ${escapeHtml(facts.destinataireNom)},</p>
      <p style="font-size:15px;">Voici les audiences déjà enregistrées pour la semaine du ${escapeHtml(facts.periode)}, à préparer dans les jours qui viennent.</p>
      <table style="width:100%; border-collapse:collapse; margin-top:16px;">
        <thead>
          <tr>
            <th style="text-align:left; padding:8px; border-bottom:2px solid #2b2b28; font-size:13px;">Quand</th>
            <th style="text-align:left; padding:8px; border-bottom:2px solid #2b2b28; font-size:13px;">Affaire</th>
          </tr>
        </thead>
        <tbody>${lignes}</tbody>
      </table>
      <hr style="border:none; border-top:1px solid #e2e0da; margin:32px 0 16px;" />
      <p style="font-size:12px; color:#8a8880;">Cette liste ne reprend que les audiences déjà saisies dans Aurore ; pense à vérifier auprès du greffe si le rôle complet a bien été publié.</p>
      <p style="font-size:12px; color:#8a8880;">Cordialement,<br/>Aurore</p>
    </div>
  </body>
</html>`;
}
