// Renders the compact profile metrics card: streak, top languages, repos,
// stars, followers, account age, and total commits — one stacked card, in
// light and dark variants.
//
// All numbers are overall totals (public + private combined) — nothing here
// names or otherwise identifies which repos are private, so a bare count
// doesn't say anything about them beyond "they exist". Repos/stars use the
// authenticated `/user` and `/user/repos` endpoints (which include private
// repos, given a token with `repo` scope). Streak comes from the GraphQL
// `viewer` contributions API. Total commits uses commit search (author:login)
// rather than the contributions API, since the latter doesn't carry history
// across a username rename (see fetchTotalCommits below).
//
// Inputs:
//  - languages.json: config_output=json dump from the lowlighter/metrics
//    plugin_languages plugin (produced by the workflow step before this one).
//  - METRICS_TOKEN env var: needs `repo` scope (classic PAT) to see private
//    repos for the repo/star counts and the language breakdown.
//
// Outputs: github-metrics-light.svg, github-metrics-dark.svg in the repo root.

import { readFileSync, writeFileSync } from "node:fs";

const TOKEN = process.env.METRICS_TOKEN;

if (!TOKEN) {
  throw new Error("METRICS_TOKEN env var is required");
}

const REST_HEADERS = {
  Authorization: `bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "JamsRepos-metrics-banner",
};

// --- Top languages, from the lowlighter/metrics JSON output ----------------
//
// Verified shape (config_output: json), confirmed against a real run:
//   { plugins: { languages: { favorites: [{ name, color, size, value }, ...] } } }
// `favorites` is already sorted and already limited to plugin_languages_limit.

function loadTopLanguages(path, limit = 3) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const favorites = raw?.plugins?.languages?.favorites;
  if (!Array.isArray(favorites)) return [];
  return favorites
    .map((f) => ({ name: f.name, color: f.color || "#8b949e", weight: f.size ?? 0 }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

// --- Profile stats: repos, stars, followers, account age (public + private) -

async function fetchProfile() {
  const res = await fetch("https://api.github.com/user", {
    headers: REST_HEADERS,
  });
  if (!res.ok) throw new Error(`GET /user failed: ${res.status}`);
  return res.json();
}

function parseLinkHeader(header) {
  if (!header) return {};
  return Object.fromEntries(
    header.split(",").map((part) => {
      const [, url, rel] = part.match(/<([^>]+)>;\s*rel="([^"]+)"/) ?? [];
      return [rel, url];
    }),
  );
}

// GitHub's /user endpoint no longer populates total_private_repos regardless
// of token scope, so repo count and stars are both derived from this same
// paginated listing (public + private, owned repos only).
async function fetchRepoStats() {
  let url = "https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=100";
  let totalRepos = 0;
  let stars = 0;
  while (url) {
    const res = await fetch(url, { headers: REST_HEADERS });
    if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
    const repos = await res.json();
    for (const repo of repos) {
      totalRepos += 1;
      if (!repo.fork) stars += repo.stargazers_count;
    }
    url = parseLinkHeader(res.headers.get("link")).next ?? null;
  }
  return { totalRepos, stars };
}

// Repos *you've* starred (distinct from "Stars" = stars received on your own
// repos). Cheap to get the count without paging through all of them: GitHub
// reports the final page number in the Link header's "last" rel.
async function fetchStarredCount() {
  const res = await fetch("https://api.github.com/user/starred?per_page=1", {
    headers: REST_HEADERS,
  });
  if (!res.ok) throw new Error(`GET /user/starred failed: ${res.status}`);
  const links = parseLinkHeader(res.headers.get("link"));
  if (links.last) return Number(new URL(links.last).searchParams.get("page"));
  const repos = await res.json();
  return repos.length;
}

// --- Streak + total commits, from the viewer's contribution history --------

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL request failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fetchContributionDays() {
  const query = `
    query {
      viewer {
        contributionsCollection {
          contributionCalendar {
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }
  `;
  const data = await graphql(query);
  const weeks = data.viewer.contributionsCollection.contributionCalendar.weeks;
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

// contributionsCollection.totalCommitContributions (even summed year-by-year
// to cover full account history) undercounts: it excludes commits made under
// a since-renamed username (this account was "LubricantJam" until 2023).
// lowlighter/metrics hits this same gap and works around it with exactly this
// search query (source/plugins/base/index.mjs) — GitHub's search-by-username
// resolves across the account's whole identity history, renames included.
async function fetchTotalCommits(login) {
  const res = await fetch(
    `https://api.github.com/search/commits?q=${encodeURIComponent(`author:${login}`)}`,
    { headers: REST_HEADERS },
  );
  if (!res.ok) throw new Error(`GET /search/commits failed: ${res.status}`);
  const data = await res.json();
  return data.total_count;
}

// --- Formatting --------------------------------------------------------------

function formatNumber(n) {
  return n.toLocaleString("en-US");
}

function formatAccountAge(joinedAt) {
  const joined = new Date(joinedAt);
  const years = Math.max(
    1,
    Math.floor((Date.now() - joined.getTime()) / (365.25 * 24 * 60 * 60 * 1000)),
  );
  return `${joined.getUTCFullYear()} · ${years} yr`;
}

// --- SVG rendering -----------------------------------------------------------

function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderBanner({ rows, theme }) {
  const dark = theme === "dark";
  const bg = dark ? "#0d1117" : "#ffffff";
  const border = dark ? "#30363d" : "#d0d7de";
  const text = dark ? "#c9d1d9" : "#24292f";
  const dim = dark ? "#8b949e" : "#57606a";

  const width = 340;
  const padY = 14;
  const rowH = 27;
  const headerH = 30;
  const height = headerH + padY + rows.length * rowH;
  const font = "-apple-system,Segoe UI,Helvetica,Arial,sans-serif";

  const rowEls = rows
    .map((row, i) => {
      const y = headerH + i * rowH;
      const midY = y + rowH / 2 + 4;
      const divider = `<line x1="14" y1="${y}" x2="${width - 14}" y2="${y}" stroke="${border}" stroke-opacity="0.6" />`;
      return `
        ${divider}
        <text x="16" y="${midY}" font-family="${font}" font-size="12.5" fill="${text}">${row.icon} ${escapeXml(row.label)}</text>
        <text x="${width - 16}" y="${midY}" font-family="${font}" font-size="12.5" font-weight="600" fill="${text}" text-anchor="end" font-variant-numeric="tabular-nums">${escapeXml(row.value)}</text>
      `;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${bg}" stroke="${border}" />
  <text x="16" y="20" font-family="${font}" font-size="11" font-weight="600" letter-spacing="0.06em" fill="${dim}">GITHUB ACTIVITY</text>
  ${rowEls}
</svg>`;
}

// --- Assemble ------------------------------------------------------------

const languages = loadTopLanguages("languages.json", 3);
const profile = await fetchProfile();
const { totalRepos, stars } = await fetchRepoStats();
const starred = await fetchStarredCount();
const days = await fetchContributionDays();
const streak = currentStreak(days);
const totalCommits = await fetchTotalCommits(profile.login);

const rows = [
  { icon: "🔥", label: "Streak", value: `${streak} day${streak === 1 ? "" : "s"}` },
  {
    icon: "💻",
    label: "Top languages",
    value: languages.length ? languages.map((l) => l.name).join(", ") : "—",
  },
  { icon: "📦", label: "Repos", value: formatNumber(totalRepos) },
  { icon: "🌠", label: "Stargazers", value: formatNumber(stars) },
  { icon: "⭐", label: "Stars", value: formatNumber(starred) },
  { icon: "👥", label: "Followers", value: formatNumber(profile.followers) },
  { icon: "📅", label: "On GitHub since", value: formatAccountAge(profile.created_at) },
  { icon: "🔁", label: "Total commits", value: formatNumber(totalCommits) },
];

writeFileSync("github-metrics-light.svg", renderBanner({ rows, theme: "light" }));
writeFileSync("github-metrics-dark.svg", renderBanner({ rows, theme: "dark" }));

console.log(`Rendered banner:\n${rows.map((r) => `  ${r.label}: ${r.value}`).join("\n")}`);
