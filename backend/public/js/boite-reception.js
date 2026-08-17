// Lot 16 - "Boite de reception" : liste les emails recents (metadonnees
// uniquement), avec suggestion de dossier et detection de date/heure - rien
// n'est jamais importe/cree sans une action explicite de l'utilisateur
// (import de piece jointe, confirmation d'evenement), voir
// routes/emailIngestion.ts.

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

let emailsCache = [];
let dossiersCache = [];
let filtreActuel = "nouveau";

function formatDateHeure(iso) {
  return new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

/** Convertit une date ISO en valeur acceptee par <input type="datetime-local">,
 * en heure LOCALE (pas UTC) - sinon l'heure affichee au moment de la
 * correction ne correspondrait pas a l'heure detectee. */
function versDatetimeLocal(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function chargerDossiers() {
  try {
    const res = await apiFetch("/api/dossiers?scope=cabinet");
    dossiersCache = res.dossiers || [];
  } catch {
    dossiersCache = [];
  }
  const options = dossiersCache
    .map((d) => `<option value="${d.id}">${escapeHtml(d.numeroDossier)} — ${escapeHtml(d.nomAffaire)}</option>`)
    .join("");
  document.getElementById("import-dossier-select").innerHTML = options;
  document.getElementById("evenement-dossier-select").innerHTML =
    `<option value="">— Aucun —</option>${options}`;
}

function renderPieceJointe(email, piece) {
  return `
    <li>
      <span>${escapeHtml(piece.nomFichier)}</span>
      <button type="button" class="secondary btn-sm" data-importer-piece="${email.id}" data-attachment-id="${escapeHtml(piece.id)}" data-nom="${escapeHtml(piece.nomFichier)}">Importer vers un dossier</button>
    </li>`;
}

function renderCarte(email) {
  const suggestions = email.dossiersSuggeres || [];
  const suggestionHtml = suggestions.length
    ? `<p class="muted">Dossier suggéré (email connu) : ${suggestions.map((s) => `${escapeHtml(s.numeroDossier)} — ${escapeHtml(s.nomAffaire)}`).join(", ")}</p>`
    : "";

  const piecesHtml = email.piecesJointes.length
    ? `<ul style="margin:8px 0; padding-left:18px;">${email.piecesJointes.map((p) => renderPieceJointe(email, p)).join("")}</ul>`
    : "";

  const dateDetecteeHtml = email.dateDetectee
    ? `
      <div style="margin-top:8px; padding:8px; border-radius:8px; background:var(--accent-tint);">
        <p style="margin:0;">Date/heure détectée : <strong>${formatDateHeure(email.dateDetectee)}</strong></p>
        <p class="muted" style="margin:4px 0;">« ${escapeHtml(email.dateDetecteeContexte || "")} »</p>
        <button type="button" class="secondary btn-sm" data-confirmer-evenement="${email.id}">Confirmer un rendez-vous</button>
      </div>`
    : "";

  const ignorerBtn =
    email.statut === "nouveau"
      ? `<button type="button" class="ghost btn-sm" data-ignorer="${email.id}">Ignorer</button>`
      : `<span class="badge">Traité</span>`;

  return `
    <div class="card" data-email-carte="${email.id}" style="margin-bottom:14px;">
      <p style="margin:0;"><strong>${escapeHtml(email.expediteurNom || email.expediteurEmail)}</strong> <span class="muted">&lt;${escapeHtml(email.expediteurEmail)}&gt;</span></p>
      <p style="margin:2px 0;">${escapeHtml(email.objet || "(sans objet)")}</p>
      <p class="muted" style="margin:2px 0;">${formatDateHeure(email.dateReception)}</p>
      ${suggestionHtml}
      ${piecesHtml}
      ${dateDetecteeHtml}
      <div style="margin-top:10px; display:flex; gap:10px; align-items:center;">
        <button type="button" class="secondary btn-sm" data-lire="${email.id}">Lire / Répondre</button>
        ${ignorerBtn}
      </div>
    </div>`;
}

function render() {
  const liste = document.getElementById("liste-emails");
  const filtres = emailsCache.filter((e) => e.statut === filtreActuel);
  if (filtres.length === 0) {
    liste.innerHTML = `<p class="muted">${filtreActuel === "nouveau" ? "Aucun email à traiter pour l'instant." : "Aucun email traité pour l'instant."}</p>`;
  } else {
    liste.innerHTML = filtres.map(renderCarte).join("");
  }

  liste.querySelectorAll("[data-importer-piece]").forEach((btn) => {
    btn.addEventListener("click", () => ouvrirImportModal(btn.dataset.importerPiece, btn.dataset.attachmentId, btn.dataset.nom));
  });
  liste.querySelectorAll("[data-confirmer-evenement]").forEach((btn) => {
    btn.addEventListener("click", () => ouvrirEvenementModal(btn.dataset.confirmerEvenement));
  });
  liste.querySelectorAll("[data-ignorer]").forEach((btn) => {
    btn.addEventListener("click", () => ignorerEmail(btn.dataset.ignorer));
  });
  liste.querySelectorAll("[data-lire]").forEach((btn) => {
    btn.addEventListener("click", () => ouvrirLireModal(btn.dataset.lire));
  });
}

async function chargerEmails() {
  const errorEl = document.getElementById("error");
  hideError(errorEl);
  try {
    const [connexions, emails] = await Promise.all([
      apiFetch("/api/email-ingestion/statut"),
      apiFetch("/api/email-ingestion/emails"),
    ]);
    document.getElementById("pas-connecte").style.display = connexions.length === 0 ? "block" : "none";
    emailsCache = emails;
    render();
  } catch (err) {
    showError(errorEl, err.message);
  }
}

async function ignorerEmail(id) {
  try {
    await apiFetch(`/api/email-ingestion/emails/${id}/ignorer`, { method: "POST" });
    await chargerEmails();
  } catch (err) {
    showError(document.getElementById("error"), err.message);
  }
}

// --- Import de piece jointe ---

let importCourant = null;

function ouvrirImportModal(emailId, attachmentId, nom) {
  importCourant = { emailId, attachmentId };
  document.getElementById("import-piece-nom").textContent = `Pièce : ${nom}`;
  hideError(document.getElementById("import-error"));
  document.getElementById("import-form").reset();
  document.getElementById("import-modal").hidden = false;
}

document.getElementById("import-annuler-btn").addEventListener("click", () => {
  document.getElementById("import-modal").hidden = true;
});

document.getElementById("import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("import-error");
  hideError(errorEl);
  const fd = new FormData(e.target);
  try {
    await apiFetch(`/api/email-ingestion/emails/${importCourant.emailId}/importer-piece`, {
      method: "POST",
      body: { attachmentId: importCourant.attachmentId, dossierId: fd.get("dossierId") },
    });
    document.getElementById("import-modal").hidden = true;
    await chargerEmails();
  } catch (err) {
    showError(errorEl, err.message);
  }
});

// --- Confirmation d'evenement ---

let evenementCourant = null;

function ouvrirEvenementModal(emailId) {
  const email = emailsCache.find((e) => e.id === emailId);
  if (!email) return;
  evenementCourant = emailId;
  hideError(document.getElementById("evenement-error"));
  document.getElementById("evenement-contexte").textContent = `Détecté dans l'email de ${email.expediteurNom || email.expediteurEmail} : « ${email.dateDetecteeContexte || ""} »`;
  document.getElementById("evenement-titre").value = email.objet || "Rendez-vous";
  document.getElementById("evenement-date").value = versDatetimeLocal(email.dateDetectee);
  document.getElementById("evenement-type").value = "rdv";
  document.getElementById("evenement-dossier-select").value = (email.dossiersSuggeres && email.dossiersSuggeres[0]) ? email.dossiersSuggeres[0].id : "";
  document.getElementById("evenement-lieu").value = "";
  document.getElementById("evenement-modal").hidden = false;
}

document.getElementById("evenement-annuler-btn").addEventListener("click", () => {
  document.getElementById("evenement-modal").hidden = true;
});

document.getElementById("evenement-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("evenement-error");
  hideError(errorEl);
  const fd = new FormData(e.target);
  const dateLocale = fd.get("dateDebut");
  if (!dateLocale) {
    showError(errorEl, "Date requise.");
    return;
  }
  try {
    await apiFetch(`/api/email-ingestion/emails/${evenementCourant}/confirmer-evenement`, {
      method: "POST",
      body: {
        type: fd.get("type"),
        titre: fd.get("titre"),
        dateDebut: new Date(dateLocale).toISOString(),
        dossierId: fd.get("dossierId") || undefined,
        lieu: fd.get("lieu") || undefined,
      },
    });
    document.getElementById("evenement-modal").hidden = true;
    await chargerEmails();
  } catch (err) {
    showError(errorEl, err.message);
  }
});

