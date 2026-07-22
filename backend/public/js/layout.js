const NAV_ITEMS = [
  { href: "/tableau-de-bord.html", label: "Tableau de bord", roles: ["titulaire", "avocat"] },
  { href: "/dashboard.html", label: "Documents générés", roles: ["titulaire", "avocat", "collaborateur"] },
  { href: "/nouvelle-action.html", label: "Nouvelle action", roles: ["titulaire", "avocat", "collaborateur"] },
  { href: "/clients.html", label: "Clients", roles: ["titulaire", "avocat", "collaborateur"] },
  { href: "/jurisprudence-base.html", label: "Jurisprudence", roles: ["titulaire", "avocat", "collaborateur"] },
  { href: "/delais-calculateur.html", label: "Délais", roles: ["titulaire", "avocat", "collaborateur"] },
  { href: "/collaborateurs.html", label: "Équipe", roles: ["titulaire", "avocat"] },
  { href: "/parametres.html", label: "Paramètres", roles: ["titulaire"] },
];

function initLayout(me) {
  const oldHeader = document.querySelector("header.topbar");
  if (oldHeader) oldHeader.remove();

  const pageEl = document.querySelector(".page");
  if (!pageEl) return;

  const path = window.location.pathname;

  const shell = document.createElement("div");
  shell.className = "app-shell";

  const sidebar = document.createElement("aside");
  sidebar.className = "sidebar";
  sidebar.id = "app-sidebar";
  const links = NAV_ITEMS.filter((item) => item.roles.includes(me.role))
    .map(
      (item) =>
        `<a href="${item.href}"${path === item.href ? ' class="active"' : ""}>${item.label}</a>`
    )
    .join("");
  sidebar.innerHTML = `<nav>${links}</nav>`;

  const main = document.createElement("div");
  main.className = "main-area";

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

  document.getElementById("logout-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    await apiFetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });
}
