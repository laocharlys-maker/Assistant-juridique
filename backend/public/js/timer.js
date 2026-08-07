// Lot 14 - chronometre persistant (widget "Temps passé" sur la fiche
// dossier). Persistance : l'etat "en cours" vit cote serveur
// (SaisieTemps.demarreA/arreteA, voir routes/saisiesTemps.ts) - ce script
// ne fait QUE relire cet etat au chargement (chargerEtat) et l'affiche en
// le faisant defiler localement (setInterval, purement visuel) : un
// rafraichissement de page ne perd jamais le temps ecoule, il est
// recalcule depuis demarreA a chaque rechargement.
(function () {
  let intervalId = null;
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

    let widgetChrono;
    if (chronoActif && chronoActif.dossier.id === dossierIdCourant) {
      const debut = new Date(chronoActif.demarreA).getTime();
      const secondes = Math.max(0, Math.floor((Date.now() - debut) / 1000));
      const avertissement = secondes > SEUIL_AVERTISSEMENT_HEURES * 3600;
      widgetChrono = `
        <div class="timer-widget timer-actif">
          <div class="timer-elapsed">${formatDureeAffichage(secondes)}</div>
          ${avertissement ? `<p class="error visible" style="margin:4px 0;">Ce chronomètre tourne depuis plus de ${SEUIL_AVERTISSEMENT_HEURES}h — vérifie que tu ne l'as pas oublié en route.</p>` : ""}
          <button type="button" class="danger" id="timer-arreter-btn">Arrêter le chronomètre</button>
        </div>`;
    } else if (chronoActif) {
      // Actif mais sur un AUTRE dossier - pas de bouton demarrer ici tant
      // qu'il n'est pas arrete (un seul chronometre actif a la fois,
      // bloque avec message clair - voir routes/saisiesTemps.ts).
      widgetChrono = `<p class="muted">Un chronomètre est en cours sur un autre dossier (${escapeHtml(chronoActif.dossier.numeroDossier)}) — arrête-le d'abord depuis ce dossier pour en démarrer un ici.</p>`;
    } else {
      widgetChrono = `<button type="button" id="timer-demarrer-btn">Démarrer le chronomètre</button>`;
    }

    const totalMinutes = saisiesDossier.reduce((acc, s) => acc + (s.dureeMinutes || 0), 0);
    const totalFacturable = saisiesDossier
      .filter((s) => s.facturable && !s.factureId)
      .reduce((acc, s) => acc + (s.montant || 0), 0);

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
          <label style="display:flex; align-items:center; gap:6px; font-weight:400;">
            <input type="checkbox" name="facturable" checked style="width:auto;" /> Facturable
          </label>
          <p class="error" id="timer-manuel-error"></p>
          <div class="edit-panel-actions">
            <button type="submit" class="btn-sm">Enregistrer</button>
            <button type="button" class="ghost btn-sm" id="timer-cancel-manuel-btn">Annuler</button>
          </div>
        </form>
        <div style="margin-top:12px;">
          ${
            saisiesDossier.length === 0
              ? '<p class="muted">Aucune saisie de temps pour ce dossier pour l\'instant.</p>'
              : saisiesDossier
                  .map(
                    (s) => `
              <div class="action-item">
                <span class="tag">${escapeHtml(s.user.nom)}</span>
                <span class="badge ${s.facturable ? "badge-a_jour" : "badge-cloture"}">${s.facturable ? "Facturable" : "Non facturable"}</span>
                ${s.factureId ? '<span class="badge badge-payee">Facturé</span>' : ""}
                <div>${s.dureeMinutes ? formatDureeCourte(s.dureeMinutes) : "en cours"} — ${new Date(s.date).toLocaleDateString("fr-FR")}${s.description ? " — " + escapeHtml(s.description) : ""}</div>
              </div>`
                  )
                  .join("")
          }
          <p style="margin-top:8px;"><strong>Total enregistré : ${formatDureeCourte(totalMinutes)}</strong></p>
        </div>
        ${
          (meCourant.role === "titulaire" || meCourant.role === "avocat") && totalFacturable > 0
            ? `<button type="button" class="secondary" id="timer-facturer-btn">Facturer le temps passé (${totalFacturable.toLocaleString("fr-FR")} F CFA)</button>`
            : ""
        }
      </div>`;

    wireEvents();
  }

  function wireEvents() {
    const demarrerBtn = document.getElementById("timer-demarrer-btn");
    if (demarrerBtn) demarrerBtn.addEventListener("click", demarrer);
    const arreterBtn = document.getElementById("timer-arreter-btn");
    if (arreterBtn) arreterBtn.addEventListener("click", arreter);

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

  async function demarrer() {
    try {
      await apiFetch("/api/saisies-temps/demarrer", { method: "POST", body: { dossierId: dossierIdCourant } });
      await chargerEtat();
    } catch (err) {
      alert(err.message);
    }
  }

  async function arreter() {
    if (!chronoActif) return;
    try {
      await apiFetch(`/api/saisies-temps/${chronoActif.id}/arreter`, { method: "POST" });
      await chargerEtat();
    } catch (err) {
      alert(err.message);
    }
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
          facturable: fd.get("facturable") === "on",
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
    demarrerTicker();
  }

  // Rafraichit l'affichage du temps ecoule chaque seconde - purement
  // visuel (le serveur reste la seule source de verite, voir chargerEtat) :
  // meme si ce timer JS s'arrete (onglet en arriere-plan throttle par le
  // navigateur), la duree reelle reste correcte au prochain rechargement,
  // recalculee depuis demarreA.
  function demarrerTicker() {
    if (intervalId) clearInterval(intervalId);
    if (chronoActif && chronoActif.dossier.id === dossierIdCourant) {
      intervalId = setInterval(() => {
        const el = document.querySelector(".timer-elapsed");
        if (!el) return;
        const debut = new Date(chronoActif.demarreA).getTime();
        const secondes = Math.max(0, Math.floor((Date.now() - debut) / 1000));
        el.textContent = formatDureeAffichage(secondes);
      }, 1000);
    }
  }

  window.initTimerWidget = async function (dossierId, me) {
    dossierIdCourant = dossierId;
    meCourant = me;
    await chargerEtat();
  };
})();
