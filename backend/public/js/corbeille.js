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

// La restauration reste reservee a l'avocat/titulaire (meme droits que la
// suppression elle-meme, inchange) - un collaborateur autorise a VOIR la
// corbeille (reglage "modules", voir users.ts) n'a donc pas le bouton, pour
// eviter un clic qui echouerait silencieusement en 403 cote serveur.
function ligneCorbeille({ titre, supprimePar, joursRestants, onRestaurer, peutRestaurer }) {
  const div = document.createElement("div");
  div.className = "action-item";
  div.innerHTML = `
    <div>${escapeHtmlCorbeille(titre)}</div>
    <div class="muted">Supprimé par ${escapeHtmlCorbeille(supprimePar || "—")} — ${formatJoursRestants(joursRestants)}</div>
  `;
  if (peutRestaurer) {
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
  }
  return div;
}

async function chargerCorbeille(peutRestaurer) {
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
            peutRestaurer,
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
            peutRestaurer,
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
            peutRestaurer,
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
  const peutRestaurer = me.role === "titulaire" || me.role === "avocat";
  await chargerCorbeille(peutRestaurer);
})();
