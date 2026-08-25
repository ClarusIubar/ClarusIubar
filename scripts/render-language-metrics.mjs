import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { GITHUB_LINGUIST_COLORS } from "./github-linguist-colors.mjs";

const OWNER = process.env.PROFILE_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || "ClarusIubar";
const TOKEN =
  process.env.METRICS_TOKEN ||
  process.env.METRICS_RUNTIME_TOKEN ||
  process.env.GITHUB_TOKEN ||
  "";

if (!TOKEN && !process.env.LANGUAGE_RENDERER_TEST_MODE) {
  throw new Error("Missing GitHub token. Set METRICS_TOKEN, METRICS_RUNTIME_TOKEN, or GITHUB_TOKEN.");
}

const outputDir = path.resolve(process.cwd(), "metrics");
const languageSvgPath = path.join(outputDir, "metrics.languages.linguist.svg");
const languageJsonPath = path.join(outputDir, "metrics.languages.json");
const metricsIgnorePath = path.resolve(process.cwd(), ".metricsignore");
const graphqlMaxAttempts = Number.parseInt(process.env.LANGUAGE_GRAPHQL_MAX_ATTEMPTS || "4", 10);
const graphqlRetryBaseDelayMs = Number.parseInt(process.env.LANGUAGE_GRAPHQL_RETRY_BASE_DELAY_MS || "1500", 10);
const displayedLanguageLimit = Number.parseInt(process.env.LANGUAGE_DISPLAY_LIMIT || "8", 10);

const REPOSITORY_BATCH_SIZE = 100;
const TREE_FETCH_CONCURRENCY = 5;

const LANGUAGE_BY_EXTENSION = new Map([
  [".astro", "Astro"], [".c", "C"], [".cpp", "C++"], [".cs", "C#"], [".css", "CSS"], [".dart", "Dart"],
  [".go", "Go"], [".h", "C"], [".html", "HTML"], [".ipynb", "Jupyter Notebook"], [".java", "Java"],
  [".js", "JavaScript"], [".jsx", "JavaScript"], [".kt", "Kotlin"], [".kts", "Kotlin"], [".lua", "Lua"],
  [".mjs", "JavaScript"], [".php", "PHP"], [".pl", "Perl"], [".ps1", "PowerShell"], [".py", "Python"],
  [".r", "R"], [".rb", "Ruby"], [".rs", "Rust"], [".scala", "Scala"], [".scss", "SCSS"], [".sh", "Shell"],
  [".sql", "SQL"], [".swift", "Swift"], [".svg", "SVG"], [".ts", "TypeScript"], [".tsx", "TypeScript"],
  [".vue", "Vue"], [".xml", "XML"], [".yml", "YAML"], [".yaml", "YAML"],
]);

const repositoriesQuery = `
query ($login: String!, $isFork: Boolean!, $after: String) {
  user(login: $login) {
    repositories(
      first: ${REPOSITORY_BATCH_SIZE}
      after: $after
      ownerAffiliations: [OWNER]
      isFork: $isFork
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        name
        nameWithOwner
        isFork
        isPrivate
        pushedAt
        defaultBranchRef {
          name
        }
      }
    }
  }
}
`;

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

export function colorForLanguage(name) {
  return GITHUB_LINGUIST_COLORS.get(name) || "#8b949e";
}

/** Parses the public `.metricsignore` file. `repo:` values may only exclude public repositories. */
export function parseMetricsIgnore(contents) {
  const repositoryNames = new Set();
  const pathPatterns = [];
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("repo:")) {
      const name = line.slice("repo:".length).trim();
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`.metricsignore line ${index + 1}: repo rules require a bare repository name.`);
      }
      repositoryNames.add(name.toLowerCase());
      continue;
    }
    if (line.startsWith("path:")) {
      const pattern = line.slice("path:".length).trim();
      if (!pattern) throw new Error(`.metricsignore line ${index + 1}: path rule cannot be empty.`);
      pathPatterns.push(pattern);
      continue;
    }
    throw new Error(`.metricsignore line ${index + 1}: expected repo: or path: rule.`);
  }
  return { repositoryNames, pathPatterns, pathMatchers: pathPatterns.map(globToRegExp) };
}

