// Lot 20 - fiche detail d'un courrier entrant OU sortant (parametre ?type=
// dans l'URL). Reutilise integralement apiFetch/requireSession/initLayout
// (js/api.js, js/layout.js) - aucune nouvelle dependance.
(function () {
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  const NATURE_LABELS = {
    correspondance: "Correspondance",
    convocation: "Convocation",
    assignation: "Assignation",
    signification: "Signification",
    mise_en_demeure: "Mise en demeure",
    courrier_client: "Courrier client",
    courrier_juridiction: "Courrier de juridiction",
    courrier_confrere: "Courrier de confrère",
    courrier_administratif: "Courrier administratif",
    autre: "Autre",
  };
  const MODE_LABELS = {
    main_propre: "Main propre",
    courrier_postal: "Courrier postal",
    huissier: "Huissier",
    email: "Email",
    fax: "Fax",
    autre: "Autre",
  };
  const STATUT_ENTRANT_LABELS = {
    recu: "Reçu", a_affecter: "À affecter", affecte: "Affecté",
    en_traitement: "En traitement", traite: "Traité", classe: "Classé",
  };
  const STATUT_SORTANT_LABELS = { brouillon: "Brouillon", envoye: "Envoyé", classe: "Classé" };
  const PROCHAIN_STATUT_ENTRANT = {
    recu: "a_affecter", a_affecter: "affecte", affecte: "en_traitement", en_traitement: "traite", traite: "classe",
  };
  const ETAPE_LABELS = {
    creation: "Création", affectation: "Affectation", changement_statut: "Changement de statut",
    dossier_rattache: "Dossier rattaché", delai_cree: "Délai créé", action_liee: "Action liée",
    piece_ajoutee: "Pièce ajoutée", envoi: "Envoi", classement: "Classement",
  };

  const params = new URLSearchParams(window.location.search);
  const type = params.get("type") === "sortant" ? "sortant" : "entrant";
  const id = params.get("id");
  const base = `/api/courriers-${type}s`;
  const errorEl = document.getElementById("error");

  let courrier = null;
  let dossiers = [];
  let clients = [];

  async function charger() {
    try {
      courrier = await apiFetch(`${base}/${id}`);
    } catch (err) {
      showError(errorEl, err.message);
      return;
    }
    document.getElementById("fiche-numero").textContent = courrier.numero;
    document.getElementById("fiche-objet").textContent = courrier.objet;
    const labels = type === "entrant" ? STATUT_ENTRANT_LABELS : STATUT_SORTANT_LABELS;
    document.getElementById("fiche-sous-titre").innerHTML =
      `<span class="badge badge-courrier-${courrier.statut}">${labels[courrier.statut] || courrier.statut}</span>` +
      (courrier.dossier ? ` — Dossier ${escapeHtml(courrier.dossier.numeroDossier)} (${escapeHtml(courrier.dossier.nomAffaire)})` : "");

    renderActions();
    renderInfos();
    renderPieces();
    renderHistorique();
    if (type === "entrant") { renderDelais(); renderActionsLiees(); }
    renderReponses();
  }

  function renderActionsLiees() {
    const card = document.getElementById("actions-liees-card");
    const el = document.getElementById("actions-liees-liste");
    const actions = courrier.actions || [];
    if (actions.length === 0) { card.style.display = "none"; return; }
    card.style.display = "block";
    el.innerHTML = actions
      .map((a) => `<div class="action-item"><span class="tag">${escapeHtml(a.nomDocument || a.typeAction)}</span> <span class="badge badge-action-${a.statut}">${a.statut}</span></div>`)
      .join("");
  }

  function renderActions() {
    const bar = document.getElementById("actions-bar");
    const boutons = [];
    if (type === "entrant") {
      if (courrier.statut !== "classe") {
        boutons.push(`<button type="button" data-action="affecter">Affecter</button>`);
        boutons.push(`<button type="button" class="secondary" data-action="avancer-statut">Faire avancer le statut</button>`);
        boutons.push(`<button type="button" class="secondary" data-action="creer-delai">Créer un délai</button>`);
        boutons.push(`<button type="button" class="secondary" data-action="creer-action">Créer une action</button>`);
        boutons.push(`<button type="button" class="secondary" data-action="repondre">Répondre au courrier</button>`);
        boutons.push(`<button type="button" class="danger" data-action="classer">Classer</button>`);
      }
    } else {
      if (courrier.statut === "brouillon") {
        boutons.push(`<button type="button" data-action="envoyer">Marquer comme envoyé</button>`);
      }
      if (courrier.statut !== "classe") {
        boutons.push(`<button type="button" class="secondary" data-action="classer-sortant">Classer</button>`);
      }
    }
    bar.innerHTML = boutons.join("");

    bar.querySelector('[data-action="affecter"]')?.addEventListener("click", ouvrirModalAffecter);
    bar.querySelector('[data-action="avancer-statut"]')?.addEventListener("click", avancerStatut);
    bar.querySelector('[data-action="creer-delai"]')?.addEventListener("click", ouvrirModalDelai);
    bar.querySelector('[data-action="creer-action"]')?.addEventListener("click", creerAction);
    bar.querySelector('[data-action="repondre"]')?.addEventListener("click", ouvrirModalRepondre);
    bar.querySelector('[data-action="classer"]')?.addEventListener("click", () => changerStatutEntrant("classe"));
    bar.querySelector('[data-action="envoyer"]')?.addEventListener("click", async () => {
      try { await apiFetch(`${base}/${id}/envoyer`, { method: "POST" }); await charger(); } catch (err) { showError(errorEl, err.message); }
    });
    bar.querySelector('[data-action="classer-sortant"]')?.addEventListener("click", async () => {
      try { await apiFetch(`${base}/${id}/classer`, { method: "POST" }); await charger(); } catch (err) { showError(errorEl, err.message); }
    });
  }

  async function avancerStatut() {
    const prochain = PROCHAIN_STATUT_ENTRANT[courrier.statut];
    if (!prochain) return;
    await changerStatutEntrant(prochain);
  }

  async function changerStatutEntrant(statut) {
    try {
      await apiFetch(`${base}/${id}/statut`, { method: "POST", body: { statut } });
      await charger();
    } catch (err) {
      showError(errorEl, err.message);
    }
  }

  // --- Informations / "compléter la fiche" ---

  function renderInfos() {
    const el = document.getElementById("infos-affichage");
    const lignes = [];
    if (type === "entrant") {
      lignes.push(["Nature", courrier.nature ? NATURE_LABELS[courrier.nature] : null]);
      lignes.push(["Expéditeur", courrier.expediteur]);
      lignes.push(["Date du courrier", courrier.dateCourrier ? new Date(courrier.dateCourrier).toLocaleDateString("fr-FR") : null]);
      lignes.push(["Reçu le", new Date(courrier.dateReception).toLocaleString("fr-FR")]);
      lignes.push(["Mode de réception", courrier.modeReception ? MODE_LABELS[courrier.modeReception] : null]);
      lignes.push(["Réceptionné par", courrier.receptionnePar?.nom]);
      lignes.push(["Affecté à", courrier.affecteA?.nom]);
    } else {
      lignes.push(["Nature", courrier.nature ? NATURE_LABELS[courrier.nature] : null]);
      lignes.push(["Destinataire", courrier.destinataire]);
      lignes.push(["Date du courrier", courrier.dateCourrier ? new Date(courrier.dateCourrier).toLocaleDateString("fr-FR") : null]);
      lignes.push(["Envoyé le", courrier.dateEnvoi ? new Date(courrier.dateEnvoi).toLocaleString("fr-FR") : null]);
      lignes.push(["Mode d'envoi", courrier.modeEnvoi ? MODE_LABELS[courrier.modeEnvoi] : null]);
      lignes.push(["Rédigé par", courrier.redigePar?.nom]);
    }
    lignes.push(["Client", courrier.client?.nom]);
    lignes.push(["Dossier", courrier.dossier ? `${courrier.dossier.numeroDossier} — ${courrier.dossier.nomAffaire}` : null]);
    lignes.push(["Observations", courrier.observations]);

    el.innerHTML = `<table>${lignes
      .map(([label, valeur]) => `<tr><th style="text-align:left; padding:4px 12px 4px 0; vertical-align:top; color:var(--muted);">${label}</th><td>${valeur ? escapeHtml(String(valeur)) : '<span class="muted">— non renseigné —</span>'}</td></tr>`)
      .join("")}</table>`;
  }

  async function chargerReferentiels() {
    try {
      const { dossiers: d } = await apiFetch("/api/dossiers");
      dossiers = d;
    } catch { /* non bloquant */ }
    try {
      clients = await apiFetch("/api/clients");
    } catch { /* non bloquant */ }
  }

  function ouvrirFormulaireEdition() {
    const form = document.getElementById("infos-form");
    const champsSpecifiques = type === "entrant"
      ? `<label>Expéditeur</label><input name="expediteur" value="${escapeHtml(courrier.expediteur || "")}" />
         <label>Mode de réception</label><select name="modeReception"><option value="">— non précisé —</option>${Object.entries(MODE_LABELS).map(([k, l]) => `<option value="${k}" ${courrier.modeReception === k ? "selected" : ""}>${l}</option>`).join("")}</select>`
      : `<label>Destinataire</label><input name="destinataire" value="${escapeHtml(courrier.destinataire || "")}" />
         <label>Mode d'envoi</label><select name="modeEnvoi"><option value="">— non précisé —</option>${Object.entries(MODE_LABELS).map(([k, l]) => `<option value="${k}" ${courrier.modeEnvoi === k ? "selected" : ""}>${l}</option>`).join("")}</select>`;

    form.innerHTML = `
      <label>Objet</label><input name="objet" value="${escapeHtml(courrier.objet)}" required />
      <label>Nature</label><select name="nature"><option value="">— non précisée —</option>${Object.entries(NATURE_LABELS).map(([k, l]) => `<option value="${k}" ${courrier.nature === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      ${champsSpecifiques}
      <label>Date du courrier</label><input name="dateCourrier" type="date" value="${courrier.dateCourrier ? courrier.dateCourrier.slice(0, 10) : ""}" />
      <label>Client</label><select name="clientId"><option value="">— aucun —</option>${clients.map((c) => `<option value="${c.id}" ${courrier.client && courrier.clientId === c.id ? "selected" : ""}>${escapeHtml(c.nom)}</option>`).join("")}</select>
      <label>Dossier</label><select name="dossierId"><option value="">— aucun —</option>${dossiers.map((d) => `<option value="${d.id}" ${courrier.dossierId === d.id ? "selected" : ""}>${escapeHtml(d.numeroDossier)} — ${escapeHtml(d.nomAffaire)}</option>`).join("")}</select>
      <label>Observations</label><textarea name="observations" rows="3">${escapeHtml(courrier.observations || "")}</textarea>
      <div style="display:flex; gap:10px; margin-top:14px;">
        <button type="submit">Enregistrer</button>
        <button type="button" class="secondary" id="annuler-edition-btn">Annuler</button>
      </div>
    `;
    document.getElementById("infos-affichage").style.display = "none";
    form.style.display = "block";
    document.getElementById("annuler-edition-btn").addEventListener("click", () => {
      form.style.display = "none";
      document.getElementById("infos-affichage").style.display = "block";
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = {
        objet: fd.get("objet"),
        nature: fd.get("nature") || null,
        dateCourrier: fd.get("dateCourrier") || null,
        clientId: fd.get("clientId") || null,
        dossierId: fd.get("dossierId") || null,
        observations: fd.get("observations") || null,
      };
      if (type === "entrant") { body.expediteur = fd.get("expediteur") || null; body.modeReception = fd.get("modeReception") || null; }
      else { body.destinataire = fd.get("destinataire") || null; body.modeEnvoi = fd.get("modeEnvoi") || null; }
      try {
        await apiFetch(`${base}/${id}`, { method: "PATCH", body });
        form.style.display = "none";
        document.getElementById("infos-affichage").style.display = "block";
        await charger();
      } catch (err) {
        showError(errorEl, err.message);
      }
    };
  }

  document.getElementById("editer-btn").addEventListener("click", ouvrirFormulaireEdition);

  // --- Pieces ---

  function renderPieces() {
    const el = document.getElementById("pieces-liste");
    const pieces = [...(courrier.documents || []).map((d) => ({ ...d, reelle: true })), ...(courrier.piecesJointes || []).map((p) => ({ ...p, reelle: false }))];
    if (pieces.length === 0) {
      el.innerHTML = '<p class="muted">Aucune pièce.</p>';
      return;
    }
    el.innerHTML = pieces
      .map(
        (p) => `<div class="action-item">
          <span class="tag">${escapeHtml(p.nomOriginal)}</span>
          ${p.reelle ? `<a href="/api/documents/${p.id}?inline=1" target="_blank">Voir</a>` : '<span class="muted">— en attente d\'un dossier pour l\'OCR —</span>'}
          <p class="muted" style="margin:4px 0 0;">Ajoutée le ${new Date(p.createdAt).toLocaleString("fr-FR")}</p>
        </div>`
      )
      .join("");
  }

  document.getElementById("piece-input").addEventListener("change", (e) => {
    const fichier = e.target.files[0];
    if (!fichier) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await apiFetch(`${base}/${id}/pieces`, { method: "POST", body: { nom: fichier.name, fichierDataUrl: reader.result } });
        await charger();
      } catch (err) {
        showError(errorEl, err.message);
      } finally {
        e.target.value = "";
      }
    };
    reader.onerror = () => showError(errorEl, "Impossible de lire ce fichier.");
    reader.readAsDataURL(fichier);
  });

  // --- Delais (entrant uniquement) ---

  function renderDelais() {
    const card = document.getElementById("delais-card");
    const el = document.getElementById("delais-liste");
    const calculs = courrier.delaiCalculs || [];
    if (calculs.length === 0) {
      card.style.display = "none";
      return;
    }
    card.style.display = "block";
    el.innerHTML = calculs
      .map(
        (c) => `<div class="action-item">
          <span class="tag">${escapeHtml(c.delaiType.nom)}</span>
          <div>Départ : ${new Date(c.dateDepart).toLocaleDateString("fr-FR")} → <strong>Date limite : ${new Date(c.dateLimite).toLocaleDateString("fr-FR")}</strong></div>
        </div>`
      )
      .join("");
  }

  async function ouvrirModalDelai() {
    const modal = document.getElementById("delai-modal");
    const select = modal.querySelector('[name="delaiTypeId"]');
    try {
      const types = await apiFetch("/api/delais-types");
      select.innerHTML = types.map((t) => `<option value="${t.id}">${escapeHtml(t.nom)} (${t.nombreUnites} ${t.unite})</option>`).join("");
    } catch (err) {
      showError(errorEl, err.message);
      return;
    }
    modal.hidden = false;
  }

  document.getElementById("delai-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = document.getElementById("delai-error");
    errEl.textContent = "";
    try {
      await apiFetch(`${base}/${id}/delai`, { method: "POST", body: { delaiTypeId: fd.get("delaiTypeId"), dateDepart: fd.get("dateDepart") } });
      document.getElementById("delai-modal").hidden = true;
      await charger();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  // --- Affecter ---

  async function ouvrirModalAffecter() {
    const modal = document.getElementById("affecter-modal");
    const select = modal.querySelector('[name="affecteAId"]');
    try {
      const utilisateurs = await apiFetch("/api/courriers-entrants-affectables");
      select.innerHTML = utilisateurs.map((u) => `<option value="${u.id}" ${courrier.affecteAId === u.id ? "selected" : ""}>${escapeHtml(u.nom)}</option>`).join("");
    } catch (err) {
      showError(errorEl, err.message);
      return;
    }
    modal.hidden = false;
  }

  document.getElementById("affecter-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = document.getElementById("affecter-error");
    errEl.textContent = "";
    try {
      await apiFetch(`${base}/${id}/affecter`, { method: "POST", body: { affecteAId: fd.get("affecteAId") } });
      document.getElementById("affecter-modal").hidden = true;
      await charger();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  // --- Creer/lier une action - webActions.ts et nouvelle-action.html
  // restent totalement inchanges : on ouvre "Nouvelle action" dans un
  // nouvel onglet (dossier pre-rempli), puis on lie APRES COUP l'action
  // creee (ou une action deja existante) via POST .../lier-action.

  async function creerAction() {
    const modal = document.getElementById("action-modal");
    const errEl = document.getElementById("action-error");
    errEl.textContent = "";

    if (!courrier.dossierId) {
      document.getElementById("action-sans-dossier").style.display = "block";
      document.getElementById("action-avec-dossier").style.display = "none";
      modal.hidden = false;
      return;
    }

    document.getElementById("action-sans-dossier").style.display = "none";
    document.getElementById("action-avec-dossier").style.display = "block";
    document.getElementById("ouvrir-nouvelle-action-link").href = `/nouvelle-action.html?dossierId=${courrier.dossierId}`;

    const select = document.querySelector('#lier-action-form [name="actionId"]');
    select.innerHTML = '<option value="">Chargement…</option>';
    try {
      const dossier = await apiFetch(`/api/dossiers/${courrier.dossierId}`);
      const dejaLiees = new Set((courrier.actions || []).map((a) => a.id));
      const disponibles = (dossier.actions || []).filter((a) => !dejaLiees.has(a.id));
      select.innerHTML = disponibles.length
        ? disponibles.map((a) => `<option value="${a.id}">${escapeHtml(a.nomDocument || a.typeAction)} — ${new Date(a.createdAt).toLocaleDateString("fr-FR")}</option>`).join("")
        : '<option value="">— aucune action disponible sur ce dossier —</option>';
    } catch (err) {
      errEl.textContent = err.message;
    }
    modal.hidden = false;
  }

  document.getElementById("lier-action-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = document.getElementById("action-error");
    errEl.textContent = "";
    const actionId = fd.get("actionId");
    if (!actionId) return;
    try {
      await apiFetch(`${base}/${id}/lier-action`, { method: "POST", body: { actionId } });
      document.getElementById("action-modal").hidden = true;
      await charger();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  // --- Repondre au courrier (cree un CourrierSortant lie) ---

  function ouvrirModalRepondre() {
    const modal = document.getElementById("repondre-modal");
    const form = modal.querySelector("form");
    form.objet.value = `Réponse : ${courrier.objet}`;
    form.destinataire.value = courrier.expediteur || "";
    modal.hidden = false;
  }

  document.getElementById("repondre-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = document.getElementById("repondre-error");
    errEl.textContent = "";
    try {
      const reponse = await apiFetch("/api/courriers-sortants", {
        method: "POST",
        body: {
          objet: fd.get("objet"),
          destinataire: fd.get("destinataire") || undefined,
          reponseAId: id,
          dossierId: courrier.dossierId || undefined,
          clientId: courrier.clientId || undefined,
        },
      });
      window.location.href = `/courrier-fiche.html?type=sortant&id=${reponse.id}`;
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  function renderReponses() {
    const card = document.getElementById("reponses-card");
    const el = document.getElementById("reponses-liste");
    document.getElementById("reponses-titre").textContent = type === "entrant" ? "Réponses" : "Répond à";

    if (type === "entrant") {
      const reponses = courrier.reponses || [];
      if (reponses.length === 0) { card.style.display = "none"; return; }
      card.style.display = "block";
      el.innerHTML = reponses
        .map((r) => `<a class="action-item" href="/courrier-fiche.html?type=sortant&id=${r.id}" style="display:block; text-decoration:none; color:inherit;"><span class="tag">${escapeHtml(r.numero)}</span> ${escapeHtml(r.objet)}</a>`)
        .join("");
    } else {
      if (!courrier.reponseA) { card.style.display = "none"; return; }
      card.style.display = "block";
      const o = courrier.reponseA;
      el.innerHTML = `<a class="action-item" href="/courrier-fiche.html?type=entrant&id=${o.id}" style="display:block; text-decoration:none; color:inherit;"><span class="tag">${escapeHtml(o.numero)}</span> ${escapeHtml(o.objet)}${o.expediteur ? ` — de ${escapeHtml(o.expediteur)}` : ""}</a>`;
    }
  }

  // --- Historique (Journal d'audit) ---

  function renderHistorique() {
    const el = document.getElementById("historique-liste");
    const logs = courrier.auditLogs || [];
    if (logs.length === 0) {
      el.innerHTML = '<p class="muted">Aucun évènement enregistré.</p>';
      return;
    }
    el.innerHTML = logs
      .slice()
      .reverse()
      .map(
        (log) => `<div class="action-item">
          <span class="tag">${ETAPE_LABELS[log.etape] || log.etape}</span>
          <div>${escapeHtml(log.detail || "")}</div>
          <p class="muted" style="margin:4px 0 0;">${new Date(log.timestamp).toLocaleString("fr-FR")}</p>
        </div>`
      )
      .join("");
  }

  document.querySelectorAll("[data-fermer-modal]").forEach((btn) => {
    btn.addEventListener("click", () => (document.getElementById(btn.dataset.fermerModal).hidden = true));
  });

  (async () => {
    const me = await requireSession();
    if (!me) return;
    initLayout(me);
    if (!id) {
      showError(errorEl, "Courrier introuvable.");
      return;
    }
    await Promise.all([charger(), chargerReferentiels()]);
  })();
})();
