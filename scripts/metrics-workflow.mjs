import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  createGitHubClient,
  resolveProfileUsername,
} from "./github-api.mjs";
import {
  buildSnapshot as buildLanguageSnapshot,
  fetchRepositories,
  parseMetricsIgnore,
  parsePrivateExcludedRepositories,
  renderLanguageAssets,
} from "./render-language-metrics.mjs";
import {
  buildSnapshot as buildContributionSnapshot,
  compareSnapshots,
  fetchContributionCalendar,
  formatChange,
  renderContributionAssets,
} from "./render-contribution-density.mjs";

async function readPreviousActivitySnapshot(rootDirectory) {
  try {
    return JSON.parse(await readFile(path.join(rootDirectory, "metrics", "contribution-activity.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Could not read previous contribution snapshot: ${error.message}`);
  }
}

export async function writeMetricAssets(rootDirectory, assets) {
  const outputDirectory = path.join(rootDirectory, "metrics");
  await mkdir(outputDirectory, { recursive: true });
  for (const [relativePath, contents] of Object.entries(assets)) {
    const segments = relativePath.split(/[\\/]/);
    if (segments.length !== 2 || segments[0] !== "metrics" || !segments[1] || segments[1] === "." || segments[1] === "..") {
      throw new Error(`Metrics output path is outside the metrics directory: ${relativePath}`);
    }
    await writeFile(path.join(rootDirectory, relativePath), contents, "utf8");
  }
}

async function appendStepSummary(environment, title, lines) {
  const summaryPath = environment.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  await appendFile(summaryPath, `## ${title}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`, "utf8");
}

export async function runMetricsRefresh({
  environment = process.env,
  rootDirectory = process.cwd(),
  client: providedClient,
  fetchImpl,
  sleepImpl,
  logger = console,
  metricsIgnoreText,
  previousActivitySnapshot,
  writeAssets = (assets) => writeMetricAssets(rootDirectory, assets),
  writeSummary = (title, lines) => appendStepSummary(environment, title, lines),
  now = () => new Date(),
} = {}) {
  const username = resolveProfileUsername(environment);
  const client = providedClient ?? createGitHubClient({
    environment,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(sleepImpl ? { sleepImpl } : {}),
    logger,
  });
  const previousSnapshot = previousActivitySnapshot === undefined
    ? await readPreviousActivitySnapshot(rootDirectory)
    : previousActivitySnapshot;
  const ignoreText = metricsIgnoreText ?? await readFile(path.join(rootDirectory, ".metricsignore"), "utf8");
  const metricsIgnore = parseMetricsIgnore(ignoreText);
  const privateExclusions = parsePrivateExcludedRepositories(environment.LANGUAGE_PRIVATE_EXCLUDED_REPOSITORIES || "");

  let outputWriteStarted = false;
  try {
    const repositorySource = await fetchRepositories(metricsIgnore, privateExclusions, { client, owner: username, environment });
    const calendar = await fetchContributionCalendar(client, username);
    const generatedAt = now().toISOString();
    const languageSnapshot = buildLanguageSnapshot(repositorySource, metricsIgnore, { username, generatedAt });
    const contributionSnapshot = buildContributionSnapshot(calendar, { username, generatedAt });
    const comparison = compareSnapshots(previousSnapshot, contributionSnapshot);
    contributionSnapshot.freshness = {
      status: "current",
      dataThrough: contributionSnapshot.window.end,
      comparison,
    };

    const assets = {
      ...renderLanguageAssets(languageSnapshot),
      ...renderContributionAssets(contributionSnapshot),
    };
    outputWriteStarted = true;
    await writeAssets(assets);
    try {
      await writeSummary("Contribution metrics refresh", [
        `Authenticated account: ${username}`,
        `Data through: ${contributionSnapshot.freshness.dataThrough}`,
        comparison.changed ? "Observed contribution values changed." : "No observed contribution values changed.",
        ...comparison.changes.map(formatChange),
      ]);
    } catch {
      logger.warn("Could not append the GitHub Metrics success summary.");
    }

    logger.log(`Rendered ${languageSnapshot.summary.displayedLanguageCount}/${languageSnapshot.summary.languageCount} languages from ${languageSnapshot.summary.repositoriesWithLanguages}/${languageSnapshot.summary.totalRepositories} repositories.`);
    logger.log(`Rendered contribution metrics through ${contributionSnapshot.freshness.dataThrough}.`);
    return { username, languageSnapshot, contributionSnapshot, assets, comparison };
  } catch (error) {
    const lastGeneratedAt = previousSnapshot?.summary?.generatedAt ?? "unknown";
    try {
      await writeSummary("GitHub Metrics refresh failed", [
        outputWriteStarted
          ? "Metrics output writing failed; the failed Actions job did not reach the commit step."
          : "The previous generated asset set was preserved.",
        `Last successful generation: ${lastGeneratedAt}`,
        `Failure: ${error.message}`,
      ]);
    } catch {
      logger.warn("Could not append the GitHub Metrics failure summary.");
    }
    throw error;
  }
}