/**
 * Parses private repository exclusions supplied only through GitHub Actions secrets.
 * The generic error deliberately does not echo the secret value.
 */
export function parsePrivateExcludedRepositories(value) {
  const names = new Set();
  for (const rawName of value.split(/[\r\n,]+/)) {
    const name = rawName.trim();
    if (!name) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error("LANGUAGE_PRIVATE_EXCLUDED_REPOSITORIES contains an invalid repository name.");
    }
    names.add(name.toLowerCase());
  }
  return names;
}

function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index++;
      if (pattern[index + 1] === "/") {
        index++;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

/** Returns true when a tracked file matches a `.metricsignore` path rule. */
export function isExcludedArtifactPath(filePath, metricsIgnore) {
  return metricsIgnore.pathMatchers.some((matcher) => matcher.test(filePath));
}

export function languageForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return LANGUAGE_BY_EXTENSION.get(extension) ?? null;
}

export function isExcludedRepository(repository, metricsIgnore, privateExcludedRepositories = new Set()) {
  if (repository.isFork) return true;
  if (repository.isPrivate) return privateExcludedRepositories.has(repository.name.toLowerCase());
  return metricsIgnore.repositoryNames.has(repository.name.toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableMessage(message) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("secondary rate limit") ||
    normalized.includes("abuse detection") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("try again later")
  );
}

function retryAfterDelayMs(response) {
  const retryAfter = response.headers.get("retry-after");
  const parsedRetryAfter = retryAfter == null ? Number.NaN : Number.parseInt(retryAfter, 10);
  if (Number.isFinite(parsedRetryAfter) && parsedRetryAfter >= 0) {
    return parsedRetryAfter * 1000;
  }
  return null;
}

function transientGraphqlError(message, cause) {
  const error = new Error(message);
  error.transient = true;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

async function existingGeneratedAssetsAvailable() {
  try {
    await Promise.all([access(languageSvgPath), access(languageJsonPath)]);
    return true;
  } catch {
    return false;
  }
}

async function requestGraphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "ClarusIubar-profile-language-metrics",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const message = await response.text();
    const errorMessage = `GitHub GraphQL request failed: ${response.status} ${message}`;
    if (isRetryableStatus(response.status) || (response.status === 403 && isRetryableMessage(message))) {
      const error = transientGraphqlError(errorMessage);
      error.retryDelayMs = retryAfterDelayMs(response);
      throw error;
    }
    throw new Error(errorMessage);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    const message = JSON.stringify(payload.errors);
    if (isRetryableMessage(message)) {
      throw transientGraphqlError(`GitHub GraphQL errors: ${message}`);
    }
    throw new Error(`GitHub GraphQL errors: ${message}`);
  }

  return payload.data;
}

async function requestGraphqlWithRetry(query, variables) {
  const maxAttempts = Number.isFinite(graphqlMaxAttempts) && graphqlMaxAttempts > 0 ? graphqlMaxAttempts : 4;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestGraphql(query, variables);
    } catch (error) {
      lastError = error;
      if (!error.transient || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = error.retryDelayMs ?? graphqlRetryBaseDelayMs * attempt;
      console.warn(
        `GitHub GraphQL request failed transiently; retrying ${attempt}/${maxAttempts - 1} after ${delayMs}ms.`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("GitHub GraphQL request failed without an error payload.");
}

async function requestGitHubApiWithRetry(url) {
  const maxAttempts = Number.isFinite(graphqlMaxAttempts) && graphqlMaxAttempts > 0 ? graphqlMaxAttempts : 4;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": "ClarusIubar-profile-language-metrics" },
      });
      if (!response.ok) {
        const message = await response.text();
        const error = new Error(`GitHub API request failed: ${response.status} ${message}`);
        if (isRetryableStatus(response.status) || (response.status === 403 && isRetryableMessage(message))) {
          error.transient = true;
          error.retryDelayMs = retryAfterDelayMs(response);
        }
        throw error;
      }
      return response.json();
    } catch (error) {
      lastError = error;
      if (!error.transient || attempt === maxAttempts) throw error;
      await sleep(error.retryDelayMs ?? graphqlRetryBaseDelayMs * attempt);
    }
  }
  throw lastError ?? new Error("GitHub API request failed without an error payload.");
}

