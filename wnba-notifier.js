const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3090);
const TZ = process.env.TZ || "Europe/Athens";
const LIVE_CHECK_EVERY_MS = Number(process.env.LIVE_CHECK_EVERY_MS || 20 * 1000);
const CHECK_EVERY_MS = Number(process.env.CHECK_EVERY_MS || 2 * 60 * 1000);
const LIVE_PAGE_REFRESH_MS = Number(process.env.LIVE_PAGE_REFRESH_MS || 15 * 1000);
const PAGE_REFRESH_MS = Number(process.env.PAGE_REFRESH_MS || 60 * 1000);
const LOOKAHEAD_DAYS = Number(process.env.LOOKAHEAD_DAYS || 45);
const SCORE_HISTORY_DAYS = Number(process.env.SCORE_HISTORY_DAYS || 2);
const BOX_SCORE_LIMIT = Number(process.env.BOX_SCORE_LIMIT || 12);
const INJURY_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STANDINGS_URL = "https://site.api.espn.com/apis/v2/sports/basketball/wnba/standings?region=us&lang=en&contentorigin=espn&type=0&level=2";
const WNBA_SCHEDULE_URL = "https://www.wnba.com/api/schedule";
const WNBA_SCHEDULE_REFRESH_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.WNBA_SCHEDULE_REFRESH_MS) || 6 * 60 * 60 * 1000,
);
const WNBA_GAME_MATCH_MAX_TIME_DIFFERENCE_MS = 8 * 60 * 60 * 1000;
const ODDS_API_BASE_URL = "https://api.odds-api.io/v3";
const ODDS_API_KEY = String(process.env.ODDS_API_KEY || "").trim();
const ODDS_BOOKMAKER = String(process.env.ODDS_BOOKMAKER || "Pamestoixima").trim();
const ODDS_REFRESH_MS = Math.max(60 * 1000, Number(process.env.ODDS_REFRESH_MS) || 15 * 60 * 1000);
const ODDS_LOOKAHEAD_DAYS = Math.max(1, Number(process.env.ODDS_LOOKAHEAD_DAYS) || 7);
const ODDS_MATCH_MAX_TIME_DIFFERENCE_MS = 8 * 60 * 60 * 1000;
const PAMESTOIXIMA_URL = "https://www.pamestoixima.gr/";
const REMINDER_MINUTES = (process.env.REMINDER_MINUTES || "1440,120,15")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
  .sort((a, b) => b - a);

const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "notifier-state.json");
const APK_FILE = path.join(__dirname, "downloads", "WNBA-Notifier.apk");

const state = loadState();
const officialScheduleCache = new Map();
const scoreboardCache = new Map();
let checkTimer = null;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { sent: {}, lastCheck: null, lastError: null, games: [] };
  }
}

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeHttpUrl(value, fallback = "") {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : fallback;
  } catch {
    return fallback;
  }
}

function formatLocalTime(iso) {
  return new Intl.DateTimeFormat("el-GR", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: TZ,
  }).format(new Date(iso));
}

function yyyymmdd(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function scoreboardDates(now = new Date()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - SCORE_HISTORY_DAYS);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + SCORE_HISTORY_DAYS + LOOKAHEAD_DAYS);
  const dates = [];
  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    dates.push(yyyymmdd(day));
  }
  return dates;
}

function pickCompetitor(competition, homeAway) {
  return competition.competitors?.find((team) => team.homeAway === homeAway) || {};
}

function competitorRecords(competitor, homeAway) {
  const records = competitor.records || [];
  const overall = records.find((record) => record.type === "total" || record.name === "overall");
  const venueType = homeAway === "home" ? "home" : "road";
  const venue = records.find((record) => record.type === venueType);

  return {
    overall: overall?.summary || "",
    venue: venue?.summary || "",
  };
}

function broadcastNames(competition) {
  const seen = new Set();
  const names = [];

  for (const item of competition.broadcasts || []) {
    for (const name of item.names || []) add(name);
    add(item.market);
    add(item.type?.shortName);
  }

  function add(value) {
    const text = String(value || "").trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(text);
  }

  return names.join(" / ");
}

function eventUrl(event) {
  const link =
    event.links?.find((item) => item.rel?.includes("summary")) ||
    event.links?.find((item) => item.href);

  if (link?.href) return link.href;

  const gameSlug = slug(event.name || event.shortName || event.id);
  return `https://www.espn.com/wnba/game/_/gameId/${event.id}/${gameSlug}`;
}

async function fetchJson(url, context) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "accept": "application/json",
          "user-agent": "WNBA Notifier/1.0",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`${context} failed: ${response.status} ${response.statusText}`);
      }

      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  throw lastError;
}

