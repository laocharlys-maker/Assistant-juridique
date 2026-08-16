// Lot 16 - ecran de connexion/deconnexion des boites mail externes
// (Gmail OAuth2 + IMAP generique), dans "Mon profil".

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function afficherMessageDepuisUrl() {
  const params = new URLSearchParams(window.location.search);
  const infoEl = document.getElementById("info");
  const errorEl = document.getElementById("error");
  if (params.get("connecte") === "gmail") {
    infoEl.textContent = "Gmail connecté avec succès.";
    infoEl.style.display = "block";
  } else if (params.get("erreur") === "gmail_refuse") {
    showError(errorEl, "Connexion Gmail annulée.");
  } else if (params.get("erreur") === "gmail_echec") {
    showError(errorEl, "Échec de la connexion à Gmail — réessaie dans un instant.");
  }
  if (params.toString()) {
    window.history.replaceState({}, "", window.location.pathname);
  }
}

function renderGmailStatus(connexion) {
  const el = document.getElementById("gmail-status");
  if (!connexion) {
    el.innerHTML = `
      <p class="muted">Non connecté.</p>
      <a href="/api/email-ingestion/gmail/connecter" class="secondary" style="display:inline-block; text-decoration:none; padding:6px 12px; border-radius:6px;">Connecter Gmail</a>`;
    return;
  }
  el.innerHTML = `
    <p>Connecté depuis le ${new Date(connexion.createdAt).toLocaleDateString("fr-FR")}.</p>
    ${connexion.derniereErreur ? `<p class="error visible">${escapeHtml(connexion.derniereErreur)}</p>` : ""}
    <button type="button" class="danger btn-sm" data-deconnecter="${connexion.id}">Déconnecter</button>`;
}

function renderImapStatus(connexion) {
  const el = document.getElementById("imap-status");
  const form = document.getElementById("imap-form");
  if (!connexion) {
    el.innerHTML = '<p class="muted">Non connecté.</p>';
    form.style.display = "block";
    return;
  }
  el.innerHTML = `
    <p>Connecté en tant que ${escapeHtml(connexion.imapUsername || "")} (${escapeHtml(connexion.imapHost || "")}) depuis le ${new Date(connexion.createdAt).toLocaleDateString("fr-FR")}.</p>
    <p class="muted">${connexion.smtpHost ? "Réponse depuis Aurore activée (SMTP configuré)." : "Réponse depuis Aurore non activée — aucun serveur SMTP renseigné."}</p>
    ${connexion.derniereErreur ? `<p class="error visible">${escapeHtml(connexion.derniereErreur)}</p>` : ""}
    <button type="button" class="danger btn-sm" data-deconnecter="${connexion.id}">Déconnecter</button>`;
  form.style.display = "none";
}

async function deconnecter(id) {
  if (!confirm("Déconnecter cette boîte mail ? Les pièces déjà importées et les événements déjà créés dans Aurore ne sont jamais affectés — seule la récupération future de nouveaux emails s'arrête.")) {
    return;
  }
  try {
    await apiFetch(`/api/email-ingestion/${id}`, { method: "DELETE" });
    await chargerStatuts();
  } catch (err) {
    showError(document.getElementById("error"), err.message);
  }
}

async function chargerStatuts() {
  const errorEl = document.getElementById("error");
  hideError(errorEl);
  try {
    const connexions = await apiFetch("/api/email-ingestion/statut");
    renderGmailStatus(connexions.find((c) => c.provider === "gmail"));
    renderImapStatus(connexions.find((c) => c.provider === "imap"));

    document.querySelectorAll("[data-deconnecter]").forEach((btn) => {
      btn.addEventListener("click", () => deconnecter(btn.dataset.deconnecter));
    });
  } catch (err) {
    showError(errorEl, err.message);
  }
}

document.getElementById("imap-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("error");
  hideError(errorEl);
  const fd = new FormData(e.target);
  try {
    await apiFetch("/api/email-ingestion/imap", {
      method: "POST",
      body: {
        imapHost: fd.get("imapHost"),
        imapPort: Number(fd.get("imapPort")),
        imapSecure: fd.get("imapSecure") === "on",
        imapUsername: fd.get("imapUsername"),
        imapPassword: fd.get("imapPassword"),
        smtpHost: fd.get("smtpHost") || undefined,
        smtpPort: fd.get("smtpPort") ? Number(fd.get("smtpPort")) : undefined,
        smtpSecure: fd.get("smtpSecure") === "on",
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
