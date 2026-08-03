import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

const OWNER = process.env.PROFILE_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || "ClarusIubar";
const TOKEN =
  process.env.METRICS_TOKEN ||
  process.env.METRICS_RUNTIME_TOKEN ||
  process.env.GITHUB_TOKEN ||
  "";

if (!TOKEN && !process.env.CONTRIBUTION_RENDERER_TEST_MODE) {
  throw new Error("Missing GitHub token. Set METRICS_TOKEN, METRICS_RUNTIME_TOKEN, or GITHUB_TOKEN.");
}

const outputDir = path.resolve(process.cwd(), "metrics");
const densityJsonPath = path.join(outputDir, "contribution-density.json");
const densitySvgPath = path.join(outputDir, "contribution-density.svg");
const volumeJsonPath = path.join(outputDir, "contribution-volume.json");
const volumeSvgPath = path.join(outputDir, "contribution-volume.svg");
const activityJsonPath = path.join(outputDir, "contribution-activity.json");
const activitySvgPath = path.join(outputDir, "contribution-activity.svg");
const graphqlMaxAttempts = Number.parseInt(process.env.CONTRIBUTION_GRAPHQL_MAX_ATTEMPTS || "4", 10);
const graphqlRetryBaseDelayMs = Number.parseInt(process.env.CONTRIBUTION_GRAPHQL_RETRY_BASE_DELAY_MS || "1500", 10);

const LEVELS = [
  { key: "FIRST_QUARTILE", label: "Q1", color: "#0e4429" },
  { key: "SECOND_QUARTILE", label: "Q2", color: "#006d32" },
  { key: "THIRD_QUARTILE", label: "Q3", color: "#26a641" },
  { key: "FOURTH_QUARTILE", label: "Q4", color: "#39d353" },
];

const VOLUME_BUCKETS = [
  { key: "COUNT_1_50", label: "1-50", rangeLabel: "1-50", min: 1, max: 50, color: "#0a3069" },
  { key: "COUNT_51_100", label: "51-100", rangeLabel: "51-100", min: 51, max: 100, color: "#0969da" },
  { key: "COUNT_101_150", label: "101-150", rangeLabel: "101-150", min: 101, max: 150, color: "#54aeff" },
  { key: "COUNT_151_PLUS", label: "150+", rangeLabel: "150+", min: 151, max: null, color: "#b6e3ff" },
];

