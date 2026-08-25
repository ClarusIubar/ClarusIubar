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
const { buildSnapshot, isExcludedArtifactPath, isExcludedRepository, parseMetricsIgnore } = await import("./render-language-metrics.mjs");

const metricsIgnore = parseMetricsIgnore("repo:obsidian\npath:**/dist/**\npath:**/*.min.js\n");

test("accepts only bare repository names and file-path rules from .metricsignore", () => {
  assert.equal(isExcludedRepository({ name: "obsidian", nameWithOwner: "ClarusIubar/obsidian", isPrivate: false }, metricsIgnore), true);
  assert.equal(isExcludedRepository({ name: "source", nameWithOwner: "ClarusIubar/source", isPrivate: false }, metricsIgnore), false);
  assert.throws(() => parseMetricsIgnore("repo:ClarusIubar/private-repo"), /bare repository name/);
});

test("always excludes private repositories without retaining their names", () => {
  assert.equal(isExcludedRepository({ name: "secret", nameWithOwner: "ClarusIubar/secret", isPrivate: true }, metricsIgnore), true);
});

test("excludes Obsidian installed-plugin bundles and common build directories", () => {
  const ignore = parseMetricsIgnore("path:**/.obsidian*/plugins/**/main.js\npath:**/.obsidian*/plugins/**/styles.css\npath:**/dist/**\npath:**/node_modules/**\n");
  assert.equal(isExcludedArtifactPath(".obsidian_Mac/plugins/dataview/main.js", ignore), true);
  assert.equal(isExcludedArtifactPath(".obsidian/plugins/calendar/styles.css", ignore), true);
  assert.equal(isExcludedArtifactPath("web/dist/app.js", ignore), true);
  assert.equal(isExcludedArtifactPath("packages/app/node_modules/react/index.js", ignore), true);
  assert.equal(isExcludedArtifactPath("src/main.ts", ignore), false);
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
    totals: { owned: 1, forks: 0, explicitlyExcluded: 0, privateExcluded: 0 },
  }, parseMetricsIgnore("path:**/.obsidian*/plugins/**/main.js\npath:**/.obsidian*/plugins/**/styles.css\n"));

  assert.equal(snapshot.summary.totalLanguageBytes, 120);
  assert.equal(snapshot.summary.excludedArtifactBytes, 1_305_034);
  assert.equal(snapshot.summary.excludedArtifactFiles, 2);
  assert.deepEqual(snapshot.languages.map(({ name, bytes }) => ({ name, bytes })), [{ name: "JavaScript", bytes: 120 }]);
  assert.equal("excludedRepositories" in snapshot.source, false);
});
