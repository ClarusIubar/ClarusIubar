import assert from "node:assert/strict";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import { publishGeneratedMetrics } from "../../scripts/publish-generated-metrics.mjs";

const PULL_REQUEST_URL = "https://github.com/ClarusIubar/ClarusIubar/pull/99";

Before(function () {
  this.publication = {
    environment: {
      GITHUB_REF_NAME: "main",
      GITHUB_RUN_ID: "12345",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REPOSITORY: "ClarusIubar/ClarusIubar",
      GH_TOKEN: "SENTINEL_SECRET_MUST_NOT_LOG",
    },
    changedFiles: ["README.md", "metrics/contribution-activity.svg"],
    failCreate: false,
    leakCredentialInCreateError: false,
    failMerge: false,
    pendingPullRequestUrl: null,
    calls: [],
    result: null,
    error: null,
  };
  this.runCommand = async (command, args) => {
    this.publication.calls.push({ command, args });
    if (command === "git" && args[0] === "diff" && args[1] === "--cached") {
      return { exitCode: 0, stdout: this.publication.changedFiles.join("\n"), stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      return this.publication.failCreate
        ? {
            exitCode: 1,
            stdout: "",
            stderr: this.publication.leakCredentialInCreateError
              ? `credential ${this.publication.environment.GH_TOKEN} was rejected`
              : "permission denied",
          }
        : { exitCode: 0, stdout: `${PULL_REQUEST_URL}\n`, stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      const openPullRequests = this.publication.pendingPullRequestUrl
        ? [{ number: 98, url: this.publication.pendingPullRequestUrl, title: "chore: update profile metrics", headRefName: "metrics/update-previous-1" }]
        : [];
      return { exitCode: 0, stdout: JSON.stringify(openPullRequests), stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "merge") {
      return this.publication.failMerge
        ? { exitCode: 1, stdout: "", stderr: "merge blocked" }
        : { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
});

Given("the metrics workflow runs on {string} with run ID {string}", function (branch, runId) {
  this.publication.environment.GITHUB_REF_NAME = branch;
  this.publication.environment.GITHUB_RUN_ID = runId;
});

Given("generated README and metrics files have changed", function () {});

Given("no generated metric files have changed", function () {
  this.publication.changedFiles = [];
});

Given("GitHub rejects pull request creation", function () {
  this.publication.failCreate = true;
});

Given("GitHub rejects pull request creation with a diagnostic containing the credential", function () {
  this.publication.failCreate = true;
  this.publication.leakCredentialInCreateError = true;
});

Given("GitHub rejects pull request merging", function () {
  this.publication.failMerge = true;
});

Given("an open metrics pull request {string} already exists", function (url) {
  this.publication.pendingPullRequestUrl = url;
});

When("the workflow publishes the generated metrics", async function () {
  try {
    this.publication.result = await publishGeneratedMetrics({
      environment: this.publication.environment,
      runCommand: this.runCommand,
    });
  } catch (error) {
    this.publication.error = error;
  }
});

Then("it stages only {string} and {string}", function (readmePath, metricsPath) {
  const add = this.publication.calls.find(({ command, args }) => command === "git" && args[0] === "add");
  assert.ok(add);
  assert.deepEqual(add.args.slice(3), [readmePath, metricsPath]);
});

Then("it pushes the publication branch {string}", function (branch) {
  const push = this.publication.calls.find(({ command, args }) => command === "git" && args[0] === "push");
  assert.ok(push);
  assert.deepEqual(push.args, ["push", "--set-upstream", "origin", branch]);
  assert.notEqual(push.args.at(-1), "main");
});

Then("it opens a pull request targeting {string}", function (base) {
  const create = this.publication.calls.find(({ command, args }) => command === "gh" && args[1] === "create");
  assert.ok(create);
  assert.ok(create.args.includes("--base"));
  assert.equal(create.args[create.args.indexOf("--base") + 1], base);
  assert.ok(create.args.includes("--head"));
  assert.equal(create.args[create.args.indexOf("--head") + 1], "metrics/update-12345-1");
});

Then("it merges that pull request with {string}", function (method) {
  const merge = this.publication.calls.find(({ command, args }) => command === "gh" && args[1] === "merge");
  assert.ok(merge);
  assert.ok(merge.args.includes(PULL_REQUEST_URL));
  assert.ok(merge.args.includes(`--${method}`));
  assert.ok(merge.args.includes("--delete-branch"));
});

Then("publication is reported as {string}", function (status) {
  assert.equal(this.publication.error, null);
  assert.equal(this.publication.result?.status, status);
});

Then("no remote branch or pull request is created", function () {
  assert.equal(this.publication.calls.some(({ command, args }) => command === "git" && args[0] === "push"), false);
  assert.equal(this.publication.calls.some(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] !== "list"), false);
});

Then("publication fails at {string}", function (stage) {
  assert.ok(this.publication.error);
  assert.equal(this.publication.error.stage, stage);
  assert.equal(this.publication.result, null);
});

Then("the pull request is not merged", function () {
  assert.equal(this.publication.calls.some(({ command, args }) => command === "gh" && args[1] === "merge"), false);
});

Then("it removes the temporary publication branch", function () {
  assert.ok(this.publication.calls.some(({ command, args }) =>
    command === "git" && args[0] === "push" && args[2] === "--delete" && args[3] === "metrics/update-12347-1",
  ));
});

Then("the failure identifies the open pull request for recovery", function () {
  assert.match(this.publication.error.message, new RegExp(PULL_REQUEST_URL.replaceAll("/", "\\/")));
  assert.equal(this.publication.error.stage, "pull request merge");
});

Then("the failure does not contain the workflow credential", function () {
  assert.doesNotMatch(this.publication.error.message, /SENTINEL_SECRET_MUST_NOT_LOG/);
});

Then("the failure identifies the existing pull request for recovery", function () {
  assert.match(this.publication.error.message, /pull\/98/);
});