const query = `
query ($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        colors
        isHalloween
        weeks {
          contributionDays {
            date
            color
            contributionCount
            contributionLevel
            weekday
          }
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

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatRange(minCount, maxCount) {
  if (minCount == null || maxCount == null) {
    return "-";
  }
  if (minCount === maxCount) {
    return `${minCount}`;
  }
  return `${minCount}-${maxCount}`;
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
    normalized.includes("resource_limits_exceeded") ||
    normalized.includes("resource limits for this query exceeded") ||
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

export function createLevelSnapshot(days, totalDays, activeDays) {
  const levels = LEVELS.map((level) => {
    const matching = days.filter((day) => day.contributionLevel === level.key);

    return {
      key: level.key,
      label: level.label,
      days: matching.length,
      share: activeDays === 0 ? 0 : matching.length / activeDays,
      shareOfYear: totalDays === 0 ? 0 : matching.length / totalDays,
      color: matching[0]?.color ?? level.color,
    };
  });

  return levels;
}

function createVolumeSnapshot(days, totalDays, activeDays) {
  return VOLUME_BUCKETS.map((bucket) => {
    const matching = days.filter((day) => {
      if (day.contributionCount < bucket.min) {
        return false;
      }
      return bucket.max == null || day.contributionCount <= bucket.max;
    });
    const counts = matching.map((day) => day.contributionCount);
    const minCount = counts.length > 0 ? Math.min(...counts) : null;
    const maxCount = counts.length > 0 ? Math.max(...counts) : null;

    return {
      key: bucket.key,
      label: bucket.label,
      days: matching.length,
      share: activeDays === 0 ? 0 : matching.length / activeDays,
      shareOfYear: totalDays === 0 ? 0 : matching.length / totalDays,
      minCount,
      maxCount,
      rangeLabel: bucket.rangeLabel,
      color: bucket.color,
    };
  });
}

export function buildSnapshot(calendar) {
  const days = calendar.weeks.flatMap((week) => week.contributionDays);
  const totalDays = days.length;
  const activeDays = days.filter((day) => day.contributionCount > 0).length;
  const maxDayCount = days.reduce((max, day) => Math.max(max, day.contributionCount), 0);
  const start = days[0]?.date ?? null;
  const end = days.at(-1)?.date ?? null;
  const currentMonth = end?.slice(0, 7) ?? "";
  const currentMonthDays = currentMonth ? days.filter((day) => day.date.startsWith(currentMonth)) : [];
  const currentMonthContributions = currentMonthDays.reduce((total, day) => total + day.contributionCount, 0);
  const currentMonthActiveDays = currentMonthDays.filter((day) => day.contributionCount > 0).length;
  const levels = createLevelSnapshot(days, totalDays, activeDays);
  const volumeBuckets = createVolumeSnapshot(days, totalDays, activeDays).map(({ color, ...bucket }) => bucket);
  const levelAssignmentFingerprint = createHash("sha256")
    .update(days.map((day) => `${day.date}:${day.contributionLevel}:${day.color}`).join("\n"))
    .digest("hex");

  return {
    username: OWNER,
    window: {
      start,
      end,
      totalDays,
    },
    summary: {
      totalContributions: calendar.totalContributions,
      activeDays,
      maxDayCount,
      currentMonth,
      currentMonthContributions,
      currentMonthActiveDays,
      generatedAt: new Date().toISOString(),
    },
    calendar: {
      colors: calendar.colors,
      isHalloween: calendar.isHalloween,
      levelAssignmentFingerprint,
    },
    levels,
    volumeBuckets,
  };
}

/**
 * Compares GitHub-provided palette and relative-level assignments between runs.
 * Numeric contribution counts are deliberately not converted into a made-up
 * threshold table because the GraphQL API exposes relative levels, not bounds.
 */
export function compareSnapshots(previous, current) {
  if (!previous) {
    return { changed: true, changes: [{ kind: "initial", message: "No previous snapshot available." }] };
  }

  const changes = [];
  if (previous.summary?.totalContributions !== current.summary.totalContributions) {
    changes.push({
      kind: "totalContributions",
      before: previous.summary?.totalContributions ?? null,
      after: current.summary.totalContributions,
    });
  }
  for (const key of ["start", "end"]) {
    if (previous.window?.[key] !== current.window[key]) {
      changes.push({ kind: `window.${key}`, before: previous.window?.[key] ?? null, after: current.window[key] });
    }
  }
  if (JSON.stringify(previous.calendar?.colors ?? null) !== JSON.stringify(current.calendar.colors)) {
    changes.push({ kind: "calendarPalette", before: previous.calendar?.colors ?? null, after: current.calendar.colors });
  }
  if (previous.calendar?.levelAssignmentFingerprint !== current.calendar.levelAssignmentFingerprint) {
    changes.push({ kind: "levelAssignments", before: previous.calendar?.levelAssignmentFingerprint ?? null, after: current.calendar.levelAssignmentFingerprint });
  }
  const previousLevels = previous.levels ?? previous.density ?? [];
  for (const level of current.levels) {
    const prior = previousLevels.find((candidate) => candidate.key === level.key);
    if (prior?.days !== level.days || prior?.color !== level.color) {
      changes.push({
        kind: "densityLevel",
        level: level.label,
        before: prior ? { days: prior.days, color: prior.color ?? null } : null,
        after: { days: level.days, color: level.color },
      });
    }
  }
  return { changed: changes.length > 0, changes };
}

async function readPreviousActivitySnapshot() {
  try {
    return JSON.parse(await readFile(activityJsonPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new Error(`Could not read previous contribution snapshot: ${error.message}`);
  }
}

function formatChange(change) {
  if (change.kind === "densityLevel") {
    return `${change.level}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`;
  }
  if (change.kind === "calendarPalette") {
    return `GitHub palette: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`;
  }
  if (change.kind === "levelAssignments") {
    return "GitHub day-level or color assignments changed.";
  }
  if (change.kind === "initial") {
    return change.message;
  }
  return `${change.kind}: ${change.before ?? "none"} -> ${change.after}`;
}

async function writeActionsSummary(title, lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  await appendFile(summaryPath, `## ${title}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`, "utf8");
}

