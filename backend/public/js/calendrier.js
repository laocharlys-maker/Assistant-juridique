// Lot 12a - vue calendrier unifiee (mois/semaine/jour/liste). Implementation
// vanilla JS (pas de librairie de calendrier lourde) : le besoin reste simple
// (chips par jour, pas de grille horaire minute par minute) et coherent avec
// le reste de l'app (aucune autre page ne charge de dependance JS externe).

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

const JOURS_LETTRES = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

const TYPE_LABELS_EVENEMENT = {
  audience: "Audience",
  rdv: "RDV",
  appel: "Appel",
  tache: "Tâche",
  echeance_procedure: "Échéance de procédure",
  autre: "Autre",
};

function debutJour(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function ajouterJours(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function debutMois(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function finMois(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}
function lundiDeLaSemaine(date) {
  const d = debutJour(date);
  const jour = d.getDay(); // 0 = dimanche
  const decalage = jour === 0 ? -6 : 1 - jour;
  return ajouterJours(d, decalage);
}
function memeJour(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function formatHeure(date) {
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

let me = null;
let currentVue = "mois";
let currentDate = new Date();
let filtreType = "";
let filtreAssigne = "";
let currentScope = "mine";
let evenements = [];
let annuaire = [];
const dossiersParNumero = new Map();
let currentDetailEvenement = null;
let currentDetailAudience = null;

// Date calendaire locale (YYYY-MM-DD) — a ne jamais remplacer par
// toISOString().slice(0,10), qui bascule sur le jour UTC et decale le mois
// affiche des que le fuseau local n'est pas UTC.
function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function peutVoirTouLeCabinet() {
  return me && (me.role === "titulaire" || me.role === "avocat");
}

// Periode reellement interrogee cote API pour la vue courante - toujours
// bornee (jamais un chargement complet du cabinet), voir README-LOT12A.md.
function periodeCourante() {
  if (currentVue === "semaine") {
    const debut = lundiDeLaSemaine(currentDate);
    return { debut, fin: ajouterJours(debut, 7) };
  }
  if (currentVue === "jour") {
    const debut = debutJour(currentDate);
    return { debut, fin: ajouterJours(debut, 1) };
  }
  if (currentVue === "liste") {
    return { debut: debutMois(currentDate), fin: finMois(currentDate) };
  }
  // mois : grille complete de 6 semaines (42 jours) a partir du lundi de la
  // semaine contenant le 1er du mois, pour ne jamais afficher une semaine
  // incomplete en debut/fin de grille.
  const debut = lundiDeLaSemaine(debutMois(currentDate));
  return { debut, fin: ajouterJours(debut, 42) };
}

function libellePeriode() {
  const { debut } = periodeCourante();
  if (currentVue === "jour") {
    return currentDate.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  if (currentVue === "semaine") {
    const fin = ajouterJours(debut, 6);
    return `${debut.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} – ${fin.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}`;
  }
  return currentDate.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

async function chargerEvenements() {
  const errorEl = document.getElementById("error");
  hideError(errorEl);
  const { debut, fin } = periodeCourante();
  document.getElementById("cal-period-label").textContent = libellePeriode();

  const params = new URLSearchParams({ debut: debut.toISOString(), fin: fin.toISOString() });
  if (filtreType) params.set("type", filtreType);
  if (filtreAssigne) params.set("assigne", filtreAssigne);
  if (peutVoirTouLeCabinet()) params.set("scope", currentScope);

  try {
    const data = await apiFetch(`/api/evenements?${params.toString()}`);
    evenements = data.evenements;
    renderVue();
  } catch (err) {
    showError(errorEl, err.message);
  }
}

function evenementsDuJour(date) {
  return evenements
    .filter((e) => memeJour(new Date(e.dateDebut), date))
    .sort((a, b) => new Date(a.dateDebut) - new Date(b.dateDebut));
}

function renderChip(e) {
  const heure = e.touteLaJournee ? "" : `${formatHeure(new Date(e.dateDebut))} `;
  return `<div class="cal-event-chip evenement-${e.type}" data-evenement-id="${e.id}" title="${escapeHtml(e.titre)}">${heure}${escapeHtml(e.titre)}</div>`;
}

function renderMois() {
  const { debut } = periodeCourante();
  const aujourdhui = new Date();
  const moisCourant = currentDate.getMonth();

  const labels = JOURS_LETTRES.map((j) => `<div class="cal-month-daylabel">${j}</div>`).join("");

  const cellules = [];
  for (let i = 0; i < 42; i++) {
    const jourDate = ajouterJours(debut, i);
    const evenementsJour = evenementsDuJour(jourDate);
    const MAX_VISIBLE = 3;
    const visibles = evenementsJour.slice(0, MAX_VISIBLE);
    const reste = evenementsJour.length - visibles.length;

    cellules.push(`
      <div class="cal-day-cell${jourDate.getMonth() !== moisCourant ? " hors-mois" : ""}${memeJour(jourDate, aujourdhui) ? " aujourdhui" : ""}" data-date="${jourDate.toISOString()}">
        <div class="cal-day-number">${jourDate.getDate()}</div>
        <div class="cal-day-events">
          ${visibles.map(renderChip).join("")}
          ${reste > 0 ? `<div class="cal-day-more">+${reste} de plus</div>` : ""}
        </div>
      </div>`);
  }

  document.getElementById("cal-body").innerHTML = `<div class="cal-month-grid">${labels}${cellules.join("")}</div>`;

  document.querySelectorAll(".cal-day-cell").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      // Un clic direct sur un chip ouvre son detail (gere plus bas) - un
      // clic ailleurs sur la cellule bascule en vue "jour" pour cette date.
      if (e.target.closest("[data-evenement-id]")) return;
      currentDate = new Date(cell.dataset.date);
      basculerVue("jour");
    });
  });
  wireChipClicks();
}

function renderSemaine() {
  const { debut } = periodeCourante();
  const aujourdhui = new Date();

  const colonnes = [];
  for (let i = 0; i < 7; i++) {
    const jourDate = ajouterJours(debut, i);
    const evenementsJour = evenementsDuJour(jourDate);
    colonnes.push(`
      <div class="cal-week-col${memeJour(jourDate, aujourdhui) ? " aujourdhui" : ""}" data-date="${jourDate.toISOString()}">
        <div class="cal-week-col-header">${jourDate.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })}</div>
        <div class="cal-day-events">
          ${evenementsJour.length === 0 ? '<p class="muted" style="font-size:0.78rem;">—</p>' : evenementsJour.map(renderChip).join("")}
        </div>
      </div>`);
  }

  document.getElementById("cal-body").innerHTML = `<div class="cal-week-grid">${colonnes.join("")}</div>`;
  wireChipClicks();
}

function renderJour() {
  const evenementsJour = evenementsDuJour(currentDate);
  document.getElementById("cal-body").innerHTML = `
    <div class="cal-day-single">
      ${
        evenementsJour.length === 0
          ? '<p class="muted">Aucun événement ce jour-là.</p>'
          : evenementsJour
              .map(
                (e) => `
        <div class="cal-liste-item" data-evenement-id="${e.id}">
          <span class="cal-liste-item-heure">${e.touteLaJournee ? "Journée" : formatHeure(new Date(e.dateDebut))}</span>
          <span class="badge badge-evenement-${e.type}">${TYPE_LABELS_EVENEMENT[e.type]}</span>
          <span>${escapeHtml(e.titre)}${e.lieu ? " — " + escapeHtml(e.lieu) : ""}</span>
        </div>`
              )
              .join("")
      }
    </div>`;
  wireChipClicks();
}

function renderListe() {
  const { debut, fin } = periodeCourante();
  const parJour = new Map();
  evenements.forEach((e) => {
    const key = debutJour(new Date(e.dateDebut)).toISOString();
    if (!parJour.has(key)) parJour.set(key, []);
    parJour.get(key).push(e);
  });

  const jours = [];
  for (let d = new Date(debut); d < fin; d = ajouterJours(d, 1)) {
    const key = debutJour(d).toISOString();
    if (parJour.has(key)) jours.push({ date: new Date(d), items: parJour.get(key) });
  }

  document.getElementById("cal-body").innerHTML =
    jours.length === 0
      ? '<p class="muted">Aucun événement pour cette période.</p>'
      : jours
          .map(
            (j) => `
      <div class="cal-liste-jour">
        <div class="cal-liste-jour-titre">${j.date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}</div>
        ${j.items
          .sort((a, b) => new Date(a.dateDebut) - new Date(b.dateDebut))
          .map(
            (e) => `
          <div class="cal-liste-item" data-evenement-id="${e.id}">
            <span class="cal-liste-item-heure">${e.touteLaJournee ? "Journée" : formatHeure(new Date(e.dateDebut))}</span>
            <span class="badge badge-evenement-${e.type}">${TYPE_LABELS_EVENEMENT[e.type]}</span>
            <span>${escapeHtml(e.titre)}${e.dossier ? " — " + escapeHtml(e.dossier.numeroDossier) : ""}</span>
          </div>`
          )
          .join("")}
      </div>`
          )
          .join("");
  wireChipClicks();
}

function renderVue() {
  if (currentVue === "mois") renderMois();
  else if (currentVue === "semaine") renderSemaine();
  else if (currentVue === "jour") renderJour();
  else renderListe();
}

function wireChipClicks() {
  document.querySelectorAll("[data-evenement-id]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const evenement = evenements.find((ev) => ev.id === el.dataset.evenementId);
      if (evenement) ouvrirDetail(evenement);
    });
  });
}

