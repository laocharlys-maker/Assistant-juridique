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
    throw new Error(message);
  }
  return data;
}

async function requireSession() {
  try {
    return await apiFetch("/api/auth/me");
  } catch {
    window.location.href = "/login.html";
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
