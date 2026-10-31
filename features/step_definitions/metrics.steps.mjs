import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import { runMetricsRefresh } from "../../scripts/metrics-workflow.mjs";

const OLD_GENERATED_AT = "2026-10-30T12:00:00.000Z";
const NEW_GENERATED_AT = "2026-11-01T00:00:00.000Z";
const SECRET_SENTINEL = "SENTINEL_SECRET_MUST_NOT_LOG";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function contributionCalendar() {
  const levels = ["FIRST_QUARTILE", "SECOND_QUARTILE", "THIRD_QUARTILE", "FOURTH_QUARTILE"];
  const colors = ["#9be9a8", "#40c463", "#30a14e", "#216e39"];
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-10-${String(25 + index).padStart(2, "0")}`,
    color: colors[index % colors.length],
    contributionCount: index,
    contributionLevel: levels[index % levels.length],
    weekday: index,
  }));
  return { totalContributions: 21, colors, isHalloween: false, weeks: [{ contributionDays: days }] };
}

function defaultRepository(owner) {
  return {
    name: "metrics-fixture",
    nameWithOwner: `${owner}/metrics-fixture`,
    isFork: false,
    isPrivate: false,
    pushedAt: "2026-10-31T00:00:00Z",
    defaultBranchRef: { name: "main", target: { tree: { oid: "TREE-DEFAULT" } } },
  };
}

function previousSnapshot() {
  return {
    username: "ClarusIubar",
    window: { start: "2026-01-01", end: "2026-10-30", totalDays: 303 },
    summary: { generatedAt: OLD_GENERATED_AT, totalContributions: 12 },
    calendar: { apiColors: ["#old"], levelAssignmentFingerprint: "old" },
    density: [],
  };
}

Before(async function () {
  this.environment = {
    PROFILE_USERNAME: "ClarusIubar",
    METRICS_TOKEN: SECRET_SENTINEL,
    GITHUB_TOKEN: "fallback-test-token",
    METRICS_API_MAX_ATTEMPTS: "4",
    METRICS_API_RETRY_BASE_DELAY_MS: "1",
  };
  this.viewerLogin = "ClarusIubar";
  this.repositories = [defaultRepository(this.environment.PROFILE_USERNAME)];
  this.treeBySha = new Map([[
    "TREE-DEFAULT",
    [{ type: "blob", path: "src/main.ts", size: 100 }],
  ]]);
  this.calendar = contributionCalendar();
  this.repositoryStatus = null;
  this.repositoryPartialErrors = false;
  this.contributionStatus = null;
  this.privateTreeStatus = null;
  this.confirmPrivateTree = false;
  this.identityLogin = "ClarusIubar";
  this.repositoryAttempts = 0;
  this.contributionAttempts = 0;
  this.identityProbeAttempts = 0;
  this.treeRequests = [];
  this.verifiedTreeOids = [];
  this.writeBatches = [];
  this.summaries = [];
  this.logs = [];
  this.assets = new Map();
  this.refreshResult = null;
  this.refreshError = null;
  this.metricsIgnoreText = await readFile(path.resolve(process.cwd(), ".metricsignore"), "utf8");
  this.priorSnapshot = previousSnapshot();

  this.fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://api.github.com/user") {
      this.identityProbeAttempts++;
      if (!this.identityLogin) return jsonResponse({ message: "Bad credentials" }, { status: 401, headers: { "x-github-request-id": "REQ-PROBE" } });
      return jsonResponse({ login: this.identityLogin }, { headers: { "x-github-request-id": "REQ-PROBE" } });
    }
    if (url === "https://api.github.com/graphql") {
      const request = JSON.parse(init.body);
      const query = request.query;
      if (query.includes("repositories(")) {
        this.repositoryAttempts++;
        if (this.repositoryStatus) {
          return jsonResponse({ message: "rate limited" }, { status: this.repositoryStatus, headers: { "x-github-request-id": `REQ-REPO-${this.repositoryAttempts}` } });
        }
        const connection = {
          totalCount: this.repositories.length,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: this.repositories,
        };
        const payload = { data: { viewer: { login: this.viewerLogin }, user: { repositories: connection } } };
        if (this.repositoryPartialErrors) payload.errors = [{ message: "synthetic partial response" }];
        return jsonResponse(payload, { headers: { "x-github-request-id": "REQ-REPOSITORIES" } });
      }
      if (query.includes("object(oid:")) {
        this.verifiedTreeOids.push(request.variables.oid);
        return jsonResponse({
          data: {
            viewer: { login: this.viewerLogin },
            repository: { object: this.confirmPrivateTree ? { __typename: "Tree", entries: [] } : null },
          },
        });
      }
      if (query.includes("contributionCalendar")) {
        this.contributionAttempts++;
        if (this.contributionStatus) {
          return jsonResponse({ message: "Bad credentials" }, {
            status: this.contributionStatus,
            headers: { "x-github-request-id": this.contributionRequestId ?? "REQ-401" },
          });
        }
        return jsonResponse({ data: {
          viewer: { login: this.viewerLogin },
          user: { contributionsCollection: { contributionCalendar: this.calendar } },
        } }, { headers: { "x-github-request-id": "REQ-CONTRIBUTIONS" } });
      }
      throw new Error("Unexpected GraphQL request in metrics feature fixture.");
    }
    if (url.includes("/git/trees/")) {
      this.treeRequests.push(url);
      if (this.privateTreeStatus) {
        return jsonResponse({ message: "Not Found" }, { status: this.privateTreeStatus, headers: { "x-github-request-id": "REQ-EMPTY-TREE" } });
      }
      const match = url.match(/\/git\/trees\/([^?]+)/);
      const entries = this.treeBySha.get(match?.[1]) ?? [];
      return jsonResponse({ truncated: false, tree: entries });
    }
    throw new Error(`Unexpected GitHub API URL: ${url}`);
  };
});

Given("the metrics refresh targets {string}", function (username) {
  this.environment.PROFILE_USERNAME = username;
});

Given("GitHub authenticates the request as {string}", function (username) {
  this.viewerLogin = username;
});

Given("the owned repository and contribution responses are complete", function () {
  this.repositoryStatus = null;
  this.repositoryPartialErrors = false;
  this.contributionStatus = null;
  this.viewerLogin = this.environment.PROFILE_USERNAME;
  this.calendar = contributionCalendar();
});

Given("a previous metrics asset set exists", function () {
  const paths = [
    "metrics/metrics.languages.json",
    "metrics/metrics.languages.linguist.svg",
    "metrics/contribution-density.json",
    "metrics/contribution-density.svg",
    "metrics/contribution-volume.json",
    "metrics/contribution-volume.svg",
    "metrics/contribution-activity.json",
    "metrics/contribution-activity.svg",
  ];
  for (const relativePath of paths) this.assets.set(relativePath, `previous:${relativePath}`);
  this.assetsBefore = new Map(this.assets);
});

Given("the selected credential source is {string}", function (source) {
  for (const name of ["METRICS_TOKEN", "METRICS_RUNTIME_TOKEN", "GITHUB_TOKEN"]) delete this.environment[name];
  this.environment[source] = SECRET_SENTINEL;
});

Given("GitHub rejects the contribution request with HTTP {int} and request ID {string}", function (status, requestId) {
  this.contributionStatus = status;
  this.contributionRequestId = requestId;
});

Given("the same credential can read the REST identity {string}", function (username) {
  this.identityLogin = username;
});

Given("GitHub returns HTTP {int} for every repository-listing attempt", function (status) {
  this.repositoryStatus = status;
});

Given("the retry limit is {int} attempts", function (attempts) {
  this.environment.METRICS_API_MAX_ATTEMPTS = String(attempts);
});

Given("the repository response contains partial data and GraphQL errors", function () {
  this.repositoryPartialErrors = true;
});

Given("an owned private repository has root tree {string}", function (treeSha) {
  this.repositories = [{
    ...defaultRepository(this.environment.PROFILE_USERNAME),
    name: "private-empty",
    nameWithOwner: `${this.environment.PROFILE_USERNAME}/private-empty`,
    isPrivate: true,
    defaultBranchRef: { name: "main", target: { tree: { oid: treeSha } } },
  }];
  this.treeBySha = new Map([[treeSha, []]]);
  this.privateTreeSha = treeSha;
});

Given("the REST tree request returns HTTP {int}", function (status) {
  this.privateTreeStatus = status;
});

Given("GraphQL confirms that exact tree object has no entries", function () {
  this.confirmPrivateTree = true;
});

Given("the contribution response is complete", function () {
  this.contributionStatus = null;
  this.calendar = contributionCalendar();
});

Given("an original repository contains source, build output, and Obsidian plugin bundles", function () {
  const repository = defaultRepository(this.environment.PROFILE_USERNAME);
  repository.name = "source-with-artifacts";
  repository.nameWithOwner = `${this.environment.PROFILE_USERNAME}/source-with-artifacts`;
  repository.defaultBranchRef.target.tree.oid = "TREE-ORIGINAL";
  this.repositories = [repository];
  this.treeBySha = new Map([["TREE-ORIGINAL", [
    { type: "blob", path: "src/main.ts", size: 100 },
    { type: "blob", path: "dist/generated.ts", size: 2_000 },
    { type: "blob", path: ".obsidian/plugins/sample/main.js", size: 10_000 },
    { type: "blob", path: ".obsidian_Mac/plugins/sample/styles.css", size: 300 },
  ]]]);
});

Given("the repository response includes an owned fork with source files", function () {
  const fork = defaultRepository(this.environment.PROFILE_USERNAME);
  fork.name = "public-fork";
  fork.nameWithOwner = `${this.environment.PROFILE_USERNAME}/public-fork`;
  fork.isFork = true;
  fork.defaultBranchRef.target.tree.oid = "TREE-FORK";
  this.repositories.push(fork);
  this.treeBySha.set("TREE-FORK", [{ type: "blob", path: "src/fork.ts", size: 50_000 }]);
});

When("the full metrics refresh runs", async function () {
  try {
    this.refreshResult = await runMetricsRefresh({
      environment: this.environment,
      rootDirectory: process.cwd(),
      fetchImpl: this.fetchImpl,
      sleepImpl: async () => {},
      logger: { warn: (message) => this.logs.push(message), log: (message) => this.logs.push(message) },
      metricsIgnoreText: this.metricsIgnoreText,
      previousActivitySnapshot: this.priorSnapshot,
      writeAssets: async (assets) => {
        this.writeBatches.push(assets);
        for (const [relativePath, contents] of Object.entries(assets)) this.assets.set(relativePath, contents);
      },
      writeSummary: async (title, lines) => this.summaries.push({ title, lines }),
      now: () => new Date(NEW_GENERATED_AT),
    });
  } catch (error) {
    this.refreshError = error;
  }
});

Then("the refresh succeeds with a fresh generated timestamp", function () {
  assert.equal(this.refreshError, null);
  assert.ok(this.refreshResult);
  assert.ok(this.refreshResult.languageSnapshot.generatedAt > OLD_GENERATED_AT);
  assert.equal(this.refreshResult.languageSnapshot.generatedAt, this.refreshResult.contributionSnapshot.summary.generatedAt);
});

Then("the new complete asset set replaces the previous asset set once", function () {
  assert.equal(this.writeBatches.length, 1);
  assert.equal(Object.keys(this.writeBatches[0]).length, 8);
  assert.equal(this.assets.size, 8);
  for (const [relativePath, contents] of this.assets) assert.notEqual(contents, `previous:${relativePath}`);
});

Then("the refresh fails at stage {string}", function (stage) {
  assert.ok(this.refreshError, "expected metrics refresh to fail");
  const actualStage = this.refreshError.diagnostic?.stage ?? this.refreshError.stage;
  assert.equal(actualStage, stage);
});

Then("the previous asset set remains byte-identical", function () {
  assert.deepEqual(this.assets, this.assetsBefore);
});

Then("the failure reports source {string} and request ID {string}", function (source, requestId) {
  assert.match(this.refreshError.message, new RegExp(`credential source=${source}`));
  assert.match(this.refreshError.message, new RegExp(`request ID=${requestId}`));
});

Then("the rejection cause is reported as undetermined", function () {
  assert.match(this.refreshError.message, /does not identify why/);
  assert.match(this.refreshError.message, /REST identity probe=HTTP 200, authenticated as ClarusIubar/);
});

Then("the rejected GraphQL request is not retried", function () {
  assert.equal(this.contributionAttempts, 1);
  assert.equal(this.identityProbeAttempts, 1);
});

Then("the diagnostic contains no credential value", function () {
  assert.doesNotMatch(this.refreshError.message, new RegExp(SECRET_SENTINEL));
});

Then("no repository tree or contribution request is made", function () {
  assert.equal(this.treeRequests.length, 0);
  assert.equal(this.contributionAttempts, 0);
});

Then("exactly {int} repository-listing attempts are made", function (attempts) {
  assert.equal(this.repositoryAttempts, attempts);
});

Then("the previous timestamp is not reported as a successful refresh", function () {
  assert.ok(this.refreshError);
  assert.equal(this.writeBatches.length, 0);
  assert.equal(this.summaries.at(-1)?.title, "GitHub Metrics refresh failed");
});

Then("no metrics asset is written", function () {
  assert.equal(this.writeBatches.length, 0);
});

Then("the refresh succeeds", function () {
  assert.equal(this.refreshError, null);
  assert.ok(this.refreshResult);
});

Then("the private repository is included with zero source files", function () {
  assert.equal(this.refreshResult.languageSnapshot.summary.totalRepositories, 1);
  assert.equal(this.refreshResult.languageSnapshot.summary.privateRepositoriesIncluded, 1);
  assert.equal(this.refreshResult.languageSnapshot.summary.totalLanguageBytes, 0);
});

Then("the GraphQL check uses tree {string}", function (treeSha) {
  assert.deepEqual(this.verifiedTreeOids, [treeSha]);
});

Then("the original source file contributes to the language totals", function () {
  assert.deepEqual(this.refreshResult.languageSnapshot.languages.map(({ name, bytes }) => ({ name, bytes })), [
    { name: "TypeScript", bytes: 100 },
  ]);
});

Then("build output and Obsidian plugin bundles contribute zero bytes", function () {
  assert.equal(this.refreshResult.languageSnapshot.summary.excludedArtifactFiles, 3);
  assert.equal(this.refreshResult.languageSnapshot.summary.excludedArtifactBytes, 12_300);
  assert.equal(this.refreshResult.languageSnapshot.summary.totalLanguageBytes, 100);
});

Then("the fork tree is never fetched", function () {
  assert.equal(this.treeRequests.some((url) => url.includes("TREE-FORK")), false);
  assert.equal(this.refreshResult.languageSnapshot.summary.totalRepositories, 1);
});