// --- Lecture du contenu complet + reponse ---
// Le contenu n'est JAMAIS mis en cache ni stocke cote client au-dela de
// l'affichage courant : ferme le volet, rouvre-le, il est re-telecharge
// depuis le fournisseur (voir routes/emailIngestion.ts, GET .../contenu -
// aucune ecriture Prisma cote serveur non plus). `lireCourant` sert
// uniquement a ignorer une reponse HTTP tardive si l'utilisateur a deja
// ferme le volet ou ouvert un autre email entre-temps.

let lireCourant = null;

function ouvrirLireModal(emailId) {
  lireCourant = emailId;
  hideError(document.getElementById("lire-error"));
  afficherContenuTexte("Chargement…");
  document.getElementById("lire-images-btn").style.display = "none";
  document.getElementById("lire-reponse-form").reset();
  document.getElementById("lire-modal").hidden = false;
  chargerContenuEmail(emailId);
}

function afficherContenuTexte(texte) {
  const contenuEl = document.getElementById("lire-contenu");
  contenuEl.replaceChildren();
  contenuEl.style.whiteSpace = "pre-wrap";
  contenuEl.textContent = texte;
}

/**
 * Affiche le HTML deja nettoye cote serveur (voir sanitizeEmailHtml.ts)
 * dans une iframe "sandbox=allow-same-origin" SANS "allow-scripts" : le
 * document de l'iframe ne peut executer aucun JavaScript (protection meme
 * si un script avait echappe au nettoyage serveur), mais "allow-same-origin"
 * permet a CE script (parent) d'acceder a son contentDocument pour
 * intercepter les clics sur les liens (ouverture via ouvrirLienExterne,
 * jamais une navigation de l'iframe elle-meme) et restaurer les images
 * bloquees a la demande.
 */
