import { marked } from "marked";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildVeilleEmailHtml(facts: {
  cabinetNom: string;
  periode: string;
  destinataireNom: string;
  digestMarkdown: string;
}): string {
  const digestHtml = marked.parse(facts.digestMarkdown, { async: false }) as string;

  return `<!doctype html>
<html lang="fr">
  <body style="margin:0; padding:24px; background-color:#f5f3ee;">
    <div style="font-family:Georgia,'Times New Roman',serif; color:#2b2b28; line-height:1.6; max-width:640px; margin:0 auto; background:#ffffff; border-radius:8px; padding:32px; border:1px solid #e2e0da;">
      <h1 style="font-size:20px; margin:0 0 4px;">Veille juridique hebdomadaire</h1>
      <p style="margin:0 0 24px; color:#6b6a64; font-size:14px;">${escapeHtml(facts.cabinetNom)} — ${escapeHtml(facts.periode)}</p>
      <p>Bonjour ${escapeHtml(facts.destinataireNom)},</p>
      <div style="font-size:15px;">
        ${digestHtml}
      </div>
      <hr style="border:none; border-top:1px solid #e2e0da; margin:32px 0 16px;" />
      <p style="font-size:12px; color:#8a8880;">Ce résumé est généré automatiquement à partir de recherches web récentes ; il ne remplace pas une vérification par l'avocat. Tu peux désactiver la réception de cet email dans Paramètres &gt; Ma réception de la veille juridique.</p>
      <p style="font-size:12px; color:#8a8880;">Cordialement,<br/>Aurore</p>
    </div>
  </body>
</html>`;
}
