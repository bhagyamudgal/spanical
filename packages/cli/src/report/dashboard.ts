import chartSource from "./vendor/chart.umd.min.js" with { type: "text" };
import type {
    CodebaseSummary,
    DevPeriodRollup,
    HotspotRow,
    PeriodRollup,
    SizeTrendPoint,
} from "../aggregate/types";

export type DashboardInput = {
    windowLabel: string;
    summary: CodebaseSummary;
    perPeriod: PeriodRollup[];
    perDev: DevPeriodRollup[];
    sizeTrend: SizeTrendPoint[];
    hotspots: HotspotRow[];
};

const HOTSPOT_LIMIT = 10;

// A closing </script> anywhere inside the injected data would terminate the
// inline bundle early, so every "<" travels as a unicode escape.
function safeJson(value: unknown): string {
    return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function esc(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

type ChartSpec = {
    id: string;
    title: string;
    kind: "bar" | "line" | "doughnut";
    note?: string;
};

const CHARTS: ChartSpec[] = [
    { id: "netGrowth", title: "Net growth per period", kind: "bar" },
    {
        id: "churn",
        title: "Churn per period",
        kind: "bar",
        note: "added vs deleted",
    },
    {
        id: "contributors",
        title: "Contributor throughput share",
        kind: "doughnut",
        note: "added + deleted lines",
    },
    {
        id: "size",
        title: "Size and complexity trend",
        kind: "line",
        note: "monthly scc snapshots",
    },
    {
        id: "languages",
        title: "Language mix per month",
        kind: "bar",
        note: "top languages, stacked code lines",
    },
    {
        id: "hotspots",
        title: "Hotspot scores",
        kind: "bar",
        note: "change frequency x complexity",
    },
];

function summaryChip(label: string, value: string): string {
    return `<div class="chip"><span class="chip-value">${value}</span><span class="chip-label">${label}</span></div>`;
}

export function buildDashboardHtml(input: DashboardInput): string {
    const { summary } = input;
    const hotspotRows = input.hotspots.slice(0, HOTSPOT_LIMIT);

    // First-seen order would let an early small language keep a palette slot
    // while a later dominant one drops off the chart entirely.
    const languageTotals = new Map<string, number>();
    for (const point of input.sizeTrend) {
        for (const language of point.languages) {
            languageTotals.set(
                language.language,
                (languageTotals.get(language.language) ?? 0) + language.code
            );
        }
    }
    const topLanguages = [...languageTotals.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([name]) => name);

    // per-dev rollups arrive per period; the share chart needs one slice per
    // human across the whole window.
    const throughputByAuthor = new Map<string, number>();
    for (const dev of input.perDev) {
        throughputByAuthor.set(
            dev.author,
            (throughputByAuthor.get(dev.author) ?? 0) + dev.throughput
        );
    }

    const data = {
        periods: input.perPeriod.map((period) => period.period),
        net: input.perPeriod.map((period) => period.net),
        added: input.perPeriod.map((period) => period.added),
        deleted: input.perPeriod.map((period) => period.deleted),
        authors: [...throughputByAuthor]
            .map(([author, throughput]) => ({ author, throughput }))
            .filter((dev) => dev.throughput > 0)
            .sort((left, right) => right.throughput - left.throughput),
        months: input.sizeTrend.map((point) => point.month),
        totalCode: input.sizeTrend.map((point) => point.totalCode),
        totalComplexity: input.sizeTrend.map((point) => point.totalComplexity),
        languageNames: topLanguages,
        languageMonths: input.sizeTrend.map((point) => ({
            month: point.month,
            languages: point.languages
                .slice()
                .sort((left, right) => right.code - left.code),
        })),
        hotspots: hotspotRows.map((row) => ({
            path: `${row.repo}/${row.path}`,
            score: row.score,
            owners: row.ownerCount,
        })),
    };

    const tables: Record<string, { headers: string[]; rows: string[][] }> = {
        netGrowth: {
            headers: ["Period", "Net lines"],
            rows: input.perPeriod.map((period) => [
                period.period,
                String(period.net),
            ]),
        },
        churn: {
            headers: ["Period", "Added", "Deleted"],
            rows: input.perPeriod.map((period) => [
                period.period,
                String(period.added),
                String(period.deleted),
            ]),
        },
        contributors: {
            headers: ["Author", "Throughput lines"],
            rows: data.authors.map((author) => [
                author.author,
                String(author.throughput),
            ]),
        },
        size: {
            headers: ["Month", "Code lines", "Complexity"],
            rows: input.sizeTrend.map((point) => [
                point.month,
                String(point.totalCode),
                String(point.totalComplexity),
            ]),
        },
        languages: {
            headers: ["Month", "Language", "Code lines"],
            rows: input.sizeTrend.flatMap((point) =>
                point.languages
                    .filter((language) =>
                        topLanguages.includes(language.language)
                    )
                    .map((language) => [
                        point.month,
                        language.language,
                        String(language.code),
                    ])
            ),
        },
        hotspots: {
            headers: ["Path", "Score", "Owners"],
            rows: data.hotspots.map((row) => [
                row.path,
                String(row.score),
                String(row.owners),
            ]),
        },
    };

    function dataTableHtml(id: string): string {
        const table = tables[id];
        if (!table || table.rows.length === 0) {
            return "";
        }
        const head = table.headers
            .map((header) => `<th>${esc(header)}</th>`)
            .join("");
        const body = table.rows
            .map(
                (row) =>
                    `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`
            )
            .join("");
        return `<details class="data-table">
  <summary>View as table</summary>
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</details>`;
    }

    const chartsHtml = CHARTS.map(
        (chart) => `<section class="card">
  <h2>${esc(chart.title)}${chart.note ? ` <small>${esc(chart.note)}</small>` : ""}</h2>
  <div class="chart-holder"><canvas id="${chart.id}" role="img" aria-label="${esc(chart.title)}"></canvas></div>
  ${dataTableHtml(chart.id)}
</section>`
    ).join("\n");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>spanical — ${esc(input.windowLabel)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    background: #0d1117; color: #e6edf3;
    font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  header .window { color: #8b949e; margin-bottom: 16px; }
  .chips { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .chip {
    display: flex; flex-direction: column; gap: 2px;
    background: #161b22; border: 1px solid #30363d;
    border-radius: 8px; padding: 10px 16px; min-width: 120px;
  }
  .chip-value { font-size: 18px; font-weight: 600; }
  .chip-label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 16px; }
  .card {
    background: #161b22; border: 1px solid #30363d;
    border-radius: 8px; padding: 16px; min-width: 0;
  }
  .card h2 { margin: 0 0 12px; font-size: 14px; font-weight: 600; }
  .card h2 small { color: #8b949e; font-weight: 400; }
  .chart-holder { position: relative; height: 300px; }
  .data-table { margin-top: 10px; font-size: 12px; }
  .data-table summary { cursor: pointer; color: #58a6ff; }
  .data-table table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  .data-table th, .data-table td {
    text-align: right; padding: 4px 8px;
    border-bottom: 1px solid #21262d;
  }
  .data-table th:first-child, .data-table td:first-child { text-align: left; }
  footer { margin-top: 20px; color: #8b949e; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>spanical dashboard</h1>
  <div class="window">${esc(input.windowLabel)}</div>
  <div class="chips">
    ${summaryChip("Commits", String(summary.commits))}
    ${summaryChip("Active devs", String(summary.activeDevs))}
    ${summaryChip("Net growth", `${summary.netGrowth >= 0 ? "+" : ""}${summary.netGrowth}`)}
    ${summaryChip("Total churn", String(summary.totalChurn))}
    ${summaryChip("Size now", `${summary.totalSizeNow} lines`)}
  </div>
</header>
<main class="grid">
${chartsHtml}
</main>
<footer>Generated by spanical · self-contained file, no external requests</footer>
<script>${chartSource}</script>
<script>
"use strict";
const DATA = ${safeJson(data)};
const CSS = getComputedStyle(document.documentElement);
const TEXT = "#8b949e";
const GRID = "#21262d";
const ACCENT = "#58a6ff";
Chart.defaults.color = TEXT;
Chart.defaults.borderColor = GRID;
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

function holder(id) {
  return document.getElementById(id);
}

(function netGrowth() {
  new Chart(holder("netGrowth"), {
    type: "bar",
    data: {
      labels: DATA.periods,
      datasets: [{
        label: "net lines",
        data: DATA.net,
        backgroundColor: DATA.net.map((v) => (v >= 0 ? "#2ea04366" : "#f8514966")),
        borderColor: DATA.net.map((v) => (v >= 0 ? "#2ea043" : "#f85149")),
        borderWidth: 1,
      }],
    },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
})();

(function churn() {
  new Chart(holder("churn"), {
    type: "bar",
    data: {
      labels: DATA.periods,
      datasets: [
        { label: "added", data: DATA.added, backgroundColor: "#2ea04399" },
        { label: "deleted", data: DATA.deleted, backgroundColor: "#f8514999" },
      ],
    },
    options: { maintainAspectRatio: false },
  });
})();

(function contributors() {
  new Chart(holder("contributors"), {
    type: "doughnut",
    data: {
      labels: DATA.authors.map((a) => a.author),
      datasets: [{
        data: DATA.authors.map((a) => a.throughput),
        backgroundColor: ["#58a6ff", "#bc8cff", "#2ea043", "#f0883e", "#f85149", "#39c5cf"],
        borderColor: "#161b22",
      }],
    },
    options: { maintainAspectRatio: false, cutout: "60%" },
  });
})();

(function size() {
  new Chart(holder("size"), {
    type: "line",
    data: {
      labels: DATA.months,
      datasets: [
        { label: "code lines", data: DATA.totalCode, borderColor: ACCENT, tension: 0.25, yAxisID: "y" },
        { label: "complexity", data: DATA.totalComplexity, borderColor: "#f0883e", tension: 0.25, yAxisID: "y1" },
      ],
    },
    options: {
      maintainAspectRatio: false,
      scales: {
        y: { position: "left" },
        y1: { position: "right", grid: { drawOnChartArea: false } },
      },
    },
  });
})();

(function languages() {
  const palette = ["#58a6ff", "#bc8cff", "#2ea043", "#f0883e", "#f85149"];
  new Chart(holder("languages"), {
    type: "bar",
    data: {
      labels: DATA.months,
      datasets: DATA.languageNames.map((name, index) => ({
        label: name,
        data: DATA.languageMonths.map((month) => {
          const hit = month.languages.find((l) => l.language === name);
          return hit ? hit.code : 0;
        }),
        backgroundColor: palette[index] + "99",
      })),
    },
    options: {
      maintainAspectRatio: false,
      scales: { x: { stacked: true }, y: { stacked: true } },
    },
  });
})();

(function hotspots() {
  new Chart(holder("hotspots"), {
    type: "bar",
    data: {
      labels: DATA.hotspots.map((h) => h.path),
      datasets: [{
        label: "score",
        data: DATA.hotspots.map((h) => h.score),
        backgroundColor: "#f0883e99",
      }],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
    },
  });
})();
</script>
</body>
</html>
`;
}
