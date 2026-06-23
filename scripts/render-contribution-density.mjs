import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const OWNER = process.env.PROFILE_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || "ClarusIubar";
const TOKEN =
  process.env.METRICS_TOKEN ||
  process.env.METRICS_RUNTIME_TOKEN ||
  process.env.GITHUB_TOKEN ||
  "";

if (!TOKEN) {
  throw new Error("Missing GitHub token. Set METRICS_TOKEN, METRICS_RUNTIME_TOKEN, or GITHUB_TOKEN.");
}

const outputDir = path.resolve(process.cwd(), "metrics");
const outputJsonPath = path.join(outputDir, "contribution-density.json");
const outputSvgPath = path.join(outputDir, "contribution-density.svg");

const LEVELS = [
  { key: "FIRST_QUARTILE", label: "Q1", color: "#0e4429" },
  { key: "SECOND_QUARTILE", label: "Q2", color: "#006d32" },
  { key: "THIRD_QUARTILE", label: "Q3", color: "#26a641" },
  { key: "FOURTH_QUARTILE", label: "Q4", color: "#39d353" },
];

const query = `
query ($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
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

function formatRange(minCount, maxCount) {
  if (minCount == null || maxCount == null) {
    return "-";
  }
  if (minCount === maxCount) {
    return `${minCount}`;
  }
  return `${minCount}–${maxCount}`;
}

function createLevelSnapshot(days, totalDays, activeDays) {
  return LEVELS.map((level) => {
    const matching = days.filter((day) => day.contributionLevel === level.key);
    const counts = matching.map((day) => day.contributionCount);
    const minCount = counts.length > 0 ? Math.min(...counts) : null;
    const maxCount = counts.length > 0 ? Math.max(...counts) : null;

    return {
      key: level.key,
      label: level.label,
      days: matching.length,
      share: activeDays === 0 ? 0 : matching.length / activeDays,
      shareOfYear: totalDays === 0 ? 0 : matching.length / totalDays,
      minCount,
      maxCount,
      color: level.color,
    };
  });
}

function buildSnapshot(calendar) {
  const days = calendar.weeks.flatMap((week) => week.contributionDays);
  const totalDays = days.length;
  const activeDays = days.filter((day) => day.contributionCount > 0).length;
  const maxDayCount = days.reduce((max, day) => Math.max(max, day.contributionCount), 0);
  const start = days[0]?.date ?? null;
  const end = days.at(-1)?.date ?? null;
  const levels = createLevelSnapshot(days, totalDays, activeDays).map(({ color, ...level }) => level);

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
      generatedAt: new Date().toISOString(),
    },
    levels,
  };
}

function renderSvg(snapshot) {
  const width = 720;
  const height = 270;
  const rowStartY = 116;
  const rowHeight = 28;

  const levelByKey = new Map(LEVELS.map((level) => [level.key, level]));
  const rows = snapshot.levels
    .map((level, index) => {
      const palette = levelByKey.get(level.key);
      const y = rowStartY + index * rowHeight;
      const barWidth = Math.max(2, Math.round(level.share * 260));

      return `
        <rect x="36" y="${y - 14}" width="648" height="22" rx="8" fill="#0d1117" />
        <circle cx="54" cy="${y}" r="6" fill="${palette.color}" />
        <text x="72" y="${y + 4}" class="label">${escapeXml(level.label)}</text>
        <text x="205" y="${y + 4}" class="value">${escapeXml(String(level.days))} days</text>
        <text x="320" y="${y + 4}" class="muted">${escapeXml(formatPercent(level.share))}</text>
        <rect x="398" y="${y - 7}" width="260" height="12" rx="6" fill="#21262d" />
        <rect x="398" y="${y - 7}" width="${barWidth}" height="12" rx="6" fill="${palette.color}" />
        <text x="670" y="${y + 4}" text-anchor="end" class="muted">${escapeXml(formatRange(level.minCount, level.maxCount))}</text>
      `;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Contribution Density</title>
  <desc id="desc">GitHub contribution density by contribution level for the last year.</desc>
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

  <text x="36" y="48" class="title">Contribution Density</text>
  <text x="36" y="72" class="subtitle">${escapeXml(snapshot.window.start)} to ${escapeXml(snapshot.window.end)} · Last 1 year</text>

  <text x="36" y="100" class="summary">${escapeXml(String(snapshot.summary.totalContributions))}</text>
  <text x="88" y="100" class="summary-label">total contributions</text>
  <text x="260" y="100" class="summary">${escapeXml(`${snapshot.summary.activeDays}/${snapshot.window.totalDays}`)}</text>
  <text x="348" y="100" class="summary-label">active days</text>
  <text x="420" y="100" class="summary">${escapeXml(String(snapshot.summary.maxDayCount))}</text>
  <text x="458" y="100" class="summary-label">max/day</text>
  <text x="684" y="100" text-anchor="end" class="summary-label">generated ${escapeXml(snapshot.summary.generatedAt.slice(0, 10))}</text>

  ${rows}
</svg>`;
}

async function fetchContributionCalendar() {
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
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${message}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data.user.contributionsCollection.contributionCalendar;
}

async function main() {
  const calendar = await fetchContributionCalendar();
  const snapshot = buildSnapshot(calendar);
  const svg = renderSvg(snapshot);

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputJsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await writeFile(outputSvgPath, svg, "utf8");

  console.log(`Wrote ${outputJsonPath}`);
  console.log(`Wrote ${outputSvgPath}`);
}

await main();