function basculerVue(vue) {
  currentVue = vue;
  document.querySelectorAll("#cal-view-tabs .tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.vue === vue));
  chargerEvenements();
}

// ---------- Detail ----------
const detailModal = document.getElementById("cal-detail-modal");

async function ouvrirDetail(evenement) {
  currentDetailEvenement = evenement;
  currentDetailAudience = null;
  document.getElementById("cal-detail-badge").className = `badge badge-evenement-${evenement.type}`;
  document.getElementById("cal-detail-badge").textContent = TYPE_LABELS_EVENEMENT[evenement.type];
  document.getElementById("cal-detail-titre").textContent = evenement.titre;
  const debut = new Date(evenement.dateDebut);
  const dateTexte = evenement.touteLaJournee
    ? formatDateLongue(debut)
    : `${formatDateLongue(debut)} à ${formatHeure(debut)}`;
  document.getElementById("cal-detail-date").textContent = dateTexte;
  document.getElementById("cal-detail-lieu").textContent = evenement.lieu ? `📍 ${evenement.lieu}` : "";
  document.getElementById("cal-detail-description").textContent = evenement.description || "";
  const dossierEl = document.getElementById("cal-detail-dossier");
  dossierEl.innerHTML = evenement.dossier
    ? `<a href="/dossier.html?id=${evenement.dossier.id}">Voir le dossier ${escapeHtml(evenement.dossier.numeroDossier)} — ${escapeHtml(evenement.dossier.nomAffaire)}</a>`
    : "";
  const assignesEl = document.getElementById("cal-detail-assignes");
  assignesEl.textContent =
    evenement.assignes && evenement.assignes.length > 0
      ? `Assigné(e)(s) : ${evenement.assignes.map((a) => a.user.nom).join(", ")}`
      : "";

  const extraEl = document.getElementById("cal-detail-audience-extra");
  extraEl.hidden = true;

  // Une audience (fusion Calendrier / Calendrier Audiences) s'edite et se
  // supprime directement ici, via /api/role-audiences. Un evenement cree
  // depuis la confirmation d'un email ("Boite de reception") se comporte
  // comme un evenement manuel (voir routes/evenements.ts, meme garde-fou
  // cote serveur) : rien ne le resynchronise depuis l'email d'origine apres
  // coup. Seule une echeance de delai calculee reste generee-seule (source
  // de verite = les delais) : la modifier ici serait ecrasee sans avertissement
  // au prochain recalcul du delai.
  const estManuel = evenement.source === "manuel";
  const estAudience = evenement.source === "role_audience";
  const estEmail = evenement.source === "email";
  document.getElementById("cal-detail-modifier-btn").hidden = !(estManuel || estAudience || estEmail);
  document.getElementById("cal-detail-supprimer-btn").hidden = !(estManuel || estAudience || estEmail);
  if (!estManuel && !estAudience && !estEmail) {
    assignesEl.textContent += `${assignesEl.textContent ? " — " : ""}Généré automatiquement depuis le calcul de délais : modifie-le depuis les Délais.`;
  }

  detailModal.hidden = false;

  if (estAudience && evenement.roleAudienceId) {
    try {
      const audience = await apiFetch(`/api/role-audiences/${evenement.roleAudienceId}`);
      if (!currentDetailEvenement || currentDetailEvenement.id !== evenement.id) return;
      currentDetailAudience = audience;
      const lignes = [
        audience.procedureNumero && `Procédure n° ${audience.procedureNumero}`,
        audience.qualiteProcedurale && `Qualité procédurale : ${audience.qualiteProcedurale}`,
        audience.objetProcedure && `Objet : ${audience.objetProcedure}`,
        audience.dernierMotif && `Dernier motif : ${audience.dernierMotif}`,
        audience.diligences && `Diligences : ${audience.diligences}`,
      ].filter(Boolean);
      document.getElementById("cal-detail-audience-procedure").innerHTML = lignes.map(escapeHtml).join("<br />");
      document.getElementById("cal-detail-audience-statut").value = audience.statut;
      extraEl.hidden = false;
    } catch {
      // Non bloquant : le detail de base (deja affiche) reste utilisable.
    }
  }
}

document.getElementById("cal-detail-fermer-btn").addEventListener("click", () => {
  detailModal.hidden = true;
});
document.getElementById("cal-detail-audience-statut").addEventListener("change", async (e) => {
  if (!currentDetailAudience) return;
  try {
    await apiFetch(`/api/role-audiences/${currentDetailAudience.id}`, { method: "PATCH", body: { statut: e.target.value } });
    await chargerEvenements();
  } catch (err) {
    alert(err.message);
  }
});
document.getElementById("cal-detail-supprimer-btn").addEventListener("click", async () => {
  if (!currentDetailEvenement) return;
  const estAudience = currentDetailEvenement.source === "role_audience";
  if (!confirm(estAudience ? "Supprimer cette audience du calendrier ?" : "Supprimer cet événement ?")) return;
  try {
    if (estAudience && currentDetailEvenement.roleAudienceId) {
      await apiFetch(`/api/role-audiences/${currentDetailEvenement.roleAudienceId}`, { method: "DELETE" });
    } else {
      await apiFetch(`/api/evenements/${currentDetailEvenement.id}`, { method: "DELETE" });
    }
    detailModal.hidden = true;
    await chargerEvenements();
    await chargerSuggestions();
  } catch (err) {
    alert(err.message);
  }
});
document.getElementById("cal-detail-modifier-btn").addEventListener("click", async () => {
  if (!currentDetailEvenement) return;
  const evenement = currentDetailEvenement;
  detailModal.hidden = true;
  if (evenement.source === "role_audience" && evenement.roleAudienceId) {
    try {
      const audience = currentDetailAudience || (await apiFetch(`/api/role-audiences/${evenement.roleAudienceId}`));
      ouvrirFormulaireAudience(audience);
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  ouvrirFormulaire(evenement);
});

// ---------- Creation / edition ----------
const formModal = document.getElementById("cal-form-modal");
const calForm = document.getElementById("cal-form");

function renderAssignesCheckboxes(selectionnes) {
  const container = document.getElementById("cal-form-assignes");
  const selection = new Set((selectionnes || []).map((a) => (a.user ? a.user.id : a)));
  container.innerHTML = annuaire
    .map(
      (u) => `
      <label>
        <input type="checkbox" value="${u.id}" ${selection.has(u.id) ? "checked" : ""} /> ${escapeHtml(u.nom)}
      </label>`
    )
    .join("");
}

const CHAMPS_AUDIENCE = [
  "juridiction",
  "chambre",
  "procedureNumero",
  "parties",
  "qualiteProcedurale",
  "objetProcedure",
  "dernierMotif",
  "diligences",
];

// Bascule le formulaire entre les champs "audience" (dedies, route
// /api/role-audiences) et les champs "evenement manuel" (rdv/appel/tache/
// autre, route /api/evenements) - fusion Calendrier / Calendrier Audiences :
// un seul formulaire, deux routes backend selon le type choisi.
function basculerChampsFormulaire(type) {
  const estAudience = type === "audience";
  document.getElementById("cal-form-audience-fields").hidden = !estAudience;
  document.getElementById("cal-form-manuel-fields").hidden = estAudience;
  document.getElementById("cal-form-fin-fields").hidden = estAudience;
  document.getElementById("cal-form-assignes-field").hidden = estAudience;
  document.getElementById("cal-form-titre").required = !estAudience;
  document.getElementById("cal-form-juridiction").required = estAudience;
  document.getElementById("cal-form-parties").required = estAudience;
}
document.getElementById("cal-form-type").addEventListener("change", (e) => {
  basculerChampsFormulaire(e.target.value);
});

function ouvrirFormulaire(evenement, dateInitiale) {
  document.getElementById("cal-form-heading").textContent = evenement ? "Modifier l'événement" : "Nouvel événement";
  document.getElementById("cal-form-id").value = evenement ? evenement.id : "";
  document.getElementById("cal-form-audience-id").value = "";
  const typeSelect = document.getElementById("cal-form-type");
  typeSelect.value = evenement ? evenement.type : "rdv";
  typeSelect.disabled = !!evenement;
  basculerChampsFormulaire(typeSelect.value);
  document.getElementById("cal-form-titre").value = evenement ? evenement.titre : "";
  document.getElementById("cal-form-description").value = evenement ? evenement.description || "" : "";
  const debutInitial = evenement ? new Date(evenement.dateDebut) : dateInitiale || new Date();
  document.getElementById("cal-form-dateDebut").value = toDatetimeLocalValue(debutInitial);
  document.getElementById("cal-form-dateFin").value = evenement && evenement.dateFin ? toDatetimeLocalValue(new Date(evenement.dateFin)) : "";
  document.getElementById("cal-form-touteLaJournee").checked = evenement ? evenement.touteLaJournee : false;
  document.getElementById("cal-form-lieu").value = evenement ? evenement.lieu || "" : "";
  document.getElementById("cal-form-dossierNumero").value = evenement && evenement.dossier ? evenement.dossier.numeroDossier : "";
  CHAMPS_AUDIENCE.forEach((f) => {
    document.getElementById(`cal-form-${f}`).value = "";
  });
  renderAssignesCheckboxes(evenement ? evenement.assignes : []);
  hideError(document.getElementById("cal-form-error"));
  document.getElementById("cal-form-submit-error").textContent = "";
  formModal.hidden = false;
}

// Edition d'une audience existante (bouton "Modifier" du detail) - meme
// modale que les evenements manuels, mais prefillee depuis le RoleAudience
// (le type reste verrouille sur "audience").
function ouvrirFormulaireAudience(audience) {
  document.getElementById("cal-form-heading").textContent = "Modifier l'audience";
  document.getElementById("cal-form-id").value = "";
  document.getElementById("cal-form-audience-id").value = audience.id;
  const typeSelect = document.getElementById("cal-form-type");
  typeSelect.value = "audience";
  typeSelect.disabled = true;
  basculerChampsFormulaire("audience");
  document.getElementById("cal-form-dateDebut").value = toDatetimeLocalValue(new Date(audience.dateAudience));
  document.getElementById("cal-form-dossierNumero").value = audience.dossier ? audience.dossier.numeroDossier : "";
  CHAMPS_AUDIENCE.forEach((f) => {
    document.getElementById(`cal-form-${f}`).value = audience[f] || "";
  });
  hideError(document.getElementById("cal-form-error"));
  document.getElementById("cal-form-submit-error").textContent = "";
  formModal.hidden = false;
}

document.getElementById("cal-nouvel-evenement-btn").addEventListener("click", () => ouvrirFormulaire(null, currentDate));
document.getElementById("cal-form-cancel-btn").addEventListener("click", () => {
  formModal.hidden = true;
});

calForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("cal-form-submit-error");
  errorEl.textContent = "";

  const type = document.getElementById("cal-form-type").value;
  const fd = new FormData(calForm);
  const dossierNumero = (fd.get("dossierNumero") || "").trim();
  const dossier = dossierNumero ? dossiersParNumero.get(dossierNumero) : null;
  if (dossierNumero && !dossier) {
    errorEl.textContent = "Numéro de dossier introuvable.";
    return;
  }

  if (type === "audience") {
    const audienceId = document.getElementById("cal-form-audience-id").value;
    const dateAudienceLocale = new Date(fd.get("dateDebut"));
    if (!audienceId && dateAudienceLocale.getTime() < Date.now()) {
      errorEl.textContent = "La date de l'audience ne peut pas être dans le passé. Vérifie la date saisie.";
      return;
    }
    const payload = {
      dateAudience: dateAudienceLocale.toISOString(),
      juridiction: fd.get("juridiction"),
      chambre: fd.get("chambre") || undefined,
      procedureNumero: fd.get("procedureNumero") || undefined,
      parties: fd.get("parties"),
      qualiteProcedurale: fd.get("qualiteProcedurale") || undefined,
      objetProcedure: fd.get("objetProcedure") || undefined,
      dernierMotif: fd.get("dernierMotif") || undefined,
      diligences: fd.get("diligences") || undefined,
      dossierId: dossier ? dossier.id : undefined,
    };
    try {
      if (audienceId) {
        await apiFetch(`/api/role-audiences/${audienceId}`, { method: "PATCH", body: payload });
      } else {
        await apiFetch("/api/role-audiences", { method: "POST", body: payload });
      }
      formModal.hidden = true;
      await chargerEvenements();
      await chargerSuggestions();
    } catch (err) {
      errorEl.textContent = err.message;
    }
    return;
  }

  const id = document.getElementById("cal-form-id").value;
  const assignes = Array.from(document.querySelectorAll('#cal-form-assignes input[type="checkbox"]:checked')).map(
    (cb) => cb.value
  );

  const payload = {
    type,
    titre: fd.get("titre"),
    description: fd.get("description") || undefined,
    dateDebut: new Date(fd.get("dateDebut")).toISOString(),
    dateFin: fd.get("dateFin") ? new Date(fd.get("dateFin")).toISOString() : undefined,
    touteLaJournee: fd.get("touteLaJournee") === "on",
    lieu: fd.get("lieu") || undefined,
    dossierId: dossier ? dossier.id : undefined,
    assignes,
  };

  try {
    if (id) {
      await apiFetch(`/api/evenements/${id}`, { method: "PATCH", body: payload });
    } else {
      await apiFetch("/api/evenements", { method: "POST", body: payload });
    }
    formModal.hidden = true;
    await chargerEvenements();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// ---------- Suggestions d'audiences (reprises du Calendrier Audiences) ----------
// Dossiers dont le dernier compte-rendu annonce une prochaine audience ce
// mois-ci et qui n'ont pas encore ete ajoutes au calendrier.
async function chargerSuggestions() {
  const box = document.getElementById("cal-suggestions-content");
  try {
    const debutStr = toLocalDateStr(debutMois(currentDate));
    const { suggestions } = await apiFetch(`/api/role-audiences/suggestions?debut=${debutStr}&periode=mois`);
    if (suggestions.length === 0) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = `
      <div class="card">
        <h2 style="margin-bottom:6px;">Suggestions d'audiences</h2>
        <p class="muted" style="margin-top:0;">Ces dossiers annoncent une prochaine audience ce mois-ci dans leur dernier compte-rendu — vérifie et complète avant d'ajouter au calendrier.</p>
        ${suggestions
          .map(
            (s) => `
          <div class="dossier-item">
            <div>
              <strong>${escapeHtml(s.dossier.nomAffaire)}</strong>
              <div class="meta">Dossier ${escapeHtml(s.dossier.numeroDossier)} · ${escapeHtml(s.dossier.nomClient)} · Prochaine audience : ${new Date(s.prochaineAudience).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${s.piecesPrevoir ? `<br />Pièces à prévoir : ${escapeHtml(s.piecesPrevoir)}` : ""}</div>
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <button type="button" class="secondary btn-sm" data-suggestion-add='${JSON.stringify({ dossierId: s.dossierId, dossierNumero: s.dossier.numeroDossier, parties: s.dossier.nomAffaire, prochaineAudience: s.prochaineAudience }).replace(/'/g, "&#39;")}'>Ajouter au calendrier</button>
              <button type="button" class="ghost btn-sm" data-suggestion-ignorer="${s.actionId}">Ne pas ajouter au calendrier</button>
            </div>
          </div>`
          )
          .join("")}
      </div>`;
    box.querySelectorAll("[data-suggestion-add]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = JSON.parse(btn.dataset.suggestionAdd);
        ouvrirFormulaire(null, new Date(s.prochaineAudience));
        const typeSelect = document.getElementById("cal-form-type");
        typeSelect.value = "audience";
        typeSelect.disabled = false;
        basculerChampsFormulaire("audience");
        document.getElementById("cal-form-dossierNumero").value = s.dossierNumero;
        document.getElementById("cal-form-parties").value = s.parties;
      });
    });
    box.querySelectorAll("[data-suggestion-ignorer]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await apiFetch(`/api/role-audiences/suggestions/${btn.dataset.suggestionIgnorer}/ignorer`, { method: "POST" });
          chargerSuggestions();
        } catch (err) {
          showError(document.getElementById("error"), err.message);
        }
      });
    });
  } catch {
    box.innerHTML = "";
  }
}