function renderMetricCard({ snapshot, title, desc, rows, paletteByKey }) {
  const width = 720;
  const height = 270;
  const rowStartY = 116;
  const rowHeight = 28;

  const renderedRows = rows
    .map((row, index) => {
      const palette = paletteByKey.get(row.key);
      const y = rowStartY + index * rowHeight;
      const barWidth = Math.max(2, Math.round(row.share * 260));
      const rangeText = row.rangeLabel || row.minCount == null ? "" : formatRange(row.minCount, row.maxCount);

      return `
        <rect x="36" y="${y - 14}" width="648" height="22" rx="8" fill="#0d1117" />
        <circle cx="54" cy="${y}" r="6" fill="${palette.color}" />
        <text x="72" y="${y + 4}" class="label">${escapeXml(row.label)}</text>
        <text x="205" y="${y + 4}" class="value">${escapeXml(String(row.days))} days</text>
        <text x="320" y="${y + 4}" class="muted">${escapeXml(formatPercent(row.share))}</text>
        <rect x="398" y="${y - 7}" width="260" height="12" rx="6" fill="#21262d" />
        <rect x="398" y="${y - 7}" width="${barWidth}" height="12" rx="6" fill="${palette.color}" />
        ${rangeText ? `<text x="670" y="${y + 4}" text-anchor="end" class="muted">${escapeXml(rangeText)}</text>` : ""}
      `;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(desc)}</desc>
  <style>
    .bg { fill: #0d1117; }
    .card { fill: #161b22; stroke: #30363d; stroke-width: 1; }
    .title { fill: #e6edf3; font: 700 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .subtitle { fill: #9da7b3; font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .label { fill: #e6edf3; font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .value { fill: #e6edf3; font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .muted { fill: #8b949e; font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .summary { fill: #e6edf3; font: 600 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .summary-label { fill: #8b949e; font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  </style>
  <rect class="bg" width="${width}" height="${height}" rx="18" />
  <rect class="card" x="12" y="12" width="${width - 24}" height="${height - 24}" rx="16" />

  <text x="36" y="48" class="title">${escapeXml(title)}</text>
  <text x="36" y="72" class="subtitle">${escapeXml(snapshot.window.start)} to ${escapeXml(snapshot.window.end)} - Last 1 year</text>

  <text x="36" y="100" class="summary">${escapeXml(String(snapshot.summary.totalContributions))}</text>
  <text x="88" y="100" class="summary-label">total contributions</text>
  <text x="260" y="100" class="summary">${escapeXml(`${snapshot.summary.activeDays}/${snapshot.window.totalDays}`)}</text>
  <text x="348" y="100" class="summary-label">active days</text>
  <text x="420" y="100" class="summary">${escapeXml(String(snapshot.summary.maxDayCount))}</text>
  <text x="458" y="100" class="summary-label">max/day</text>
  <text x="684" y="100" text-anchor="end" class="summary-label">generated ${escapeXml(snapshot.summary.generatedAt.slice(0, 10))}</text>

  ${renderedRows}
</svg>`;
}

function renderDensitySvg(snapshot) {
  return renderMetricCard({
    snapshot,
    title: "Contribution Density",
    desc: "GitHub-provided contribution levels and colors for active days during the last year.",
    rows: snapshot.levels,
    paletteByKey: new Map(snapshot.levels.map((level) => [level.key, level])),
  });
}

function renderVolumeSvg(snapshot) {
  return renderMetricCard({
    snapshot,
    title: "Contribution Volume",
    desc: "GitHub contribution volume by absolute daily contribution count for active days.",
    rows: snapshot.volumeBuckets,
    paletteByKey: new Map(VOLUME_BUCKETS.map((bucket) => [bucket.key, bucket])),
  });
}

function renderActivityPanel({ title, subtitle, rows, paletteByKey, x, y, width }) {
  const rowHeight = 29;
  const defaultBarX = x + 230;
  const defaultBarWidth = width - 300;
  const rangeX = x + width - 18;
  const percentX = x + 166;

  const renderedRows = rows
    .map((row, index) => {
      const palette = paletteByKey.get(row.key);
      const rowY = y + 68 + index * rowHeight;
      const rangeText = row.rangeLabel || row.minCount == null ? "" : formatRange(row.minCount, row.maxCount);
      const hasThreshold = false;
      const daysX = hasThreshold ? x + 132 : x + 111;
      const rowPercentX = hasThreshold ? x + 178 : percentX;
      const barX = hasThreshold ? x + 240 : defaultBarX;
      const barWidth = hasThreshold ? width - 310 : defaultBarWidth;
      const fillWidth = Math.max(3, Math.round(row.share * barWidth));

      return `
        <rect x="${x + 16}" y="${rowY - 15}" width="${width - 32}" height="22" rx="6" fill="#0d1117" />
        <circle cx="${x + 31}" cy="${rowY - 4}" r="5.5" fill="${palette.color}" />
        <text x="${x + 48}" y="${rowY}" class="row-label">${escapeXml(row.label)}</text>
        ${hasThreshold ? `<text x="${x + 74}" y="${rowY}" class="row-threshold">${escapeXml(row.thresholdLabel)}</text>` : ""}
        <text x="${daysX}" y="${rowY}" class="row-value">${escapeXml(String(row.days))}d</text>
        <text x="${rowPercentX}" y="${rowY}" class="row-muted">${escapeXml(formatPercent(row.share))}</text>
        <rect x="${barX}" y="${rowY - 10}" width="${barWidth}" height="10" rx="5" fill="#21262d" />
        <rect x="${barX}" y="${rowY - 10}" width="${fillWidth}" height="10" rx="5" fill="${palette.color}" />
        ${rangeText ? `<text x="${rangeX}" y="${rowY}" text-anchor="end" class="row-muted">${escapeXml(rangeText)}</text>` : ""}
      `;
    })
    .join("");

  return `
    <g>
      <rect x="${x}" y="${y}" width="${width}" height="164" rx="12" fill="#0d1117" stroke="#21262d" />
      <text x="${x + 16}" y="${y + 28}" class="panel-title">${escapeXml(title)}</text>
      <text x="${x + 16}" y="${y + 48}" class="panel-subtitle">${escapeXml(subtitle)}</text>
      ${renderedRows}
    </g>
  `;
}

function renderActivityStat({ x, label, value, accent = "#79c0ff" }) {
  return `
    <g>
      <rect x="${x}" y="92" width="172" height="52" rx="12" fill="#0d1117" stroke="#21262d" />
      <rect x="${x}" y="92" width="4" height="52" rx="2" fill="${accent}" />
      <text x="${x + 18}" y="116" class="stat-value">${escapeXml(value)}</text>
      <text x="${x + 18}" y="134" class="stat-label">${escapeXml(label)}</text>
    </g>
  `;
}

export function renderActivitySvg(snapshot) {
  const width = 900;
  const height = 420;
  const generatedDate = snapshot.summary.generatedAt.slice(0, 10);
  const dataThrough = snapshot.freshness?.dataThrough ?? snapshot.window.end;
  const freshnessStatus = snapshot.freshness?.status ?? "current";
  const densityPalette = new Map(snapshot.levels.map((level) => [level.key, level]));
  const volumePalette = new Map(VOLUME_BUCKETS.map((bucket) => [bucket.key, bucket]));
  const densityPanel = renderActivityPanel({
    title: "Density",
    subtitle: "GitHub relative levels and colors, active days only",
    rows: snapshot.levels,
    paletteByKey: densityPalette,
    x: 34,
    y: 178,
    width: 398,
  });
  const volumePanel = renderActivityPanel({
    title: "Volume",
    subtitle: "Absolute contribution count per active day",
    rows: snapshot.volumeBuckets,
    paletteByKey: volumePalette,
    x: 468,
    y: 178,
    width: 398,
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Contribution Activity</title>
  <desc id="desc">GitHub-provided contribution levels and colors with absolute contribution volume for active days during the last year.</desc>
  <style>
    .bg { fill: #0d1117; }
    .card { fill: #161b22; stroke: #30363d; stroke-width: 1; }
    .divider { stroke: #30363d; stroke-width: 1; }
    .eyebrow { fill: #79c0ff; font: 700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0; }
    .title { fill: #f0f6fc; font: 800 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .subtitle { fill: #9da7b3; font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .stat-value { fill: #f0f6fc; font: 800 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .stat-label { fill: #8b949e; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .panel-title { fill: #f0f6fc; font: 800 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .panel-subtitle { fill: #8b949e; font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .row-label { fill: #f0f6fc; font: 700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .row-threshold { fill: #9da7b3; font: 700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .row-value { fill: #f0f6fc; font: 700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .row-muted { fill: #9da7b3; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .note { fill: #6e7681; font: 500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  </style>
  <rect class="bg" width="${width}" height="${height}" rx="16" />
  <rect class="card" x="14" y="14" width="${width - 28}" height="${height - 28}" rx="14" />

  <text x="38" y="48" class="eyebrow">LAST 1 YEAR</text>
  <text x="38" y="82" class="title">Contribution Activity</text>
  <text x="38" y="106" class="subtitle">${escapeXml(snapshot.window.start)} to ${escapeXml(snapshot.window.end)}</text>

  ${renderActivityStat({ x: 34, label: "Total", value: formatNumber(snapshot.summary.totalContributions), accent: "#39d353" })}
  ${renderActivityStat({ x: 218, label: "This month", value: formatNumber(snapshot.summary.currentMonthContributions), accent: "#54aeff" })}
  ${renderActivityStat({ x: 402, label: "Active days", value: `${snapshot.summary.activeDays}/${snapshot.window.totalDays}`, accent: "#f2cc60" })}
  ${renderActivityStat({ x: 586, label: "Max/day", value: formatNumber(snapshot.summary.maxDayCount), accent: "#ff7b72" })}

  <line class="divider" x1="34" y1="164" x2="866" y2="164" />

  ${densityPanel}
  ${volumePanel}
  <text x="34" y="374" class="note">Percentages exclude zero-contribution days. Density uses GitHub-provided relative levels and colors.</text>
  <text x="866" y="374" text-anchor="end" class="note">data through ${escapeXml(dataThrough)} | ${escapeXml(freshnessStatus)} | generated ${escapeXml(generatedDate)}</text>
</svg>`;
}

async function requestContributionCalendar() {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "ClarusIubar-profile-metrics",
    },
    body: JSON.stringify({
      query,
      variables: { login: OWNER },
    }),
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

  return payload.data.user.contributionsCollection.contributionCalendar;
}

async function fetchContributionCalendar() {
  const maxAttempts = Number.isFinite(graphqlMaxAttempts) && graphqlMaxAttempts > 0 ? graphqlMaxAttempts : 4;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestContributionCalendar();
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

/**
 * Produces the three persisted asset snapshots from one normalized calendar result.
 * Every artifact carries the same freshness contract so consumers do not need to
 * infer whether an SVG and its companion JSON were generated in the same run.
 */
export function createAssetSnapshots(snapshot) {
  const { volumeBuckets, ...densitySnapshot } = snapshot;
  return {
    densitySnapshot,
    volumeSnapshot: {
      username: snapshot.username,
      window: snapshot.window,
      summary: snapshot.summary,
      freshness: snapshot.freshness,
      buckets: volumeBuckets,
    },
    activitySnapshot: {
      username: snapshot.username,
      window: snapshot.window,
      summary: snapshot.summary,
      freshness: snapshot.freshness,
      density: snapshot.levels,
      volume: volumeBuckets,
    },
  };
}

async function main() {
  const previousSnapshot = await readPreviousActivitySnapshot();
  let calendar;
  try {
    calendar = await fetchContributionCalendar();
  } catch (error) {
    const lastGeneratedAt = previousSnapshot?.summary?.generatedAt ?? "unknown";
    await writeActionsSummary("Contribution metrics refresh failed", [
      "Existing generated assets were preserved.",
      `Last successful generation: ${lastGeneratedAt}`,
      `Reason: ${error.message}`,
    ]);
    throw error;
  }
  const snapshot = buildSnapshot(calendar);
  const comparison = compareSnapshots(previousSnapshot, snapshot);
  snapshot.freshness = {
    status: "current",
    dataThrough: snapshot.window.end,
    comparison,
  };
  const densitySvg = renderDensitySvg(snapshot);
  const volumeSvg = renderVolumeSvg(snapshot);
  const activitySvg = renderActivitySvg(snapshot);
  const { densitySnapshot, volumeSnapshot, activitySnapshot } = createAssetSnapshots(snapshot);

  await mkdir(outputDir, { recursive: true });
  await writeFile(densityJsonPath, `${JSON.stringify(densitySnapshot, null, 2)}\n`, "utf8");
  await writeFile(densitySvgPath, densitySvg, "utf8");
  await writeFile(volumeJsonPath, `${JSON.stringify(volumeSnapshot, null, 2)}\n`, "utf8");
  await writeFile(volumeSvgPath, volumeSvg, "utf8");
  await writeFile(activityJsonPath, `${JSON.stringify(activitySnapshot, null, 2)}\n`, "utf8");
  await writeFile(activitySvgPath, activitySvg, "utf8");

  await writeActionsSummary("Contribution metrics refresh", [
    `Data through: ${snapshot.freshness.dataThrough}`,
    comparison.changed ? "Observed contribution values changed." : "No observed contribution values changed.",
    ...comparison.changes.map(formatChange),
  ]);

  console.log(`Wrote ${densityJsonPath}`);
  console.log(`Wrote ${densitySvgPath}`);
  console.log(`Wrote ${volumeJsonPath}`);
  console.log(`Wrote ${volumeSvgPath}`);
  console.log(`Wrote ${activityJsonPath}`);
  console.log(`Wrote ${activitySvgPath}`);
}

if (!process.env.CONTRIBUTION_RENDERER_TEST_MODE) {
  await main();
}
