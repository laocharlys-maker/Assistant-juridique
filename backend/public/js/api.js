/**
 * Telecharge un fichier binaire (Word/PDF...) genere par une route API
 * authentifiee. JAMAIS via un simple `<a href target="_blank">` : dans la
 * webview desktop (Tauri), l'ouverture d'une "nouvelle fenetre" declenchee
 * par target="_blank" n'a aucun gestionnaire enregistre cote Rust
 * (src-tauri/src/main.rs n'ecoute que CloseRequested) - le clic ne produit
 * alors STRICTEMENT AUCUN EFFET, de facon totalement silencieuse (aucune
 * requete HTTP emise, aucune erreur visible, rien dans les logs) - constate
 * concretement sur les telechargements Word/PDF de "Nouvelle action" et de
 * "Jurisprudence". fetch() + Blob + `<a download>` declenche a la place la
 * boite de dialogue native "Enregistrer sous" du systeme d'exploitation,
 * sans jamais passer par un mecanisme de nouvelle fenetre - fonctionne
 * identiquement dans un navigateur classique et dans la webview desktop.
 */
async function downloadFile(url, fallbackFilename) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || `Erreur ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/);
  const filename = match ? match[1] : fallbackFilename;
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error || `Erreur ${response.status}`;
    const error = new Error(message);
    // Conserve le statut HTTP et le corps de reponse (ex: licenceEtat sur un
    // 403 de licence, voir middleware/requireLicence.ts) - additif, ne
    // change rien pour les appelants existants qui n'utilisent que
    // err.message.
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

async function requireSession() {
  try {
    return await apiFetch("/api/auth/me");
  } catch (err) {
    // Une licence invalide/expiree bloque /api/auth/me comme le reste de
    // l'API (voir middleware/requireLicence.ts) - dans ce cas, rediriger
    // vers l'ecran de connexion serait une impasse (le login lui-meme est
    // bloque). Seul l'ecran d'activation permet de sortir de cet etat.
    window.location.href = err && err.body && err.body.licenceEtat ? "/licence.html" : "/login.html";
    return null;
  }
}

function showError(el, message) {
  el.textContent = message;
  el.classList.add("visible");
}

function hideError(el) {
  el.classList.remove("visible");
}

// Marque d'un asterisque tout label directement suivi d'un champ obligatoire
// (input/select/textarea[required]) - evite de devoir le faire a la main
// dans chaque page. Les champs facultatifs ne sont jamais touches.
function markRequiredFields() {
  document.querySelectorAll("input[required], select[required], textarea[required]").forEach((field) => {
    const label = field.previousElementSibling;
    if (label && label.tagName === "LABEL" && !label.querySelector(".required-mark")) {
      const mark = document.createElement("span");
      mark.className = "required-mark";
      mark.textContent = " *";
      mark.setAttribute("aria-hidden", "true");
      label.appendChild(mark);
    }
  });
}
document.addEventListener("DOMContentLoaded", markRequiredFields);

// Ecran de premier lancement : si le mode de deploiement (poste unique /
// serveur reseau, Lot 6) n'a jamais ete choisi, redirige vers l'ecran de
// bienvenue (Lot 8) - avant meme l'ecran de licence, sur TOUTE page qui
// charge ce script (donc sans avoir a instrumenter chaque page une par
// une). welcome-setup.html enchaine lui-meme vers setup-mode.html (choix
// du mode) puis licence.html (activation) - voir welcome-setup.js.
// /api/network-info reste toujours accessible (voir
// middleware/requireLicence.ts), y compris sans licence ni session.
(async () => {
  if (window.location.pathname.startsWith("/setup-mode") || window.location.pathname.startsWith("/welcome-setup")) return;
  try {
    const info = await apiFetch("/api/network-info");
    if (!info.setupComplete) {
      window.location.href = "/welcome-setup.html";
    }
  } catch {
    // /api/network-info ne devrait normalement jamais echouer (route
    // publique) - en cas de souci reseau/serveur, ne bloque pas la page :
    // requireSession()/l'ecran de licence prennent le relais normalement.
  }
})();
