/**
 * Boutons/formulaire "Envoyer" (email au client, a un collegue, a
 * l'huissier, ou a soi-meme) pour une action generee - memes regles
 * metier que la fiche dossier (dossier.html, implementation d'origine,
 * non touchee ici pour ne pas risquer de regression sur une page deja
 * fonctionnelle) : extrait ici pour etre reutilise a l'identique sur
 * "Documents generes" (dashboard.html), plutot que de dupliquer
 * ENVOI_CONFIG a deux endroits qui pourraient diverger avec le temps.
 *
 * clientsAvecEmail/collegues/huissiersAnnuaire sont TOUS des listes
 * cabinet-entier (jamais filtrees par dossier - verifie : /api/clients,
 * /api/users/annuaire, /api/huissiers) : un seul chargement de contexte
 * (loadEnvoiContext) suffit pour rendre les controles d'envoi de
 * n'importe quelle action du cabinet, quel que soit son dossier.
 */

const ENVOI_CONFIG = {
  redac: { moi: true },
  conclusions: { collegue: true },
  assignation: { huissier: true, collegue: true },
  mise_en_demeure: { huissier: true, collegue: true },
  requete: { moi: true, collegue: true },
  projet_ordonnance: { moi: true, collegue: true },
  resume_pdf: { moi: true, collegue: true },
  jurisprudence: { moi: true, collegue: true },
  recherche_juridique: { moi: true, collegue: true },
  traduction: { moi: true, collegue: true, client: true },
};
const DEFAULT_ENVOI_CONFIG = { client: true, collegue: true };

function envoiConfigFor(typeAction) {
  if (typeAction === "note_plaidoirie") return null;
  return ENVOI_CONFIG[typeAction] || DEFAULT_ENVOI_CONFIG;
}

async function loadEnvoiContext(me) {
  const context = { me, clientsAvecEmail: [], collegues: [], huissiersAnnuaire: [] };
  try {
    const clients = await apiFetch("/api/clients");
    context.clientsAvecEmail = clients.filter((c) => c.email);
  } catch {
    context.clientsAvecEmail = [];
  }
  try {
    const annuaire = await apiFetch("/api/users/annuaire");
    const autres = annuaire.filter((u) => u.id !== me.id);
    const avocatsAnnuaire = autres.filter((u) => u.role === "titulaire" || u.role === "avocat");
    const collaborateursAnnuaire = autres.filter((u) => u.role === "collaborateur");
    context.collegues = avocatsAnnuaire.concat(collaborateursAnnuaire);
  } catch {
    context.collegues = [];
  }
  try {
    context.huissiersAnnuaire = await apiFetch("/api/huissiers");
  } catch {
    context.huissiersAnnuaire = [];
  }
  return context;
}

/**
 * HTML des controles d'envoi pour une action - vide si ce type de document
 * n'est jamais envoye par email (note de plaidoirie), si l'action n'est pas
 * encore validee, ou (une fois envoyee) un simple rappel du destinataire et
 * de la date.
 */
