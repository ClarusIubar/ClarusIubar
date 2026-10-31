const API_ROOT = "https://api.github.com";
const GRAPHQL_ENDPOINT = `${API_ROOT}/graphql`;
const USER_ENDPOINT = `${API_ROOT}/user`;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

const CREDENTIAL_NAMES = ["METRICS_TOKEN", "METRICS_RUNTIME_TOKEN", "GITHUB_TOKEN"];

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function selectCredential(environment) {
  for (const name of CREDENTIAL_NAMES) {
    const value = environment[name];
    if (typeof value === "string" && value.trim()) {
      return { token: value.trim(), source: name };
    }
  }
  throw new Error(`Missing GitHub credential. Set one of: ${CREDENTIAL_NAMES.join(", ")}.`);
}

export function resolveProfileUsername(environment = process.env) {
  const username = String(environment.PROFILE_USERNAME ?? environment.GITHUB_REPOSITORY_OWNER ?? "").trim();
  if (!username) {
    throw new Error("Missing PROFILE_USERNAME or GITHUB_REPOSITORY_OWNER.");
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(username)) {
    throw new Error("PROFILE_USERNAME must be a valid GitHub account login.");
  }
  return username;
}

function safeHeader(response, name, pattern = /^[\x20-\x7e]{1,160}$/) {
  const value = response.headers?.get(name)?.trim();
  return value && pattern.test(value) ? value : null;
}

function requestId(response) {
  return safeHeader(response, "x-github-request-id", REQUEST_ID_PATTERN);
}

function retryableStatus(status, response, bodyText) {
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  if (status !== 403) return false;
  const remaining = response.headers?.get("x-ratelimit-remaining");
  const message = bodyText.toLowerCase();
  return remaining === "0" || ["secondary rate limit", "abuse detection", "temporarily unavailable", "try again later"]
    .some((fragment) => message.includes(fragment));
}

