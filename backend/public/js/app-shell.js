/**
 * Coquille a onglets : la sidebar/topbar (initLayout(), layout.js) restent
 * fixes, et chaque ecran de l'appli (dossier, nouvelle action, courriers...)
 * se charge dans un <iframe> garde en vie - changer d'onglet ne recharge
 * jamais une page, donc un formulaire en cours de remplissage n'est jamais
 * perdu. Fermer un onglet (icone x) detruit bien son iframe (et donc son
 * formulaire non enregistre) - comportement attendu, identique a fermer un
 * onglet de navigateur.
 *
 * Point d'entree unique pour toute l'appli : window.auroraOuvrirOnglet(url),
 * expose ici et appele depuis n'importe quelle page via irAPagina()/le clic
 * sur un lien interne (voir js/api.js, obtenirControleurOnglets()).
 */

let auroraOnglets = [];

function auroraPageInitialePourRole(role) {
  // Meme regle que login.html (apresConnexion) - centralisee ici plutot que
  // dupliquee, puisque login.html redirige maintenant vers /app-shell.html
  // sans connaitre la destination finale.
  return role === "titulaire" || role === "avocat" ? "/tableau-de-bord.html" : "/dashboard.html";
}

function auroraTitreGeneriquePourUrl(url) {
  const nomFichier = url
    .split("?")[0]
    .split("#")[0]
    .replace(/^\//, "")
    .replace(/\.html$/, "");
  return nomFichier
    .split("-")
    .filter(Boolean)
    .map((mot) => mot.charAt(0).toUpperCase() + mot.slice(1))
    .join(" ");
}

function auroraTitreInitialPourUrl(url) {
  for (const item of NAV_ITEMS) {
    if (item.children) {
      const enfant = item.children.find((c) => c.href === url);
      if (enfant) return enfant.label;
    } else if (item.href === url || item.href === url.split("?")[0]) {
      return item.label;
    }
  }
  return auroraTitreGeneriquePourUrl(url);
}

function auroraTrouverOnglet(url) {
  return auroraOnglets.find((o) => o.url === url);
}

function auroraMettreAJourBoutonsFermer() {
  const unSeulOnglet = auroraOnglets.length <= 1;
  auroraOnglets.forEach((o) => {
    o.closeBtn.hidden = unSeulOnglet;
  });
}

function auroraMettreAJourSidebarActive(url) {
  const sidebar = document.getElementById("app-sidebar");
  if (!sidebar) return;
  const chemin = url.split("?")[0];

  sidebar.querySelectorAll("nav > a, .nav-children a").forEach((a) => {
    const href = a.getAttribute("href") || "";
    const actif = href === url || (!href.includes("?") && href === chemin);
    a.classList.toggle("active", actif);
  });

  sidebar.querySelectorAll("[data-nav-children]").forEach((children) => {
    const enfantActif = children.querySelector("a.active") != null;
    children.classList.toggle("open", enfantActif);
    const idx = children.getAttribute("data-nav-children");
    const bouton = sidebar.querySelector(`[data-nav-parent="${idx}"]`);
    if (bouton) {
      bouton.classList.toggle("active", enfantActif);
      bouton.setAttribute("aria-expanded", String(enfantActif));
    }
  });
}

function auroraActiverOnglet(onglet) {
  auroraOnglets.forEach((o) => {
    const actif = o === onglet;
    o.tabBtn.classList.toggle("active", actif);
    o.iframe.style.display = actif ? "block" : "none";
  });
  auroraMettreAJourSidebarActive(onglet.url);
}

function auroraFermerOnglet(onglet) {
  // Toujours garder au moins un onglet ouvert - fermer le dernier n'aurait
  // aucun sens (plus aucun ecran visible).
  if (auroraOnglets.length <= 1) return;

  const idx = auroraOnglets.indexOf(onglet);
  if (idx === -1) return;
  auroraOnglets.splice(idx, 1);
  onglet.tabBtn.remove();
  onglet.iframe.remove();
  auroraMettreAJourBoutonsFermer();

  const etaitActif = onglet.tabBtn.classList.contains("active");
  if (etaitActif) {
    const prochain = auroraOnglets[idx] || auroraOnglets[idx - 1] || auroraOnglets[0];
    if (prochain) auroraActiverOnglet(prochain);
  }
}

function auroraCreerOnglet(url) {
  const tabBar = document.getElementById("tab-bar");
  const tabContent = document.getElementById("tab-content");
  if (!tabBar || !tabContent) return null;

  const iframe = document.createElement("iframe");
  iframe.className = "tab-iframe";
  iframe.src = url;

  const tabBtn = document.createElement("div");
  tabBtn.className = "tab-item";
  tabBtn.setAttribute("role", "button");
  tabBtn.tabIndex = 0;

  const tabLabel = document.createElement("span");
  tabLabel.className = "tab-item-label";
  tabLabel.textContent = auroraTitreInitialPourUrl(url);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "tab-close-btn";
  closeBtn.setAttribute("aria-label", "Fermer l'onglet");
  closeBtn.innerHTML = "&times;";

  tabBtn.appendChild(tabLabel);
  tabBtn.appendChild(closeBtn);

  const onglet = { url, iframe, tabBtn, tabLabel, closeBtn };
  auroraOnglets.push(onglet);

  tabBtn.addEventListener("click", (e) => {
    if (e.target === closeBtn) return;
    auroraActiverOnglet(onglet);
  });
  tabBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      auroraActiverOnglet(onglet);
    }
  });
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    auroraFermerOnglet(onglet);
  });

  // Reprend le titre reel de la page une fois chargee (ex: "Dossier n°
  // 2026-014") quand il est plus precis que le libelle generique du menu -
  // jamais bloquant (acces a contentDocument toujours possible ici, meme
  // origine garantie).
  iframe.addEventListener("load", () => {
    try {
      const titreReel = iframe.contentDocument && iframe.contentDocument.title;
      if (titreReel) {
        const nettoye = titreReel.replace(/^Aurore\s*[—-]\s*/, "").trim();
        if (nettoye) tabLabel.textContent = nettoye;
      }
    } catch {
      // Jamais bloquant.
    }
  });

  tabBar.appendChild(tabBtn);
  tabContent.appendChild(iframe);
  auroraMettreAJourBoutonsFermer();
  return onglet;
}

window.auroraOuvrirOnglet = function (url) {
  const existant = auroraTrouverOnglet(url);
  if (existant) {
    auroraActiverOnglet(existant);
    return;
  }
  const onglet = auroraCreerOnglet(url);
  if (onglet) auroraActiverOnglet(onglet);
};

function initAuroraOnglets(me) {
  // Voir style.css, ".main-area.main-area--shell" : limite le display:flex
  // vertical a la coquille elle-meme, jamais aux autres pages (qui
  // reutilisent la meme classe ".main-area" sans jamais l'IIFE de
  // app-shell.js).
  document.querySelector(".main-area")?.classList.add("main-area--shell");
  window.auroraOuvrirOnglet(auroraPageInitialePourRole(me.role));
}
