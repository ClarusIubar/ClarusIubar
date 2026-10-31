/*
File: render-language-metrics.test.mjs
Purpose: Verify repository tree fallback, artifact filtering, and language aggregation.
Primary Responsibility: Exercise private empty-tree handling, file-path filtering, and source-language totals.
Design Intent: Keep an empty private repository from suppressing complete metrics while excluding generated artifacts.
Non-Goals: Validate GitHub authentication or live service availability.
Dependencies: node:test, node:assert/strict, render-language-metrics.mjs.
*/
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env.LANGUAGE_RENDERER_TEST_MODE = "1";
process.env.PROFILE_USERNAME ??= "ClarusIubar";
const {
  buildSnapshot,
  colorForLanguage,
  fetchRepositories,
  isEmptyPrivateTreeAfterRestNotFound,
  isExcludedArtifactPath,
  isExcludedRepository,
  parseMetricsIgnore,
  parsePrivateExcludedRepositories,
} = await import("./render-language-metrics.mjs");

const metricsIgnore = parseMetricsIgnore("repo:obsidian\npath:**/dist/**\npath:**/*.min.js\n");

test("accepts only bare repository names and file-path rules from .metricsignore", () => {
  assert.equal(isExcludedRepository({ name: "obsidian", nameWithOwner: "ClarusIubar/obsidian", isPrivate: false }, metricsIgnore), true);
  assert.equal(isExcludedRepository({ name: "source", nameWithOwner: "ClarusIubar/source", isPrivate: false }, metricsIgnore), false);
  assert.throws(() => parseMetricsIgnore("repo:ClarusIubar/private-repo"), /bare repository name/);
});

test("includes private repositories unless a private exclusion secret matches", () => {
  const privateExcluded = parsePrivateExcludedRepositories("secret");
  const privateRepository = { name: "secret", nameWithOwner: "ClarusIubar/secret", isPrivate: true, isFork: false };
  assert.equal(isExcludedRepository(privateRepository, metricsIgnore, privateExcluded), true);
  assert.equal(isExcludedRepository({ ...privateRepository, name: "included", nameWithOwner: "ClarusIubar/included" }, metricsIgnore, privateExcluded), false);
  assert.equal(isExcludedRepository({ ...privateRepository, name: "obsidian", nameWithOwner: "ClarusIubar/obsidian" }, metricsIgnore), false);
  assert.equal(isExcludedRepository({ name: "fork", isFork: true, isPrivate: false }, metricsIgnore), true);
  assert.throws(() => parsePrivateExcludedRepositories("ClarusIubar/private-repo"), /invalid repository name/);
});

test("filters secret-excluded private repositories before fetching trees and reports the exclusion count", async () => {
  const repositories = [
    {
      name: "obsidian",
      nameWithOwner: "ClarusIubar/obsidian",
      isPrivate: true,
      isFork: false,
      defaultBranchRef: { name: "main", target: { tree: { oid: "obsidian-tree" } } },
    },
    {
      name: "private-app",
      nameWithOwner: "ClarusIubar/private-app",
      isPrivate: true,
      isFork: false,
      defaultBranchRef: { name: "main", target: { tree: { oid: "private-tree" } } },
    },
    {
      name: "public-app",
      nameWithOwner: "ClarusIubar/public-app",
      isPrivate: false,
      isFork: false,
      defaultBranchRef: { name: "main", target: { tree: { oid: "public-tree" } } },
    },
  ];
  const requestedTrees = [];
  const source = await fetchRepositories(
    parseMetricsIgnore(""),
    parsePrivateExcludedRepositories("OBSIDIAN"),
    {
      fetchOwnedRepositories: async () => ({ repositories, totalCount: repositories.length }),
      fetchTree: async (url) => {
        requestedTrees.push(url);
        const size = url.includes("private-tree") ? 200 : 100;
        return { truncated: false, tree: [{ type: "blob", path: "src/main.ts", size }] };
      },
    },
  );

  assert.equal(requestedTrees.length, 2);
  assert.equal(requestedTrees.some((url) => url.includes("obsidian-tree")), false);
  assert.deepEqual(source.repositories.map(({ name }) => name), ["private-app", "public-app"]);
  assert.equal(source.totals.privateExcluded, 1);
  assert.equal(source.totals.privateIncluded, 1);

  const snapshot = buildSnapshot(source, parseMetricsIgnore(""));
  assert.equal(snapshot.summary.ownedRepositories, 3);
  assert.equal(snapshot.summary.totalRepositories, 2);
  assert.equal(snapshot.summary.privateRepositoriesExcluded, 1);
  assert.equal(snapshot.summary.privateRepositoriesIncluded, 1);
  assert.equal(snapshot.summary.totalLanguageBytes, 300);
});

test("accepts a private empty tree only after GraphQL confirms the exact tree object", async () => {
  const repository = { nameWithOwner: "ClarusIubar/private-empty", isPrivate: true };
  let capturedRequest;
  const isEmpty = await isEmptyPrivateTreeAfterRestNotFound(repository, "root-tree-sha", async (query, variables) => {
    capturedRequest = { query, variables };
    return { repository: { object: { __typename: "Tree", entries: [] } } };
  });

  assert.equal(isEmpty, true);
  assert.match(capturedRequest.query, /object\(oid: \$oid\)/);
  assert.deepEqual(capturedRequest.variables, { owner: "ClarusIubar", name: "private-empty", oid: "root-tree-sha" });
});

