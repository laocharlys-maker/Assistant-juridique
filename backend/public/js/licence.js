const statusBox = document.getElementById("status-box");
const activationCard = document.getElementById("activation-card");
const activeCard = document.getElementById("active-card");
const activeMessage = document.getElementById("active-message");
const errorEl = document.getElementById("error");
const successEl = document.getElementById("success");
const dropzone = document.getElementById("dropzone");
const dropzoneLabel = document.getElementById("dropzone-label");
const dropzoneFilename = document.getElementById("dropzone-filename");
const fileInput = document.getElementById("file-input");
const codeInput = document.getElementById("code-input");
const activateBtn = document.getElementById("activate-btn");
const checkNowWrap = document.getElementById("check-now-wrap");
const checkNowBtn = document.getElementById("check-now-btn");

let fileContent = null;

function renderStatus(status) {
  statusBox.innerHTML = "";
  if (status.etat === "grace" || status.etat === "bloquee") {
    const box = document.createElement("div");
    box.className = `licence-status-box ${status.etat}`;
    box.textContent = status.messageUtilisateur;
    statusBox.appendChild(box);
  }

  const licenceUtilisable = status.etat === "valide" || status.etat === "grace";
  activeCard.style.display = licenceUtilisable ? "block" : "none";
  if (licenceUtilisable) {
    activeMessage.textContent = status.messageUtilisateur;
  }
  // Le formulaire d'activation reste toujours visible (meme licence valide :
  // permet d'activer une autre licence, ex: changement de poste/cabinet).
  activationCard.style.display = "block";
  // "Verifier maintenant" a un sens des qu'une licence (meme expiree/bloquee)
  // est installee - une revocation resolue ou un renouvellement cote
  // service peut toujours etre recupere. Inutile si aucune licence n'a
  // jamais ete activee sur ce poste (rien a verifier).
  checkNowWrap.style.display = status.etat === "absente" ? "none" : "block";
}

async function loadStatus() {
  try {
    const status = await apiFetch("/api/licence/status");
    renderStatus(status);
  } catch (err) {
    // /api/licence/status est toujours censee repondre (voir
    // middleware/requireLicence.ts) - une erreur ici signale un probleme
    // plus large (backend indisponible), pas un etat de licence normal.
    showError(errorEl, "Impossible de récupérer le statut de la licence. Réessayez dans quelques instants.");
  }
}

function setFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    fileContent = String(reader.result || "");
    dropzoneFilename.textContent = file.name;
    codeInput.value = "";
  };
  reader.onerror = () => {
    showError(errorEl, "Impossible de lire ce fichier.");
  };
  reader.readAsText(file);
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => setFile(fileInput.files[0]));

["dragenter", "dragover"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  });
});
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) setFile(file);
});

// Coller un code efface le fichier deja selectionne (un seul mode
// d'activation actif a la fois, evite toute ambiguite sur ce qui sera
// envoye).
codeInput.addEventListener("input", () => {
  if (codeInput.value.trim()) {
    fileContent = null;
    dropzoneFilename.textContent = "";
  }
});

activateBtn.addEventListener("click", async () => {
  hideError(errorEl);
  successEl.classList.remove("visible");
  const content = fileContent || codeInput.value.trim();
  if (!content) {
    showError(errorEl, "Déposez un fichier .lic ou collez un code d'activation avant de continuer.");
    return;
  }
  activateBtn.disabled = true;
  activateBtn.textContent = "Activation en cours…";
  try {
    const status = await apiFetch("/api/licence/activate", { method: "POST", body: { content } });
    fileContent = null;
    dropzoneFilename.textContent = "";
    codeInput.value = "";
    showError(successEl, "Licence activée avec succès.");
    renderStatus(status);
  } catch (err) {
    showError(errorEl, err.message);
  } finally {
    activateBtn.disabled = false;
    activateBtn.textContent = "Activer la licence";
  }
});

checkNowBtn?.addEventListener("click", async () => {
  hideError(errorEl);
  successEl.classList.remove("visible");
  checkNowBtn.disabled = true;
  checkNowBtn.textContent = "Vérification…";
  try {
    const { result, status } = await apiFetch("/api/licence/check-now", { method: "POST" });
    // result.ok distingue "verifie, tout va bien" de "rien a signaler" (mode
    // manuel, ou service en ligne pas encore configure - voir
    // security/licenceManager.ts runPhoneHomeCheck) - dans les deux cas le
    // message doit rester visible, jamais un clic sans aucun retour.
    if (result.ok) {
      showError(successEl, result.message);
    } else {
      showError(errorEl, result.message);
    }
    renderStatus(status);
  } catch (err) {
    showError(errorEl, err.message);
  } finally {
    checkNowBtn.disabled = false;
    checkNowBtn.textContent = "Vérifier maintenant";
  }
});

loadStatus();