async function fetchRepositoriesByForkState(isFork) {
  const repositories = [];
  let after = null;

  while (true) {
    const data = await requestGraphqlWithRetry(repositoriesQuery, {
      login: OWNER,
      isFork,
      after,
    });
    const connection = data.user?.repositories;
    if (!connection) {
      throw new Error(`GitHub GraphQL returned no repositories connection for ${OWNER}.`);
    }

    repositories.push(...connection.nodes);

    if (!connection.pageInfo.hasNextPage) {
      return { repositories, totalCount: connection.totalCount };
    }
    after = connection.pageInfo.endCursor;
  }
}

async function fetchRepositories(metricsIgnore, privateExcludedRepositories) {
  const owned = await fetchRepositoriesByForkState(false);
  if (owned.repositories.some((repository) => repository.isPrivate && metricsIgnore.repositoryNames.has(repository.name.toLowerCase()))) {
    throw new Error(".metricsignore must not list private repositories; use LANGUAGE_PRIVATE_EXCLUDED_REPOSITORIES instead.");
  }
  const explicitlyExcluded = owned.repositories.filter(
    (repository) => !repository.isPrivate && metricsIgnore.repositoryNames.has(repository.name.toLowerCase()),
  );
  const privateExcluded = owned.repositories.filter(
    (repository) => repository.isPrivate && privateExcludedRepositories.has(repository.name.toLowerCase()),
  );
  const includedRepositories = owned.repositories.filter(
    (repository) => !isExcludedRepository(repository, metricsIgnore, privateExcludedRepositories),
  );
  const repositories = await mapWithConcurrency(includedRepositories, TREE_FETCH_CONCURRENCY, async (repository) => {
    const branch = repository.defaultBranchRef?.name;
    if (!branch) return { ...repository, files: [] };
    const tree = await requestGitHubApiWithRetry(
      `https://api.github.com/repos/${repository.nameWithOwner}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    if (tree.truncated) {
      throw new Error("A repository Git tree is truncated; cannot calculate accurate file-level language metrics.");
    }
    return { ...repository, files: tree.tree.filter((entry) => entry.type === "blob" && Number.isFinite(entry.size)) };
  });

  return {
    repositories,
    totals: {
      owned: owned.totalCount,
      forks: 0,
      explicitlyExcluded: explicitlyExcluded.length,
      privateExcluded: privateExcluded.length,
      privateIncluded: owned.repositories.filter((repository) => repository.isPrivate).length - privateExcluded.length,
      privateExclusionSecretConfigured: privateExcludedRepositories.size > 0,
    },
  };
}

export function buildSnapshot({ repositories, totals }, metricsIgnore) {
  const languages = new Map();
  let repositoryLanguageBytes = 0;
  let repositoriesWithLanguages = 0;
  let excludedArtifactFiles = 0;
  let excludedArtifactBytes = 0;

  for (const repository of repositories) {
    const repositoryLanguages = new Map();
    for (const file of repository.files ?? []) {
      if (isExcludedArtifactPath(file.path, metricsIgnore)) {
        excludedArtifactFiles++;
        excludedArtifactBytes += file.size;
        continue;
      }
      const name = languageForPath(file.path);
      if (name) repositoryLanguages.set(name, (repositoryLanguages.get(name) ?? 0) + file.size);
    }
    const repositoryBytes = [...repositoryLanguages.values()].reduce((total, size) => total + size, 0);
    if (repositoryBytes <= 0) {
      continue;
    }
    repositoriesWithLanguages++;
    repositoryLanguageBytes += repositoryBytes;

    for (const [name, bytes] of repositoryLanguages) {
      const current = languages.get(name) ?? {
        name,
        bytes: 0,
        repositories: 0,
        color: colorForLanguage(name),
      };
      current.bytes += bytes;
      current.repositories++;
      languages.set(name, current);
    }
  }

  const sortedLanguages = [...languages.values()]
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
    .map((language) => ({
      ...language,
      share: repositoryLanguageBytes === 0 ? 0 : language.bytes / repositoryLanguageBytes,
    }));

  const limit = Number.isFinite(displayedLanguageLimit) && displayedLanguageLimit > 0 ? displayedLanguageLimit : 8;
  const displayedLanguages = sortedLanguages.slice(0, limit);
  const displayedBytes = displayedLanguages.reduce((total, language) => total + language.bytes, 0);

  return {
    username: OWNER,
    generatedAt: new Date().toISOString(),
    source: {
      ownerAffiliations: ["OWNER"],
      includeForks: false,
      metricsIgnoreFile: ".metricsignore",
      privateRepositoriesIncluded: true,
      privateExclusionSecretConfigured: Boolean(totals.privateExclusionSecretConfigured),
      languageColorSource: "GitHub Linguist languages.yml snapshot",
      repositoryBatchSize: REPOSITORY_BATCH_SIZE,
      metric: "Tracked source-file bytes after build-artifact exclusion",
      excludedPathRuleCount: metricsIgnore.pathPatterns.length,
    },
    summary: {
      totalRepositories: repositories.length,
      ownedRepositories: totals.owned,
      forkRepositories: totals.forks,
      explicitlyExcludedRepositories: totals.explicitlyExcluded,
      privateRepositoriesExcluded: totals.privateExcluded,
      privateRepositoriesIncluded: totals.privateIncluded,
      repositoriesWithLanguages,
      languageCount: sortedLanguages.length,
      totalLanguageBytes: repositoryLanguageBytes,
      displayedLanguageBytes: displayedBytes,
      displayedLanguageCount: displayedLanguages.length,
      excludedArtifactFiles,
      excludedArtifactBytes,
    },
    languages: sortedLanguages,
    displayedLanguages,
  };
}

function renderEmptySvg(snapshot) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="760" height="180" viewBox="0 0 760 180" role="img" aria-labelledby="title desc">
  <title id="title">Languages</title>
  <desc id="desc">No repository language data was available.</desc>
  <style>
    .bg { fill: #0d1117; }
    .card { fill: #161b22; stroke: #30363d; stroke-width: 1; }
    .title { fill: #f0f6fc; font: 800 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .muted { fill: #8b949e; font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  </style>
  <rect class="bg" width="760" height="180" rx="16" />
  <rect class="card" x="12" y="12" width="736" height="156" rx="14" />
  <text x="36" y="52" class="title">Languages</text>
  <text x="36" y="84" class="muted">No visible repository language metadata found for ${escapeXml(snapshot.username)}.</text>
  <text x="36" y="112" class="muted">Generated ${escapeXml(snapshot.generatedAt.slice(0, 10))}</text>
</svg>`;
}

function renderLanguageSvg(snapshot) {
  if (snapshot.displayedLanguages.length === 0) {
    return renderEmptySvg(snapshot);
  }

  const width = 900;
  const height = 292;
  const barX = 42;
  const barY = 120;
  const barWidth = 816;
  const barHeight = 14;
  let offset = 0;
  const segments = snapshot.displayedLanguages
    .map((language) => {
      const segmentWidth = Math.max(2, Math.round(language.share * barWidth));
      const rendered = `<rect x="${barX + offset}" y="${barY}" width="${segmentWidth}" height="${barHeight}" rx="3" fill="${escapeXml(language.color)}" />`;
      offset += segmentWidth;
      return rendered;
    })
    .join("");

  const renderedRows = snapshot.displayedLanguages
    .map((language, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = column === 0 ? 48 : 500;
      const y = 170 + row * 32;
      return [
        `<circle cx="${x}" cy="${y - 4}" r="5.5" fill="${escapeXml(language.color)}" />`,
        `<text x="${x + 18}" y="${y}" class="language">${escapeXml(language.name)}</text>`,
        `<text x="${x + 260}" y="${y}" class="value" text-anchor="end">${escapeXml(formatBytes(language.bytes))}</text>`,
        `<text x="${x + 340}" y="${y}" class="muted" text-anchor="end">${escapeXml(formatPercent(language.share))}</text>`,
      ].join("\n  ");
    })
    .join("\n  ");

  const repoSummary = `${formatNumber(snapshot.summary.repositoriesWithLanguages)}/${formatNumber(snapshot.summary.totalRepositories)} repos with language data`;
  const languageSummary = `${formatNumber(snapshot.summary.languageCount)} languages`;
  const byteSummary = `${formatBytes(snapshot.summary.totalLanguageBytes)} visible language bytes`;
  const exclusionSummary = `${formatNumber(snapshot.summary.excludedArtifactFiles)} build artifacts excluded`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Languages</title>
  <desc id="desc">Repository language mix for visible owned repositories.</desc>
  <style>
    .bg { fill: #0d1117; }
    .card { fill: #161b22; stroke: #30363d; stroke-width: 1; }
    .eyebrow { fill: #79c0ff; font: 700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
    .title { fill: #f0f6fc; font: 800 26px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .subtitle { fill: #9da7b3; font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .language { fill: #f0f6fc; font: 700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .value { fill: #c9d1d9; font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .muted { fill: #8b949e; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .note { fill: #6e7681; font: 500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  </style>
  <rect class="bg" width="${width}" height="${height}" rx="16" />
  <rect class="card" x="12" y="12" width="${width - 24}" height="${height - 24}" rx="14" />

  <text x="42" y="48" class="eyebrow">VISIBLE REPOSITORIES</text>
  <text x="42" y="82" class="title">Languages</text>
  <text x="42" y="106" class="subtitle">${escapeXml(languageSummary)} - ${escapeXml(byteSummary)} - ${escapeXml(repoSummary)} - ${escapeXml(exclusionSummary)}</text>

  <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="7" fill="#21262d" />
  ${segments}

  ${renderedRows}
</svg>`;
}

function stripTrailingWhitespace(value) {
  return value.replace(/[ \t]+$/gm, "");
}

async function main() {
  const metricsIgnore = parseMetricsIgnore(await readFile(metricsIgnorePath, "utf8"));
  const privateExcludedRepositories = parsePrivateExcludedRepositories(
    process.env.LANGUAGE_PRIVATE_EXCLUDED_REPOSITORIES || "",
  );
  let source;
  try {
    source = await fetchRepositories(metricsIgnore, privateExcludedRepositories);
  } catch (error) {
    if (error.transient && (await existingGeneratedAssetsAvailable())) {
      console.warn("GitHub GraphQL is temporarily unavailable; preserving existing language assets.");
      console.warn(error.message);
      return;
    }
    throw error;
  }

  const snapshot = buildSnapshot(source, metricsIgnore);
  const svg = stripTrailingWhitespace(renderLanguageSvg(snapshot));

  await mkdir(outputDir, { recursive: true });
  await writeFile(languageJsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await writeFile(languageSvgPath, svg, "utf8");

  console.log(`Wrote ${languageJsonPath}`);
  console.log(`Wrote ${languageSvgPath}`);
  console.log(
    `Rendered ${snapshot.summary.displayedLanguageCount}/${snapshot.summary.languageCount} languages from ${snapshot.summary.repositoriesWithLanguages}/${snapshot.summary.totalRepositories} repositories.`,
  );
}

if (!process.env.LANGUAGE_RENDERER_TEST_MODE) {
  await main();
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]);
    }
  }));
  return results;
}
