// Format de date unique utilise partout dans l'app pour l'affichage d'une
// date complete (ex: "dimanche 20 juillet 2026") - jamais le format court
// jour/mois/annee. Accepte une Date ou une chaine ISO.
function formatDateLongue(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

const NAV_ICONS = {
  dashboard: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  docs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h6"/>',
  plus: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 12v6"/><path d="M9 15h6"/>',
  clients: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  team: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  invoice: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 12h6"/><path d="M9 16h4"/>',
  radar: '<path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 2v10l7 4"/>',
  audit: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
};

const NAV_ITEMS = [
  { href: "/tableau-de-bord.html", label: "Tableau de bord", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "dashboard" },
  { href: "/calendrier.html", label: "Calendrier", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "calendar" },
  { href: "/nouvelle-action.html", label: "Nouvelle action", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "plus", moduleKey: "nouvelle_action" },
  { href: "/dashboard.html", label: "Documents générés", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "docs", moduleKey: "documents_generes" },
  { href: "/clients.html", label: "Clients", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "clients" },
  { href: "/jurisprudence-base.html", label: "Jurisprudence", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "book", moduleKey: "jurisprudence" },
  { href: "/delais-calculateur.html", label: "Délais", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "clock", moduleKey: "delais" },
  { href: "/feuilles-temps.html", label: "Feuilles de temps", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "clock", moduleKey: "facturation" },
  { href: "/boite-reception.html", label: "Boîte de réception", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "mail" },
  {
    label: "Équipe",
    roles: ["titulaire", "avocat"],
    group: "Cabinet",
    icon: "team",
    children: [
      { href: "/collaborateurs.html?filtre=avocat", label: "Avocats" },
      { href: "/collaborateurs.html?filtre=collaborateur", label: "Collaborateurs" },
    ],
  },
  { href: "/factures.html", label: "Facturation", roles: ["titulaire", "avocat"], group: "Cabinet", icon: "invoice", moduleKey: "facturation" },
  { href: "/veille-juridique.html", label: "Veille juridique", roles: ["titulaire", "avocat"], group: "Cabinet", icon: "radar", moduleKey: "veille_juridique" },
  { href: "/audit-logs.html", label: "Journal d'audit", roles: ["titulaire"], group: "Cabinet", icon: "audit" },
  { href: "/parametres.html", label: "Paramètres", roles: ["titulaire"], group: "Cabinet", icon: "settings" },
  { href: "/admin-tableau-de-bord.html", label: "Tableau de bord", roles: ["super_admin"], group: "Plateforme", icon: "dashboard" },
  { href: "/admin-plateforme.html", label: "Cabinets clients", roles: ["super_admin"], group: "Plateforme", icon: "team" },
  { href: "/admin-acces.html", label: "Accès & quotas", roles: ["super_admin"], group: "Plateforme", icon: "clock" },
  { href: "/admin-factures.html", label: "Facturation abonnement", roles: ["super_admin"], group: "Plateforme", icon: "invoice" },
  { href: "/journal-plateforme.html", label: "Journal plateforme", roles: ["super_admin"], group: "Plateforme", icon: "audit" },
];

const THEME_STORAGE_KEY = "aurore-theme";

function applyStoredTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark") document.documentElement.setAttribute("data-theme", "dark");
}
// Applique le theme immediatement (avant meme initLayout) pour eviter un
// flash de fond clair chez qui a choisi le mode sombre.
applyStoredTheme();

