// Lot 14 - vue agregee des feuilles de temps (par collaborateur ou par
// dossier), avec export PDF - consomme GET /api/saisies-temps/feuille
// (routes/saisiesTemps.ts), qui delegue l'agregation elle-meme a
// services/feuillesTemps.ts (jamais recalculee ici, uniquement affichee).

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatDureeCourte(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, "0")}`;
}

let me = null;
let groupBy = "collaborateur";
let scope = "mine";

function peutVoirEquipe() {
  return me && (me.role === "titulaire" || me.role === "avocat");
}

function periodeCourante() {
  const choix = document.getElementById("filter-periode").value;
  const now = new Date();
  if (choix === "semaine") {
    const jour = now.getDay();
    const decalage = jour === 0 ? -6 : 1 - jour;
    const debut = new Date(now.getFullYear(), now.getMonth(), now.getDate() + decalage);
    const fin = new Date(debut);
    fin.setDate(fin.getDate() + 7);
    return { debut, fin };
  }
  if (choix === "mois") {
    const debut = new Date(now.getFullYear(), now.getMonth(), 1);
    const fin = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { debut, fin };
  }
  return { debut: null, fin: null };
}

function construireParams(format) {
  const params = new URLSearchParams({ groupBy });
  const { debut, fin } = periodeCourante();
  if (debut) params.set("debut", debut.toISOString());
  if (fin) params.set("fin", fin.toISOString());

  const dossierId = document.getElementById("filter-dossier").value;
  if (dossierId) params.set("dossierId", dossierId);

  if (peutVoirEquipe() && scope === "equipe") {
    const userId = document.getElementById("filter-collaborateur").value;
    if (userId) params.set("userId", userId);
  }

  if (format) params.set("format", format);
  return params;
}

async function chargerFeuille() {
  const errorEl = document.getElementById("error");
  hideError(errorEl);
  const bodyEl = document.getElementById("feuille-body");
  try {
    const params = construireParams();
    // Un collaborateur reste toujours scope a ses propres saisies cote
    // serveur (voir routes/saisiesTemps.ts) - le parametre "scope" ici ne
    // sert qu'a piloter l'AFFICHAGE (filtre collaborateur visible ou non),
    // jamais a elargir l'acces.
    const data = await apiFetch(`/api/saisies-temps/feuille?${params.toString()}`);
    renderFeuille(data.lignes);
  } catch (err) {
    bodyEl.innerHTML = "";
    showError(errorEl, err.message);
  }
}

// "Facturer ce temps" n'a de sens qu'a l'echelle d'UN dossier (le serveur
// facture toujours par dossier, voir POST /api/factures/depuis-temps) et
// uniquement pour un avocat/titulaire (meme permission cote serveur,
// requireAvocat) : un collaborateur ne peut pas creer de facture. En vue
// "Par dossier", chaque ligne EST deja un dossier (l.cle = dossierId, voir
// agregerParDossier). En vue "Par collaborateur", chaque ligne est une
// PERSONNE (total tous ses dossiers confondus - inchange) mais expose
// desormais une sous-liste par dossier (l.dossiers, voir
// agregerParCollaborateurAvecDossiers cote serveur) : c'est sur CES
// sous-lignes que "Facturer ce temps" apparait, jamais sur le total de la
// personne elle-meme (facturer "tout ce qu'un collaborateur a fait, tous
// dossiers confondus" n'a pas de sens, une facture est toujours pour un
// seul dossier/client).
function renderFeuille(lignes) {
  const bodyEl = document.getElementById("feuille-body");
  if (!lignes || lignes.length === 0) {
    bodyEl.innerHTML = '<p class="muted">Aucune saisie de temps pour cette sélection.</p>';
    return;
  }

  const peutFacturer = peutVoirEquipe();

  let totalDuree = 0;
  let totalMontant = 0;

  function ligneDossierHtml(dossier) {
    return `
      <div class="action-item" style="margin-left:20px; background:var(--panel-alt);">
        <span class="tag">${escapeHtml(dossier.dossierLabel)}</span>
        <div>${formatDureeCourte(dossier.dureeMinutes)} — ${dossier.montant.toLocaleString("fr-FR")} F CFA</div>
        ${peutFacturer ? `<button type="button" class="secondary btn-sm" data-facturer="${dossier.dossierId}" data-montant="${dossier.montant}" style="margin-top:6px;">Facturer ce temps</button>` : ""}
      </div>`;
  }

  const lignesHtml = lignes
    .map((l) => {
      totalDuree += l.dureeMinutes;
      totalMontant += l.montant;

      if (groupBy === "collaborateur" && l.dossiers) {
        return `
          <div class="action-item">
            <span class="tag">${escapeHtml(l.label)}</span>
            <div><strong>${formatDureeCourte(l.dureeMinutes)}</strong> — ${l.montant.toLocaleString("fr-FR")} F CFA</div>
          </div>
          ${l.dossiers.map(ligneDossierHtml).join("")}`;
      }

      return `
        <div class="action-item">
          <span class="tag">${escapeHtml(l.label)}</span>
          <div><strong>${formatDureeCourte(l.dureeMinutes)}</strong> — ${l.montant.toLocaleString("fr-FR")} F CFA</div>
          ${peutFacturer ? `<button type="button" class="secondary btn-sm" data-facturer="${l.cle}" data-montant="${l.montant}" style="margin-top:6px;">Facturer ce temps</button>` : ""}
        </div>`;
    })
    .join("");

  bodyEl.innerHTML = `
    ${lignesHtml}
    <div class="action-item" style="background:var(--panel-alt);">
      <strong>Total — ${formatDureeCourte(totalDuree)} — ${totalMontant.toLocaleString("fr-FR")} F CFA</strong>
    </div>`;

  bodyEl.querySelectorAll("[data-facturer]").forEach((btn) => {
    btn.addEventListener("click", () => ouvrirModalFacturer(btn.dataset.facturer, Number(btn.dataset.montant)));
  });
}

// Meme fenetre que le bouton "Facturer" du chronometre (voir js/timer.js,
// ouvrirModalFacturer()) : demande un libelle (remplace le detail horaire
// brut, jamais affiche sur la facture) et laisse modifier le montant
// suggere (deja connu ici, calcule cote serveur lors du chargement de la
// feuille) avant de facturer. Agrege tout le temps facturable et pas
// encore facture sur ce dossier, puis renvoie vers Facturation avec le
// client/dossier deja preselectionnes (voir factures.html, lecture de
// ?dossierId= au chargement).
function ouvrirModalFacturer(dossierId, montantSuggere) {
  let modal = document.getElementById("feuilles-facturer-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.id = "feuilles-facturer-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="modal-box">
        <h2>Facturer ce temps</h2>
        <p class="muted">Le détail horaire ne sera pas affiché sur la facture — indique le libellé à afficher et vérifie/ajuste le montant si besoin.</p>
        <p class="error" id="feuilles-facturer-error"></p>
        <input type="hidden" id="feuilles-facturer-dossier-id" />
        <label for="feuilles-facturer-libelle">Libellé</label>
        <input id="feuilles-facturer-libelle" placeholder="ex: Honoraires - suivi du dossier" />
        <label for="feuilles-facturer-montant">Montant (F CFA)</label>
        <input id="feuilles-facturer-montant" type="number" min="1" step="1" />
        <div style="display:flex; gap:10px; margin-top:18px;">
          <button type="button" id="feuilles-facturer-confirmer-btn">Facturer</button>
          <button type="button" class="ghost" id="feuilles-facturer-annuler-btn">Annuler</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById("feuilles-facturer-annuler-btn").addEventListener("click", () => {
      modal.hidden = true;
    });
    document.getElementById("feuilles-facturer-confirmer-btn").addEventListener("click", confirmerFacturer);
  }
  document.getElementById("feuilles-facturer-dossier-id").value = dossierId;
  document.getElementById("feuilles-facturer-libelle").value = "";
  document.getElementById("feuilles-facturer-montant").value = montantSuggere;
  document.getElementById("feuilles-facturer-error").textContent = "";
  modal.hidden = false;
}

async function confirmerFacturer() {
  const errorEl = document.getElementById("feuilles-facturer-error");
  const confirmerBtn = document.getElementById("feuilles-facturer-confirmer-btn");
  const dossierId = document.getElementById("feuilles-facturer-dossier-id").value;
  const libelle = document.getElementById("feuilles-facturer-libelle").value.trim();
  const montant = Number(document.getElementById("feuilles-facturer-montant").value);
  if (!libelle) {
    errorEl.textContent = "Indique un libellé.";
    return;
  }
  if (!montant || montant <= 0) {
    errorEl.textContent = "Le montant doit être un nombre positif.";
    return;
  }
  // Desactive pendant l'envoi - evite qu'un double-clic ne declenche deux
  // requetes concurrentes (voir genererNumero cote serveur).
  confirmerBtn.disabled = true;
  try {
    await apiFetch("/api/factures/depuis-temps", {
      method: "POST",
      body: { dossierId, description: libelle, montant },
    });
    document.getElementById("feuilles-facturer-modal").hidden = true;
    // facturee=1 : la facture existe deja (montant deja calcule cote
    // serveur) - voir factures.html, evite de rouvrir un formulaire vide.
    window.location.href = `/factures.html?dossierId=${dossierId}&facturee=1`;
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    confirmerBtn.disabled = false;
  }
}

async function chargerReferentiels() {
  try {
    const { dossiers } = await apiFetch("/api/dossiers?scope=cabinet");
    const select = document.getElementById("filter-dossier");
    select.innerHTML =
      '<option value="">Tous les dossiers</option>' +
      dossiers.map((d) => `<option value="${d.id}">${escapeHtml(d.numeroDossier)} — ${escapeHtml(d.nomAffaire)}</option>`).join("");
  } catch {
    // Non bloquant : le filtre par dossier reste juste indisponible.
  }

  if (peutVoirEquipe()) {
    try {
      const annuaire = await apiFetch("/api/users/annuaire");
      const select = document.getElementById("filter-collaborateur");
      select.innerHTML =
        '<option value="">Tous les collaborateurs</option>' +
        annuaire.map((u) => `<option value="${u.id}">${escapeHtml(u.nom)}</option>`).join("");
    } catch {
      // Non bloquant.
    }
  }
}

document.querySelectorAll("#groupby-tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    groupBy = btn.dataset.groupby;
    document.querySelectorAll("#groupby-tabs .tab").forEach((b) => b.classList.toggle("active", b === btn));
    chargerFeuille();
  });
});
document.querySelectorAll("#scope-tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    scope = btn.dataset.scope;
    document.querySelectorAll("#scope-tabs .tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.getElementById("filter-collaborateur").style.display = scope === "equipe" ? "" : "none";
    chargerFeuille();
  });
});
["filter-periode", "filter-dossier", "filter-collaborateur"].forEach((id) => {
  document.getElementById(id).addEventListener("change", chargerFeuille);
});
document.getElementById("telecharger-pdf-btn").addEventListener("click", async () => {
  try {
    const params = construireParams("pdf");
    await downloadFile(`/api/saisies-temps/feuille?${params.toString()}`, "feuille-de-temps.pdf");
  } catch (err) {
    showError(document.getElementById("error"), err.message);
  }
});

(async () => {
  me = await requireSession();
  if (!me) return;
  initLayout(me);

  if (peutVoirEquipe()) {
    document.getElementById("scope-tabs").style.display = "";
    document.querySelector('#scope-tabs .tab[data-scope="mine"]').classList.add("active");
  }

  await chargerReferentiels();
  await chargerFeuille();
})();
