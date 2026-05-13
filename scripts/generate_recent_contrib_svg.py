from __future__ import annotations

import json
import os
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


QUERY = """
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      contributionCalendar {
        totalContributions
        weeks {
          firstDay
          contributionDays {
            contributionCount
            color
            date
            weekday
          }
        }
      }
    }
  }
}
"""


def github_graphql(token: str, payload: dict[str, object]) -> dict[str, object]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        "https://api.github.com/graphql",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "clarusiubar-profile-recent-contrib",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read().decode("utf-8")
    data = json.loads(raw)
    if "errors" in data:
        raise RuntimeError(json.dumps(data["errors"], ensure_ascii=False))
    return data["data"]


def iso_datetime(value: date, end_of_day: bool = False) -> str:
    hour = 23 if end_of_day else 0
    minute = 59 if end_of_day else 0
    second = 59 if end_of_day else 0
    dt = datetime(value.year, value.month, value.day, hour, minute, second, tzinfo=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def build_svg(login: str, weeks: list[dict[str, object]], totals: dict[str, int], start: date, end: date) -> str:
    width = 980
    height = 340
    cell = 18
    gap = 4
    left = 80
    top = 92
    heatmap_width = len(weeks) * (cell + gap)
    stats_x = left + heatmap_width + 44
    chart_x = 640
    chart_title_y = 92
    weekly_totals = [sum(day["contributionCount"] for day in week["contributionDays"]) for week in weeks]
    max_weekly = max(max(weekly_totals), 1)
    active_days = sum(1 for week in weeks for day in week["contributionDays"] if day["contributionCount"] > 0)
    max_day = max(day["contributionCount"] for week in weeks for day in week["contributionDays"])

    month_labels: list[str] = []
    for index, week in enumerate(weeks):
        first = date.fromisoformat(week["firstDay"])
        if index == 0 or first.day <= 7:
            month_labels.append(
                f'<text x="{left + index * (cell + gap)}" y="74" fill="#9FB2D0" font-size="12">{first.strftime("%b")}</text>'
            )

    day_labels = []
    day_names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    for row, name in enumerate(day_names):
        y = top + row * (cell + gap) + 13
        day_labels.append(f'<text x="32" y="{y}" fill="#8EA0BE" font-size="12">{name}</text>')

    heatmap = []
    for col, week in enumerate(weeks):
        for row, day in enumerate(week["contributionDays"]):
            x = left + col * (cell + gap)
            y = top + row * (cell + gap)
            color = day["color"]
            count = day["contributionCount"]
            tooltip = f'{day["date"]}: {count} contributions'
            heatmap.append(
                f'<rect x="{x}" y="{y}" width="{cell}" height="{cell}" rx="4" fill="{color}"><title>{tooltip}</title></rect>'
            )

    bars = []
    bar_base_y = 250
    for index, total in enumerate(weekly_totals):
        bar_height = 88 * total / max_weekly
        x = chart_x + index * 16
        y = bar_base_y - bar_height
        bars.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="10" height="{bar_height:.1f}" rx="4" fill="#45B3FF"><title>week {index + 1}: {total} contributions</title></rect>'
        )

    summary_items = [
        ("Total", totals["total"]),
        ("Commit", totals["commit"]),
        ("Issue", totals["issue"]),
        ("PR", totals["pr"]),
        ("Review", totals["review"]),
        ("Active days", active_days),
        ("Peak day", max_day),
    ]
    summary_svg = []
    for index, (label, value) in enumerate(summary_items):
        row = index // 2
        col = index % 2
        x = stats_x + col * 108
        y = 92 + row * 46
        summary_svg.append(f'<text x="{x}" y="{y}" fill="#8EA0BE" font-size="12">{label}</text>')
        summary_svg.append(f'<text x="{x}" y="{y + 20}" fill="#F4F7FB" font-size="18" font-weight="700">{value}</text>')

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">
  <title id="title">Recent 12 weeks contribution activity for {login}</title>
  <desc id="desc">Contribution heatmap and weekly totals from {start.isoformat()} to {end.isoformat()}.</desc>
  <defs>
    <linearGradient id="card-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0B1220" />
      <stop offset="100%" stop-color="#111C31" />
    </linearGradient>
  </defs>
  <rect width="{width}" height="{height}" rx="18" fill="url(#card-bg)" />
  <text x="28" y="38" fill="#F4F7FB" font-size="24" font-weight="700">Recent 12 Weeks</text>
  <text x="28" y="60" fill="#8EA0BE" font-size="13">{login} - {start.isoformat()} ~ {end.isoformat()}</text>
  {''.join(month_labels)}
  {''.join(day_labels)}
  {''.join(heatmap)}
  {''.join(summary_svg)}
  <text x="{chart_x}" y="{chart_title_y}" fill="#F4F7FB" font-size="18" font-weight="700">Weekly activity</text>
  <text x="{chart_x}" y="{chart_title_y + 22}" fill="#8EA0BE" font-size="13">Weekly totals across the last 12 weeks</text>
  <line x1="{chart_x}" y1="{bar_base_y}" x2="{chart_x + 12 * 16}" y2="{bar_base_y}" stroke="#2A3955" stroke-width="1" />
  {''.join(bars)}
</svg>
'''


def main() -> None:
    token = os.environ.get("GITHUB_TOKEN")
    login = os.environ.get("GITHUB_LOGIN", os.environ.get("GITHUB_REPOSITORY_OWNER", "ClarusIubar"))
    if not token:
        raise SystemExit("GITHUB_TOKEN is required")

    end = date.today()
    start = end - timedelta(days=83)
    variables = {
        "login": login,
        "from": iso_datetime(start),
        "to": iso_datetime(end, end_of_day=True),
    }
    data = github_graphql(token, {"query": QUERY, "variables": variables})
    collection = data["user"]["contributionsCollection"]
    weeks = collection["contributionCalendar"]["weeks"][-12:]
    totals = {
        "total": collection["contributionCalendar"]["totalContributions"],
        "commit": collection["totalCommitContributions"],
        "issue": collection["totalIssueContributions"],
        "pr": collection["totalPullRequestContributions"],
        "review": collection["totalPullRequestReviewContributions"],
    }

    output = Path("profile-contrib")
    output.mkdir(parents=True, exist_ok=True)
    svg = build_svg(login, weeks, totals, start, end)
    (output / "recent-12-weeks.svg").write_text(svg, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
