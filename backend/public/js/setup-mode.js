const errorEl = document.getElementById("error");
const cardStandalone = document.getElementById("card-standalone");
const cardReseau = document.getElementById("card-reseau");
const warningReseau = document.getElementById("warning-reseau");
const confirmBtn = document.getElementById("confirm-btn");
const doneCard = document.getElementById("done-card");
const doneMessage = document.getElementById("done-message");
const reseauNextSteps = document.getElementById("reseau-next-steps");

let modeChoisi = null;

function selectionner(mode) {
  modeChoisi = mode;
  cardStandalone.classList.toggle("selected", mode === "standalone");
  cardReseau.classList.toggle("selected", mode === "reseau");
  warningReseau.style.display = mode === "reseau" ? "block" : "none";
  confirmBtn.disabled = false;
}

cardStandalone.addEventListener("click", () => selectionner("standalone"));
cardReseau.addEventListener("click", () => selectionner("reseau"));

confirmBtn.addEventListener("click", async () => {
  if (!modeChoisi) return;
  hideError(errorEl);
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Enregistrement…";
  try {
    await apiFetch("/api/network-info/mode", { method: "POST", body: { mode: modeChoisi } });
    doneMessage.textContent =
      modeChoisi === "reseau"
        ? "Mode « Serveur réseau » activé."
        : "Mode « Poste unique » activé.";
    reseauNextSteps.style.display = modeChoisi === "reseau" ? "block" : "none";
    document.querySelector(".card").style.display = "none";
    doneCard.style.display = "block";
  } catch (err) {
    showError(
      errorEl,
      err.message === "Non authentifié"
        ? "Ce réglage est déjà configuré : connectez-vous en tant que titulaire pour le modifier."
        : err.message
    );
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Confirmer";
  }
});

// Pré-sélectionne le mode déjà actif si cet écran est rouvert après coup
// (ex: pour changer de mode plus tard, depuis les paramètres), et affiche
// les informations de connexion (IP/hostname/port) si le mode réseau est
// actif - a chaque visite, pas seulement juste après l'avoir choisi.
(async () => {
  try {
    const info = await apiFetch("/api/network-info");
    if (info.deploymentMode) selectionner(info.deploymentMode);

    if (info.deploymentMode === "reseau") {
      document.getElementById("info-hostname").textContent = `https://${info.hostname}:${info.port}`;
      document.getElementById("info-ip").textContent = info.localIp
        ? `https://${info.localIp}:${info.port}`
        : "aucune interface réseau locale détectée";
      document.getElementById("info-port").textContent = String(info.port);
      document.getElementById("connection-info-card").style.display = "block";
    }
  } catch {
    // Pas bloquant : l'utilisateur peut simplement choisir un mode.
  }
})();
