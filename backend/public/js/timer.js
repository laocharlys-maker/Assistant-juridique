// Lot 14 - widget "Temps passé" sur la fiche dossier (historique, saisie
// manuelle, total, facturation). Le chronometre demarrer/arreter lui-meme a
// ete deplace vers Nouvelle action + le Header (voir initHeaderChrono dans
// layout.js) - ce widget affiche seulement, en lecture seule, qu'un
// chronometre est en cours ici s'il y en a un (avec un lien vers le
// Header/Nouvelle action pour l'arreter), pour eviter toute duplication des
// controles demarrer/arreter a deux endroits.
(function () {
  let chronoActif = null;
  let dossierIdCourant = null;
  let meCourant = null;
  let saisiesDossier = [];

  const SEUIL_AVERTISSEMENT_HEURES = 4;

  function formatDureeAffichage(secondesTotales) {
    const h = Math.floor(secondesTotales / 3600);
    const m = Math.floor((secondesTotales % 3600) / 60);
    const s = Math.floor(secondesTotales % 60);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  // Meme convention d'affichage compact que services/feuillesTemps.ts
  // (formatDuree) cote serveur - "3h30", "45min", "2h".
  function formatDureeCourte(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h === 0) return `${m}min`;
    if (m === 0) return `${h}h`;
    return `${h}h${String(m).padStart(2, "0")}`;
  }

  function render() {
    const el = document.getElementById("timer-section");
    if (!el) return;

    // Le chronometre demarrer/arreter vit desormais dans Nouvelle action et
    // le Header (voir layout.js) - ici, simple rappel en lecture seule s'il
    // tourne sur CE dossier, pour ne pas dupliquer les controles.
    let widgetChrono = "";
    if (chronoActif && chronoActif.dossier.id === dossierIdCourant) {
      // demarreA null (mais arreteA null aussi) = EN PAUSE, voir le
      // commentaire sur SaisieTemps.demarreA (schema.prisma).
      const enPause = !chronoActif.demarreA;
      const accumulee = chronoActif.dureeAccumuleeSecondes || 0;
      const segmentEnCours = chronoActif.demarreA
        ? Math.max(0, Math.floor((Date.now() - new Date(chronoActif.demarreA).getTime()) / 1000))
        : 0;
      const secondes = accumulee + segmentEnCours;
      const avertissement = !enPause && secondes > SEUIL_AVERTISSEMENT_HEURES * 3600;
      widgetChrono = `
        <p class="muted">⏱ Un chronomètre est ${enPause ? "en pause" : "en cours"} sur ce dossier (${formatDureeAffichage(secondes)}) — pilote-le depuis le Header.${avertissement ? " Il tourne depuis plus de 4h, vérifie que tu ne l'as pas oublié en route." : ""}</p>`;
    }

    // Le temps deja rattache a une facture (factureId non nul) disparait de
    // ce widget des qu'il est facture - seul le temps de travail non encore
    // facture (y compris un chronometre encore actif, dureeMinutes null) y
    // reste visible. Un temps facture se consulte desormais uniquement
    // depuis la facture elle-meme (Facturation), plus ici.
    const saisiesAffichees = saisiesDossier.filter((s) => !s.factureId);
    const totalMinutes = saisiesAffichees.reduce((acc, s) => acc + (s.dureeMinutes || 0), 0);
    const saisiesFacturables = saisiesAffichees.filter((s) => s.dureeMinutes);
    const totalAFacturer = saisiesFacturables.reduce((acc, s) => acc + (s.montant || 0), 0);
    // Une saisie dont le montant est null n'a pas pu etre valorisee (taux
    // horaire absent au moment de la saisie, voir tauxHoraireApplique) -
    // signale-le plutot que de laisser le montant total silencieusement
    // incomplet.
    const minutesSansTaux = saisiesFacturables
      .filter((s) => s.montant === null || s.montant === undefined)
      .reduce((acc, s) => acc + s.dureeMinutes, 0);

    el.innerHTML = `
      <div class="card">
        <h2 style="margin-top:0;">Temps passé</h2>
        ${widgetChrono}
        <div style="margin-top:10px;">
          <button type="button" class="ghost btn-sm" id="timer-toggle-manuel-btn">+ Ajouter une saisie manuelle</button>
        </div>
        <form id="timer-manuel-form" class="edit-panel" hidden style="margin-top:8px;">
          <label>Date</label>
          <input type="date" name="date" required value="${new Date().toISOString().slice(0, 10)}" />
          <label>Durée (en minutes)</label>
          <input type="number" name="dureeMinutes" min="1" required placeholder="ex: 90" />
          <label>Description (optionnel)</label>
          <input name="description" />
          <p class="error" id="timer-manuel-error"></p>
          <div class="edit-panel-actions">
            <button type="submit" class="btn-sm">Enregistrer</button>
            <button type="button" class="ghost btn-sm" id="timer-cancel-manuel-btn">Annuler</button>
          </div>
        </form>
        <div style="margin-top:12px;">
          ${
            saisiesAffichees.length === 0
              ? '<p class="muted">Aucun temps non facturé pour ce dossier pour l\'instant.</p>'
              : saisiesAffichees
                  .map(
                    (s) => `
              <div class="action-item">
                <span class="tag">${escapeHtml(s.user.nom)}</span>
                <div>${s.dureeMinutes ? formatDureeCourte(s.dureeMinutes) : "en cours"}${typeof s.montant === "number" ? ` — ${s.montant.toLocaleString("fr-FR")} F CFA` : ""} — ${new Date(s.date).toLocaleDateString("fr-FR")}${s.description ? " — " + escapeHtml(s.description) : ""}</div>
              </div>`
                  )
                  .join("")
          }
          <p style="margin-top:8px;"><strong>Total non facturé : ${formatDureeCourte(totalMinutes)}</strong></p>
        </div>
        ${
          (meCourant.role === "titulaire" || meCourant.role === "avocat") && totalAFacturer > 0
            ? `<button type="button" class="secondary" id="timer-facturer-btn">Facturer le temps passé (${totalAFacturer.toLocaleString("fr-FR")} F CFA)</button>`
            : ""
        }
        ${
          minutesSansTaux > 0
            ? `<p class="muted" style="margin-top:8px;">${formatDureeCourte(minutesSansTaux)} non valorisé — taux horaire non renseigné (à renseigner par l'administrateur dans Équipe &gt; Collaborateurs).</p>`
            : ""
        }
      </div>`;

    wireEvents();
  }

  function wireEvents() {
    const manuelForm = document.getElementById("timer-manuel-form");
    const toggleManuelBtn = document.getElementById("timer-toggle-manuel-btn");
    if (toggleManuelBtn) {
      toggleManuelBtn.addEventListener("click", () => {
        manuelForm.hidden = false;
        toggleManuelBtn.hidden = true;
      });
    }
    const cancelManuelBtn = document.getElementById("timer-cancel-manuel-btn");
    if (cancelManuelBtn) {
      cancelManuelBtn.addEventListener("click", () => {
        manuelForm.hidden = true;
        toggleManuelBtn.hidden = false;
      });
    }
    if (manuelForm) {
      manuelForm.addEventListener("submit", soumettreManuel);
    }

    const facturerBtn = document.getElementById("timer-facturer-btn");
    if (facturerBtn) facturerBtn.addEventListener("click", facturer);
  }

  async function soumettreManuel(e) {
    e.preventDefault();
    const errorEl = document.getElementById("timer-manuel-error");
    errorEl.textContent = "";
    const fd = new FormData(e.target);
    try {
      await apiFetch("/api/saisies-temps", {
        method: "POST",
        body: {
          dossierId: dossierIdCourant,
          date: fd.get("date"),
          dureeMinutes: Number(fd.get("dureeMinutes")),
          description: fd.get("description") || undefined,
        },
      });
      await chargerEtat();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  async function facturer() {
    if (
      !confirm(
        "Générer une facture à partir de tout le temps facturable et non encore facturé enregistré sur ce dossier ?"
      )
    ) {
      return;
    }
    try {
      await apiFetch("/api/factures/depuis-temps", { method: "POST", body: { dossierId: dossierIdCourant } });
      window.location.href = `/factures.html?dossierId=${dossierIdCourant}`;
    } catch (err) {
      alert(err.message);
    }
  }

  async function chargerEtat() {
    try {
      chronoActif = await apiFetch("/api/saisies-temps/actif");
    } catch {
      chronoActif = null;
    }
    try {
      saisiesDossier = await apiFetch(`/api/saisies-temps?dossierId=${dossierIdCourant}`);
    } catch {
      saisiesDossier = [];
    }
    render();
  }

  window.initTimerWidget = async function (dossierId, me) {
    dossierIdCourant = dossierId;
    meCourant = me;
    await chargerEtat();
  };
})();
