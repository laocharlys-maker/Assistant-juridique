/**
 * Message temporaire bien visible en haut de l'ecran, sans dependance a une
 * page en particulier (styles inline, s'auto-detruit) - utilise pour
 * confirmer un telechargement (voir downloadFile ci-dessous) : sans ca,
 * rien a l'ecran n'indique qu'un clic a fonctionne (le fichier part
 * directement dans le dossier Telechargements, hors de vue), ce qui laisse
 * un utilisateur non technique legitimement penser que le clic n'a rien
 * fait.
 */
function showToast(message) {
  const toast = document.createElement("div");
  toast.textContent = `✅ ${message}`;
  // En haut de l'ecran (pas en bas) et 5s (pas 3s) : un premier essai en
  // bas/court s'est revele trop discret pour etre remarque de facon fiable
  // (confirme present dans le DOM lors d'un test automatise, mais pas
  // remarque par un vrai utilisateur pendant un test manuel) - plus grand,
  // plus long, couleur de succes, en haut ou le regard revient naturellement
  // apres un clic.
  toast.style.cssText = [
    "position:fixed",
    "left:50%",
    "top:24px",
    "transform:translateX(-50%)",
    "background:#166534",
    "color:#fff",
    "padding:14px 24px",
    "border-radius:10px",
    "font-size:1rem",
    "font-weight:600",
    "box-shadow:0 6px 20px rgba(0,0,0,0.3)",
    "z-index:99999",
    "opacity:0",
    "transition:opacity 0.2s ease",
    "max-width:min(90vw, 480px)",
    "text-align:center",
  ].join(";");
  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = "1";
  });
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 250);
  }, 5000);
}

/**
 * Variante de showToast() pour les actions suivies d'un window.location.reload()
 * immediat (ex: envoi d'un document depuis la fiche dossier) : un showToast()
 * classique n'aurait pas le temps de s'afficher avant que le rechargement ne
 * detruise le DOM. Le message est memorise avant le rechargement, puis
 * consomme et affiche une seule fois au prochain chargement de page (voir
 * l'IIFE juste en dessous).
 */
function showToastAfterReload(message) {
  sessionStorage.setItem("aurore_toast_apres_rechargement", message);
}

(function () {
  const message = sessionStorage.getItem("aurore_toast_apres_rechargement");
  if (!message) return;
  sessionStorage.removeItem("aurore_toast_apres_rechargement");
  document.addEventListener("DOMContentLoaded", () => showToast(message));
})();

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
  showToast(`Téléchargement lancé : ${filename} — voir votre dossier Téléchargements.`);
}

/**
 * Ouvre un lien externe (source de jurisprudence...) avec le
 * navigateur par defaut du systeme. Meme raison que downloadFile()
 * ci-dessus : `<a href target="_blank">` n'a strictement aucun effet dans
 * la webview desktop Tauri. Passe par la commande Rust ouvrir_lien_externe
 * (voir src-tauri/src/main.rs) via window.__TAURI__.core.invoke - exposee
 * globalement par `app.withGlobalTauri: true` (tauri.conf.json), seule
 * option sans bundler JS pour ces scripts charges en balise <script> brute.
 * En dehors du contexte Tauri (page ouverte dans un navigateur classique,
 * ex: developpement), window.__TAURI__ est absent : repli sur
 * window.open(), comportement normal d'un navigateur.
 */
async function ouvrirLienExterne(url) {
  if (!url) return;
  try {
    if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function") {
      await window.__TAURI__.core.invoke("ouvrir_lien_externe", { url });
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  } catch (err) {
    // err peut etre soit une Error JS classique (repli window.open, rare),
    // soit directement la chaine renvoyee par le cote Rust (Result<(),
    // String> -> la valeur Err() est le rejet tel quel, jamais enveloppee
    // dans une Error) - toujours extraire un texte lisible, jamais
    // afficher "[object Object]".
    const detail =
      typeof err === "string" ? err : err && typeof err.message === "string" ? err.message : JSON.stringify(err);
    console.error("[lien-externe] impossible d'ouvrir le lien :", detail);
    showToast(`Impossible d'ouvrir ce lien : ${detail}`);
  }
}

// Delegation globale (une seule fois, sur document) plutot qu'un
// addEventListener par lien genere dynamiquement : couvre tout lien
// `class="lien-externe"` insere par n'importe quelle page via innerHTML
// (sources de jurisprudence...), y compris ceux ajoutes apres
// coup (resultat de recherche, etc.), sans avoir a re-brancher un listener
// a chaque rendu.
document.addEventListener("click", (event) => {
  const lien = event.target.closest("a.lien-externe");
  if (!lien) return;
  event.preventDefault();
  ouvrirLienExterne(lien.getAttribute("href"));
});

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
    // Une erreur de validation de formulaire (zod, voir schemas/*.ts cote
    // backend) renvoie toujours le meme message generique ("Formulaire
    // invalide") au niveau superieur, avec le detail exploitable (quel
    // champ, pourquoi) dans `details` - jamais affiche jusqu'ici, laissant
    // l'utilisateur sans aucune indication sur ce qui doit etre corrige
    // (constate concretement : "Le contenu doit etre suffisamment
    // detaille..." reste invisible, seul "Formulaire invalide" s'affiche).
    // Corrige ici, au point d'entree unique de tous les appels API, plutot
    // que formulaire par formulaire.
    let message = data.error || `Erreur ${response.status}`;
    if (Array.isArray(data.details) && data.details.length > 0) {
      const detailMessages = data.details
        .map((d) => (d && typeof d.message === "string" ? d.message : null))
        .filter(Boolean);
      if (detailMessages.length > 0) {
        message = detailMessages.join(" ");
      }
    }
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
