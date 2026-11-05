// Generates the profile stat cards as static SVGs in ./cards.
// Runs daily from .github/workflows/profile-cards.yml so the README never
// depends on a public stats server staying online.
//
// Local run:  GITHUB_TOKEN=$(gh auth token) node scripts/generate-cards.mjs

import { mkdir, writeFile } from "node:fs/promises";

const LOGIN = process.env.PROFILE_LOGIN || "moodyminji";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("GITHUB_TOKEN is required");

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

// ---------- data ----------

const profile = (
  await gql(
    `query($login: String!) {
      user(login: $login) {
        name createdAt
        followers { totalCount }
        pullRequests { totalCount }
        issues { totalCount }
        repositories(ownerAffiliations: OWNER, isFork: false, first: 100) {
          totalCount
          nodes {
            stargazerCount
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name color } }
            }
          }
        }
      }
    }`,
    { login: LOGIN },
  )
).user;

// Contribution history, one year per request (the API caps a range at 1 year).
const days = [];
let totalCommits = 0;
const start = new Date(profile.createdAt);
const now = new Date();
for (let y = start.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
  const from = new Date(Date.UTC(y, 0, 1));
  const to = y === now.getUTCFullYear() ? now : new Date(Date.UTC(y, 11, 31, 23, 59, 59));
  const c = (
    await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            restrictedContributionsCount
            contributionCalendar { weeks { contributionDays { date contributionCount } } }
          }
        }
      }`,
      { login: LOGIN, from: from.toISOString(), to: to.toISOString() },
    )
  ).user.contributionsCollection;
  totalCommits += c.totalCommitContributions + c.restrictedContributionsCount;
  for (const w of c.contributionCalendar.weeks) days.push(...w.contributionDays);
}

const seen = new Set();
const calendar = days
  .filter((d) => !seen.has(d.date) && seen.add(d.date))
  .sort((a, b) => a.date.localeCompare(b.date));

const totalContributions = calendar.reduce((s, d) => s + d.contributionCount, 0);

let longest = 0, longestEnd = null, run = 0;
for (const d of calendar) {
  run = d.contributionCount > 0 ? run + 1 : 0;
  if (run > longest) { longest = run; longestEnd = d.date; }
}
// Current streak: today with no contributions yet doesn't break it.
let current = 0;
for (let i = calendar.length - 1; i >= 0; i--) {
  if (calendar[i].contributionCount > 0) current++;
  else if (i === calendar.length - 1) continue;
  else break;
}

const stars = profile.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);

const langMap = new Map();
for (const r of profile.repositories.nodes) {
  for (const { size, node } of r.languages.edges) {
    const prev = langMap.get(node.name) || { size: 0, color: node.color || "#8b949e" };
    prev.size += size;
    langMap.set(node.name, prev);
  }
}
const langTotal = [...langMap.values()].reduce((s, l) => s + l.size, 0) || 1;
const languages = [...langMap.entries()]
  .map(([name, l]) => ({ name, color: l.color, pct: (l.size / langTotal) * 100 }))
  .sort((a, b) => b.pct - a.pct)
  .slice(0, 6);

// ---------- rendering ----------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n));
const fmtDate = (iso) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// Colours follow GitHub's own light/dark palettes so the cards blend into either theme.
const STYLE = `
  <style>
    .bg { fill: #ffffff; stroke: #d0d7de; }
    .title { font: 600 15px 'Segoe UI', Ubuntu, -apple-system, sans-serif; fill: #0969da; }
    .label { font: 400 13px 'Segoe UI', Ubuntu, -apple-system, sans-serif; fill: #57606a; }
    .value { font: 600 13px 'Segoe UI', Ubuntu, -apple-system, sans-serif; fill: #1f2328; }
    .big { font: 700 26px 'Segoe UI', Ubuntu, -apple-system, sans-serif; fill: #1f2328; }
    .hl { fill: #0969da; }
    .muted { font: 400 11px 'Segoe UI', Ubuntu, -apple-system, sans-serif; fill: #6e7781; }
    .icon { fill: #0969da; }
    .track { fill: #eaeef2; }
    .ring { stroke: #0969da; }
    .divider { stroke: #d0d7de; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; stroke: #30363d; }
      .title { fill: #58a6ff; }
      .label { fill: #8b949e; }
      .value, .big { fill: #e6edf3; }
      .hl { fill: #58a6ff; }
      .muted { fill: #7d8590; }
      .icon { fill: #58a6ff; }
      .track { fill: #21262d; }
      .ring { stroke: #58a6ff; }
      .divider { stroke: #30363d; }
    }
    .fade { animation: fade .5s ease-out both; }
    @keyframes fade { from { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .fade { animation: none; } }
  </style>`;

const card = (w, h, title, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>${STYLE}
  <rect class="bg" x="0.5" y="0.5" rx="8" width="${w - 1}" height="${h - 1}"/>
  <text class="title" x="22" y="34">${esc(title)}</text>
  ${body}
</svg>
`;

// Octicons (MIT), 16px
const ICONS = {
  star: "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z",
  commit: "M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z",
  pr: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z",
  issue: "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
  repo: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
  flame: "M9.533.753V.752c.217 2.385 1.463 3.626 2.653 4.81C13.37 6.74 14.498 7.863 14.498 10c0 3.5-3 6-6.5 6S1.5 13.512 1.5 10c0-1.298.536-2.56 1.425-3.286.376-.308.862 0 1.035.454C4.46 8.487 5.581 8.419 6 8c.282-.282.341-.811-.003-1.5C4.34 3.187 7.035.75 8.77.146c.39-.137.726.194.763.607ZM7.998 14.5c2.832 0 5-1.98 5-4.5 0-1.463-.68-2.19-1.879-3.383l-.036-.037c-1.013-1.008-2.3-2.29-2.834-4.434-.322.256-.63.579-.864.953-.432.696-.621 1.58-.046 2.73.473.947.67 2.284-.278 3.232-.61.61-1.545.84-2.403.633a2.79 2.79 0 0 1-1.436-.874A3.198 3.198 0 0 0 3 10c0 2.53 2.164 4.5 4.998 4.5Z",
};
const icon = (name, x, y) => `<path class="icon" transform="translate(${x} ${y})" d="${ICONS[name]}"/>`;

// Stats + languages cards share a height so they sit side by side.
const CARD_H = 195;

// Stats card
const statRows = [
  ["star", "Total stars earned", stars],
  ["commit", "Total commits", totalCommits],
  ["pr", "Pull requests", profile.pullRequests.totalCount],
  ["issue", "Issues opened", profile.issues.totalCount],
  ["repo", "Public repositories", profile.repositories.totalCount],
];
const statsSvg = card(
  420, CARD_H, `${profile.name || LOGIN}'s GitHub Stats`,
  statRows
    .map(([ic, label, val], i) => {
      const y = 66 + i * 28;
      return `<g class="fade" style="animation-delay:${i * 80}ms">
        ${icon(ic, 22, y - 12)}
        <text class="label" x="48" y="${y}">${esc(label)}</text>
        <text class="value" x="398" y="${y}" text-anchor="end">${fmt(val)}</text>
      </g>`;
    })
    .join(""),
);

// Top languages card
const BAR_W = 376;
let bx = 22;
const bar = languages
  .map((l) => {
    const w = (l.pct / 100) * BAR_W;
    const seg = `<rect x="${bx.toFixed(2)}" y="50" width="${w.toFixed(2)}" height="8" fill="${l.color}"/>`;
    bx += w;
    return seg;
  })
  .join("");
const legend = languages
  .map((l, i) => {
    const x = 22 + (i % 2) * 190;
    const y = 94 + Math.floor(i / 2) * 32;
    return `<g class="fade" style="animation-delay:${i * 80}ms">
      <circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${l.color}"/>
      <text class="value" x="${x + 16}" y="${y}">${esc(l.name)}</text>
      <text class="label" x="${x + 178}" y="${y}" text-anchor="end">${l.pct.toFixed(1)}%</text>
    </g>`;
  })
  .join("");
const langSvg = card(
  420, CARD_H, "Most Used Languages",
  `<clipPath id="barclip"><rect x="22" y="50" width="${BAR_W}" height="8" rx="4"/></clipPath>
   <rect class="track" x="22" y="50" width="${BAR_W}" height="8" rx="4"/>
   <g clip-path="url(#barclip)">${bar}</g>${legend}`,
);

// Streak card
const firstDay = calendar.find((d) => d.contributionCount > 0)?.date ?? calendar[0].date;
const col = (x, big, label, sub, extra = "") => `
  <g class="fade" transform="translate(${x} 0)">
    ${extra}
    <text class="big" x="0" y="${extra ? 108 : 96}" text-anchor="middle">${big}</text>
    <text class="value" x="0" y="${extra ? 152 : 126}" text-anchor="middle">${esc(label)}</text>
    <text class="muted" x="0" y="${extra ? 170 : 146}" text-anchor="middle">${esc(sub)}</text>
  </g>`;
const longestStart = longestEnd
  ? new Date(new Date(longestEnd + "T00:00:00Z").getTime() - (longest - 1) * 864e5).toISOString().slice(0, 10)
  : null;
const streakSvg = card(
  495, 195, "Contribution Streak",
  `${col(85, fmt(totalContributions), "Total contributions", `${fmtDate(firstDay)} – present`)}
   <line class="divider" x1="165" y1="56" x2="165" y2="172"/>
   ${col(
     247.5, current, "Current streak",
     current ? `ending ${fmtDate(calendar.at(-1).date)}` : "start one today",
     `<circle class="ring" cx="0" cy="98" r="36" fill="none" stroke-width="5"/>
      <circle class="bg" cx="0" cy="60" r="13" stroke="none"/>
      ${icon("flame", -8, 51)}`,
   )}
   <line class="divider" x1="330" y1="56" x2="330" y2="172"/>
   ${col(410, longest, "Longest streak", longestStart ? `${fmtDate(longestStart)} – ${fmtDate(longestEnd)}` : "—")}`,
);

await mkdir("cards", { recursive: true });
await writeFile("cards/stats.svg", statsSvg);
await writeFile("cards/languages.svg", langSvg);
await writeFile("cards/streak.svg", streakSvg);

console.log(
  JSON.stringify(
    { stars, totalCommits, totalContributions, current, longest, languages: languages.map((l) => `${l.name} ${l.pct.toFixed(1)}%`) },
    null, 2,
  ),
);
