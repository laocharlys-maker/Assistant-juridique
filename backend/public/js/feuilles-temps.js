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

// "Facturer ce dossier" n'a de sens qu'en vue "Par dossier" (la ligne
// correspond alors a un dossier, l.cle = dossierId - voir agregerParDossier
// cote serveur) et uniquement pour un avocat/titulaire (meme permission que
// POST /api/factures/depuis-temps, requireAvocat cote serveur) : un
// collaborateur ne peut pas creer de facture.
function renderFeuille(lignes) {
  const bodyEl = document.getElementById("feuille-body");
  if (!lignes || lignes.length === 0) {
    bodyEl.innerHTML = '<p class="muted">Aucune saisie de temps pour cette sélection.</p>';
    return;
  }

  const peutFacturer = groupBy === "dossier" && peutVoirEquipe();

  let totalDuree = 0;
  let totalMontant = 0;

  const lignesHtml = lignes
    .map((l) => {
      totalDuree += l.dureeMinutes;
      totalMontant += l.montant;
      return `
        <div class="action-item">
          <span class="tag">${escapeHtml(l.label)}</span>
          <div><strong>${formatDureeCourte(l.dureeMinutes)}</strong> — ${l.montant.toLocaleString("fr-FR")} F CFA</div>
          ${peutFacturer ? `<button type="button" class="secondary btn-sm" data-facturer="${l.cle}" style="margin-top:6px;">Facturer ce dossier</button>` : ""}
        </div>`;
    })
    .join("");

  bodyEl.innerHTML = `
    ${lignesHtml}
    <div class="action-item" style="background:var(--panel-alt);">
      <strong>Total — ${formatDureeCourte(totalDuree)} — ${totalMontant.toLocaleString("fr-FR")} F CFA</strong>
    </div>`;

  bodyEl.querySelectorAll("[data-facturer]").forEach((btn) => {
    btn.addEventListener("click", () => facturerDossier(btn.dataset.facturer));
  });
}

// Reprend exactement le meme flux que le bouton "Facturer" du chronometre
// (voir js/timer.js, facturer()) : agrege tout le temps facturable et pas
// encore facture sur ce dossier en une facture, puis renvoie vers
// Facturation avec le client/dossier deja preselectionnes (voir
// factures.html, lecture de ?dossierId= au chargement).
async function facturerDossier(dossierId) {
  if (
    !confirm(
      "Générer une facture à partir de tout le temps facturable et non encore facturé enregistré sur ce dossier ?"
    )
  ) {
    return;
  }
  try {
    await apiFetch("/api/factures/depuis-temps", { method: "POST", body: { dossierId } });
    window.location.href = `/factures.html?dossierId=${dossierId}`;
  } catch (err) {
    showError(document.getElementById("error"), err.message);
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
