import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAuthenticatedViewer,
  createGitHubClient,
  resolveProfileUsername,
} from "./github-api.mjs";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("requires the profile owner and selects a named credential without a hardcoded account", () => {
  assert.equal(resolveProfileUsername({ PROFILE_USERNAME: "MetricOwner" }), "MetricOwner");
  assert.equal(resolveProfileUsername({ GITHUB_REPOSITORY_OWNER: "RepositoryOwner" }), "RepositoryOwner");
  assert.throws(() => resolveProfileUsername({}), /Missing PROFILE_USERNAME/);

  const client = createGitHubClient({
    environment: { METRICS_TOKEN: "metrics-secret", GITHUB_TOKEN: "fallback-secret" },
    fetchImpl: async () => jsonResponse({ data: {} }),
  });
  assert.equal(client.credentialSource, "METRICS_TOKEN");
});

test("a 401 records request evidence and an identity probe without retrying or exposing credentials", async () => {
  const secret = "do-not-log-this-token";
  const calls = [];
  const client = createGitHubClient({
    environment: { METRICS_TOKEN: secret, METRICS_API_MAX_ATTEMPTS: "4" },
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/graphql")) {
        return jsonResponse({ message: "Bad credentials" }, { status: 401, headers: { "x-github-request-id": "REQ-401" } });
      }
      return jsonResponse({ login: "MetricOwner" }, { headers: { "x-github-request-id": "REQ-USER" } });
    },
  });

  await assert.rejects(client.graphql("query { viewer { login } }", {}, { stage: "repository listing" }), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.transient, false);
    assert.equal(error.diagnostic.credentialSource, "METRICS_TOKEN");
    assert.equal(error.diagnostic.requestId, "REQ-401");
    assert.match(error.message, /REST identity probe=HTTP 200, authenticated as MetricOwner/);
    assert.match(error.message, /does not identify why/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  assert.deepEqual(calls, ["https://api.github.com/graphql", "https://api.github.com/user"]);
});

test("retries rate limits only within the configured bound", async () => {
  const calls = [];
  const delays = [];
  const client = createGitHubClient({
    environment: { GITHUB_TOKEN: "fallback-secret", METRICS_API_MAX_ATTEMPTS: "3", METRICS_API_RETRY_BASE_DELAY_MS: "5" },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse({ message: "rate limited" }, { status: 429, headers: { "x-github-request-id": `REQ-${calls.length}` } });
    },
    sleepImpl: async (delay) => delays.push(delay),
    logger: { warn() {} },
  });

  await assert.rejects(client.graphql("query { viewer { login } }", {}, { stage: "repository listing" }), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.diagnostic.attempt, 3);
    assert.equal(error.transient, true);
    return true;
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [5, 10]);
});

test("rejects partial GraphQL data and keeps response text out of diagnostics", async () => {
  const client = createGitHubClient({
    environment: { GITHUB_TOKEN: "fallback-secret" },
    fetchImpl: async () => jsonResponse({
      data: { viewer: { login: "MetricOwner" } },
      errors: [{ message: "private repository name must not be logged" }],
    }, { headers: { "x-github-request-id": "REQ-PARTIAL" } }),
  });

  await assert.rejects(client.graphql("query { viewer { login } }", {}, { stage: "repository listing" }), (error) => {
    assert.equal(error.diagnostic.graphqlErrors, 1);
    assert.match(error.message, /GraphQL errors=1/);
    assert.doesNotMatch(error.message, /private repository name/);
    return true;
  });
});

test("checks the authenticated viewer against the requested profile", () => {
  assert.equal(assertAuthenticatedViewer({ viewer: { login: "MetricOwner" } }, "metricowner", "contribution calendar"), "MetricOwner");
  assert.throws(
    () => assertAuthenticatedViewer({ viewer: { login: "OtherOwner" } }, "MetricOwner", "repository listing"),
    /expected MetricOwner, received OtherOwner/,
  );
});