function renderEnvoiControls(action, context) {
  const { me, clientsAvecEmail, collegues, huissiersAnnuaire } = context;
  const envoiConfig = envoiConfigFor(action.typeAction);
  if (!envoiConfig) return "";

  if (action.statut === "envoye") {
    return `<p class="muted" style="margin-top:8px;">Envoyé à ${escapeHtml(action.destinataireEmail || "")} le ${action.envoyeAt ? new Date(action.envoyeAt).toLocaleString("fr-FR") : ""}</p>`;
  }
  if (action.statut !== "valide") {
    // Indication explicite plutot qu'un formulaire d'envoi qui disparait
    // silencieusement : sans ca, un document non valide n'affiche RIEN ici,
    // ce qui a ete pris a tort pour un bug d'affichage ("aucun bouton
    // d'envoi") alors que c'est le comportement voulu (l'envoi n'est
    // propose qu'une fois le document valide par un avocat/titulaire, voir
    // ENVOI_CONFIG plus haut) - deja le cas sur la fiche dossier, juste
    // jamais explique sur cette page de liste.
    const lienDossier = action.dossier?.id ? `/dossier.html?id=${action.dossier.id}` : null;
    return `<p class="muted" style="margin-top:8px;">Pas encore validé — l'envoi sera possible une fois le document validé${lienDossier ? ` (<a href="${lienDossier}">voir la fiche dossier</a>)` : ""}.</p>`;
  }

  const estCollaborateur = me && me.role === "collaborateur";
  const boutonsEnvoi = [];
  if (envoiConfig.moi) {
    boutonsEnvoi.push(
      `<button type="button" class="secondary" data-envoyer-moi="${action.id}" style="margin:0;">M'envoyer par mail</button>`
    );
  }
  if (envoiConfig.client && !estCollaborateur && clientsAvecEmail.length > 0) {
    boutonsEnvoi.push(
      `<select data-envoyer-client="${action.id}" style="width:auto;">
         <option value="">— Envoyer à un client —</option>
         ${clientsAvecEmail.map((c) => `<option value="${escapeHtml(c.email)}">${escapeHtml(c.nom)}</option>`).join("")}
       </select>`
    );
  }
  if (envoiConfig.collegue && collegues.length > 0) {
    boutonsEnvoi.push(
      `<select data-envoyer-collegue="${action.id}" style="width:auto;">
         <option value="">— Envoyer à un collègue —</option>
         ${collegues.map((u) => `<option value="${escapeHtml(u.email)}">${escapeHtml(u.nom)}</option>`).join("")}
       </select>`
    );
  }
  if (envoiConfig.huissier && huissiersAnnuaire.length > 0) {
    boutonsEnvoi.push(
      `<select data-envoyer-huissier="${action.id}" style="width:auto;">
         <option value="">— Envoyer à l'huissier —</option>
         ${huissiersAnnuaire.map((h) => `<option value="${escapeHtml(h.email)}">${escapeHtml(h.nom)}</option>`).join("")}
       </select>`
    );
  }

  const canUseOwnSignature = me && me.role !== "collaborateur" && me.signatureUrl;
  const canUseResponsableSignature = me && me.role === "collaborateur" && me.peutUtiliserSignatureResponsable;
  const signatureLabel = canUseResponsableSignature
    ? `Insérer la signature de ${escapeHtml(me.responsable?.nom || "mon responsable")}`
    : "Insérer ma signature";
  const hasSignatureOption = canUseOwnSignature || canUseResponsableSignature;
  const signatureCheckbox = hasSignatureOption
    ? `<div style="margin:8px 0 0; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
         <label style="display:flex; align-items:center; gap:6px; font-weight:400; margin:0;">
           <input type="checkbox" name="avecSignature" id="envoi-avecSignature-${action.id}" style="width:auto;" /> ${signatureLabel}
         </label>
         <select name="positionSignature" style="width:auto;">
           <option value="START">Alignée à gauche</option>
           <option value="CENTER">Centrée</option>
           <option value="END" selected>Alignée à droite</option>
         </select>
       </div>`
    : "";

  return `
    <form data-envoyer-form="${action.id}" style="margin-top:10px;">
      ${boutonsEnvoi.length > 0 ? `<div style="margin:0 0 8px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">${boutonsEnvoi.join("")}</div>` : ""}
      ${estCollaborateur ? '<p class="muted" style="margin:0 0 6px;">Tu ne peux envoyer ce document qu\'à un membre du cabinet (pas directement à un client).</p>' : ""}
      <div style="display:flex; gap:8px; align-items:flex-end;">
        <div style="flex:1;">
          <label style="margin:0 0 4px;">Envoyer à (email)</label>
          <input type="email" name="email" id="envoi-email-${action.id}" placeholder="${estCollaborateur ? "choisis un destinataire ci-dessus" : "adresse@example.com"}" required ${estCollaborateur ? "readonly" : ""} />
        </div>
        <button type="submit">Envoyer</button>
      </div>
      ${signatureCheckbox}
    </form>`;
}

/**
 * Attache les gestionnaires d'evenements des controles rendus par
 * renderEnvoiControls() ci-dessus, a appeler une fois apres insertion dans
 * le DOM. `container` peut contenir les formulaires de plusieurs actions a
 * la fois (ex: toute une liste "Documents generes"). `onSent(actionId)` est
 * appele apres un envoi reussi (ex: rafraichir la liste).
 */
function bindEnvoiHandlers(container, context, onSent) {
  container.querySelectorAll("[data-envoyer-form]").forEach((form) => {
    const actionId = form.dataset.envoyerForm;
    // Empeche un clic dans le formulaire (boutons, select, submit) de se
    // propager a un element parent cliquable (ex: l'en-tete d'un
    // accordeon qui l'ouvre/le referme).
    form.addEventListener("click", (e) => e.stopPropagation());
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await apiFetch(`/api/actions/${actionId}/envoyer`, {
          method: "POST",
          body: {
            email: fd.get("email"),
            avecSignature: fd.get("avecSignature") === "on",
            positionSignature: fd.get("positionSignature") || "END",
          },
        });
        if (onSent) onSent(actionId);
      } catch (err) {
        alert(err.message);
      }
    });

    const emailInput = form.querySelector(`#envoi-email-${actionId}`);
    const envoyerMoiBtn = container.querySelector(`[data-envoyer-moi="${actionId}"]`);
    if (envoyerMoiBtn && emailInput) {
      envoyerMoiBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        emailInput.value = context.me.email;
      });
    }
    [
      `[data-envoyer-client="${actionId}"]`,
      `[data-envoyer-collegue="${actionId}"]`,
      `[data-envoyer-huissier="${actionId}"]`,
    ].forEach((selector) => {
      const select = container.querySelector(selector);
      if (!select || !emailInput) return;
      select.addEventListener("click", (e) => e.stopPropagation());
      select.addEventListener("change", () => {
        if (select.value) emailInput.value = select.value;
      });
    });
  });
}