// ---------- Navigation / filtres ----------
document.querySelectorAll("#cal-view-tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => basculerVue(btn.dataset.vue));
});
document.getElementById("cal-prev-btn").addEventListener("click", () => {
  if (currentVue === "jour") currentDate = ajouterJours(currentDate, -1);
  else if (currentVue === "semaine") currentDate = ajouterJours(currentDate, -7);
  else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1);
  chargerEvenements();
  chargerSuggestions();
});
document.getElementById("cal-next-btn").addEventListener("click", () => {
  if (currentVue === "jour") currentDate = ajouterJours(currentDate, 1);
  else if (currentVue === "semaine") currentDate = ajouterJours(currentDate, 7);
  else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
  chargerEvenements();
  chargerSuggestions();
});
document.getElementById("cal-today-btn").addEventListener("click", () => {
  currentDate = new Date();
  chargerEvenements();
  chargerSuggestions();
});
document.getElementById("cal-filter-type").addEventListener("change", (e) => {
  filtreType = e.target.value;
  chargerEvenements();
});
document.getElementById("cal-filter-assigne").addEventListener("change", (e) => {
  filtreAssigne = e.target.value;
  chargerEvenements();
});
document.querySelectorAll("#cal-scope-tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentScope = btn.dataset.scope;
    document.querySelectorAll("#cal-scope-tabs .tab").forEach((b) => b.classList.toggle("active", b === btn));
    chargerEvenements();
  });
});

