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
