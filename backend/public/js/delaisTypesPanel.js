/**
 * Referentiel des types de delais (nom, duree, texte de loi) - logique
 * extraite de delais-types.html pour etre reutilisee telle quelle comme
 * onglet "Types de délais configurés" sur la page de calcul des délais
 * (delais-calculateur.html), sans dupliquer create-form/liste/toggle/delete
 * a deux endroits qui pourraient diverger avec le temps. delais-types.html
 * continue de fonctionner seul (lien direct/marque-page) en appelant ce
 * meme module.
 *
 * `container` doit contenir un formulaire de creation avec les mêmes champs
 * que ci-dessous et un element `[data-types-list]` pour la liste - voir le
 * HTML genere par renderDelaisTypesPanel() ci-dessous, a inserer une seule
 * fois dans le DOM avant d'appeler initDelaisTypesPanel(container).
 */

function delaisTypesPanelHtml() {
  return `
    <div class="card">
      <h2>Ajouter un type de délai</h2>
      <form data-types-create-form>
        <label>Nom (ex: Délai d'appel)</label>
        <input name="nom" required />
        <label>Nombre</label>
        <input name="nombreUnites" type="number" min="1" required />
        <label>Unité</label>
        <select name="unite" required>
          <option value="jours">Jours</option>
          <option value="mois">Mois</option>
        </select>
        <label style="display:flex; align-items:center; gap:8px; font-weight:400;">
          <input type="checkbox" name="joursOuvresUniquement" style="width:auto;" checked />
          Reporter au prochain jour ouvré si l'échéance tombe un week-end
        </label>
        <label>Texte de loi de référence</label>
        <input name="texteReference" required placeholder="ex: Code de procédure civile béninois, art. XX" />
        <button type="submit">Ajouter au référentiel</button>
      </form>
    </div>

    <div class="card">
      <h2>Délais du référentiel</h2>
      <div data-types-error class="error"></div>
      <div data-types-list><p class="muted">Chargement…</p></div>
    </div>`;
}

function initDelaisTypesPanel(container) {
  const listEl = container.querySelector("[data-types-list]");
  const errorEl = container.querySelector("[data-types-error]");
  const formEl = container.querySelector("[data-types-create-form]");

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  async function loadTypes() {
    try {
      const types = await apiFetch("/api/delais-types?all=1");
      if (types.length === 0) {
        listEl.innerHTML = '<p class="muted">Aucun délai saisi pour l\'instant.</p>';
        return;
      }
      listEl.innerHTML = types
        .map(
          (t) => `
        <div class="action-item">
          <span class="tag">${t.nombreUnites} ${t.unite === "mois" ? "mois" : "jours"}${t.joursOuvresUniquement ? " · report si week-end" : ""}${t.actif ? "" : " · INACTIF"}</span>
          <div><strong>${escapeHtml(t.nom)}</strong></div>
          <p class="muted">${escapeHtml(t.texteReference)}</p>
          <button type="button" class="secondary" data-toggle="${t.id}" data-actif="${t.actif}">${t.actif ? "Désactiver" : "Réactiver"}</button>
          <button type="button" class="secondary" data-delete="${t.id}">Supprimer</button>
        </div>`
        )
        .join("");
      listEl.querySelectorAll("[data-toggle]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const actif = btn.dataset.actif === "true";
          await apiFetch(`/api/delais-types/${btn.dataset.toggle}`, {
            method: "PATCH",
            body: { actif: !actif },
          });
          loadTypes();
        });
      });
      listEl.querySelectorAll("[data-delete]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("Supprimer ce type de délai du référentiel ?")) return;
          await apiFetch(`/api/delais-types/${btn.dataset.delete}`, { method: "DELETE" });
          loadTypes();
        });
      });
    } catch (err) {
      listEl.innerHTML = `<p class="error visible">${escapeHtml(err.message)}</p>`;
    }
  }

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideError(errorEl);
    const fd = new FormData(formEl);
    try {
      await apiFetch("/api/delais-types", {
        method: "POST",
        body: {
          nom: fd.get("nom"),
          nombreUnites: Number(fd.get("nombreUnites")),
          unite: fd.get("unite"),
          joursOuvresUniquement: fd.get("joursOuvresUniquement") === "on",
          texteReference: fd.get("texteReference"),
        },
      });
      formEl.reset();
      loadTypes();
    } catch (err) {
      showError(errorEl, err.message);
    }
  });

  loadTypes();
}