async function chargerReferentiels() {
  try {
    annuaire = await apiFetch("/api/users/annuaire");
    const select = document.getElementById("cal-filter-assigne");
    select.innerHTML =
      '<option value="">Tous les collaborateurs</option>' +
      annuaire.map((u) => `<option value="${u.id}">${escapeHtml(u.nom)}</option>`).join("");
  } catch {
    annuaire = [];
  }
  try {
    const { dossiers } = await apiFetch("/api/dossiers");
    const datalist = document.getElementById("cal-dossiers-datalist");
    datalist.innerHTML = dossiers
      .map((d) => `<option value="${escapeHtml(d.numeroDossier)}">${escapeHtml(d.nomAffaire)}</option>`)
      .join("");
    dossiers.forEach((d) => dossiersParNumero.set(d.numeroDossier, d));
  } catch {
    // Non bloquant : la creation d'un evenement sans dossier reste possible.
  }
}

(async () => {
  me = await requireSession();
  if (!me) return;
  initLayout(me);

  if (peutVoirTouLeCabinet()) {
    document.getElementById("cal-scope-tabs").style.display = "";
    document.querySelector('#cal-scope-tabs .tab[data-scope="mine"]').classList.add("active");
  }

  // Lien depuis l'Agenda du dossier (?date=YYYY-MM-DD&vue=jour) - centre le
  // calendrier sur la date correspondante.
  const params = new URLSearchParams(window.location.search);
  const dateParam = params.get("date");
  if (dateParam) {
    const parsed = new Date(dateParam);
    if (!Number.isNaN(parsed.getTime())) currentDate = parsed;
  }
  const vueParam = params.get("vue");
  if (vueParam && ["mois", "semaine", "jour", "liste"].includes(vueParam)) currentVue = vueParam;
  document.querySelectorAll("#cal-view-tabs .tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.vue === currentVue));

  await chargerReferentiels();
  await chargerEvenements();
  await chargerSuggestions();
})();
