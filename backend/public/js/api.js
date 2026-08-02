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
