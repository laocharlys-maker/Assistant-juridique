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
};

const NAV_ITEMS = [
  { href: "/tableau-de-bord.html", label: "Tableau de bord", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "dashboard" },
  { href: "/role-semaine.html", label: "Audiences programmées", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "calendar" },
  { href: "/nouvelle-action.html", label: "Nouvelle action", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "plus" },
  { href: "/dashboard.html", label: "Documents générés", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "docs" },
  { href: "/clients.html", label: "Clients", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "clients" },
  { href: "/jurisprudence-base.html", label: "Jurisprudence", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "book" },
  { href: "/delais-calculateur.html", label: "Délais", roles: ["titulaire", "avocat", "collaborateur"], group: "Travail", icon: "clock" },
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
  { href: "/factures.html", label: "Facturation", roles: ["titulaire", "avocat"], group: "Cabinet", icon: "invoice" },
  { href: "/veille-juridique.html", label: "Veille juridique", roles: ["titulaire", "avocat"], group: "Cabinet", icon: "radar" },
  { href: "/audit-logs.html", label: "Journal d'audit", roles: ["titulaire"], group: "Cabinet", icon: "audit" },
  { href: "/parametres.html", label: "Paramètres", roles: ["titulaire"], group: "Cabinet", icon: "settings" },
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

  const items = NAV_ITEMS.filter((item) => item.roles.includes(me.role));
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
      <span class="brand-word">AURORE</span>
    </div>
    <div class="topbar-right">
      <button type="button" id="theme-toggle-btn" class="icon-btn" aria-label="Changer de thème" title="Mode clair / sombre">
        <svg id="theme-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
          isDark
            ? '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>'
            : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
        }</svg>
      </button>
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
}