test("keeps nonempty and invalid private trees fail-closed and propagates lookup errors", async () => {
  const repository = { nameWithOwner: "ClarusIubar/private-repository", isPrivate: true };
  const nonempty = await isEmptyPrivateTreeAfterRestNotFound(repository, "root-tree-sha", async () => ({
    repository: { object: { __typename: "Tree", entries: [{ name: "tracked-file.md" }] } },
  }));
  const invalidTree = await isEmptyPrivateTreeAfterRestNotFound(repository, "root-tree-sha", async () => ({
    repository: { object: { __typename: "Blob", entries: [] } },
  }));
  const publicRepository = await isEmptyPrivateTreeAfterRestNotFound(
    { ...repository, isPrivate: false },
    "root-tree-sha",
    async () => ({ repository: { object: { __typename: "Tree", entries: [] } } }),
  );

  assert.equal(nonempty, false);
  assert.equal(invalidTree, false);
  await assert.rejects(
    isEmptyPrivateTreeAfterRestNotFound(repository, "root-tree-sha", async () => {
      throw new Error("synthetic lookup failure");
    }),
    /synthetic lookup failure/,
  );
  assert.equal(publicRepository, false);
});

test("propagates GraphQL failures while verifying an empty private tree", async () => {
  const transientError = Object.assign(new Error("synthetic temporary lookup failure"), { transient: true });
  await assert.rejects(
    isEmptyPrivateTreeAfterRestNotFound(
      { nameWithOwner: "ClarusIubar/private-repository", isPrivate: true },
      "root-tree-sha",
      async () => {
        throw transientError;
      },
    ),
    (error) => error === transientError,
  );
});

test("excludes Obsidian installed-plugin bundles and common build directories", () => {
  const ignore = parseMetricsIgnore("path:**/.obsidian*/plugins/**/main.js\npath:**/.obsidian*/plugins/**/styles.css\npath:**/dist/**\npath:**/node_modules/**\n");
  assert.equal(isExcludedArtifactPath(".obsidian_Mac/plugins/dataview/main.js", ignore), true);
  assert.equal(isExcludedArtifactPath(".obsidian/plugins/calendar/styles.css", ignore), true);
  assert.equal(isExcludedArtifactPath("web/dist/app.js", ignore), true);
  assert.equal(isExcludedArtifactPath("packages/app/node_modules/react/index.js", ignore), true);
  assert.equal(isExcludedArtifactPath("src/main.ts", ignore), false);
});

test("excludes SVG image assets from source-language totals", () => {
  const snapshot = buildSnapshot({
    repositories: [{
      files: [
        { path: "assets/logo.svg", size: 2_000 },
        { path: "src/main.ts", size: 100 },
      ],
    }],
    totals: { owned: 1, forks: 0, explicitlyExcluded: 0, privateExcluded: 0, privateIncluded: 0 },
  }, parseMetricsIgnore("path:**/*.svg\n"));

  assert.equal(snapshot.summary.totalLanguageBytes, 100);
  assert.equal(snapshot.summary.excludedArtifactBytes, 2_000);
  assert.deepEqual(snapshot.languages.map(({ name, bytes }) => ({ name, bytes })), [{ name: "TypeScript", bytes: 100 }]);
});

test("configures SVG files as excluded language assets", async () => {
  const configuredIgnore = parseMetricsIgnore(await readFile(new URL("../.metricsignore", import.meta.url), "utf8"));
  assert.equal(isExcludedArtifactPath("assets/logo.svg", configuredIgnore), true);
});

test("uses the complete GitHub Linguist color catalog instead of a local language whitelist", () => {
  const snapshot = buildSnapshot({
    repositories: [{
      files: [
        { path: "assets/logo.svg", size: 30 },
        { path: "lib/main.dart", size: 20 },
        { path: "db/schema.sql", size: 10 },
      ],
    }],
    totals: { owned: 1, forks: 0, explicitlyExcluded: 0, privateExcluded: 0, privateIncluded: 0 },
  }, parseMetricsIgnore(""));

  assert.deepEqual(
    snapshot.languages.map(({ name, color }) => ({ name, color })),
    [
      { name: "SVG", color: "#ff9900" },
      { name: "Dart", color: "#00B4AB" },
      { name: "SQL", color: "#e38c00" },
    ],
  );
  assert.equal(snapshot.source.languageColorSource, "GitHub Linguist languages.yml snapshot");
});

test("uses a neutral color only when a language is absent from GitHub Linguist", () => {
  assert.equal(colorForLanguage("Uncatalogued Language"), "#8b949e");
});

test("counts source files but omits generated plugin bundles", () => {
  const snapshot = buildSnapshot({
    repositories: [{
      nameWithOwner: "ClarusIubar/obsidian",
      files: [
        { path: "notes/readme.md", size: 400 },
        { path: ".obsidian_Mac/plugins/dataview/main.js", size: 1_302_069 },
        { path: ".obsidian_Mac/plugins/dataview/styles.css", size: 2_965 },
        { path: "scripts/clean.js", size: 120 },
      ],
    }],
    totals: { owned: 1, forks: 0, explicitlyExcluded: 0, privateExcluded: 0, privateIncluded: 0 },
  }, parseMetricsIgnore("path:**/.obsidian*/plugins/**/main.js\npath:**/.obsidian*/plugins/**/styles.css\n"));

  assert.equal(snapshot.summary.totalLanguageBytes, 120);
  assert.equal(snapshot.summary.excludedArtifactBytes, 1_305_034);
  assert.equal(snapshot.summary.excludedArtifactFiles, 2);
  assert.deepEqual(snapshot.languages.map(({ name, bytes }) => ({ name, bytes })), [{ name: "JavaScript", bytes: 120 }]);
  assert.equal("excludedRepositories" in snapshot.source, false);
  assert.equal(snapshot.source.privateRepositoriesIncluded, true);
});
