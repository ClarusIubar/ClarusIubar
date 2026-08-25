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
const { buildSnapshot, isExcludedArtifactPath, isExcludedRepository, parseExcludedRepositories } = await import("./render-language-metrics.mjs");

test("accepts repository exclusions by short or owner-qualified name", () => {
  const excluded = parseExcludedRepositories("obsidian, ClarusIubar/archive");
  assert.equal(isExcludedRepository({ name: "obsidian", nameWithOwner: "ClarusIubar/obsidian" }, excluded), true);
  assert.equal(isExcludedRepository({ name: "archive", nameWithOwner: "ClarusIubar/archive" }, excluded), true);
  assert.equal(isExcludedRepository({ name: "source", nameWithOwner: "ClarusIubar/source" }, excluded), false);
});

test("excludes Obsidian installed-plugin bundles and common build directories", () => {
  assert.equal(isExcludedArtifactPath(".obsidian_Mac/plugins/dataview/main.js"), true);
  assert.equal(isExcludedArtifactPath(".obsidian/plugins/calendar/styles.css"), true);
  assert.equal(isExcludedArtifactPath("web/dist/app.js"), true);
  assert.equal(isExcludedArtifactPath("packages/app/node_modules/react/index.js"), true);
  assert.equal(isExcludedArtifactPath("src/main.ts"), false);
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
    totals: { owned: 1, forks: 0 },
  });

  assert.equal(snapshot.summary.totalLanguageBytes, 120);
  assert.equal(snapshot.summary.excludedArtifactBytes, 1_305_034);
  assert.equal(snapshot.summary.excludedArtifactFiles, 2);
  assert.deepEqual(snapshot.languages.map(({ name, bytes }) => ({ name, bytes })), [{ name: "JavaScript", bytes: 120 }]);
});
