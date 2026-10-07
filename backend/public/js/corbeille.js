function escapeHtmlCorbeille(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatJoursRestants(jours) {
  if (jours <= 0) return "purge aujourd'hui";
  if (jours === 1) return "purge définitive dans 1 jour";
  return `purge définitive dans ${jours} jours`;
}

function ligneCorbeille({ titre, supprimePar, joursRestants, onRestaurer }) {
  const div = document.createElement("div");
  div.className = "action-item";
  div.innerHTML = `
    <div>${escapeHtmlCorbeille(titre)}</div>
    <div class="muted">Supprimé par ${escapeHtmlCorbeille(supprimePar || "—")} — ${formatJoursRestants(joursRestants)}</div>
  `;
  const restaurerBtn = document.createElement("button");
  restaurerBtn.type = "button";
  restaurerBtn.className = "secondary btn-sm";
  restaurerBtn.textContent = "Restaurer";
  restaurerBtn.style.marginTop = "6px";
  restaurerBtn.addEventListener("click", async () => {
    restaurerBtn.disabled = true;
    try {
      await onRestaurer();
      div.remove();
    } catch (err) {
      restaurerBtn.disabled = false;
      alert(err.message);
    }
  });
  div.appendChild(restaurerBtn);
  return div;
}

async function chargerCorbeille() {
  const errorEl = document.getElementById("error");
  hideError(errorEl);
  try {
    const data = await apiFetch("/api/corbeille");

    const dossiersEl = document.getElementById("liste-dossiers");
    dossiersEl.innerHTML = "";
    if (data.dossiers.length === 0) {
      dossiersEl.innerHTML = '<p class="muted">Aucun dossier dans la corbeille.</p>';
    } else {
      data.dossiers.forEach((d) => {
        dossiersEl.appendChild(
          ligneCorbeille({
            ...d,
            onRestaurer: () => apiFetch(`/api/dossiers/${d.id}/restaurer`, { method: "POST" }),
          })
        );
      });
    }

    const clientsEl = document.getElementById("liste-clients");
    clientsEl.innerHTML = "";
    if (data.clients.length === 0) {
      clientsEl.innerHTML = '<p class="muted">Aucun client dans la corbeille.</p>';
    } else {
      data.clients.forEach((c) => {
        clientsEl.appendChild(
          ligneCorbeille({
            ...c,
            onRestaurer: () => apiFetch(`/api/clients/${c.id}/restaurer`, { method: "POST" }),
          })
        );
      });
    }

    const actionsEl = document.getElementById("liste-actions");
    actionsEl.innerHTML = "";
    if (data.actions.length === 0) {
      actionsEl.innerHTML = '<p class="muted">Aucun document généré dans la corbeille.</p>';
    } else {
      data.actions.forEach((a) => {
        actionsEl.appendChild(
          ligneCorbeille({
            ...a,
            onRestaurer: () => apiFetch(`/api/dossiers/${a.dossierId}/actions/${a.id}/restaurer`, { method: "POST" }),
          })
        );
      });
    }
  } catch (err) {
    showError(errorEl, err.message);
  }
}

(async () => {
  const me = await requireSession();
  if (!me) return;
  initLayout(me);
  await chargerCorbeille();
})();
