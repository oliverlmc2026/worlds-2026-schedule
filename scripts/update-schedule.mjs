#!/usr/bin/env node
// Usage: node scripts/update-schedule.mjs [path/to/index.html]
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const API = "https://esports-api.lolesports.com/persisted/gw";
const WORLDS_LEAGUE_ID = "98767975604431411";
const HEADERS = { "x-api-key": "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z" };
const HTML = process.argv[2] ?? fileURLToPath(new URL("../index.html", import.meta.url));

const SWISS_ROUND_SIZES = [8, 8, 8, 6, 3];
const PLAY_IN_STAGES = ["勝部準決賽", "勝部準決賽", "勝部決賽", "敗部準決賽", "敗部決賽", "入圍賽總決賽"];
const PHASE = { "Play-Ins": "入圍賽", Swiss: "瑞士輪" };

async function api(path, params) {
  const res = await fetch(`${API}/${path}?${new URLSearchParams({ hl: "en-US", leagueId: WORLDS_LEAGUE_ID, ...params })}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()).data;
}

async function latestTournament() {
  const { leagues } = await api("getTournamentsForLeague");
  const t = leagues[0].tournaments.filter((x) => x.slug.startsWith("worlds_")).sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  if (!t) throw new Error("no worlds tournament found");
  return t;
}

async function fetchEvents(t) {
  const events = [];
  let { schedule } = await api("getSchedule");
  events.push(...schedule.events);
  while (schedule.pages.newer) {
    ({ schedule } = await api("getSchedule", { pageToken: schedule.pages.newer }));
    events.push(...schedule.events);
  }
  let older = (await api("getSchedule")).schedule.pages.older;
  while (older && events.every((e) => e.startTime.slice(0, 10) > t.startDate)) {
    ({ schedule } = await api("getSchedule", { pageToken: older }));
    events.push(...schedule.events);
    older = schedule.pages.older;
  }
  return events
    .filter((e) => e.type === "match" && e.league.slug === "worlds" && e.startTime.slice(0, 10) >= t.startDate && e.startTime.slice(0, 10) <= t.endDate)
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.match.id.localeCompare(b.match.id));
}

function nameStages(events) {
  const byBlock = Map.groupBy(events, (e) => e.blockName);
  const stage = new Map();
  for (const [block, list] of byBlock) {
    list.forEach((e, i) => {
      let s;
      if (block === "Swiss") {
        let n = i, round = 0;
        while (round < SWISS_ROUND_SIZES.length && n >= SWISS_ROUND_SIZES[round]) n -= SWISS_ROUND_SIZES[round++];
        s = `第 ${round + 1} 輪`;
      } else if (block === "Play-Ins") s = list.length === PLAY_IN_STAGES.length ? PLAY_IN_STAGES[i] : `第 ${i + 1} 場`;
      else if (block === "Quarterfinals") s = `八強 ${i + 1}`;
      else if (block === "Semifinals") s = `四強 ${i + 1}`;
      else if (block === "Finals") s = "總決賽";
      else s = list.length > 1 ? `第 ${i + 1} 場` : block;
      stage.set(e.match.id, s);
    });
  }
  return stage;
}

function buildBlock(events) {
  const stage = nameStages(events);
  const teams = {};
  const rows = events.map((e) => {
    const [h, a] = e.match.teams;
    const code = (x) => (x.code === "TBD" ? null : x.code);
    for (const x of [h, a]) if (code(x)) teams[x.code] = x.name;
    const row = [e.startTime.slice(0, 16) + "Z", PHASE[e.blockName] ?? "淘汰賽", stage.get(e.match.id), e.match.strategy.count];
    if (code(h) && code(a)) {
      row.push(h.code, a.code);
      if (e.state === "completed") row.push(h.result.gameWins, a.result.gameWins);
    }
    return "  " + JSON.stringify(row);
  });
  const sorted = Object.fromEntries(Object.entries(teams).sort(([x], [y]) => x.localeCompare(y)));
  return (updated) => `// BEGIN GENERATED (scripts/update-schedule.mjs)
const UPDATED=${JSON.stringify(updated)};
const TEAMS=${JSON.stringify(sorted)};
const RAW=[
${rows.join(",\n")}
];
// END GENERATED`;
}

const tournament = await latestTournament();
const events = await fetchEvents(tournament);
if (events.length === 0) throw new Error(`no matches returned for ${tournament.slug}; leaving index.html untouched`);

const html = await readFile(HTML, "utf8");
const re = /\/\/ BEGIN GENERATED[\s\S]*?\/\/ END GENERATED/;
if (!re.test(html)) throw new Error("BEGIN/END GENERATED markers not found in " + HTML);

const block = buildBlock(events);
const stripUpdated = (s) => s.replace(/^const UPDATED=.*\n/m, "");
const next = block(new Date().toISOString().slice(0, 16) + "Z");
if (stripUpdated(html.match(re)[0]) === stripUpdated(next)) {
  console.log(`${tournament.slug}: ${events.length} matches, no change`);
} else {
  await writeFile(HTML, html.replace(re, () => next));
  const done = events.filter((e) => e.state === "completed").length;
  console.log(`${tournament.slug}: ${events.length} matches (${done} completed), updated ${HTML}`);
}
