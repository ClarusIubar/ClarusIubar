import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const OUTPUT_PATHS = ["README.md", "metrics/"];
const METRICS_PULL_REQUEST_TITLE = "chore: update profile metrics";

export class MetricsPublicationError extends Error {
  constructor(stage, message) {
    super(message);
    this.name = "MetricsPublicationError";
    this.stage = stage;
  }
}

function redact(text, environment) {
  let result = String(text ?? "");
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "METRICS_TOKEN"]) {
    const value = environment[name];
    if (typeof value === "string" && value.length > 0) result = result.replaceAll(value, "[REDACTED]");
  }
  return result.trim().slice(0, 500);
}

function execute(command, args, environment) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", env: environment, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        errorCode: error && typeof error.code === "string" ? error.code : null,
        stdout,
        stderr,
      });
    });
  });
}

async function checked(runCommand, command, args, stage, environment) {
  const result = await runCommand(command, args);
  if (result.exitCode !== 0) {
    const detail = redact(result.stderr || result.errorCode, environment);
    throw new MetricsPublicationError(stage, `${stage} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function pullRequestUrl(stdout) {
  return String(stdout).match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/)?.[0] ?? null;
}

export async function publishGeneratedMetrics({ environment = process.env, runCommand = (command, args) => execute(command, args, environment) } = {}) {
  if (environment.GITHUB_REF_NAME !== "main") {
    throw new MetricsPublicationError("unsupported branch", "Metrics publication is allowed only from the main branch.");
  }
  if (!/^\d+$/.test(environment.GITHUB_RUN_ID ?? "") || !/^\d+$/.test(environment.GITHUB_RUN_ATTEMPT ?? "")) {
    throw new MetricsPublicationError("workflow context", "The Actions run ID or attempt is unavailable for a unique publication branch.");
  }
  if (!/^[^/]+\/[^/]+$/.test(environment.GITHUB_REPOSITORY ?? "")) {
    throw new MetricsPublicationError("workflow context", "The repository name is unavailable for pull request creation.");
  }
  if (!environment.GH_TOKEN) {
    throw new MetricsPublicationError("workflow credential", "The GitHub CLI credential is unavailable.");
  }
  const repository = environment.GITHUB_REPOSITORY;
  const openPullRequests = await checked(runCommand, "gh", [
    "pr", "list", "--repo", repository, "--base", "main", "--state", "open",
    "--json", "number,url,title,headRefName", "--limit", "100",
  ], "inspect pending metrics pull requests", environment);
  let parsedPullRequests;
  try {
    parsedPullRequests = JSON.parse(openPullRequests.stdout);
  } catch {
    throw new MetricsPublicationError("inspect pending metrics pull requests", "GitHub returned invalid pull request data.");
  }
  if (!Array.isArray(parsedPullRequests)) {
    throw new MetricsPublicationError("inspect pending metrics pull requests", "GitHub returned invalid pull request data.");
  }
  const pendingMetricsPullRequest = parsedPullRequests.find((pullRequest) =>
    pullRequest?.title === METRICS_PULL_REQUEST_TITLE
      && typeof pullRequest.headRefName === "string"
      && pullRequest.headRefName.startsWith("metrics/update-"),
  );
  if (pendingMetricsPullRequest) {
    throw new MetricsPublicationError(
      "pending metrics pull request",
      `An earlier metrics pull request is still open: ${pendingMetricsPullRequest.url}`,
    );
  }

  await checked(runCommand, "git", ["config", "user.name", "github-actions"], "git identity", environment);
  await checked(runCommand, "git", ["config", "user.email", "github-actions@github.com"], "git identity", environment);
  await checked(runCommand, "git", ["add", "-A", "--", ...OUTPUT_PATHS], "stage generated metrics", environment);
  const staged = await checked(runCommand, "git", ["diff", "--cached", "--name-only"], "inspect generated metrics", environment);
  const changedPaths = String(staged.stdout).split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (changedPaths.length === 0) return { status: "unchanged", changedPaths: [] };

  const branch = `metrics/update-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`;
  await checked(runCommand, "git", ["switch", "--create", branch], "create publication branch", environment);
  await checked(runCommand, "git", ["commit", "-m", METRICS_PULL_REQUEST_TITLE], "commit generated metrics", environment);
  await checked(runCommand, "git", ["push", "--set-upstream", "origin", branch], "push publication branch", environment);

  const createResult = await runCommand("gh", [
    "pr", "create", "--repo", repository, "--base", "main", "--head", branch,
    "--title", METRICS_PULL_REQUEST_TITLE,
    "--body", "Automated profile metrics refresh. This change contains only README metric references and generated metrics files.",
  ]);
  if (createResult.exitCode !== 0) {
    const detail = redact(createResult.stderr || createResult.errorCode, environment);
    const cleanup = await runCommand("git", ["push", "origin", "--delete", branch]);
    const cleanupDetail = cleanup.exitCode === 0
      ? "The temporary branch was removed."
      : `The temporary branch could not be removed${redact(cleanup.stderr || cleanup.errorCode, environment) ? `: ${redact(cleanup.stderr || cleanup.errorCode, environment)}` : "."}`;
    throw new MetricsPublicationError(
      "pull request creation",
      `Pull request creation failed${detail ? `: ${detail}` : ""}. ${cleanupDetail}`,
    );
  }

  const url = pullRequestUrl(createResult.stdout);
  if (!url) throw new MetricsPublicationError("pull request creation", "GitHub did not return a metrics pull request URL.");

  const mergeResult = await runCommand("gh", ["pr", "merge", url, "--repo", repository, "--squash", "--delete-branch"]);
  if (mergeResult.exitCode !== 0) {
    const detail = redact(mergeResult.stderr || mergeResult.errorCode, environment);
    throw new MetricsPublicationError(
      "pull request merge",
      `Metrics are staged in ${url}, but the pull request could not be merged${detail ? `: ${detail}` : ""}`,
    );
  }

  return { status: "merged", branch, pullRequestUrl: url, changedPaths };
}

async function main() {
  try {
    const result = await publishGeneratedMetrics();
    console.log(result.status === "unchanged"
      ? "Metrics publication skipped: generated README and metrics files are unchanged."
      : `Metrics published through ${result.pullRequestUrl}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
