// Lot 12b - ecran de connexion/deconnexion des agendas externes (Google
// Calendar OAuth2 + CalDAV generique), dans "Mon profil".

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function afficherMessageDepuisUrl() {
  const params = new URLSearchParams(window.location.search);
  const infoEl = document.getElementById("info");
  const errorEl = document.getElementById("error");
  if (params.get("connecte") === "google") {
    infoEl.textContent = "Google Calendar connecté avec succès.";
    infoEl.style.display = "block";
  } else if (params.get("erreur") === "google_refuse") {
    showError(errorEl, "Connexion Google annulée.");
  } else if (params.get("erreur") === "google_echec") {
    showError(errorEl, "Échec de la connexion à Google Calendar — réessaie dans un instant.");
  }
  if (params.toString()) {
    window.history.replaceState({}, "", window.location.pathname);
  }
}

function renderGoogleStatus(connexionGoogle) {
  const el = document.getElementById("google-status");
  if (!connexionGoogle) {
    el.innerHTML = `
      <p class="muted">Non connecté.</p>
      <a href="/api/calendrier-externe/google/connecter" class="secondary" style="display:inline-block; text-decoration:none; padding:6px 12px; border-radius:6px;">Connecter Google Calendar</a>`;
    return;
  }
  el.innerHTML = `
    <p>Connecté depuis le ${new Date(connexionGoogle.createdAt).toLocaleDateString("fr-FR")}.</p>
    ${connexionGoogle.derniereErreur ? `<p class="error visible">${escapeHtml(connexionGoogle.derniereErreur)}</p>` : ""}
    <button type="button" class="danger btn-sm" data-deconnecter="${connexionGoogle.id}">Déconnecter</button>`;
}

function renderCaldavStatus(connexionCaldav) {
  const el = document.getElementById("caldav-status");
  const form = document.getElementById("caldav-form");
  if (!connexionCaldav) {
    el.innerHTML = '<p class="muted">Non connecté.</p>';
    form.style.display = "block";
    return;
  }
  el.innerHTML = `
    <p>Connecté en tant que ${escapeHtml(connexionCaldav.caldavUsername || "")} depuis le ${new Date(connexionCaldav.createdAt).toLocaleDateString("fr-FR")}.</p>
    ${connexionCaldav.derniereErreur ? `<p class="error visible">${escapeHtml(connexionCaldav.derniereErreur)}</p>` : ""}
    <button type="button" class="danger btn-sm" data-deconnecter="${connexionCaldav.id}">Déconnecter</button>`;
  form.style.display = "none";
}

async function deconnecter(id) {
  if (!confirm("Déconnecter cet agenda ? Les événements déjà créés dans Aurore et dans l'agenda externe ne sont jamais affectés — seule la synchronisation future s'arrête.")) {
    return;
  }
  try {
    await apiFetch(`/api/calendrier-externe/${id}`, { method: "DELETE" });
    await chargerStatuts();
  } catch (err) {
    showError(document.getElementById("error"), err.message);
  }
}

async function chargerStatuts() {
  const errorEl = document.getElementById("error");
  hideError(errorEl);
  try {
    const connexions = await apiFetch("/api/calendrier-externe/statut");
    const google = connexions.find((c) => c.provider === "google");
    const caldav = connexions.find((c) => c.provider === "caldav");
    renderGoogleStatus(google);
    renderCaldavStatus(caldav);

    document.querySelectorAll("[data-deconnecter]").forEach((btn) => {
      btn.addEventListener("click", () => deconnecter(btn.dataset.deconnecter));
    });
  } catch (err) {
    showError(errorEl, err.message);
  }
}

document.getElementById("caldav-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("error");
  hideError(errorEl);
  const fd = new FormData(e.target);
  try {
    await apiFetch("/api/calendrier-externe/caldav", {
      method: "POST",
      body: {
        caldavUrl: fd.get("caldavUrl"),
        caldavUsername: fd.get("caldavUsername"),
        caldavPassword: fd.get("caldavPassword"),
      },
    });
    e.target.reset();
    await chargerStatuts();
  } catch (err) {
    showError(errorEl, err.message);
  }
});

(async () => {
  const me = await requireSession();
  if (!me) return;
  initLayout(me);
  afficherMessageDepuisUrl();
  await chargerStatuts();
})();
