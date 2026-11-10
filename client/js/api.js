/* ######################################################################
 * Thin fetch wrapper. The server answers errors as
 * { error, errorDescription, details? }; this turns them into ApiError.
 * ###################################################################### */

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {{ error?: string, errorDescription?: string, details?: unknown }} body
   */
  constructor(status, body) {
    super(body.errorDescription || body.error || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error;
    this.details = body.details;
  }
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, form?: FormData, token?: string }} [options]
 */
export async function api(path, options = {}) {
  const { method = "GET", body, form, token } = options;
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, {
      errorDescription:
        "Can't reach RealPay. Check your connection and try again.",
    });
  }

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { errorDescription: text.slice(0, 200) };
    }
  }
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

/* ---------- capability tokens kept in this browser ---------- */

const KEY_PREFIX = "realpay:";

/**
 * @param {string} projectId
 * @returns {{ owner?: string, contractor?: string, active?: "owner" | "contractor" }}
 */
export function loadTokens(projectId) {
  try {
    return JSON.parse(localStorage.getItem(KEY_PREFIX + projectId) || "{}");
  } catch {
    return {};
  }
}

/**
 * @param {string} projectId
 * @param {{ owner?: string, contractor?: string, active?: string }} tokens
 */
export function saveTokens(projectId, tokens) {
  try {
    localStorage.setItem(KEY_PREFIX + projectId, JSON.stringify(tokens));
  } catch {
    // Private mode or blocked storage: the share link still works.
  }
}

/** Lists projects this browser holds a link for, newest first. */
export function knownProjects() {
  const projects = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(KEY_PREFIX)) continue;
      const value = JSON.parse(localStorage.getItem(key) || "{}");
      projects.push({ id: key.slice(KEY_PREFIX.length), ...value });
    }
  } catch {
    return [];
  }
  return projects.toSorted((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}
