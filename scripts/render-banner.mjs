// Renders the compact profile metrics banner: current contribution streak +
// top-3 public languages, as one line, in light and dark variants.
//
// Inputs:
//  - languages.json: config_output=json dump from the lowlighter/metrics
//    plugin_languages plugin (produced by the workflow step before this one).
//  - GH_USER / METRICS_TOKEN env vars: used to fetch the public contribution
//    calendar via the GraphQL API and derive the current streak.
//
// Outputs: github-metrics-light.svg, github-metrics-dark.svg in the repo root.

import { readFileSync, writeFileSync } from "node:fs";

const GH_USER = process.env.GH_USER;
const TOKEN = process.env.METRICS_TOKEN;

if (!GH_USER || !TOKEN) {
  throw new Error("GH_USER and METRICS_TOKEN env vars are required");
}

// --- Top languages, from the lowlighter/metrics JSON output ---------------

function findLanguages(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const entries = Object.entries(node);
  const looksLikeLanguages =
    entries.length > 0 &&
    entries.every(
      ([, v]) => v && typeof v === "object" && "color" in v,
    );
  if (looksLikeLanguages) return node;
  for (const [, v] of entries) {
    const found = findLanguages(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function loadTopLanguages(path, limit = 3) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const languages = findLanguages(raw);
  if (!languages) return [];
  return Object.entries(languages)
    .map(([name, v]) => ({
      name,
      color: v.color || "#8b949e",
      weight: v.size ?? v.percentage ?? v.count ?? 0,
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

// --- Current streak, from the public contribution calendar -----------------

async function fetchContributionDays(login, token) {
  const query = `
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }
  `;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { login } }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  const weeks = json.data.user.contributionsCollection.contributionCalendar.weeks;
  return weeks
    .flatMap((w) => w.contributionDays)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function currentStreak(days) {
  let i = days.length - 1;
  if (i >= 0 && days[i].contributionCount === 0) i -= 1; // today may not be "over" yet
  let streak = 0;
  while (i >= 0 && days[i].contributionCount > 0) {
    streak += 1;
    i -= 1;
  }
  return streak;
}

// --- SVG rendering -----------------------------------------------------------

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderBanner({ streak, languages, theme }) {
  const dark = theme === "dark";
  const bg = dark ? "#0d1117" : "#ffffff";
  const border = dark ? "#30363d" : "#d0d7de";
  const text = dark ? "#c9d1d9" : "#24292f";
  const dim = dark ? "#8b949e" : "#57606a";

  const width = 420;
  const height = 44;
  const streakLabel = `${streak}-day streak`;

  const langChips = languages
    .map((l, i) => {
      const x = 200 + i * 70;
      return `
        <circle cx="${x}" cy="${height / 2}" r="4" fill="${l.color}" />
        <text x="${x + 10}" y="${height / 2 + 4}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="12" fill="${text}">${escapeXml(l.name)}</text>
      `;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="${bg}" stroke="${border}" />
  <text x="16" y="${height / 2 + 5}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="14" fill="${text}">🔥 <tspan font-weight="600">${escapeXml(streakLabel)}</tspan></text>
  <line x1="190" y1="10" x2="190" y2="${height - 10}" stroke="${border}" />
  ${langChips}
  ${languages.length === 0 ? `<text x="200" y="${height / 2 + 4}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="12" fill="${dim}">no public language data</text>` : ""}
</svg>`;
}

const languages = loadTopLanguages("languages.json", 3);
const days = await fetchContributionDays(GH_USER, TOKEN);
const streak = currentStreak(days);

writeFileSync("github-metrics-light.svg", renderBanner({ streak, languages, theme: "light" }));
writeFileSync("github-metrics-dark.svg", renderBanner({ streak, languages, theme: "dark" }));

console.log(`Rendered banner: streak=${streak}, languages=${languages.map((l) => l.name).join(", ")}`);
