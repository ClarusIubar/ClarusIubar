/*
File: render-contribution-density.test.mjs
Purpose: Verify contribution snapshot range comparison and freshness rendering.
Primary Responsibility: Exercise deterministic renderer behavior without GitHub GraphQL.
Design Intent: Keep range-change detection testable from small in-memory fixtures.
Non-Goals: End-to-end validation of GitHub authentication or Actions commits.
Dependencies: node:test, node:assert/strict, render-contribution-density.mjs.
*/
import assert from "node:assert/strict";
import test from "node:test";

process.env.CONTRIBUTION_RENDERER_TEST_MODE = "1";
const { compareSnapshots, renderActivitySvg } = await import("./render-contribution-density.mjs");

function snapshot({ total = 100, start = "2026-01-01", end = "2026-12-31", q1 = [1, 25] } = {}) {
  return {
    window: { start, end },
    summary: { totalContributions: total, generatedAt: "2026-08-03T00:00:00.000Z" },
    levels: [
      { key: "FIRST_QUARTILE", label: "Q1", minCount: q1[0], maxCount: q1[1], thresholdLabel: `${q1[0]}-${q1[1]}` },
      { key: "SECOND_QUARTILE", label: "Q2", minCount: 26, maxCount: 50, thresholdLabel: "26-50" },
      { key: "THIRD_QUARTILE", label: "Q3", minCount: 51, maxCount: 75, thresholdLabel: "51-75" },
      { key: "FOURTH_QUARTILE", label: "Q4", minCount: 76, maxCount: 100, thresholdLabel: "76-100" },
    ],
  };
}

test("does not report a change for identical snapshots", () => {
  assert.deepEqual(compareSnapshots(snapshot(), snapshot()), { changed: false, changes: [] });
});

test("reports total, window, and observed density-range changes", () => {
  const result = compareSnapshots(snapshot(), snapshot({ total: 101, end: "2027-01-01", q1: [1, 30] }));
  assert.equal(result.changed, true);
  assert.deepEqual(result.changes, [
    { kind: "totalContributions", before: 100, after: 101 },
    { kind: "window.end", before: "2026-12-31", after: "2027-01-01" },
    { kind: "densityRange", level: "Q1", before: "1-25", after: "1-30" },
  ]);
});

test("renders data-through date and current freshness state", () => {
  const rendered = renderActivitySvg({
    ...snapshot(),
    window: { start: "2026-01-01", end: "2026-08-02" },
    summary: { totalContributions: 100, activeDays: 1, currentMonthContributions: 1, maxDayCount: 1, generatedAt: "2026-08-03T00:00:00.000Z" },
    levels: snapshot().levels.map((level) => ({ ...level, days: 1, share: 0.25 })),
    volumeBuckets: [],
    freshness: { status: "current", dataThrough: "2026-08-02" },
  });
  assert.match(rendered, /data through 2026-08-02 · current/);
});
