import path from "node:path";
import process from "node:process";
import { assertAuthenticatedViewer, createGitHubClient, resolveProfileUsername } from "./github-api.mjs";
import { GITHUB_LINGUIST_COLORS } from "./github-linguist-colors.mjs";

const REPOSITORY_BATCH_SIZE = 100;
const TREE_FETCH_CONCURRENCY = 5;
const DEFAULT_DISPLAYED_LANGUAGE_LIMIT = 8;

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
  viewer {
    login
  }
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
          target {
            ... on Commit {
              tree {
                oid
              }
            }
          }
        }
      }
    }
  }
}
`;

const emptyPrivateTreeQuery = `
query ($owner: String!, $name: String!, $oid: GitObjectID!) {
  viewer {
    login
  }
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      __typename
      ... on Tree {
        entries {
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

/**
 * Confirms that a private repository's exact root tree is empty after REST returned 404.
 * Why: GitHub can return 404 for an empty private tree; accepting only a GraphQL-confirmed
 * empty tree prevents that case from hiding the rest of the metrics while keeping failures closed.
 * @param {{isPrivate: boolean, nameWithOwner: string}} repository Repository returned by GitHub GraphQL.
 * @param {string} treeSha Root tree object ID from the repository's default branch.
 * @param {(query: string, variables: object) => Promise<object>} graphqlRequest GraphQL request seam for deterministic tests.
 * @returns {Promise<boolean>} True only when GitHub confirms this exact object is an empty Tree.
 * @throws Transient lookup errors are propagated so the caller can preserve existing generated assets.
 */
export async function isEmptyPrivateTreeAfterRestNotFound(
  repository,
  treeSha,
  graphqlRequest,
  expectedUsername,
) {
  if (
    !repository ||
    !repository.isPrivate ||
    typeof repository.nameWithOwner !== "string" ||
    typeof treeSha !== "string"
  ) {
    return false;
  }

  const parts = repository.nameWithOwner.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [owner, name] = parts;

  if (typeof graphqlRequest !== "function") {
    throw new Error("An authenticated GraphQL request is required to verify a private empty tree.");
  }
  const data = await graphqlRequest(emptyPrivateTreeQuery, { owner, name, oid: treeSha }, { stage: "private empty-tree verification" });
  if (expectedUsername) assertAuthenticatedViewer(data, expectedUsername, "private empty-tree verification");
  const tree = data.repository?.object;
  return tree?.__typename === "Tree" && Array.isArray(tree.entries) && tree.entries.length === 0;
}

async function fetchRepositoriesByForkState(isFork, owner, client) {
  const repositories = [];
  let after = null;
  let totalCount = null;
  const seenCursors = new Set();

  while (true) {
    const data = await client.graphql(repositoriesQuery, {
      login: owner,
      isFork,
      after,
    }, { stage: "repository listing" });
    assertAuthenticatedViewer(data, owner, "repository listing");
    const connection = data.user?.repositories;
    if (!connection) {
      throw new Error(`GitHub GraphQL returned no repositories connection for ${owner}.`);
    }
    if (!Array.isArray(connection.nodes) || !Number.isInteger(connection.totalCount) || !connection.pageInfo) {
      throw new Error("GitHub GraphQL returned an incomplete repositories page.");
    }
    if (totalCount !== null && connection.totalCount !== totalCount) {
      throw new Error("GitHub repository listing changed during pagination; refusing an incomplete metrics snapshot.");
    }
    totalCount = connection.totalCount;

    repositories.push(...connection.nodes);

    if (!connection.pageInfo.hasNextPage) {
      if (repositories.length !== totalCount) {
        throw new Error("GitHub repository listing ended before all repositories were read.");
      }
      return { repositories, totalCount };
    }
    const nextCursor = connection.pageInfo.endCursor;
    if (typeof nextCursor !== "string" || !nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("GitHub repository listing returned a missing or repeated pagination cursor.");
    }
    seenCursors.add(nextCursor);
    after = nextCursor;
  }
}

export async function fetchRepositories(
  metricsIgnore,
  privateExcludedRepositories = new Set(),
  dependencies = {},
) {
  const environment = dependencies.environment ?? process.env;
  const owner = dependencies.owner ?? resolveProfileUsername(environment);
  let client = dependencies.client;
  const getClient = () => {
    if (!client) {
      client = createGitHubClient({
        environment,
        ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
        ...(dependencies.sleepImpl ? { sleepImpl: dependencies.sleepImpl } : {}),
        ...(dependencies.logger ? { logger: dependencies.logger } : {}),
      });
    }
    return client;
  };
  const fetchOwnedRepositories = dependencies.fetchOwnedRepositories ?? (() => fetchRepositoriesByForkState(false, owner, getClient()));
  const fetchTree = dependencies.fetchTree ?? ((url) => getClient().rest(url, { stage: "repository tree" }));
  const graphqlRequest = dependencies.graphqlRequest ?? ((...args) => getClient().graphql(...args));
  const owned = await fetchOwnedRepositories();
  if (!Array.isArray(owned.repositories) || !Number.isInteger(owned.totalCount)) {
    throw new Error("GitHub repository listing did not return a complete repository set.");
  }
  if (owned.repositories.some((repository) => repository.isPrivate && metricsIgnore.repositoryNames.has(repository.name.toLowerCase()))) {
    throw new Error(".metricsignore cannot exclude private repositories; all owned private repositories are included.");
  }
  if (metricsIgnore.repositoryNames.size > 0) {
    throw new Error(".metricsignore repo: rules are disabled; all owned non-fork repositories are included.");
  }
  const privateExcluded = owned.repositories.filter(
    (repository) => repository.isPrivate && privateExcludedRepositories.has(repository.name.toLowerCase()),
  );
  const includedRepositories = owned.repositories.filter(
    (repository) => !isExcludedRepository(repository, metricsIgnore, privateExcludedRepositories),
  );
  const repositories = await mapWithConcurrency(includedRepositories, TREE_FETCH_CONCURRENCY, async (repository) => {
    const branch = repository.defaultBranchRef?.name;
    const treeSha = repository.defaultBranchRef?.target?.tree?.oid;
    if (!branch) return { ...repository, files: [] };
    if (!treeSha) {
      throw new Error(
        repository.isPrivate
          ? "GitHub GraphQL returned no default-branch tree SHA for a private repository."
          : `GitHub GraphQL returned no default-branch tree SHA for public repository ${repository.nameWithOwner} (${branch}).`,
      );
    }

    let tree;
    try {
      tree = await fetchTree(
        `https://api.github.com/repos/${repository.nameWithOwner}/git/trees/${treeSha}?recursive=1`,
      );
    } catch (error) {
      if (error.status === 404 && repository.isPrivate) {
        if (await isEmptyPrivateTreeAfterRestNotFound(repository, treeSha, graphqlRequest, owner)) {
          return { ...repository, files: [] };
        }
        throw new Error(
          "GitHub returned 404 while reading an owned private repository tree. Metrics generation stopped to avoid incomplete results; private repository names and API details are omitted from this public workflow log.",
        );
      }
      if (error.status === 404) {
        error.message = `GitHub returned 404 while reading the default-branch tree for public repository ${repository.nameWithOwner} (${branch}): ${error.message}`;
      }
      throw error;
    }

    if (tree.truncated) {
      throw new Error(
        `GitHub returned a truncated tree for repository ${repository.isPrivate ? "a private repository" : repository.nameWithOwner}; cannot calculate accurate file-level language metrics.`,
      );
    }
    return { ...repository, files: tree.tree.filter((entry) => entry.type === "blob" && Number.isFinite(entry.size)) };
  });
  return {
    repositories,
    totals: {
      owned: owned.totalCount,
      forks: 0,
      explicitlyExcluded: 0,
      privateExcluded: privateExcluded.length,
      privateIncluded: includedRepositories.filter((repository) => repository.isPrivate).length,
    },
  };
}

export function buildSnapshot({ repositories, totals }, metricsIgnore, {
  username = resolveProfileUsername(process.env),
  generatedAt = new Date().toISOString(),
  displayLimit = Number.parseInt(process.env.LANGUAGE_DISPLAY_LIMIT || String(DEFAULT_DISPLAYED_LANGUAGE_LIMIT), 10),
} = {}) {
  if (typeof username !== "string" || !username) {
    throw new Error("A configured username is required to build language metrics.");
  }
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

  const limit = Number.isFinite(displayLimit) && displayLimit > 0 ? displayLimit : DEFAULT_DISPLAYED_LANGUAGE_LIMIT;
  const displayedLanguages = sortedLanguages.slice(0, limit);
  const displayedBytes = displayedLanguages.reduce((total, language) => total + language.bytes, 0);

  return {
    username,
    generatedAt,
    source: {
      ownerAffiliations: ["OWNER"],
      includeForks: false,
      metricsIgnoreFile: ".metricsignore",
      privateRepositoriesIncluded: true,
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

export function renderLanguageSvg(snapshot) {
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

export function renderLanguageAssets(snapshot) {
  return {
    "metrics/metrics.languages.json": `${JSON.stringify(snapshot, null, 2)}\n`,
    "metrics/metrics.languages.linguist.svg": stripTrailingWhitespace(renderLanguageSvg(snapshot)),
  };
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