function initLayout(me) {
  const oldHeader = document.querySelector("header.topbar");
  if (oldHeader) oldHeader.remove();

  const pageEl = document.querySelector(".page");
  if (!pageEl) return;

  const path = window.location.pathname;
  const fullPath = path + window.location.search;

  const shell = document.createElement("div");
  shell.className = "app-shell";

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  sidebar.id = "app-sidebar";

  const modulesDesactives = me.modulesDesactives || [];
  const items = NAV_ITEMS.filter(
    (item) => item.roles.includes(me.role) && (!item.moduleKey || !modulesDesactives.includes(item.moduleKey))
  );
  let navHtml = "";
  let lastGroup = null;
  items.forEach((item, idx) => {
    if (item.group !== lastGroup) {
      navHtml += `<div class="nav-group-label">${item.group}</div>`;
      lastGroup = item.group;
    }
    if (item.children) {
      const childActive = item.children.some((c) => path === c.href.split("?")[0]);
      navHtml += `<button type="button" class="nav-parent${childActive ? " active" : ""}" data-nav-parent="${idx}" aria-expanded="${childActive}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[item.icon] || ""}</svg><span>${item.label}</span><svg class="nav-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>`;
      navHtml += `<div class="nav-children${childActive ? " open" : ""}" data-nav-children="${idx}">`;
      item.children.forEach((c) => {
        const isActive = c.href.includes("?") ? fullPath === c.href : path === c.href;
        navHtml += `<a href="${c.href}"${isActive ? ' class="active"' : ""}>${c.label}</a>`;
      });
      navHtml += `</div>`;
    } else {
      navHtml += `<a href="${item.href}"${path === item.href ? ' class="active"' : ""}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[item.icon] || ""}</svg><span>${item.label}</span></a>`;
    }
  });
  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <div class="sidebar-brand-mark"></div>
      <span class="sidebar-brand-word">AURORE</span>
    </div>
    <nav>${navHtml}</nav>
  `;

  const main = document.createElement("div");
  main.className = "main-area";

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";

  const topbar = document.createElement("header");
  topbar.className = "app-topbar";
  topbar.innerHTML = `
    <div class="topbar-left">
      <button type="button" id="sidebar-toggle" class="icon-btn hamburger" aria-label="Afficher/masquer le menu" title="Menu">
        <span></span><span></span><span></span>
      </button>
      <img src="/logo-aurore-header.png" alt="" class="brand-logo" onerror="this.style.display='none'" />
      <span class="brand-word">AURORE, ASSISTANTE JURIDIQUE</span>
      <span id="header-chrono" class="header-chrono" hidden></span>
    </div>
    <div class="topbar-right">
      <button type="button" id="theme-toggle-btn" class="icon-btn" aria-label="Changer de thème" title="Mode clair / sombre">
        <svg id="theme-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
          isDark
            ? '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>'
            : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
        }</svg>
      </button>
      <a href="mailto:azomedia20@gmail.com" class="topbar-link" title="Contacter le support AzoMedIA">Support</a>
      <a href="/profil.html" class="topbar-link">Mon profil</a>
      <button type="button" id="logout-btn" class="icon-btn" aria-label="Déconnexion" title="Déconnexion">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </button>
    </div>
  `;

  document.body.prepend(shell);
  shell.appendChild(sidebar);
  main.appendChild(topbar);
  main.appendChild(pageEl);
  shell.appendChild(main);

  if (window.innerWidth < 900) {
    sidebar.classList.add("collapsed");
  }

  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
  });

  sidebar.querySelectorAll("[data-nav-parent]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const children = sidebar.querySelector(`[data-nav-children="${btn.dataset.navParent}"]`);
      const willOpen = !children.classList.contains("open");
      children.classList.toggle("open", willOpen);
      btn.setAttribute("aria-expanded", String(willOpen));
    });
  });

  document.getElementById("theme-toggle-btn").addEventListener("click", () => {
    const root = document.documentElement;
    const nowDark = root.getAttribute("data-theme") === "dark";
    if (nowDark) {
      root.removeAttribute("data-theme");
      localStorage.setItem(THEME_STORAGE_KEY, "light");
    } else {
      root.setAttribute("data-theme", "dark");
      localStorage.setItem(THEME_STORAGE_KEY, "dark");
    }
    const icon = document.getElementById("theme-icon");
    icon.innerHTML = nowDark
      ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
      : '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>';
  });

  document.getElementById("logout-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    await apiFetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  // Bandeau d'expiration imminente (Lot 3) : si initLayout() a pu s'executer,
  // la licence est forcement "valide" ou "grace" (sinon /api/auth/me aurait
  // deja ete bloque par requireLicence.ts et requireSession() aurait
  // redirige vers /licence.html avant meme d'appeler initLayout) - seul le
  // cas "grace" a besoin d'un bandeau ici.
  checkLicenceBanner(main, topbar);

  // Lot 14 (deplace) : chronometre persistant dans le Header - visible sur
  // TOUTE page (initLayout tourne partout), pas seulement sur la fiche
  // dossier ou Nouvelle action. L'etat "en cours" est toujours relu depuis
  // le serveur a chaque chargement de page (voir /api/saisies-temps/actif) :
  // jamais uniquement en memoire navigateur, donc jamais perdu en changeant
  // de page.
  initHeaderChrono(me);

  // Pop-up "Factures en attente de paiement" - une fois par jour maximum
  // (throttle localStorage), reserve aux avocats/titulaire (memes roles que
  // /api/factures/rappels, voir requireAvocat).
  initFacturesRappel(me);
}

function escapeHtmlHeaderChrono(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

let headerChronoIntervalId = null;

async function initHeaderChrono(me) {
  const el = document.getElementById("header-chrono");
  if (!el) return;
  // Meme module que la facturation (voir routes/saisiesTemps.ts) - inutile
  // d'interroger une route que ce cabinet n'a pas.
  if ((me.modulesDesactives || []).includes("facturation")) return;

  let chronoActif = null;

  function render() {
    if (headerChronoIntervalId) {
      clearInterval(headerChronoIntervalId);
      headerChronoIntervalId = null;
    }
    if (!chronoActif) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    const debut = new Date(chronoActif.demarreA).getTime();
    const tick = () => {
      const secondes = Math.max(0, Math.floor((Date.now() - debut) / 1000));
      const h = Math.floor(secondes / 3600);
      const m = Math.floor((secondes % 3600) / 60);
      const s = Math.floor(secondes % 60);
      const pad = (n) => String(n).padStart(2, "0");
      const span = document.getElementById("header-chrono-temps");
      if (span) span.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
    };
    el.innerHTML = `
      <span class="header-chrono-badge" title="Chronomètre en cours — dossier ${escapeHtmlHeaderChrono(chronoActif.dossier.numeroDossier)}">⏱ <span id="header-chrono-temps"></span> <span>· ${escapeHtmlHeaderChrono(chronoActif.dossier.numeroDossier)}</span></span>
      <button type="button" id="header-chrono-stop-btn" class="icon-btn" aria-label="Arrêter le chronomètre" title="Arrêter le chronomètre">✕</button>
    `;
    tick();
    headerChronoIntervalId = setInterval(tick, 1000);
    document.getElementById("header-chrono-stop-btn").addEventListener("click", async () => {
      try {
        await apiFetch(`/api/saisies-temps/${chronoActif.id}/arreter`, { method: "POST" });
        await rafraichir();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  async function rafraichir() {
    try {
      chronoActif = await apiFetch("/api/saisies-temps/actif");
    } catch {
      chronoActif = null;
    }
    render();
  }

  // Expose pour que d'autres pages (Nouvelle action) puissent forcer un
  // rafraichissement immediat juste apres avoir demarre/arrete le
  // chronometre elles-memes, sans attendre le prochain chargement de page.
  window.rafraichirHeaderChrono = rafraichir;

  await rafraichir();
}

async function checkLicenceBanner(main, topbar) {
  try {
    const status = await apiFetch("/api/licence/status");
    if (status.etat !== "grace") return;
    const banner = document.createElement("div");
    banner.className = "licence-banner";
    banner.innerHTML = `<span>${status.messageUtilisateur}</span><a href="/licence.html">Activer une nouvelle licence</a>`;
    main.insertBefore(banner, topbar.nextSibling);
  } catch {
    // Echec silencieux : ne doit jamais empecher l'affichage normal de la
    // page (ex: API temporairement indisponible).
  }
}

function escapeHtmlFacturesRappel(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// Cle localStorage isolee par utilisateur (poste partage possible en mode
// reseau, voir README-LOT6.md) - jamais cote serveur : purement un
// throttle d'affichage ("deja vu aujourd'hui"), pas une donnee metier. La
// suppression definitive par facture ("Ne plus me rappeler") est, elle,
// persistee cote serveur (FactureRappelIgnore) pour survivre a un
// changement de poste/navigateur.
function factureRappelStorageKey(me) {
  return `aurore-rappel-factures-dernier-${me.id}`;
}

function factureRappelDejaAffiche(me) {
  const aujourdHui = new Date().toISOString().slice(0, 10);
  return localStorage.getItem(factureRappelStorageKey(me)) === aujourdHui;
}

function factureRappelMarquerAffiche(me) {
  const aujourdHui = new Date().toISOString().slice(0, 10);
  localStorage.setItem(factureRappelStorageKey(me), aujourdHui);
}

async function initFacturesRappel(me) {
  if (me.role !== "titulaire" && me.role !== "avocat") return;
  if (factureRappelDejaAffiche(me)) return;

  let factures;
  try {
    factures = await apiFetch("/api/factures/rappels");
  } catch {
    // Module facturation desactive pour ce cabinet, ou erreur reseau
    // ponctuelle - jamais bloquant, on reessaiera au prochain chargement.
    return;
  }
  if (!factures || factures.length === 0) return;

  // Marque comme "vu" des maintenant (pas seulement a la fermeture) : un
  // rechargement de page dans la meme journee ne doit pas le rouvrir.
  factureRappelMarquerAffiche(me);
  afficherPopupFacturesRappel(factures);
}

function afficherPopupFacturesRappel(factures) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "factures-rappel-overlay";

  function ligneHtml(f) {
    const enRetard = f.dateEcheance && new Date(f.dateEcheance) < new Date();
    return `
      <div class="action-item" data-facture-rappel-ligne="${f.id}">
        <span class="tag">${escapeHtmlFacturesRappel(f.numero)}</span>
        ${enRetard ? '<span class="badge badge-echeance_proche">En retard</span>' : ""}
        <div>${escapeHtmlFacturesRappel(f.clientNom || "Client non précisé")} — <strong>${f.montant.toLocaleString("fr-FR")} F CFA</strong>${
          f.dateEcheance ? ` — échéance le ${new Date(f.dateEcheance).toLocaleDateString("fr-FR")}` : ""
        }</div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:6px;">
          <button type="button" class="secondary btn-sm" data-facture-rappel-payee="${f.id}">Marquer comme payée</button>
          <button type="button" class="ghost btn-sm" data-facture-rappel-ignorer="${f.id}">Ne plus me rappeler</button>
        </div>
      </div>`;
  }

  overlay.innerHTML = `
    <div class="modal-box">
      <h2>Factures en attente de paiement</h2>
      <p class="muted">${factures.length} facture${factures.length > 1 ? "s" : ""} envoyée${factures.length > 1 ? "s" : ""} pas encore marquée${factures.length > 1 ? "s" : ""} payée${factures.length > 1 ? "s" : ""}.</p>
      <div id="factures-rappel-liste">${factures.map(ligneHtml).join("")}</div>
      <div style="display:flex; gap:10px; margin-top:18px;">
        <button type="button" class="ghost" id="factures-rappel-fermer-btn">Fermer</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  function fermerSiVide() {
    if (overlay.querySelectorAll("[data-facture-rappel-ligne]").length === 0) {
      overlay.remove();
    }
  }

  overlay.querySelector("#factures-rappel-fermer-btn").addEventListener("click", () => overlay.remove());

  overlay.querySelectorAll("[data-facture-rappel-payee]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await apiFetch(`/api/factures/${btn.dataset.factureRappelPayee}`, { method: "PATCH", body: { statut: "payee" } });
        overlay.querySelector(`[data-facture-rappel-ligne="${btn.dataset.factureRappelPayee}"]`)?.remove();
        fermerSiVide();
      } catch (err) {
        btn.disabled = false;
        alert(err.message);
      }
    });
  });

  overlay.querySelectorAll("[data-facture-rappel-ignorer]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await apiFetch(`/api/factures/${btn.dataset.factureRappelIgnorer}/ignorer-rappel`, { method: "POST" });
        overlay.querySelector(`[data-facture-rappel-ligne="${btn.dataset.factureRappelIgnorer}"]`)?.remove();
        fermerSiVide();
      } catch (err) {
        btn.disabled = false;
        alert(err.message);
      }
    });
  });
}
