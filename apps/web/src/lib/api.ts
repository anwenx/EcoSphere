
const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  "http://localhost:4000/api/v1";

let csrfToken: string | null = null;

/**
 * Store the CSRF token returned by the backend.
 * The session token itself is kept in an HTTP-only cookie.
 */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/**
 * Read the CSRF cookie as a fallback if the token has not
 * yet been stored in memory.
 */
function getCsrfToken(): string | null {
  if (csrfToken) {
    return csrfToken;
  }

  if (typeof document === "undefined") {
    return null;
  }

  const cookie = document.cookie
    .split("; ")
    .find((item) => item.startsWith("eco_csrf="));

  if (!cookie) {
    return null;
  }

  return decodeURIComponent(cookie.substring("eco_csrf=".length));
}

export async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers);

  headers.set("Content-Type", "application/json");

  const method = (options.method ?? "GET").toUpperCase();
  const safeMethods = ["GET", "HEAD", "OPTIONS"];

  // The backend requires CSRF protection for state-changing requests.
  if (!safeMethods.includes(method)) {
    const csrf = getCsrfToken();

    if (csrf) {
      headers.set("X-CSRF-Token", csrf);
    }
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    method,
    headers,

    // Send the eco_session and eco_csrf cookies to the API.
    credentials: "include",
  });

  const responseText = await response.text();

  let data: any;

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(
      `The API returned an invalid response (${response.status}).`
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        data?.error?.message ??
          "Your session has expired or you are not logged in. Please sign in again."
      );
    }

    if (response.status === 403) {
      throw new Error(
        data?.error?.message ??
          "Access denied. Check your account permissions."
      );
    }

    throw new Error(
      data?.error?.message ??
        `API request failed with status ${response.status}.`
    );
  }

  return data as T;
}