function normalizeTeamName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(women|woman|womens|women's|w)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function teamNamesMatch(left, right) {
  const normalizedLeft = normalizeTeamName(left);
  const normalizedRight = normalizeTeamName(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return (
    Math.min(normalizedLeft.length, normalizedRight.length) >= 5 &&
    (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  );
}

function findMatchingOddsEvent(game, events) {
  return (events || [])
    .filter(
      (event) =>
        teamNamesMatch(game.homeTeam, event.home) &&
        teamNamesMatch(game.awayTeam, event.away) &&
        Math.abs(new Date(game.startTime).getTime() - new Date(event.date).getTime()) <=
          ODDS_MATCH_MAX_TIME_DIFFERENCE_MS,
    )
    .sort(
      (a, b) =>
        Math.abs(new Date(game.startTime).getTime() - new Date(a.date).getTime()) -
        Math.abs(new Date(game.startTime).getTime() - new Date(b.date).getTime()),
    )[0];
}

function officialTeamName(team) {
  return `${team?.teamCity || ""} ${team?.teamName || ""}`.trim();
}

function flattenOfficialSchedule(payload) {
  return (payload?.leagueSchedule?.gameDates || []).flatMap((date) => date.games || []);
}

async function fetchOfficialWnbaSchedule(season) {
  const cached = officialScheduleCache.get(season);
  if (cached && Date.now() - cached.fetchedAt < WNBA_SCHEDULE_REFRESH_MS) return cached.games;

  const params = new URLSearchParams({ season: String(season), regionId: "1" });
  try {
    const payload = await fetchJson(`${WNBA_SCHEDULE_URL}?${params}`, `Official WNBA ${season} schedule`);
    const games = flattenOfficialSchedule(payload);
    officialScheduleCache.set(season, { fetchedAt: Date.now(), games });
    return games;
  } catch (error) {
    if (cached?.games?.length) return cached.games;
    throw error;
  }
}

function findMatchingOfficialGame(game, officialGames) {
  const startTime = new Date(game.startTime).getTime();
  return (officialGames || [])
    .filter((officialGame) => {
      const officialStartTime = new Date(officialGame.gameDateTimeUTC).getTime();
      return (
        teamNamesMatch(game.homeTeam, officialTeamName(officialGame.homeTeam)) &&
        teamNamesMatch(game.awayTeam, officialTeamName(officialGame.awayTeam)) &&
        Number.isFinite(startTime) &&
        Number.isFinite(officialStartTime) &&
        Math.abs(startTime - officialStartTime) <= WNBA_GAME_MATCH_MAX_TIME_DIFFERENCE_MS
      );
    })
    .sort(
      (left, right) =>
        Math.abs(startTime - new Date(left.gameDateTimeUTC).getTime()) -
        Math.abs(startTime - new Date(right.gameDateTimeUTC).getTime()),
    )[0];
}

async function attachOfficialWnbaGameLinks(games) {
  const existingById = new Map((state.games || []).map((game) => [game.espnId, game]));
  const seasons = [
    ...new Set(
      games
        .map((game) => new Date(game.startTime).getUTCFullYear())
        .filter((season) => Number.isInteger(season)),
    ),
  ];
  const schedulesBySeason = new Map();

  await Promise.all(
    seasons.map(async (season) => {
      try {
        schedulesBySeason.set(season, await fetchOfficialWnbaSchedule(season));
      } catch (error) {
        console.error(`Official WNBA ${season} schedule failed:`, error.message || error);
        schedulesBySeason.set(season, []);
      }
    }),
  );

  for (const game of games) {
    const season = new Date(game.startTime).getUTCFullYear();
    const officialGame = findMatchingOfficialGame(game, schedulesBySeason.get(season));
    const cachedGame = existingById.get(game.espnId);
    const wnbaGameId = String(officialGame?.gameId || cachedGame?.wnbaGameId || "").trim();
    if (!wnbaGameId) continue;

    game.wnbaGameId = wnbaGameId;
    game.wnbaUrl = `https://www.wnba.com/game/${encodeURIComponent(wnbaGameId)}`;
    game.condensedGameUrl = `${game.wnbaUrl}?watchCondensedGame=true`;
  }

  return games;
}

function decimalOdd(value) {
  const odd = Number(value);
  return Number.isFinite(odd) && odd >= 1.01 ? odd : null;
}

function bookmakerMarkets(payload) {
  const entries = Object.entries(payload?.bookmakers || {});
  return entries.find(([name]) => name.toLowerCase() === ODDS_BOOKMAKER.toLowerCase()) || entries.find(
    ([name]) => name.toLowerCase().startsWith("pamestoixima"),
  );
}

function extractPamestoiximaMoneyline(payload) {
  const bookmaker = bookmakerMarkets(payload);
  if (!bookmaker) return null;

  const [bookmakerName, markets] = bookmaker;
  const moneylineNames = new Set(["ml", "moneyline", "match winner", "winner", "2 way", "2 way ot included"]);
  const market = (markets || []).find((item) => moneylineNames.has(String(item.name || "").trim().toLowerCase()));
  const prices = market?.odds?.find((item) => decimalOdd(item.home) && decimalOdd(item.away));
  if (!prices) return null;

  const urls = payload.urls || {};
  const bookmakerUrlEntry = Object.entries(urls).find(
    ([name]) => name.toLowerCase() === bookmakerName.toLowerCase(),
  );

  return {
    bookmaker: bookmakerName,
    home: decimalOdd(prices.home),
    away: decimalOdd(prices.away),
    updatedAt: market.updatedAt || null,
    url: safeHttpUrl(bookmakerUrlEntry?.[1] || prices.homeLink || prices.awayLink, PAMESTOIXIMA_URL),
  };
}

async function resolveWnbaOddsLeagueSlug() {
  if (state.oddsLeagueSlug) return state.oddsLeagueSlug;

  const params = new URLSearchParams({ apiKey: ODDS_API_KEY, sport: "basketball" });
  const leagues = await fetchJson(`${ODDS_API_BASE_URL}/leagues?${params}`, "Odds API leagues");
  const league = (Array.isArray(leagues) ? leagues : []).find((item) => {
    const name = `${item.name || ""} ${item.slug || ""}`.toLowerCase();
    return name.includes("wnba") && !name.includes("all star");
  });

  if (!league?.slug) throw new Error("WNBA league is not available from the odds provider");
  state.oddsLeagueSlug = league.slug;
  return league.slug;
}

async function fetchPamestoiximaOdds(games) {
  const oddsWindowEnd = Date.now() + ODDS_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;
  const eligibleGames = games.filter(
    (game) => game.statusState !== "post" && new Date(game.startTime).getTime() <= oddsWindowEnd,
  );
  if (!eligibleGames.length) return games;

  const league = await resolveWnbaOddsLeagueSlug();
  const startTimes = eligibleGames.map((game) => new Date(game.startTime).getTime()).filter(Number.isFinite);
  const from = new Date(Math.min(Date.now(), ...startTimes) - 6 * 60 * 60 * 1000).toISOString();
  const to = new Date(Math.max(...startTimes) + 24 * 60 * 60 * 1000).toISOString();
  const eventParams = new URLSearchParams({
    apiKey: ODDS_API_KEY,
    sport: "basketball",
    league,
    bookmaker: ODDS_BOOKMAKER,
    status: "pending,live",
    from,
    to,
    limit: "500",
  });
  const eventsPayload = await fetchJson(`${ODDS_API_BASE_URL}/events?${eventParams}`, "Pamestoixima WNBA events");
  const events = Array.isArray(eventsPayload) ? eventsPayload : [];
  const matched = eligibleGames
    .map((game) => ({ game, event: findMatchingOddsEvent(game, events) }))
    .filter((item) => item.event?.id);

  for (let index = 0; index < matched.length; index += 10) {
    const batch = matched.slice(index, index + 10);
    const oddsParams = new URLSearchParams({
      apiKey: ODDS_API_KEY,
      eventIds: batch.map((item) => item.event.id).join(","),
      bookmakers: ODDS_BOOKMAKER,
    });
    const oddsPayload = await fetchJson(`${ODDS_API_BASE_URL}/odds/multi?${oddsParams}`, "Pamestoixima moneyline odds");
    const oddsById = new Map((Array.isArray(oddsPayload) ? oddsPayload : []).map((item) => [String(item.id), item]));

    for (const item of batch) {
      const odds = extractPamestoiximaMoneyline(oddsById.get(String(item.event.id)));
      if (odds) item.game.odds = odds;
    }
  }

  return games;
}

function reuseCachedOdds(games) {
  const existingById = new Map((state.games || []).map((game) => [game.espnId, game.odds]));
  for (const game of games) {
    const cached = existingById.get(game.espnId);
    if (cached && game.statusState !== "post") game.odds = cached;
  }
  return games;
}

async function attachPamestoiximaOdds(games) {
  if (!ODDS_API_KEY) return games;

  const lastAttempt = new Date(state.oddsLastCheck || 0).getTime();
  if (!state.oddsLastError && Number.isFinite(lastAttempt) && Date.now() - lastAttempt < ODDS_REFRESH_MS) {
    return reuseCachedOdds(games);
  }

  state.oddsLastCheck = new Date().toISOString();
  try {
    await fetchPamestoiximaOdds(games);
    state.oddsLastSuccess = state.oddsLastCheck;
    state.oddsLastError = null;
  } catch (error) {
    state.oddsLastError = error?.message || String(error);
    reuseCachedOdds(games);
    console.error("Pamestoixima odds failed:", state.oddsLastError);
  }

  return games;
}

function zonedDateTimeToUtc(year, month, day, hour, minute, timeZone) {
  const desiredWallTime = Date.UTC(year, month - 1, day, hour, minute);
  let instant = desiredWallTime;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const displayedWallTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    instant += desiredWallTime - displayedWallTime;
  }

  return new Date(instant);
}

function injuryReportTimestamp(href) {
  const match = String(href || "").match(
    /Injury-Report_(\d{4})-(\d{2})-(\d{2})_(\d{2})_(\d{2})(AM|PM)\.pdf/i,
  );
  if (!match) return null;

  const [, year, month, day, rawHour, minute, meridiem] = match;
  const hour = (Number(rawHour) % 12) + (meridiem.toUpperCase() === "PM" ? 12 : 0);
  return zonedDateTimeToUtc(Number(year), Number(month), Number(day), hour, Number(minute), "America/New_York");
}

async function fetchLatestInjuryReport() {
  const payload = await fetchJson("https://www.wnba.com/api/injury-reports", "Official WNBA injury report");
  const now = Date.now();
  const reports = (payload.links || [])
    .map((report) => {
      try {
        const url = new URL(report.href);
        if (url.protocol !== "https:" || url.hostname !== "ak-static.cms.nba.com") return null;
        const publishedAt = injuryReportTimestamp(url.href);
        return publishedAt
          ? { url: url.href, label: report.label || "Official report", publishedAt: publishedAt.toISOString() }
          : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((report) => {
      const age = now - new Date(report.publishedAt).getTime();
      return age >= -5 * 60 * 1000 && age <= INJURY_REPORT_MAX_AGE_MS;
    })
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  return reports[0] || null;
}

function normalizeEvent(event) {
  const competition = event.competitions?.[0] || {};
  const homeCompetitor = pickCompetitor(competition, "home");
  const awayCompetitor = pickCompetitor(competition, "away");
  const homeTeam = homeCompetitor.team || {};
  const awayTeam = awayCompetitor.team || {};
  const startTime = new Date(event.date || competition.date).toISOString();
  const away = awayTeam.displayName || awayTeam.name || "Away";
  const home = homeTeam.displayName || homeTeam.name || "Home";
  const statusType = event.status?.type || {};
  const awayScore = Number(awayCompetitor.score || 0);
  const homeScore = Number(homeCompetitor.score || 0);
  const awayRecords = competitorRecords(awayCompetitor, "away");
  const homeRecords = competitorRecords(homeCompetitor, "home");

  return {
    league: "WNBA",
    espnId: String(event.id || competition.id || ""),
    name: event.name || `${away} at ${home}`,
    shortName: event.shortName || `${awayTeam.abbreviation || away} @ ${homeTeam.abbreviation || home}`,
    homeTeam: home,
    awayTeam: away,
    homeRecord: homeRecords.overall,
    homeVenueRecord: homeRecords.venue,
    awayRecord: awayRecords.overall,
    awayVenueRecord: awayRecords.venue,
    homeScore,
    awayScore,
    startTime,
    status: statusType.description || statusType.name || "Scheduled",
    statusState: statusType.state || "pre",
    statusDetail: statusType.shortDetail || statusType.detail || "",
    completed: Boolean(statusType.completed),
    venue: competition.venue?.fullName || "",
    channel: broadcastNames(competition),
    url: eventUrl(event),
    source: "ESPN WNBA scoreboard API",
    id: `${event.id}|${slug(away)}|${slug(home)}|${slug(startTime)}`,
  };
}

async function fetchGames() {
  const now = Date.now();
  const dates = scoreboardDates(new Date(now));
  const today = yyyymmdd(new Date(now));
  const yesterday = yyyymmdd(new Date(now - 24 * 60 * 60 * 1000));
  const eventsByDate = new Map();
  for (const date of scoreboardCache.keys()) {
    if (!dates.includes(date)) scoreboardCache.delete(date);
  }

  // ESPN rejects date ranges. Fetch individual days with bounded concurrency;
  // keep yesterday fresh too, since US evening games finish after midnight UTC.
  let nextDate = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (nextDate < dates.length) {
      const date = dates[nextDate++];
      const cached = scoreboardCache.get(date);
      const maxAge = date >= yesterday && date <= today ? 0 :
        date > today ? 60 * 60 * 1000 : 5 * 60 * 1000;
      if (cached && now - cached.fetchedAt < maxAge) {
        eventsByDate.set(date, cached.events);
        continue;
      }
      const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?limit=300&dates=${date}`;
      const payload = await fetchJson(url, `ESPN scoreboard ${date}`);
      if (!Array.isArray(payload.events)) throw new Error(`ESPN scoreboard ${date}: missing events`);
      scoreboardCache.set(date, { fetchedAt: Date.now(), events: payload.events });
      eventsByDate.set(date, payload.events);
    }
  }));
  const events = new Map();
  for (const date of dates) {
    for (const event of eventsByDate.get(date)) events.set(String(event.id), event);
  }
  const historyCutoff = now - SCORE_HISTORY_DAYS * 24 * 60 * 60 * 1000;

  return [...events.values()]
    .map(normalizeEvent)
    .filter((game) => new Date(game.startTime).getTime() >= historyCutoff)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

function standingStat(entry, name) {
  return (entry.stats || []).find((stat) => stat.name === name);
}

function normalizeStandingEntry(entry, index) {
  const team = entry.team || {};
  const wins = standingStat(entry, "wins")?.displayValue || "0";
  const losses = standingStat(entry, "losses")?.displayValue || "0";

  return {
    rank: standingStat(entry, "playoffSeed")?.displayValue || String(index + 1),
    team: team.displayName || team.shortDisplayName || team.name || "Team",
    abbreviation: team.abbreviation || "",
    record: standingStat(entry, "overall")?.displayValue || `${wins}-${losses}`,
    wins: Number(wins),
    losses: Number(losses),
    winPercent: standingStat(entry, "winPercent")?.displayValue || "-",
    gamesBehind: standingStat(entry, "gamesBehind")?.displayValue || "-",
    streak: standingStat(entry, "streak")?.displayValue || "-",
  };
}

function overallStandings(groups) {
  const teams = new Map();

  for (const group of groups || []) {
    for (const entry of group.entries || []) {
      const key = String(entry.abbreviation || entry.team || "").trim().toUpperCase();
      if (!key || teams.has(key)) continue;

      const recordMatch = String(entry.record || "").match(/(\d+)\s*-\s*(\d+)/);
      const wins = Number.isFinite(entry.wins) ? entry.wins : Number(recordMatch?.[1] || 0);
      const losses = Number.isFinite(entry.losses) ? entry.losses : Number(recordMatch?.[2] || 0);
      teams.set(key, { ...entry, wins, losses });
    }
  }

  const entries = [...teams.values()].sort((a, b) => {
    const aPlayed = a.wins + a.losses;
    const bPlayed = b.wins + b.losses;
    const aPct = aPlayed ? a.wins / aPlayed : 0;
    const bPct = bPlayed ? b.wins / bPlayed : 0;
    return bPct - aPct || b.wins - a.wins || a.losses - b.losses || a.team.localeCompare(b.team);
  });

  const leader = entries[0];
  return entries.map((entry, index) => {
    const gamesBehind = leader
      ? ((leader.wins - entry.wins) + (entry.losses - leader.losses)) / 2
      : 0;

    return {
      ...entry,
      rank: String(index + 1),
      gamesBehind: gamesBehind === 0 ? "-" : Number.isInteger(gamesBehind) ? String(gamesBehind) : gamesBehind.toFixed(1),
    };
  });
}

async function fetchStandings() {
  const payload = await fetchJson(STANDINGS_URL, "ESPN standings");

  return (payload.children || [])
    .map((group) => ({
      name: group.name || group.abbreviation || "WNBA",
      entries: (group.standings?.entries || []).map(normalizeStandingEntry),
    }))
    .filter((group) => group.entries.length);
}

async function fetchBoxScore(game) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/summary?event=${encodeURIComponent(game.espnId)}`;
  const payload = await fetchJson(url, `ESPN summary for ${game.espnId}`);
  return normalizeBoxScore(payload);
}

function normalizeBoxScore(payload) {
  const players = payload.boxscore?.players || [];

  return players
    .map((team) => {
      const table = team.statistics?.[0] || {};
      const labels = table.labels || [];
      const athletes = (table.athletes || [])
        .filter((entry) => !entry.didNotPlay)
        .map((entry) => ({
          name: entry.athlete?.displayName || entry.athlete?.shortName || "Player",
          position: entry.athlete?.position?.abbreviation || "",
          starter: Boolean(entry.starter),
          stats: entry.stats || [],
        }));

      return {
        team: team.team?.displayName || team.team?.name || "Team",
        labels,
        athletes,
      };
    })
    .filter((team) => team.labels.length && team.athletes.length);
}

async function attachBoxScores(games) {
  const existingById = new Map((state.games || []).map((game) => [game.espnId, game.boxScore]));
  const gamesWithStats = games.filter((game) => game.statusState !== "pre").slice(0, BOX_SCORE_LIMIT);

  await Promise.all(
    gamesWithStats.map(async (game) => {
      try {
        game.boxScore = await fetchBoxScore(game);
      } catch (error) {
        game.boxScore = existingById.get(game.espnId) || [];
        console.error(`WNBA box score failed for ${game.espnId}:`, error.message || error);
      }
    }),
  );

  for (const game of games) {
    if (!game.boxScore) game.boxScore = existingById.get(game.espnId) || [];
  }

  return games;
}

async function checkGames() {
  try {
    const fetchedGames = await fetchGames();
    const [games, injuryReport, standings] = await Promise.all([
      Promise.all([
        attachBoxScores(fetchedGames),
        attachPamestoiximaOdds(fetchedGames),
        attachOfficialWnbaGameLinks(fetchedGames),
      ]).then(() => fetchedGames),
      fetchLatestInjuryReport().catch((error) => {
        console.error("Official WNBA injury report failed:", error.message || error);
        const existing = state.injuryReport;
        const existingAge = existing ? Date.now() - new Date(existing.publishedAt).getTime() : Infinity;
        return existingAge <= INJURY_REPORT_MAX_AGE_MS ? existing : null;
      }),
      fetchStandings().catch((error) => {
        console.error("WNBA standings failed:", error.message || error);
        return state.standings || [];
      }),
    ]);
    state.games = games;
    state.injuryReport = injuryReport;
    state.standings = standings;
    state.lastCheck = new Date().toISOString();
    state.lastError = null;

    sendDueReminders(games);
    saveState();
  } catch (error) {
    state.lastCheck = new Date().toISOString();
    state.lastError = error?.stack || String(error);
    saveState();
    console.error("WNBA notifier check failed:", error);
  } finally {
    scheduleNextCheck();
  }
}

function hasLiveGame() {
  return (state.games || []).some((game) => game.statusState === "in");
}

function scheduleNextCheck() {
  if (checkTimer) clearTimeout(checkTimer);
  const delay = hasLiveGame() ? LIVE_CHECK_EVERY_MS : CHECK_EVERY_MS;
  checkTimer = setTimeout(checkGames, delay);
  checkTimer.unref();
}

function sendDueReminders(games) {
  const now = Date.now();

  for (const game of games) {
    const startsAt = new Date(game.startTime).getTime();
    const minutesUntil = Math.ceil((startsAt - now) / 60000);
    if (minutesUntil <= 0) continue;

    for (const threshold of REMINDER_MINUTES) {
      if (minutesUntil > threshold) continue;

      const key = `${game.id}|${threshold}`;
      if (state.sent[key]) continue;

      state.sent[key] = new Date().toISOString();
      logReminder(game, minutesUntil);
    }
  }
}

function logReminder(game, minutesUntil) {
  const hours = Math.max(1, Math.round(minutesUntil / 60));
  const startsIn =
    minutesUntil >= 24 * 60
      ? `${Math.round(minutesUntil / (24 * 60))} day(s)`
      : minutesUntil >= 60
        ? `${hours} hour(s)`
        : `${minutesUntil} minute(s)`;

  console.log(`WNBA reminder: ${game.awayTeam} at ${game.homeTeam}`);
  console.log(`Starts in ${startsIn}`);
  console.log(`Time: ${formatLocalTime(game.startTime)} (${TZ})`);
  console.log(`Venue: ${game.venue || "TBD"}`);
  console.log(`Channel: ${game.channel || "TBD"}`);
  console.log(`Source: ${game.url}`);
}

function scoreText(game) {
  if (game.statusState === "pre") return "-";
  return `${game.awayScore ?? 0} - ${game.homeScore ?? 0}`;
}

function statusBadge(game) {
  const state = game.statusState === "in" ? "live" : game.statusState === "post" ? "post" : "pre";
  const label = state === "live" ? `LIVE ${game.statusDetail || game.status}` : game.completed ? "Final" : "Scheduled";
  return `<span class="badge ${state}">${escapeHtml(label)}</span>`;
}

function formatOdd(value) {
  const odd = decimalOdd(value);
  return odd ? odd.toFixed(2) : "—";
}

function renderPamestoiximaOdds(game) {
  const odds = game.odds;
  if (!odds) return '<span class="odds-empty">—</span>';

  const updatedAt = odds.updatedAt ? `Updated ${formatLocalTime(odds.updatedAt)}` : "Current available odds";
  return `<a class="odds-card" href="${escapeHtml(safeHttpUrl(odds.url, PAMESTOIXIMA_URL))}" title="${escapeHtml(updatedAt)}">
    <span class="odds-brand">Pamestoixima</span>
    <span class="odds-price"><small>Away</small>${escapeHtml(formatOdd(odds.away))}</span>
    <span class="odds-price"><small>Home</small>${escapeHtml(formatOdd(odds.home))}</span>
  </a>`;
}

function renderGameLinks(game) {
  const source = `<a class="source-link" href="${escapeHtml(game.url)}">source</a>`;
  if (!game.completed || !game.condensedGameUrl) return `<div class="game-links">${source}</div>`;

  const condensedUrl = safeHttpUrl(game.condensedGameUrl);
  if (!condensedUrl) return `<div class="game-links">${source}</div>`;

  return `<div class="game-links">
    <a class="condensed-link" href="${escapeHtml(condensedUrl)}" target="_blank" rel="noopener" title="Open the official WNBA condensed game">Condensed game</a>
    ${source}
  </div>`;
}

function oddsFeedStatus() {
  if (!ODDS_API_KEY) return "not configured";
  if (state.oddsLastError) return "temporarily unavailable; cached odds may be shown";
  if (state.oddsLastSuccess) return `updated ${formatLocalTime(state.oddsLastSuccess)}`;
  return "waiting for first update";
}

function renderBoxScore(game) {
  if (!game.boxScore?.length) {
    return game.statusState === "pre"
      ? `<div class="box-empty">Box score will appear when the game starts.</div>`
      : `<div class="box-empty">Box score not available yet.</div>`;
  }

  return `<div class="box-score">
    ${game.boxScore.map(renderTeamBoxScore).join("")}
  </div>`;
}

function renderBoxScorePanel(game) {
  const available = Boolean(game.boxScore?.length);
  const gameId = game.espnId || game.id || "unknown-game";
  const message = available
    ? "Player stats and team box score"
    : game.statusState === "pre"
      ? "Available once the game starts"
      : "Not available yet";

  return `<details class="box-details" data-game-id="${escapeHtml(gameId)}">
    <summary>
      <span class="box-details-title">Box score</span>
      <span class="box-details-status">${escapeHtml(message)}</span>
    </summary>
    <div class="box-details-content">${renderBoxScore(game)}</div>
  </details>`;
}

function renderTeamBoxScore(team) {
  const labels = ["Player", ...team.labels];
  const rows = team.athletes
    .map((player) => {
      const starter = player.starter ? " <span class=\"starter\">S</span>" : "";
      const name = `${escapeHtml(player.name)}${starter}`;
      const position = player.position ? ` <span class="position">${escapeHtml(player.position)}</span>` : "";
      return `<tr><td class="player">${name}${position}</td>${team.labels
        .map((_, index) => `<td>${escapeHtml(player.stats[index] ?? "")}</td>`)
        .join("")}</tr>`;
    })
    .join("");

  return `<section class="team-box">
    <h3>${escapeHtml(team.team)}</h3>
    <div class="box-scroll">
      <table class="stats-table">
        <thead><tr>${labels.map((label) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderTeamRecord(overall, venue, venueLabel) {
  if (!overall && !venue) return "";

  const overallText = overall ? `<span>${escapeHtml(overall)}</span>` : "";
  const venueText = venue ? `<span class="venue-record">${escapeHtml(venueLabel)} ${escapeHtml(venue)}</span>` : "";
  const separator = overall && venue ? `<span class="record-separator">•</span>` : "";
  return `<span class="team-record">${overallText}${separator}${venueText}</span>`;
}

function renderInjuryReport() {
  const report = state.injuryReport;
  if (!report) {
    return `<section class="injury-report injury-report-empty">
      <div><span class="injury-eyebrow">Official WNBA</span><h2>Latest injury report</h2></div>
      <span>No official report published within the last 24 hours.</span>
    </section>`;
  }

  return `<section class="injury-report">
    <div>
      <span class="injury-eyebrow">Official WNBA • Last 24 hours</span>
      <h2>Latest injury report</h2>
      <span class="injury-updated">Updated ${escapeHtml(formatLocalTime(report.publishedAt))}</span>
    </div>
    <a class="injury-link" href="${escapeHtml(report.url)}">Open PDF report</a>
  </section>`;
}

function renderStandings() {
  const overallEntries = overallStandings(state.standings);
  const groups = overallEntries.length ? [{ name: "Overall Standings", entries: overallEntries }] : [];
  const cards = groups
    .map((group) => {
      const rows = (group.entries || [])
        .map((entry) => {
          const streakClass = /^W/i.test(entry.streak)
            ? "streak-win"
            : /^L/i.test(entry.streak)
              ? "streak-loss"
              : "";

          return `<tr>
            <td class="standing-rank">${escapeHtml(entry.rank)}</td>
            <td class="standing-team"><span class="standing-abbr">${escapeHtml(entry.abbreviation)}</span>${escapeHtml(entry.team)}</td>
            <td>${escapeHtml(entry.record)}</td>
            <td class="standings-pct">${escapeHtml(entry.winPercent)}</td>
            <td class="standings-gb">${escapeHtml(entry.gamesBehind)}</td>
            <td><span class="streak ${streakClass}">${escapeHtml(entry.streak)}</span></td>
          </tr>`;
        })
        .join("");

      return `<article class="standings-card">
        <h3>${escapeHtml(group.name)}</h3>
        <div class="standings-scroll">
          <table class="standings-table">
            <thead><tr><th>#</th><th>Team</th><th>W-L</th><th class="standings-pct">PCT</th><th class="standings-gb">GB</th><th>Streak</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </article>`;
    })
    .join("");

  return `<section class="standings-section">
    <div class="standings-heading">
      <div><span class="standings-eyebrow">Current season</span><h2>WNBA Standings</h2></div>
      <span class="standings-note">W = wins • L = losses</span>
    </div>
    ${cards ? `<div class="standings-grid">${cards}</div>` : '<div class="standings-empty">Standings are temporarily unavailable.</div>'}
  </section>`;
}

function renderPage() {
  const rows = (state.games || [])
    .map(
      (game) => `
    <tr class="game-row ${game.statusState === "in" ? "live-row" : ""}">
      <td class="team-cell away-team" data-label="Away"><span class="team-label">AWAY</span><span class="team-name">${escapeHtml(game.awayTeam)}</span>${renderTeamRecord(game.awayRecord, game.awayVenueRecord, "Away")}</td>
      <td class="team-cell home-team" data-label="Home"><span class="team-label">HOME</span><span class="team-name">${escapeHtml(game.homeTeam)}</span>${renderTeamRecord(game.homeRecord, game.homeVenueRecord, "Home")}</td>
      <td class="score" data-label="Score"><span class="score-label">Score</span><span class="score-value">${escapeHtml(scoreText(game))}</span></td>
      <td class="game-meta game-odds" data-label="Pamestoixima">${renderPamestoiximaOdds(game)}</td>
      <td class="game-meta game-status" data-label="Status">${statusBadge(game)}</td>
      <td class="game-meta game-time" data-label="Time">${escapeHtml(formatLocalTime(game.startTime))}</td>
      <td class="game-meta game-venue" data-label="Venue">${escapeHtml(game.venue || "TBD")}</td>
      <td class="game-meta game-channel" data-label="Channel">${escapeHtml(game.channel || "TBD")}</td>
      <td class="game-meta game-link" data-label="Links">${renderGameLinks(game)}</td>
    </tr>
    <tr class="box-row ${game.statusState === "in" ? "live-row" : ""}">
      <td colspan="9">${renderBoxScorePanel(game)}</td>
    </tr>
  `,
    )
    .join("");

  const status = state.lastError ? "ERROR" : "OK";
  const refreshMs = hasLiveGame() ? LIVE_PAGE_REFRESH_MS : PAGE_REFRESH_MS;
  const refreshSeconds = Math.max(1, Math.round(refreshMs / 1000));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="${refreshSeconds}">
  <title>WNBA Notifier</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; color: #172033; background: #edf2f7; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px 16px; }
    h1 { margin: 0 0 6px; font-size: 28px; color: #111c44; }
    p { margin: 0 0 18px; color: #526076; }
    table { width: 100%; border-collapse: separate; border-spacing: 0 8px; }
    th, td { padding: 10px 12px; text-align: left; }
    thead th { background: #111c44; color: #fff; font-weight: 600; }
    thead th:first-child { border-radius: 10px 0 0 10px; }
    thead th:last-child { border-radius: 0 10px 10px 0; }
    .game-row > td { background: #fff; border-top: 1px solid #dce3ed; border-bottom: 1px solid #dce3ed; }
    .game-row > td:first-child { border-left: 1px solid #dce3ed; border-radius: 10px 0 0 10px; }
    .game-row > td:last-child { border-right: 1px solid #dce3ed; border-radius: 0 10px 10px 0; }
    .team-cell { font-weight: 700; min-width: 130px; }
    .team-name { display: block; }
    .team-label { display: block; width: fit-content; margin-bottom: 5px; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800; letter-spacing: .06em; }
    .team-record { display: flex; flex-wrap: wrap; gap: 3px 6px; margin-top: 6px; color: #526076; font-size: 12px; font-weight: 600; line-height: 1.2; }
    .record-separator { color: #9aa6b6; }
    .venue-record { font-weight: 500; }
    .away-team { border-left: 5px solid #2e65bf !important; color: #173d7a; }
    .away-team .team-label { background: #e5efff; color: #24549e; }
    .home-team { border-left: 5px solid #e96f22; color: #9d3c0b; }
    .home-team .team-label { background: #fff0e7; color: #bf4f13; }
    .score { background: #162a60 !important; color: #fff; font-size: 19px; font-weight: 800; letter-spacing: .03em; text-align: center; white-space: nowrap; }
    .score-label { display: none; }
    .game-odds { min-width: 122px; }
    .odds-card { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; color: inherit; text-decoration: none; }
    .odds-brand { grid-column: 1 / -1; color: #17653a; font-size: 11px; font-weight: 800; letter-spacing: .02em; }
    .odds-price { display: flex; align-items: baseline; justify-content: space-between; gap: 5px; padding: 4px 6px; border-radius: 5px; background: #e9f7ef; color: #0a6b35; font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .odds-price small { color: #577264; font-size: 9px; font-weight: 700; text-transform: uppercase; }
    .odds-card:hover .odds-price { background: #d8f0e2; }
    .odds-empty { color: #94a3b8; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 13px; font-weight: 700; white-space: nowrap; }
    .badge.pre { background: #eef2f7; color: #334155; }
    .badge.live { background: #ffe8e8; color: #b00020; }
    .badge.post { background: #e9f7ef; color: #0a6b35; }
    .game-links { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; }
    .condensed-link { display: inline-flex; align-items: center; gap: 6px; padding: 7px 9px; border: 0; border-radius: 7px; background: #e96f22; color: #fff; font: inherit; font-size: 12px; font-weight: 800; line-height: 1.15; text-decoration: none; white-space: nowrap; cursor: pointer; }
    .condensed-link::before { content: "▶"; font-size: 10px; }
    .condensed-link:hover { background: #c65312; }
    .source-link { font-size: 12px; }
    .live-row > td { background: #fff9f5; border-color: #ffd7bd; }
    .live-row .score { background: #ba3e15 !important; }
    .box-row > td { padding: 0; }
    .box-details { overflow: hidden; border: 1px solid #cfd9e8; border-radius: 10px; background: #f8fbff; }
    .box-details summary { display: flex; align-items: center; gap: 10px; padding: 12px 14px; color: #1a3d75; font-weight: 700; cursor: pointer; list-style: none; }
    .box-details summary::-webkit-details-marker { display: none; }
    .box-details summary::before { content: "+"; display: inline-grid; width: 20px; height: 20px; place-items: center; border-radius: 50%; background: #2e65bf; color: #fff; font-size: 17px; line-height: 1; }
    .box-details[open] summary { border-bottom: 1px solid #cfd9e8; background: #e9f2ff; }
    .box-details[open] summary::before { content: "−"; }
    .box-details-title { font-size: 15px; }
    .box-details-status { margin-left: auto; color: #66758c; font-size: 13px; font-weight: 400; text-align: right; }
    .box-details-content { padding: 10px 14px 16px; }
    .box-score { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding-top: 4px; }
    .team-box h3 { margin: 8px 0; font-size: 16px; }
    .box-scroll { overflow-x: auto; border: 1px solid #e6e6e6; background: #fff; }
    .stats-table { min-width: 760px; border: 0; font-size: 13px; }
    .stats-table th, .stats-table td { padding: 7px 8px; white-space: nowrap; }
    .stats-table th { background: #f0f2f5; color: #20242a; }
    .stats-table .player { min-width: 160px; font-weight: 700; }
    .stats-table th:not(:first-child), .stats-table td:not(:first-child) { text-align: center; font-variant-numeric: tabular-nums; }
    .starter { margin-left: 4px; color: #0a6b35; font-size: 11px; }
    .position { color: #666; font-weight: 400; }
    .box-empty { padding: 10px 0 4px; color: #666; font-size: 14px; }
    .status { margin: 14px 0; padding: 10px 12px; background: #fff; border-left: 4px solid ${state.lastError ? "#b00020" : "#0a7c3d"}; }
    .standings-section { margin: 0 0 18px; padding: 16px; border: 1px solid #d7e0ee; border-radius: 12px; background: #fff; }
    .standings-heading { display: flex; align-items: end; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
    .standings-heading h2 { margin: 3px 0 0; color: #111c44; font-size: 21px; }
    .standings-eyebrow { color: #2e65bf; font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .standings-note { color: #657186; font-size: 12px; }
    .standings-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .standings-card { overflow: hidden; border: 1px solid #dce3ed; border-radius: 10px; }
    .standings-card h3 { margin: 0; padding: 10px 12px; background: #eef4fc; color: #173d7a; font-size: 15px; }
    .standings-scroll { overflow-x: auto; }
    .standings-table { margin: 0; border-spacing: 0; font-size: 13px; }
    .standings-table th, .standings-table td { padding: 8px 7px; white-space: nowrap; }
    .standings-table thead th { border-radius: 0; background: #162a60; font-size: 11px; letter-spacing: .03em; text-transform: uppercase; }
    .standings-table th:not(:nth-child(2)), .standings-table td:not(:nth-child(2)) { text-align: center; font-variant-numeric: tabular-nums; }
    .standings-table tbody tr:not(:last-child) td { border-bottom: 1px solid #e7ecf3; }
    .standing-rank { width: 24px; color: #657186; font-weight: 700; }
    .standing-team { min-width: 145px; font-weight: 700; }
    .standing-abbr { display: inline-block; min-width: 28px; margin-right: 6px; color: #2e65bf; font-size: 11px; }
    .streak { display: inline-block; min-width: 27px; padding: 3px 6px; border-radius: 999px; background: #eef2f7; font-weight: 800; }
    .streak-win { background: #dcfce7; color: #087437; }
    .streak-loss { background: #fee2e2; color: #b42318; }
    .standings-empty { padding: 14px; border-radius: 8px; background: #f8fafc; color: #657186; font-size: 13px; }
    .injury-report { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin: 0 0 18px; padding: 14px 16px; border: 1px solid #f0c6c6; border-left: 5px solid #c93a3a; border-radius: 10px; background: #fff7f7; }
    .injury-report h2 { margin: 3px 0 4px; color: #7f1d1d; font-size: 18px; }
    .injury-eyebrow { color: #a32828; font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .injury-updated, .injury-report-empty > span { color: #657186; font-size: 13px; }
    .injury-link { flex: 0 0 auto; padding: 9px 12px; border-radius: 8px; background: #a72424; color: #fff; font-size: 13px; font-weight: 700; text-decoration: none; }
    .injury-link:hover { background: #861b1b; }
    .injury-report-empty { border-color: #dce3ed; border-left-color: #94a3b8; background: #fff; }
    .injury-report-empty h2 { color: #334155; }
    .injury-report-empty .injury-eyebrow { color: #64748b; }
    .refresh { color: #666; font-size: 13px; }
    .responsible-note { margin: 6px 0 0; color: #657186; font-size: 11px; line-height: 1.4; }
    a { color: #0b5cad; }
    @media (max-width: 980px) {
      .box-score { grid-template-columns: 1fr; }
    }
    @media (max-width: 980px) {
      main { width: 100%; box-sizing: border-box; padding: 22px 12px 32px; overflow: hidden; }
      h1 { font-size: 28px; line-height: 1.15; }
      p { font-size: 16px; line-height: 1.35; }
      .status { box-sizing: border-box; margin: 14px 0 18px; padding: 12px; overflow-wrap: anywhere; }
      .standings-section { padding: 13px; }
      .standings-heading { align-items: start; flex-direction: column; gap: 5px; }
      .standings-grid { grid-template-columns: 1fr; }
      .injury-report { align-items: stretch; flex-direction: column; gap: 12px; padding: 14px; }
      .injury-link { box-sizing: border-box; width: 100%; text-align: center; }
      .games-table, .games-table tbody { display: block; width: 100%; }
      .games-table { border-spacing: 0; }
      .games-table thead { display: none; }
      .game-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        width: 100%;
        overflow: hidden;
        border: 1px solid #dce3ed;
        border-radius: 14px;
        background: #fff;
        box-shadow: 0 4px 14px rgba(17, 28, 68, .06);
      }
      .game-row + .box-row { margin-top: 8px; }
      .box-row + .game-row { margin-top: 18px; }
      .game-row > td,
      .game-row > td:first-child,
      .game-row > td:last-child {
        display: block;
        min-width: 0;
        box-sizing: border-box;
        border: 0;
        border-radius: 0;
        overflow-wrap: anywhere;
      }
      .team-cell { min-height: 112px; padding: 15px 12px; font-size: 17px; line-height: 1.25; }
      .team-record { margin-top: 7px; font-size: 12px; }
      .away-team { border-left: 5px solid #2e65bf !important; }
      .home-team { border-left: 5px solid #e96f22 !important; }
      .score {
        display: grid !important;
        grid-column: 1 / -1;
        grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
        align-items: center;
        padding: 12px 14px;
        font-size: 24px;
        text-align: center;
      }
      .score-label { display: block; justify-self: end; margin-right: 12px; font-size: 11px; font-weight: 700; letter-spacing: .08em; opacity: .72; text-transform: uppercase; }
      .score-value { grid-column: 2; }
      .game-meta {
        position: relative;
        padding: 27px 12px 12px !important;
        border-top: 1px solid #e7ecf3 !important;
        color: #243147;
        font-size: 14px;
        line-height: 1.35;
      }
      .game-meta::before {
        content: attr(data-label);
        position: absolute;
        top: 9px;
        left: 12px;
        color: #718096;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: .08em;
        text-transform: uppercase;
      }
      .game-odds { grid-column: 1 / -1; }
      .odds-card { max-width: 250px; }
      .game-venue, .game-channel { grid-column: 1 / -1; }
      .game-link { grid-column: 1 / -1; padding-top: 25px !important; }
      .box-row { display: block; width: 100%; }
      .box-row > td { display: block; width: 100%; }
      .box-details { width: 100%; box-sizing: border-box; border-radius: 12px; }
      .box-details summary { display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: start; column-gap: 10px; row-gap: 4px; padding: 12px; }
      .box-details summary::before { grid-row: span 2; }
      .box-details-title { align-self: center; }
      .box-details-status { grid-column: 2; max-width: none; margin: 0; line-height: 1.3; text-align: left; }
      .box-details-content { min-width: 0; padding: 10px 12px 16px; }
      .box-score, .team-box, .box-scroll { min-width: 0; max-width: 100%; }
      .team-box h3 { margin: 8px 0 6px; padding-left: 2px; }
      .box-scroll { border-radius: 8px; -webkit-overflow-scrolling: touch; }
      .stats-table { display: table; width: 100%; min-width: 650px; }
      .stats-table thead { display: table-header-group; }
      .stats-table tbody { display: table-row-group; }
      .stats-table tr { display: table-row; }
      .stats-table th, .stats-table td { display: table-cell; width: auto; }
      .stats-table th:first-child, .stats-table td:first-child { position: sticky; left: 0; z-index: 1; background: #fff; text-align: left; }
      .stats-table th:first-child { background: #f0f2f5; box-shadow: 3px 0 5px rgba(23, 32, 51, .08); }
      .stats-table td:first-child { box-shadow: 3px 0 5px rgba(23, 32, 51, .05); }
    }
    @media (max-width: 380px) {
      main { padding-inline: 9px; }
      .standings-pct, .standings-gb { display: none; }
      .standing-team { min-width: 130px; }
      .team-cell { padding-inline: 10px; font-size: 16px; }
      .box-details-status { display: none; }
    }
  </style>
</head>
<body>
  <main>
    <h1>WNBA Notifier</h1>
    <p>WNBA games with live scores, final results, and local reminder times.</p>
    <div class="status">
      Last check (local time): <time id="last-check" datetime="${escapeHtml(state.lastCheck || "")}">${escapeHtml(state.lastCheck || "never")}</time><br>
      Status: ${status}<br>
      Pamestoixima odds: ${escapeHtml(oddsFeedStatus())}<br>
      <span class="refresh">Auto refresh: ${refreshSeconds}s</span>
    </div>
    ${renderStandings()}
    ${renderInjuryReport()}
    <table class="games-table">
      <thead><tr><th>Away</th><th>Home</th><th>Score</th><th>Pamestoixima</th><th>Status</th><th>Time</th><th>Venue</th><th>Channel</th><th>Links</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9">No WNBA games found.</td></tr>'}</tbody>
    </table>
    <p class="responsible-note">21+ • Play responsibly. Odds can change or be withdrawn; confirm them on Pamestoixima before placing a bet.</p>
  </main>
  <script>
    (() => {
      const stateKey = "wnba-page-state:" + window.location.pathname;
      const boxes = Array.from(document.querySelectorAll(".box-details[data-game-id]"));
      const lastCheck = document.getElementById("last-check");

      if (lastCheck && lastCheck.dateTime) {
        const lastCheckDate = new Date(lastCheck.dateTime);
        if (!Number.isNaN(lastCheckDate.getTime())) {
          lastCheck.textContent = lastCheckDate.toLocaleString();
        }
      }

      if ("scrollRestoration" in history) history.scrollRestoration = "manual";

      function readState() {
        try {
          return JSON.parse(sessionStorage.getItem(stateKey) || "{}");
        } catch {
          return {};
        }
      }

      function saveState() {
        try {
          sessionStorage.setItem(stateKey, JSON.stringify({
            scrollY: window.scrollY,
            openGames: boxes.filter((box) => box.open).map((box) => box.dataset.gameId),
          }));
        } catch {
          // The page still works when browser storage is unavailable.
        }
      }

      const savedState = readState();
      const openGames = new Set(Array.isArray(savedState.openGames) ? savedState.openGames : []);
      boxes.forEach((box) => {
        box.open = openGames.has(box.dataset.gameId);
        box.addEventListener("toggle", saveState);
      });

      const savedScrollY = Number(savedState.scrollY);
      if (Number.isFinite(savedScrollY) && savedScrollY > 0) {
        requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, savedScrollY)));
      }

      window.addEventListener("pagehide", saveState);
      window.addEventListener("beforeunload", saveState);
    })();
  </script>
</body>
</html>`;
}

const server = http.createServer((request, response) => {
  if (request.url === "/downloads/wnba-notifier.apk") {
    if (!fs.existsSync(APK_FILE)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("APK not available.");
      return;
    }

    const apkSize = fs.statSync(APK_FILE).size;
    response.writeHead(200, {
      "cache-control": "public, max-age=300",
      "content-disposition": 'attachment; filename="WNBA-Notifier.apk"',
      "content-length": apkSize,
      "content-type": "application/vnd.android.package-archive",
    });

    if (request.method === "HEAD") {
      response.end();
    } else {
      fs.createReadStream(APK_FILE).pipe(response);
    }
    return;
  }

  if (request.url === "/health") {
    response.writeHead(state.lastError ? 500 : 200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({
      ok: !state.lastError,
      lastCheck: state.lastCheck,
      lastError: state.lastError,
      odds: {
        configured: Boolean(ODDS_API_KEY),
        bookmaker: ODDS_BOOKMAKER,
        lastCheck: state.oddsLastCheck || null,
        lastSuccess: state.oddsLastSuccess || null,
        lastError: state.oddsLastError || null,
      },
    }));
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(renderPage());
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`WNBA notifier listening on ${PORT}`);
    checkGames();
  });
}

module.exports = {
  attachOfficialWnbaGameLinks,
  extractPamestoiximaMoneyline,
  fetchPamestoiximaOdds,
  findMatchingOfficialGame,
  findMatchingOddsEvent,
  flattenOfficialSchedule,
  normalizeTeamName,
  overallStandings,
  renderPage,
  renderGameLinks,
  renderPamestoiximaOdds,
  teamNamesMatch,
};
