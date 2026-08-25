/*
File: render-language-metrics.test.mjs
Purpose: Verify repository language metrics exclude generated build artifacts.
Primary Responsibility: Exercise file-path filtering and source-language aggregation.
Design Intent: Prevent vault plugin bundles and common build outputs from distorting profile metrics.
Non-Goals: Validate GitHub authentication or network retry behavior.
Dependencies: node:test, node:assert/strict, render-language-metrics.mjs.
*/
import assert from "node:assert/strict";
import test from "node:test";

process.env.LANGUAGE_RENDERER_TEST_MODE = "1";
const { buildSnapshot, colorForLanguage, isExcludedArtifactPath, isExcludedRepository, parseMetricsIgnore, parsePrivateExcludedRepositories } = await import("./render-language-metrics.mjs");

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

test("excludes Obsidian installed-plugin bundles and common build directories", () => {
  const ignore = parseMetricsIgnore("path:**/.obsidian*/plugins/**/main.js\npath:**/.obsidian*/plugins/**/styles.css\npath:**/dist/**\npath:**/node_modules/**\n");
  assert.equal(isExcludedArtifactPath(".obsidian_Mac/plugins/dataview/main.js", ignore), true);
  assert.equal(isExcludedArtifactPath(".obsidian/plugins/calendar/styles.css", ignore), true);
  assert.equal(isExcludedArtifactPath("web/dist/app.js", ignore), true);
  assert.equal(isExcludedArtifactPath("packages/app/node_modules/react/index.js", ignore), true);
  assert.equal(isExcludedArtifactPath("src/main.ts", ignore), false);
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
  assert.equal(snapshot.source.privateExclusionSecretConfigured, false);
});
