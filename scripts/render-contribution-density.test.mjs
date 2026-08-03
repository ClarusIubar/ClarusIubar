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

function snapshot({ total = 100, colors = ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"], fingerprint = "same", q1Color = "#9be9a8" } = {}) {
  return {
    window: { start: "2026-01-01", end: "2026-12-31" },
    summary: { totalContributions: total, generatedAt: "2026-08-03T00:00:00.000Z" },
    calendar: { colors, isHalloween: false, levelAssignmentFingerprint: fingerprint },
    levels: [
      { key: "FIRST_QUARTILE", label: "Q1", days: 25, share: 0.25, color: q1Color },
      { key: "SECOND_QUARTILE", label: "Q2", days: 25, share: 0.25, color: "#40c463" },
      { key: "THIRD_QUARTILE", label: "Q3", days: 25, share: 0.25, color: "#30a14e" },
      { key: "FOURTH_QUARTILE", label: "Q4", days: 25, share: 0.25, color: "#216e39" },
    ],
  };
}

test("does not report a change for identical GitHub snapshots", () => {
  assert.deepEqual(compareSnapshots(snapshot(), snapshot()), { changed: false, changes: [] });
});

test("detects GitHub palette and level/color assignment changes", () => {
  const result = compareSnapshots(snapshot(), snapshot({ colors: ["#000000"], fingerprint: "changed", q1Color: "#ff0000" }));
  assert.equal(result.changed, true);
  assert.equal(result.changes.some((change) => change.kind === "calendarPalette"), true);
  assert.equal(result.changes.some((change) => change.kind === "levelAssignments"), true);
  assert.deepEqual(result.changes.find((change) => change.kind === "densityLevel"), {
    kind: "densityLevel",
    level: "Q1",
    before: { days: 25, color: "#9be9a8" },
    after: { days: 25, color: "#ff0000" },
  });
});

test("renders GitHub-returned density colors without numeric ranges", () => {
  const rendered = renderActivitySvg({
    ...snapshot({ q1Color: "#ff0000" }),
    summary: { totalContributions: 100, activeDays: 1, currentMonthContributions: 1, maxDayCount: 1, generatedAt: "2026-08-03T00:00:00.000Z" },
    volumeBuckets: [],
    freshness: { status: "current", dataThrough: "2026-08-02" },
  });
  assert.match(rendered, /fill="#ff0000"/);
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
