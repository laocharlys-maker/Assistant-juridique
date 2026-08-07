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

function ouvrirDetail(evenement) {
  currentDetailEvenement = evenement;
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

  const estManuel = evenement.source === "manuel";
  document.getElementById("cal-detail-modifier-btn").hidden = !estManuel;
  document.getElementById("cal-detail-supprimer-btn").hidden = !estManuel;
  if (!estManuel) {
    const origine = evenement.source === "role_audience" ? "le rôle de la semaine" : "le calcul de délais";
    assignesEl.textContent += `${assignesEl.textContent ? " — " : ""}Généré automatiquement depuis ${origine} : modifie-le depuis sa source.`;
  }

  detailModal.hidden = false;
}

document.getElementById("cal-detail-fermer-btn").addEventListener("click", () => {
  detailModal.hidden = true;
});
document.getElementById("cal-detail-supprimer-btn").addEventListener("click", async () => {
  if (!currentDetailEvenement) return;
  if (!confirm("Supprimer cet événement ?")) return;
  try {
    await apiFetch(`/api/evenements/${currentDetailEvenement.id}`, { method: "DELETE" });
    detailModal.hidden = true;
    await chargerEvenements();
  } catch (err) {
    alert(err.message);
  }
});
document.getElementById("cal-detail-modifier-btn").addEventListener("click", () => {
  if (!currentDetailEvenement) return;
  detailModal.hidden = true;
  ouvrirFormulaire(currentDetailEvenement);
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

function ouvrirFormulaire(evenement, dateInitiale) {
  document.getElementById("cal-form-heading").textContent = evenement ? "Modifier l'événement" : "Nouvel événement";
  document.getElementById("cal-form-id").value = evenement ? evenement.id : "";
  document.getElementById("cal-form-type").value = evenement ? evenement.type : "rdv";
  document.getElementById("cal-form-titre").value = evenement ? evenement.titre : "";
  document.getElementById("cal-form-description").value = evenement ? evenement.description || "" : "";
  const debutInitial = evenement ? new Date(evenement.dateDebut) : dateInitiale || new Date();
  document.getElementById("cal-form-dateDebut").value = toDatetimeLocalValue(debutInitial);
  document.getElementById("cal-form-dateFin").value = evenement && evenement.dateFin ? toDatetimeLocalValue(new Date(evenement.dateFin)) : "";
  document.getElementById("cal-form-touteLaJournee").checked = evenement ? evenement.touteLaJournee : false;
  document.getElementById("cal-form-lieu").value = evenement ? evenement.lieu || "" : "";
  document.getElementById("cal-form-dossierNumero").value = evenement && evenement.dossier ? evenement.dossier.numeroDossier : "";
  renderAssignesCheckboxes(evenement ? evenement.assignes : []);
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

  const id = document.getElementById("cal-form-id").value;
  const fd = new FormData(calForm);
  const dossierNumero = (fd.get("dossierNumero") || "").trim();
  const dossier = dossierNumero ? dossiersParNumero.get(dossierNumero) : null;
  if (dossierNumero && !dossier) {
    errorEl.textContent = "Numéro de dossier introuvable.";
    return;
  }
  const assignes = Array.from(document.querySelectorAll('#cal-form-assignes input[type="checkbox"]:checked')).map(
    (cb) => cb.value
  );

  const payload = {
    type: fd.get("type"),
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

// ---------- Navigation / filtres ----------
document.querySelectorAll("#cal-view-tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => basculerVue(btn.dataset.vue));
});
document.getElementById("cal-prev-btn").addEventListener("click", () => {
  if (currentVue === "jour") currentDate = ajouterJours(currentDate, -1);
  else if (currentVue === "semaine") currentDate = ajouterJours(currentDate, -7);
  else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1);
  chargerEvenements();
});
document.getElementById("cal-next-btn").addEventListener("click", () => {
  if (currentVue === "jour") currentDate = ajouterJours(currentDate, 1);
  else if (currentVue === "semaine") currentDate = ajouterJours(currentDate, 7);
  else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
  chargerEvenements();
});
document.getElementById("cal-today-btn").addEventListener("click", () => {
  currentDate = new Date();
  chargerEvenements();
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
})();
