/*
File: render-contribution-density.test.mjs
Purpose: Verify GitHub level/color synchronization and freshness rendering.
Primary Responsibility: Exercise deterministic renderer behavior without GitHub GraphQL.
Design Intent: Keep palette and relative-level change detection testable with fixtures.
Non-Goals: End-to-end validation of GitHub authentication or Actions commits.
Dependencies: node:test, node:assert/strict, render-contribution-density.mjs.
*/
import assert from "node:assert/strict";
import test from "node:test";

process.env.CONTRIBUTION_RENDERER_TEST_MODE = "1";
const { compareSnapshots, createAssetSnapshots, renderActivitySvg } = await import("./render-contribution-density.mjs");

function snapshot({ total = 100, apiColors = ["#9be9a8", "#40c463", "#30a14e", "#216e39"], fingerprint = "same", q1GithubColor = "#9be9a8" } = {}) {
  return {
    window: { start: "2026-01-01", end: "2026-12-31" },
    summary: { totalContributions: total, generatedAt: "2026-08-03T00:00:00.000Z" },
    calendar: { apiColors, displayColors: ["#0e4429", "#006d32", "#26a641", "#39d353"], isHalloween: false, levelAssignmentFingerprint: fingerprint },
    levels: [
      { key: "FIRST_QUARTILE", label: "Q1", days: 25, share: 0.25, color: "#0e4429", githubColor: q1GithubColor },
      { key: "SECOND_QUARTILE", label: "Q2", days: 25, share: 0.25, color: "#006d32", githubColor: "#40c463" },
      { key: "THIRD_QUARTILE", label: "Q3", days: 25, share: 0.25, color: "#26a641", githubColor: "#30a14e" },
      { key: "FOURTH_QUARTILE", label: "Q4", days: 25, share: 0.25, color: "#39d353", githubColor: "#216e39" },
    ],
  };
}

test("does not report a change for identical GitHub snapshots", () => {
  assert.deepEqual(compareSnapshots(snapshot(), snapshot()), { changed: false, changes: [] });
});

test("detects GitHub palette and level/color assignment changes", () => {
  const result = compareSnapshots(snapshot(), snapshot({ apiColors: ["#000000"], fingerprint: "changed", q1GithubColor: "#ff0000" }));
  assert.equal(result.changed, true);
  assert.equal(result.changes.some((change) => change.kind === "calendarPalette"), true);
  assert.equal(result.changes.some((change) => change.kind === "levelAssignments"), true);
  assert.deepEqual(result.changes.find((change) => change.kind === "densityLevel"), {
    kind: "densityLevel",
    level: "Q1",
    before: { days: 25, githubColor: "#9be9a8" },
    after: { days: 25, githubColor: "#ff0000" },
  });
});

test("renders the dark grass palette without numeric ranges", () => {
  const rendered = renderActivitySvg({
    ...snapshot(),
    summary: { totalContributions: 100, activeDays: 1, currentMonthContributions: 1, maxDayCount: 1, generatedAt: "2026-08-03T00:00:00.000Z" },
    volumeBuckets: [],
    freshness: { status: "current", dataThrough: "2026-08-02" },
  });
  assert.match(rendered, /fill="#0e4429"/);
  assert.match(rendered, /fill="#39d353"/);
  assert.doesNotMatch(rendered, />1-25</);
  assert.match(rendered, /data through 2026-08-02 \| current/);
});

test("persists the same freshness and GitHub calendar metadata in every JSON asset", () => {
  const source = {
    ...snapshot(),
    username: "ClarusIubar",
    volumeBuckets: [],
    freshness: { status: "current", dataThrough: "2026-08-02", comparison: { changed: false, changes: [] } },
  };
  const assets = createAssetSnapshots(source);
  assert.deepEqual(assets.densitySnapshot.calendar, source.calendar);
  assert.deepEqual(assets.volumeSnapshot.calendar, source.calendar);
  assert.deepEqual(assets.activitySnapshot.calendar, source.calendar);
  assert.deepEqual(assets.volumeSnapshot.freshness, source.freshness);
  assert.deepEqual(assets.activitySnapshot.freshness, source.freshness);
});
