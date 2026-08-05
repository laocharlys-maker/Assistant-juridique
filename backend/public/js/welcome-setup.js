const startBtn = document.getElementById("start-btn");

startBtn.addEventListener("click", () => {
  // setup-mode.html (Lot 6) gere le choix Poste unique/Serveur reseau ; une
  // fois confirme, la suite normale de l'application (licence puis
  // connexion, deja geree par requireSession()/le gate licence) prend le
  // relais automatiquement - rien d'autre a orchestrer ici.
  window.location.href = "/setup-mode.html";
});

// Si cette page est rouverte alors que la configuration initiale a deja
// ete faite (ex: favori, retour arriere du navigateur), inutile de la
// montrer a nouveau - redirige directement vers la suite normale.
(async () => {
  try {
    const info = await apiFetch("/api/network-info");
    if (info.setupComplete) {
      window.location.href = "/login.html";
    }
  } catch {
    // Pas bloquant : l'utilisateur peut simplement cliquer "Commencer".
  }
})();