function afficherContenuHtml(html) {
  const contenuEl = document.getElementById("lire-contenu");
  contenuEl.replaceChildren();
  contenuEl.style.whiteSpace = "normal";

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "0";
  iframe.style.background = "#fff";
  contenuEl.appendChild(iframe);

  iframe.addEventListener("load", () => {
    const doc = iframe.contentDocument;
    if (!doc || !doc.body) return;

    doc.body.addEventListener("click", (e) => {
      const lien = e.target.closest("a[href]");
      if (!lien) return;
      e.preventDefault();
      ouvrirLienExterne(lien.getAttribute("href"));
    });

    const imagesBloquees = doc.querySelectorAll("img[data-blocked-src]");
    const imagesBtn = document.getElementById("lire-images-btn");
    if (imagesBloquees.length > 0) {
      imagesBtn.style.display = "inline-block";
      imagesBtn.onclick = () => {
        imagesBloquees.forEach((img) => img.setAttribute("src", img.getAttribute("data-blocked-src")));
        imagesBtn.style.display = "none";
      };
    } else {
      imagesBtn.style.display = "none";
    }
  });

  iframe.srcdoc = html;
}

async function chargerContenuEmail(emailId) {
  try {
    const data = await apiFetch(`/api/email-ingestion/emails/${emailId}/contenu`);
    if (lireCourant !== emailId) return;
    if (data.html) {
      afficherContenuHtml(data.html);
    } else {
      afficherContenuTexte(data.texte || "(email vide ou illisible)");
    }
  } catch (err) {
    if (lireCourant !== emailId) return;
    afficherContenuTexte("");
    showError(document.getElementById("lire-error"), err.message);
  }
}

document.getElementById("lire-fermer-btn").addEventListener("click", () => {
  document.getElementById("lire-modal").hidden = true;
  lireCourant = null;
});

document.getElementById("lire-reponse-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("lire-error");
  hideError(errorEl);
  const fd = new FormData(e.target);
  try {
    await apiFetch(`/api/email-ingestion/emails/${lireCourant}/repondre`, {
      method: "POST",
      body: { corps: fd.get("corps") },
    });
    document.getElementById("lire-modal").hidden = true;
    lireCourant = null;
    showToast("Réponse envoyée.");
  } catch (err) {
    showError(errorEl, err.message);
  }
});

// --- Onglets ---

document.querySelectorAll(".tabs [data-filtre]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tabs [data-filtre]").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    filtreActuel = tab.dataset.filtre;
    render();
  });
});

(async () => {
  const me = await requireSession();
  if (!me) return;
  initLayout(me);
  await chargerDossiers();
  await chargerEmails();
})();