function retryDelay(response, fallbackMs, attempt) {
  const value = response.headers?.get("retry-after");
  const seconds = value == null ? Number.NaN : Number.parseInt(value, 10);
  const date = value == null ? Number.NaN : Date.parse(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : Number.NaN;
  return Math.max(0, Math.min(60_000, Number.isFinite(milliseconds) ? milliseconds : fallbackMs * attempt));
}

async function responseText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function diagnosticMessage(diagnostic) {
  const details = [`stage=${diagnostic.stage}`, `status=${diagnostic.status}`, `credential source=${diagnostic.credentialSource}`];
  if (diagnostic.requestId) details.push(`request ID=${diagnostic.requestId}`);
  if (diagnostic.acceptedScopes) details.push(`accepted scopes=${diagnostic.acceptedScopes}`);
  if (diagnostic.acceptedPermissions) details.push(`accepted permissions=${diagnostic.acceptedPermissions}`);
  if (diagnostic.attempt) details.push(`attempt=${diagnostic.attempt}`);
  if (diagnostic.graphqlErrors) details.push(`GraphQL errors=${diagnostic.graphqlErrors}`);
  if (diagnostic.responseError) details.push(`response=${diagnostic.responseError}`);
  if (diagnostic.identityProbe) details.push(`REST identity probe=${diagnostic.identityProbe}`);
  const reason = diagnostic.status === 401 ? "; GitHub rejected the request, but the response does not identify why" : "";
  return `GitHub ${diagnostic.api} request failed (${details.join("; ")})${reason}.`;
}

export class GitHubApiError extends Error {
  constructor(diagnostic, { retryable = false, retryDelayMs = null, cause } = {}) {
    super(diagnosticMessage(diagnostic), cause ? { cause } : undefined);
    this.name = "GitHubApiError";
    this.diagnostic = Object.freeze({ ...diagnostic });
    this.status = diagnostic.status;
    this.transient = retryable;
    this.retryDelayMs = retryDelayMs;
  }
}

export class GitHubIdentityError extends Error {
  constructor(expected, actual, stage) {
    const actualLabel = actual ? `received ${actual}` : "no authenticated viewer was returned";
    super(`GitHub authenticated-account check failed at ${stage}: expected ${expected}, ${actualLabel}.`);
    this.name = "GitHubIdentityError";
    this.stage = stage;
  }
}

export function assertAuthenticatedViewer(data, expectedUsername, stage) {
  const actual = data?.viewer?.login;
  if (typeof actual !== "string" || actual.toLowerCase() !== expectedUsername.toLowerCase()) {
    throw new GitHubIdentityError(expectedUsername, typeof actual === "string" ? actual : null, stage);
  }
  return actual;
}

function isRetryableGraphqlError(errors) {
  const message = JSON.stringify(errors).toLowerCase();
  return ["secondary rate limit", "abuse detection", "resource_limits_exceeded", "resource limits for this query exceeded", "temporarily unavailable", "try again later"]
    .some((fragment) => message.includes(fragment));
}

export function createGitHubClient({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger = console,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("GitHub API client requires fetch.");
  const credential = selectCredential(environment);
  const maxAttempts = positiveInteger(environment.METRICS_API_MAX_ATTEMPTS, 4, 8);
  const retryBaseDelayMs = positiveInteger(environment.METRICS_API_RETRY_BASE_DELAY_MS, 1_500, 30_000);

  async function probeRestIdentity() {
    try {
      const response = await fetchImpl(USER_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${credential.token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ClarusIubar-profile-metrics",
        },
      });
      const id = requestId(response);
      if (!response.ok) return `HTTP ${response.status}${id ? ` (request ID ${id})` : ""}`;
      const identity = await response.json();
      return typeof identity?.login === "string"
        ? `HTTP ${response.status}, authenticated as ${identity.login}${id ? ` (request ID ${id})` : ""}`
        : `HTTP ${response.status}, login unavailable${id ? ` (request ID ${id})` : ""}`;
    } catch {
      return "unavailable";
    }
  }

  async function request(url, { api, stage, method, body, attempt, probeOn401 = true }) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${credential.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "ClarusIubar-profile-metrics",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new GitHubApiError({
        api,
        stage,
        status: "network error",
        credentialSource: credential.source,
        attempt,
      }, { retryable: true, cause });
    }

    const id = requestId(response);
    const acceptedScopes = safeHeader(response, "x-oauth-scopes");
    const acceptedPermissions = safeHeader(response, "x-accepted-github-permissions");
    if (!response.ok) {
      const bodyText = await responseText(response);
      const retryable = retryableStatus(response.status, response, bodyText);
      const identityProbe = response.status === 401 && probeOn401 ? await probeRestIdentity() : null;
      throw new GitHubApiError({
        api,
        stage,
        status: response.status,
        credentialSource: credential.source,
        requestId: id,
        acceptedScopes,
        acceptedPermissions,
        attempt,
        identityProbe,
      }, {
        retryable,
        retryDelayMs: retryable ? retryDelay(response, retryBaseDelayMs, attempt) : null,
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new GitHubApiError({
        api,
        stage,
        status: response.status,
        credentialSource: credential.source,
        requestId: id,
        attempt,
        responseError: "invalid JSON",
      }, { cause });
    }

    if (api === "GraphQL" && Array.isArray(payload?.errors) && payload.errors.length > 0) {
      const retryable = isRetryableGraphqlError(payload.errors);
      throw new GitHubApiError({
        api,
        stage,
        status: response.status,
        credentialSource: credential.source,
        requestId: id,
        acceptedScopes,
        acceptedPermissions,
        attempt,
        graphqlErrors: payload.errors.length,
      }, {
        retryable,
        retryDelayMs: retryable ? retryDelay(response, retryBaseDelayMs, attempt) : null,
      });
    }
    if (!payload || typeof payload !== "object" || (api === "GraphQL" && (!payload.data || typeof payload.data !== "object"))) {
      throw new GitHubApiError({
        api,
        stage,
        status: response.status,
        credentialSource: credential.source,
        requestId: id,
        attempt,
        responseError: "missing data",
      });
    }
    return payload;
  }

  async function requestWithRetry(url, options) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const payload = await request(url, { ...options, attempt });
        return options.api === "GraphQL" ? payload.data : payload;
      } catch (error) {
        lastError = error;
        if (!error.transient || attempt === maxAttempts) throw error;
        const delay = error.retryDelayMs ?? Math.min(60_000, retryBaseDelayMs * attempt);
        logger.warn(`GitHub API retry at stage=${options.stage}; credential source=${credential.source}; attempt=${attempt}/${maxAttempts}; delay=${delay}ms${error.diagnostic?.requestId ? `; request ID=${error.diagnostic.requestId}` : ""}.`);
        await sleepImpl(delay);
      }
    }
    throw lastError;
  }

  return Object.freeze({
    credentialSource: credential.source,
    maxAttempts,
    graphql(query, variables, { stage = "GraphQL query" } = {}) {
      return requestWithRetry(GRAPHQL_ENDPOINT, { api: "GraphQL", stage, method: "POST", body: { query, variables } });
    },
    rest(url, { stage = "REST request" } = {}) {
      return requestWithRetry(url, { api: "REST", stage, method: "GET" });
    },
  });
}
