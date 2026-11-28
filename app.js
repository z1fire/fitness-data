// Fitness data dashboard. Loads the SQLite database the Project Z app uploads
// (database/projectz-fitness.db) into the browser with sql.js and draws
// everything from it. No server, no build step.

const DB_URL = "database/projectz-fitness.db";
const SQL_JS = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/";

// Muscle ids → names, as in Project Z (fitness/model/Exercise.kt, Muscles.ALL).
const MUSCLES = {
  neck: "Neck", chest: "Chest", front_deltoid: "Front Delt", side_deltoid: "Side Delt", rear_deltoid: "Rear Delt",
  biceps: "Biceps", triceps: "Triceps", forearms: "Forearms", traps: "Traps", lats: "Lats", rhomboids: "Rhomboids",
  abs: "Abs", obliques: "Obliques", lower_back: "Lower Back", hip_flexors: "Hip Flexors", quads: "Quads",
  hamstrings: "Hamstrings", glutes: "Glutes", calves: "Calves", adductors: "Adductors", tibialis: "Shins",
};
const UPPER = ["neck", "chest", "front_deltoid", "side_deltoid", "rear_deltoid", "biceps", "triceps", "forearms", "traps", "lats", "rhomboids"];
const LOWER = ["hip_flexors", "quads", "hamstrings", "glutes", "calves", "adductors", "tibialis"];
const PATTERNS = {
  PUSH: "Push", PULL: "Pull", SQUAT: "Squat", HINGE: "Hinge", LUNGE: "Lunge",
  CORE: "Core", GRIP: "Grip", CARRY: "Carry", LOCOMOTION: "Locomotion", OTHER: "Other",
};
const KINDS = { Isometric: "Load cell", Set: "Sets", Cardio: "Cardio", Hold: "Hold" };
const MAX_1RM_REPS = 12;
const SERIES = ["--s1", "--s2", "--s3"];
// Each side keeps its color in every chart, whichever sides are present.
const SIDE_COLORS = { Both: "--s1", Left: "--s2", Right: "--s3" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY = 86400000;

const WEEKLY = {
  days: { y: "Training days", unit: "days", max: 7, hint: "Days with at least one logged entry of any kind." },
  sessions: { y: "Workouts", unit: "workouts", hint: "A new workout starts after 2 hours without logging." },
  minutes: { y: "Workout time (min)", unit: "min", hint: "From the first to the last entry of each workout." },
  sets: { y: "Working sets", unit: "sets", hint: "Strength sets, load-cell efforts, and timed holds.", value: (e) => (e.kind === "Cardio" ? 0 : 1) },
  tonnage: { y: "Volume (lbs)", unit: "lbs", hint: "Load × reps of every set. Bodyweight sets count body weight plus any added load.", value: (e) => tonnage(e) },
  cardio: { y: "Cardio (min)", unit: "min", hint: "Every cardio entry, including the under-desk bike.", value: (e) => (e.kind === "Cardio" ? (e.seconds || 0) / 60 : 0) },
  calories: { y: "Calories (kcal)", unit: "kcal", hint: "Estimated from MET × body weight × duration when each entry was saved.", value: (e) => e.calories || 0 },
};

const EXAMPLES = [
  ["Sets and heaviest load per exercise", `SELECT e.name, COUNT(*) AS sets, MAX(s.load_lbs) AS heaviest_lbs
FROM fitness_sets s JOIN fitness_exercises e ON e.id = s.exercise_id
GROUP BY e.name ORDER BY sets DESC`],
  ["Load-cell peaks by exercise and side", `SELECT e.name, f.side, COUNT(*) AS efforts,
  ROUND(MAX(f.peak_lbs), 1) AS best_peak_lbs, ROUND(AVG(f.peak_lbs), 1) AS avg_peak_lbs
FROM fitness_iso_efforts f JOIN fitness_exercises e ON e.id = f.exercise_id
GROUP BY e.name, f.side ORDER BY efforts DESC`],
  ["Training days per month", `SELECT substr(local_date, 1, 7) AS month, COUNT(DISTINCT local_date) AS training_days
FROM (SELECT local_date FROM fitness_sets UNION ALL SELECT local_date FROM fitness_iso_efforts
      UNION ALL SELECT local_date FROM fitness_cardio UNION ALL SELECT local_date FROM fitness_holds)
GROUP BY month ORDER BY month`],
  ["Sets per primary muscle", `SELECT m.muscle, COUNT(*) AS sets
FROM (SELECT exercise_id FROM fitness_sets UNION ALL SELECT exercise_id FROM fitness_iso_efforts
      UNION ALL SELECT exercise_id FROM fitness_holds) x
JOIN fitness_exercise_muscles m ON m.exercise_id = x.exercise_id AND m.role = 'primary'
GROUP BY m.muscle ORDER BY sets DESC`],
  ["Cardio minutes by month and exercise", `SELECT substr(c.local_date, 1, 7) AS month, e.name,
  ROUND(SUM(c.duration_sec) / 60.0) AS minutes, ROUND(SUM(c.calories)) AS calories
FROM fitness_cardio c JOIN fitness_exercises e ON e.id = c.exercise_id
GROUP BY month, e.name ORDER BY month, minutes DESC`],
  ["Raw samples of the latest sampled effort", `SELECT s.sample_index, s.t_ms, s.raw, s.force_lbs
FROM fitness_iso_samples s
WHERE s.effort_id = (SELECT id FROM fitness_iso_efforts
                     WHERE id IN (SELECT effort_id FROM fitness_iso_samples)
                     ORDER BY performed_at DESC LIMIT 1)
ORDER BY s.sample_index`],
  ["Body weight by week", `SELECT date(local_date, 'weekday 0', '-6 days') AS week_of,
  ROUND(AVG(weight_lbs), 1) AS avg_lbs, COUNT(*) AS weigh_ins
FROM fitness_bodyweight GROUP BY week_of ORDER BY week_of`],
  ["Workouts and their length", `SELECT datetime(started_at / 1000, 'unixepoch', 'localtime') AS started,
  ROUND((ended_at - started_at) / 60000.0) AS minutes, notes
FROM fitness_sessions ORDER BY started_at DESC`],
];

let db = null;
let selectedDay = null;
let data = null;
let rangeDays = "all";
const sampleCache = new Map();

const $ = (id) => document.getElementById(id);
const sum = (a, b) => a + b;

// ── Loading ──────────────────────────────────────────────────────────────────

async function main() {
  try { rangeDays = localStorage.getItem("range") || "all"; } catch (e) { /* storage blocked */ }
  try { $("weekly-metric").value = localStorage.getItem("weekly") || "days"; } catch (e) { /* storage blocked */ }
  setupRangeChips();
  let bytes;
  try {
    const response = await fetch(DB_URL, { cache: "no-cache" });
    if (!response.ok) throw new Error(String(response.status));
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (e) {
    showEmpty("No data has been uploaded yet. Project Z uploads it after its next backup (Settings → Backup → Public fitness data).");
    return;
  }
  const SQL = await initSqlJs({ locateFile: (file) => SQL_JS + file });
  db = new SQL.Database(bytes);
  data = loadData();
  const info = rows("SELECT exported_at, app_version FROM export_info LIMIT 1")[0];
  $("updated").textContent = info
    ? `Updated ${new Date(info.exported_at).toLocaleString()} · Project Z ${info.app_version}`
    : "";
  $("content").hidden = false;
  $("weekly-metric").addEventListener("change", () => {
    try { localStorage.setItem("weekly", $("weekly-metric").value); } catch (e) { /* storage blocked */ }
    renderWeekly(entriesInRange());
  });
  preferredExercise = new URLSearchParams(location.search).get("exercise");
  $("exercise").addEventListener("change", exerciseChanged);
  $("exercise-search").addEventListener("input", () => { renderExerciseOptions(); exerciseChanged(); });
  $("metric").addEventListener("change", renderExerciseChart);
  $("effort").addEventListener("change", renderCurve);
  setupDay();
  setupExplorer();
  render();
  // The page was hidden while loading, so a #section link scrolls only now.
  const target = location.hash && document.getElementById(location.hash.slice(1));
  if (target) target.scrollIntoView();
}

function showEmpty(message) {
  $("updated").textContent = "";
  $("empty").textContent = message;
  $("empty").hidden = false;
  $("range").hidden = true;
}

function rows(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function hasColumn(table, column) {
  return rows(`PRAGMA table_info(${table})`).some((c) => c.name === column);
}

function loadData() {
  const exercises = new Map(rows("SELECT id, name, type, pattern, equipment, sided, aliases FROM fitness_exercises").map((e) => [e.id, { ...e, aliases: parseList(e.aliases), primary: [], secondary: [] }]));
  rows("SELECT exercise_id, muscle, role FROM fitness_exercise_muscles").forEach((m) => {
    const ex = exercises.get(m.exercise_id);
    if (ex) (m.role === "primary" ? ex.primary : ex.secondary).push(m.muscle);
  });
  const cardioLoad = hasColumn("fitness_cardio", "load_lbs") ? "load_lbs" : "NULL";
  const common = "id, session_id, exercise_id, performed_at, local_date";
  const entries = [
    ...rows(`SELECT 'Isometric' AS kind, ${common}, side, rom, peak_lbs, avg_lbs, NULL AS load_lbs, NULL AS reps, duration_ms / 1000.0 AS seconds, NULL AS method, NULL AS miles, calories, notes FROM fitness_iso_efforts`),
    ...rows(`SELECT 'Set' AS kind, ${common}, side, NULL AS rom, NULL AS peak_lbs, NULL AS avg_lbs, load_lbs, reps, duration_sec AS seconds, method, NULL AS miles, calories, notes FROM fitness_sets`),
    ...rows(`SELECT 'Cardio' AS kind, ${common}, 'Bilateral' AS side, NULL AS rom, NULL AS peak_lbs, NULL AS avg_lbs, ${cardioLoad} AS load_lbs, NULL AS reps, duration_sec AS seconds, NULL AS method, distance_miles AS miles, calories, notes FROM fitness_cardio`),
    ...rows(`SELECT 'Hold' AS kind, ${common}, side, rom, NULL AS peak_lbs, NULL AS avg_lbs, load_lbs, NULL AS reps, duration_sec AS seconds, NULL AS method, NULL AS miles, calories, notes FROM fitness_holds`),
  ].sort((a, b) => a.performed_at - b.performed_at);
  // A workout's training day is the day of its first entry (so the 3 AM rollover applies).
  const sessionDay = new Map();
  entries.forEach((e) => { if (!sessionDay.has(e.session_id)) sessionDay.set(e.session_id, e.local_date); });
  const routines = new Map(rows("SELECT id, name FROM fitness_routines").map((r) => [r.id, r.name]));
  const sessions = rows("SELECT id, started_at, ended_at, notes, routine_id FROM fitness_sessions")
    .map((s) => ({ ...s, routine: routines.get(s.routine_id) || null, date: sessionDay.get(s.id) || isoDate(new Date(s.started_at)) }));
  const bodyweight = rows("SELECT measured_at, local_date, weight_lbs FROM fitness_bodyweight ORDER BY measured_at");
  const sampled = new Set(rows("SELECT DISTINCT effort_id FROM fitness_iso_samples").map((r) => r.effort_id));
  return { exercises, entries, sessions, bodyweight, sampled };
}

// ── Range ────────────────────────────────────────────────────────────────────

function setupRangeChips() {
  document.querySelectorAll("#range button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.range === rangeDays));
    b.addEventListener("click", () => {
      rangeDays = b.dataset.range;
      try { localStorage.setItem("range", rangeDays); } catch (e) { /* storage blocked */ }
      document.querySelectorAll("#range button").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
      if (data) render();
    });
  });
}

/** The first local date in range, or null for all time. */
function cutoff() {
  if (rangeDays === "all") return null;
  return isoDate(new Date(Date.now() - Number(rangeDays) * DAY));
}

const inRange = (localDate) => { const c = cutoff(); return c === null || localDate >= c; };
const entriesInRange = () => data.entries.filter((e) => inRange(e.local_date));

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  const entries = entriesInRange();
  renderTiles(entries);
  renderWeekly(entries);
  renderCalendar(entries);
  renderPunchcard(entries);
  renderDay();
  renderHeatmap(entries);
  renderBalance(entries);
  renderExerciseOptions();
  renderExercise();
  renderLeftRight(entries);
  renderSummary(entries);
  renderBodyweight();
  renderPrs(entries);
}

function renderTiles(entries) {
  const days = new Set(entries.map((e) => e.local_date));
  const sets = entries.filter((e) => e.kind !== "Cardio").length;
  const lifted = entries.map(tonnage).reduce(sum, 0);
  const cardioMin = entries.filter((e) => e.kind === "Cardio").reduce((s, e) => s + (e.seconds || 0), 0) / 60;
  const sessions = data.sessions.filter((s) => inRange(s.date)).length;
  const bw = data.bodyweight.filter((b) => inRange(b.local_date));
  const tiles = [
    ["Training days", fmt(days.size)],
    ["Workouts", fmt(sessions)],
    ["Working sets", fmt(sets)],
    ["Volume lifted", lifted >= 10000 ? `${fmt(lifted / 1000, 1)}K lbs` : `${fmt(lifted)} lbs`],
    ["Cardio", cardioMin >= 120 ? `${fmt(cardioMin / 60, 1)} h` : `${fmt(cardioMin)} min`],
  ];
  let bwDelta = "";
  if (bw.length) {
    const last = bw[bw.length - 1].weight_lbs;
    tiles.push(["Body weight", `${fmt(last, 1)} lbs`]);
    if (bw.length > 1) {
      const change = last - bw[0].weight_lbs;
      bwDelta = `${change >= 0 ? "+" : "−"}${fmt(Math.abs(change), 1)} lbs in range`;
    }
  }
  $("tiles").replaceChildren(...tiles.map(([label, value]) => {
    const tile = el("div", "tile");
    tile.append(el("div", "label", label), el("div", "value", value));
    if (label === "Body weight" && bwDelta) tile.append(el("div", "delta", bwDelta));
    return tile;
  }));
}

function tonnage(e) {
  return e.kind === "Set" && e.load_lbs > 0 && e.reps > 0 ? e.load_lbs * e.reps : 0;
}

// ── Weekly totals ────────────────────────────────────────────────────────────

function renderWeekly(entries) {
  const metric = WEEKLY[$("weekly-metric").value] ? $("weekly-metric").value : "days";
  const spec = WEEKLY[metric];
  const weeks = weekList(entries);
  const totals = new Map(weeks.map((w) => [w, 0]));
  const add = (date, v) => { const w = weekStart(date); if (totals.has(w)) totals.set(w, totals.get(w) + v); };
  if (metric === "days") {
    new Set(entries.map((e) => e.local_date)).forEach((d) => add(d, 1));
  } else if (metric === "sessions" || metric === "minutes") {
    data.sessions.filter((s) => inRange(s.date)).forEach((s) =>
      add(s.date, metric === "sessions" ? 1 : Math.max(0, (s.ended_at || s.started_at) - s.started_at) / 60000));
  } else {
    entries.forEach((e) => add(e.local_date, spec.value(e)));
  }
  const bars = weeks.map((w) => ({ x: w, y: totals.get(w) }));
  // The current week is still going, so it's left out of the average.
  const done = bars.slice(0, -1);
  const avg = done.length ? done.map((b) => b.y).reduce(sum, 0) / done.length : null;
  $("weekly-hint").textContent = spec.hint + (avg === null ? "" : ` Average ${fmt(avg, 1)} ${spec.unit} a week over ${done.length} full ${done.length === 1 ? "week" : "weeks"} (dashed line).`);
  columnChart($("weekly-chart"), bars, {
    yLabel: spec.y,
    yMax: spec.max,
    ticks: spec.max ? [0, 1, 2, 3, 4, 5, 6, 7] : undefined,
    avg,
    tip: (b) => `<b>Week of ${dateLabel(b.x)}</b><br>${fmt(b.y, 1)} ${spec.unit}`,
  });
}

// ── When ─────────────────────────────────────────────────────────────────────

function renderCalendar(entries) {
  const wrap = $("calendar");
  const weeks = weekList(entries);
  if (!weeks.length) { wrap.replaceChildren(el("p", "chart-empty", "Nothing logged in this range.")); return; }
  const perDay = new Map();
  entries.forEach((e) => {
    const d = perDay.get(e.local_date) || { n: 0, sets: 0, cardio: 0 };
    d.n += 1;
    if (e.kind === "Cardio") d.cardio += (e.seconds || 0) / 60; else d.sets += 1;
    perDay.set(e.local_date, d);
  });
  const max = Math.max(1, ...[...perDay.values()].map((d) => d.n));
  const today = isoDate(new Date());
  const first = cutoff() || entries[0].local_date;
  const table = el("table", "heat");
  const head = el("tr");
  head.append(el("th"));
  let lastMonth = "";
  weeks.forEach((w) => {
    const month = w.slice(0, 7);
    head.append(el("th", "", month !== lastMonth ? shortMonth(w) : ""));
    lastMonth = month;
  });
  table.append(el("thead"));
  table.tHead.append(head);
  const body = el("tbody");
  WEEKDAYS.forEach((name, r) => {
    const tr = el("tr");
    tr.append(el("th", "", r % 2 === 0 ? name : ""));
    weeks.forEach((w) => {
      const day = addDays(w, r);
      const td = el("td");
      if (day > today || day < first) { td.className = "out"; tr.append(td); return; }
      const d = perDay.get(day);
      td.style.background = heatColor(d ? d.n : 0, max);
      td.dataset.day = day;
      td.classList.add("pick");
      if (day === selectedDay) td.classList.add("selected");
      td.addEventListener("click", () => { showDay(day); $("day").scrollIntoView({ behavior: "smooth" }); });
      hover(td, () => {
        if (!d) return `<b>${dateLabel(day)}</b><br>Rest day<br>Click to see the day`;
        const parts = [];
        if (d.sets) parts.push(`${d.sets} working ${d.sets === 1 ? "set" : "sets"}`);
        if (d.cardio) parts.push(`${fmt(d.cardio)} min cardio`);
        return `<b>${dateLabel(day)}</b><br>${parts.join("<br>")}<br>Click to see the day`;
      });
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(body);
  wrap.replaceChildren(table);
  wrap.scrollLeft = wrap.scrollWidth;
}

function renderPunchcard(entries) {
  const wrap = $("punchcard");
  if (!entries.length) { wrap.replaceChildren(el("p", "chart-empty", "Nothing logged in this range.")); return; }
  const grid = WEEKDAYS.map(() => new Array(24).fill(0));
  entries.forEach((e) => {
    const t = new Date(e.performed_at);
    grid[(t.getDay() + 6) % 7][t.getHours()] += 1;
  });
  const max = Math.max(1, ...grid.flat());
  const table = el("table", "heat");
  const head = el("tr");
  head.append(el("th"));
  for (let h = 0; h < 24; h++) head.append(el("th", "", h % 3 === 0 ? hourLabel(h) : ""));
  table.append(el("thead"));
  table.tHead.append(head);
  const body = el("tbody");
  WEEKDAYS.forEach((name, r) => {
    const tr = el("tr");
    tr.append(el("th", "", name));
    grid[r].forEach((n, h) => {
      const td = el("td");
      td.style.background = heatColor(n, max);
      hover(td, () => `<b>${name}, ${hourLabel(h)}–${hourLabel((h + 1) % 24)}</b><br>${n} ${n === 1 ? "entry" : "entries"}`);
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(body);
  wrap.replaceChildren(table);
}

// ── One day ──────────────────────────────────────────────────────────────────

function trainingDays() {
  return [...new Set(data.entries.map((e) => e.local_date))].sort();
}

function setupDay() {
  const days = trainingDays();
  const input = $("day-date");
  if (days.length) { input.min = days[0]; input.max = isoDate(new Date()); }
  input.addEventListener("change", () => input.value && showDay(input.value));
  const step = (direction) => {
    const all = trainingDays();
    const from = selectedDay || all[all.length - 1];
    const next = direction < 0 ? [...all].reverse().find((d) => d < from) : all.find((d) => d > from);
    if (next) showDay(next);
  };
  $("day-prev").addEventListener("click", () => step(-1));
  $("day-next").addEventListener("click", () => step(1));
  $("day-latest").addEventListener("click", () => days.length && showDay(days[days.length - 1]));
  // ?day=yyyy-mm-dd opens that day, so a day can be linked to.
  const asked = new URLSearchParams(location.search).get("day");
  selectedDay = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : days[days.length - 1] || null;
}

function showDay(day) {
  selectedDay = day;
  setParam("day", day);
  document.querySelectorAll("#calendar td.selected").forEach((td) => td.classList.remove("selected"));
  document.querySelector(`#calendar td[data-day="${day}"]`)?.classList.add("selected");
  renderDay();
}

function renderDay() {
  const view = $("day-view");
  const day = selectedDay;
  if (!day) { view.replaceChildren(el("p", "chart-empty", "Nothing logged yet.")); return; }
  $("day-date").value = day;
  const days = trainingDays();
  $("day-prev").disabled = !days.some((d) => d < day);
  $("day-next").disabled = !days.some((d) => d > day);
  const list = data.entries.filter((e) => e.local_date === day);
  const weighIns = data.bodyweight.filter((b) => b.local_date === day);
  const summary = el("p", "day-summary");
  summary.append(el("span", "when", new Date(dateMs(day)).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })));
  const facts = [];
  const sessions = groupBy(list, (e) => e.session_id);
  if (list.length) {
    const sets = list.filter((e) => e.kind !== "Cardio").length;
    const cardio = list.filter((e) => e.kind === "Cardio").reduce((s, e) => s + (e.seconds || 0), 0) / 60;
    const lifted = list.map(tonnage).reduce(sum, 0);
    const kcal = list.reduce((s, e) => s + (e.calories || 0), 0);
    facts.push(`${sessions.size} ${sessions.size === 1 ? "workout" : "workouts"}`);
    if (sets) facts.push(`${sets} working ${sets === 1 ? "set" : "sets"}`);
    if (lifted) facts.push(`${fmt(lifted)} lbs lifted`);
    if (cardio) facts.push(`${fmt(cardio)} min cardio`);
    if (kcal) facts.push(`${fmt(kcal)} kcal`);
  }
  if (weighIns.length) facts.push(`weighed in at ${fmt(weighIns[weighIns.length - 1].weight_lbs, 1)} lbs`);
  summary.append(el("span", "facts", facts.length ? facts.join(" · ") : "Rest day. Nothing was logged."));
  const nodes = [summary];
  let n = 0;
  sessions.forEach((entries, id) => {
    n += 1;
    const session = data.sessions.find((s) => s.id === id);
    const block = el("div", "workout");
    const start = entries[0].performed_at;
    const end = entries[entries.length - 1].performed_at;
    const mins = Math.round((end - start) / 60000);
    let title = `${sessions.size > 1 ? `Workout ${n}` : "Workout"} · ${timeLabel(start)}`;
    if (mins > 0) title += `–${timeLabel(end)} (${duration(mins * 60)})`;
    if (session?.routine) title += ` · ${session.routine} routine`;
    block.append(el("h3", "", title));
    if (session?.notes) block.append(el("p", "note", session.notes));
    groupBy(entries, (e) => e.exercise_id).forEach((items, exerciseId) => {
      const ex = data.exercises.get(exerciseId);
      const box = el("div", "exercise-block");
      const head = el("h4");
      head.append(exerciseLink(exerciseId, ex?.name || exerciseId));
      const muscles = (ex?.primary || []).map((m) => MUSCLES[m] || m).join(", ");
      if (muscles) head.append(el("span", "", ` · ${muscles}`));
      box.append(head);
      box.append(entryTable(items));
      block.append(box);
    });
    nodes.push(block);
  });
  view.replaceChildren(...nodes);
}

/** One entry in words: "120 lbs × 8", "Peak 172.4 lbs · avg 150 lbs · 12 s", ... */
function entryResult(e) {
  if (e.kind === "Isometric") {
    const parts = [`Peak ${fmt(e.peak_lbs, 1)} lbs`];
    if (e.avg_lbs) parts.push(`avg ${fmt(e.avg_lbs, 1)} lbs`);
    if (e.seconds) parts.push(duration(e.seconds));
    if (e.rom) parts.push(`ROM ${String(e.rom).toLowerCase().replace(/_/g, " ")}`);
    return parts.join(" · ");
  }
  if (e.kind === "Set") {
    let text = e.load_lbs > 0 ? `${fmt(e.load_lbs, 1)} lbs × ${fmt(e.reps)}` : `${fmt(e.reps)} reps`;
    if (e.method === "BODYWEIGHT") text += " (bodyweight)";
    const rm = oneRm(e);
    if (rm !== null && e.reps > 1) text += ` · est. 1RM ${fmt(rm)} lbs`;
    if (e.seconds) text += ` · ${duration(e.seconds)}`;
    return text;
  }
  if (e.kind === "Cardio") {
    const parts = [duration(e.seconds || 0)];
    if (e.miles > 0) parts.push(`${fmt(e.miles, 2)} mi`, `${fmt(e.seconds / 60 / e.miles, 1)} min/mi`);
    if (e.load_lbs > 0) parts.push(`carrying ${fmt(e.load_lbs, 1)} lbs`);
    return parts.join(" · ");
  }
  return `Hold ${duration(e.seconds || 0)}${e.load_lbs > 0 ? ` with ${fmt(e.load_lbs, 1)} lbs` : ""}`;
}

/**
 * The record this entry set, if it beat every earlier entry of the same
 * exercise, side, and range of motion (as the app keys records). An exercise's
 * first entry is a starting point, not a record.
 */
function prOn(e) {
  const measure = (x) => {
    if (x.kind === "Isometric") return ["peak force", x.peak_lbs];
    if (x.kind === "Set") {
      const rm = oneRm(x);
      if (rm !== null) return ["estimated 1RM", rm];
      if ((x.method === "BODYWEIGHT" || !(x.load_lbs > 0)) && x.reps > 0) return ["reps", x.reps];
      return null;
    }
    if (x.kind === "Hold") return ["hold", x.seconds];
    return null;
  };
  const mine = measure(e);
  if (!mine || !(mine[1] > 0)) return null;
  const earlier = data.entries
    .filter((x) => x.exercise_id === e.exercise_id && x.side === e.side && x.rom === e.rom && x.performed_at < e.performed_at)
    .map(measure)
    .filter((m) => m && m[0] === mine[0]);
  if (!earlier.length) return null;
  return earlier.every((m) => mine[1] > m[1]) ? mine[0] : null;
}

// ── Muscles ──────────────────────────────────────────────────────────────────

/** Calls visit(muscle, sets, entry) for every strength entry: 1 per primary muscle, 0.5 per secondary. */
function forEachMuscleSet(entries, visit) {
  entries.filter((e) => e.kind !== "Cardio").forEach((e) => {
    const ex = data.exercises.get(e.exercise_id);
    if (!ex) return;
    new Set(ex.primary).forEach((m) => visit(m, 1, e));
    new Set(ex.secondary.filter((m) => !ex.primary.includes(m))).forEach((m) => visit(m, 0.5, e));
  });
}

function renderHeatmap(entries) {
  const weeks = weekList(entries);
  const sets = new Map(); // muscle → week → sets
  forEachMuscleSet(entries, (m, n, e) => {
    const week = weekStart(e.local_date);
    if (!sets.has(m)) sets.set(m, new Map());
    sets.get(m).set(week, (sets.get(m).get(week) || 0) + n);
  });
  const wrap = $("heat");
  if (!weeks.length) { wrap.replaceChildren(el("p", "chart-empty", "No strength work in this range.")); return; }
  const max = Math.max(1, ...[...sets.values()].flatMap((m) => [...m.values()]));
  const table = el("table", "heat");
  const head = el("tr");
  head.append(el("th"));
  weeks.forEach((w, i) => head.append(el("th", "", i % 4 === 0 ? shortDate(w) : "")));
  table.append(el("thead"));
  table.tHead.append(head);
  const body = el("tbody");
  Object.keys(MUSCLES).forEach((m) => {
    const tr = el("tr");
    tr.append(el("th", "", MUSCLES[m]));
    weeks.forEach((w) => {
      const v = sets.get(m)?.get(w) || 0;
      const td = el("td");
      td.style.background = heatColor(v, max);
      hover(td, () => `<b>${MUSCLES[m]}</b>, week of ${dateLabel(w)}<br>${fmt(v, 1)} sets`);
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(body);
  wrap.replaceChildren(table);
  wrap.scrollLeft = wrap.scrollWidth;
}

function renderBalance(entries) {
  const muscles = new Map(Object.keys(MUSCLES).map((m) => [m, 0]));
  forEachMuscleSet(entries, (m, n) => muscles.set(m, (muscles.get(m) || 0) + n));
  const patterns = new Map(Object.keys(PATTERNS).map((p) => [p, 0]));
  entries.filter((e) => e.kind !== "Cardio").forEach((e) => {
    const ex = data.exercises.get(e.exercise_id);
    if (ex && patterns.has(ex.pattern)) patterns.set(ex.pattern, patterns.get(ex.pattern) + 1);
  });
  const total = (ids) => ids.map((m) => muscles.get(m) || 0).reduce(sum, 0);
  const ratio = (label, a, b, names) => {
    const tile = el("div", "tile");
    tile.append(
      el("div", "label", label),
      el("div", "value", b > 0 ? `${fmt(a / b, 2)} : 1` : "—"),
      el("div", "delta", `${fmt(a, 1)} ${names[0]} vs ${fmt(b, 1)} ${names[1]} sets`),
    );
    return tile;
  };
  $("ratios").replaceChildren(
    ratio("Push : Pull", patterns.get("PUSH"), patterns.get("PULL"), ["push", "pull"]),
    ratio("Quads : Hamstrings", muscles.get("quads"), muscles.get("hamstrings"), ["quad", "hamstring"]),
    ratio("Upper : Lower body", total(UPPER), total(LOWER), ["upper", "lower"]),
  );
  hBars($("muscle-bars"), [...muscles.entries()].map(([m, v]) => ({ name: MUSCLES[m] || m, value: v })), "sets");
  hBars($("pattern-bars"), [...patterns.entries()].map(([p, v]) => ({ name: PATTERNS[p], value: v })), "sets");
}

/** Sorted horizontal bars drawn in HTML, so they wrap and scale with the page. */
function hBars(container, items, unit) {
  items.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  const max = Math.max(1, ...items.map((i) => i.value));
  const grid = el("div", "bars");
  items.forEach((item) => {
    const track = el("span", item.value ? "track" : "track zero");
    const fill = el("span", "fill");
    fill.style.width = `${(item.value / max) * 100}%`;
    track.append(fill);
    hover(track, () => `<b>${item.name}</b><br>${fmt(item.value, 1)} ${unit}`);
    grid.append(el("span", "name", item.name), track, el("span", "val", fmt(item.value, 1)));
  });
  container.replaceChildren(grid);
}

// ── Exercise history ─────────────────────────────────────────────────────────

const HISTORY_PAGE = 20;
let preferredExercise = null;
let historyDays = HISTORY_PAGE;

/** Fills the exercise picker with every logged exercise matching the search box. */
function renderExerciseOptions() {
  const select = $("exercise");
  const query = $("exercise-search").value.trim().toLowerCase();
  const counts = new Map();
  data.entries.forEach((e) => counts.set(e.exercise_id, (counts.get(e.exercise_id) || 0) + 1));
  const matches = [...counts.keys()].map((id) => data.exercises.get(id)).filter(Boolean)
    .filter((ex) => !query || ex.name.toLowerCase().includes(query) || ex.aliases.some((a) => a.toLowerCase().includes(query)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const previous = select.value || preferredExercise;
  if (!matches.length) {
    const none = el("option", "", "No logged exercise matches");
    none.value = "";
    select.replaceChildren(none);
    return;
  }
  select.replaceChildren(...matches.map((ex) => {
    const o = el("option", "", `${ex.name} (${counts.get(ex.id)})`);
    o.value = ex.id;
    return o;
  }));
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (matches.some((ex) => ex.id === previous)) select.value = previous;
  else if (!query && busiest) select.value = busiest[0];
  else select.value = matches[0].id;
}

function exerciseChanged() {
  historyDays = HISTORY_PAGE;
  if ($("exercise").value) setParam("exercise", $("exercise").value);
  renderExercise();
}

/** Opens one exercise's history (from a link elsewhere on the page). */
function showExercise(id) {
  $("exercise-search").value = "";
  preferredExercise = id;
  renderExerciseOptions();
  $("exercise").value = id;
  exerciseChanged();
  $("progress").scrollIntoView({ behavior: "smooth" });
}

function exerciseLink(id, name) {
  const a = el("a", "", name);
  a.href = `?exercise=${encodeURIComponent(id)}#progress`;
  a.addEventListener("click", (ev) => { ev.preventDefault(); showExercise(id); });
  return a;
}

function exerciseEntries() {
  const id = $("exercise").value;
  return data.entries.filter((e) => e.exercise_id === id && inRange(e.local_date));
}

const titleCase = (text) => {
  const s = String(text || "").toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Name, labels, muscles, and all-time numbers for the picked exercise. */
function renderAbout() {
  const id = $("exercise").value;
  const ex = data.exercises.get(id);
  const about = $("exercise-about");
  if (!ex) { about.replaceChildren(); return; }
  const all = data.entries.filter((e) => e.exercise_id === id);
  const box = el("div", "about");
  box.append(el("div", "about-name", ex.name));
  const labels = [
    [...new Set(all.map((e) => KINDS[e.kind]))].join(" & "),
    PATTERNS[ex.pattern],
    ex.equipment && ex.equipment !== "OTHER" ? titleCase(ex.equipment) : "",
    ex.sided ? "one side at a time" : "",
  ].filter((label, i, list) => label && list.indexOf(label) === i);
  box.append(el("div", "about-meta", labels.join(" · ")));
  const names = (ids) => ids.map((m) => MUSCLES[m] || m).join(", ");
  if (ex.primary.length) {
    box.append(el("div", "about-meta", `Works ${names(ex.primary)}${ex.secondary.length ? `; also ${names(ex.secondary)}` : ""}`));
  }
  const tiles = [];
  if (all.length) {
    tiles.push(["First logged", dateLabel(all[0].local_date)]);
    tiles.push(["Latest", dateLabel(all[all.length - 1].local_date)]);
    tiles.push(["Days", fmt(new Set(all.map((e) => e.local_date)).size)]);
    tiles.push(["Entries", fmt(all.length)]);
    const lifted = all.map(tonnage).reduce(sum, 0);
    if (lifted) tiles.push(["Volume lifted", `${fmt(lifted)} lbs`]);
    const minutes = all.filter((e) => e.kind === "Cardio").reduce((s, e) => s + (e.seconds || 0), 0) / 60;
    if (minutes) tiles.push(["Total time", minutes >= 120 ? `${fmt(minutes / 60, 1)} h` : `${fmt(minutes)} min`]);
    // All-time bests, one per kind of entry and side.
    Object.keys(KINDS).forEach((kind) => {
      const ofKind = all.filter((e) => e.kind === kind);
      const sides = [...new Set(ofKind.map((e) => e.side))].sort((a, b) => sideOrder(a) - sideOrder(b));
      sides.forEach((side) => {
        const measure = bestMeasure(ofKind.filter((e) => e.side === side));
        if (!measure) return;
        const best = Math.max(...measure.list.map(measure.value));
        const name = /^(Longest|Most|Heaviest)/.test(measure.label) ? measure.label : `Best ${measure.label.toLowerCase()}`;
        const label = `${name}${side === "Bilateral" ? "" : `, ${side.toLowerCase()}`}`;
        tiles.push([label, measure.unit === "s" ? duration(best) : `${fmt(best, 1)} ${measure.unit}`]);
      });
    });
  }
  const grid = el("div", "tiles tiles-small");
  tiles.forEach(([label, value]) => {
    const tile = el("div", "tile");
    tile.append(el("div", "label", label), el("div", "value", value));
    grid.append(tile);
  });
  box.append(grid);
  about.replaceChildren(box);
}

/** Every day the picked exercise was logged, newest first, all time. */
function renderHistory() {
  const id = $("exercise").value;
  const view = $("exercise-history");
  const all = data.entries.filter((e) => e.exercise_id === id);
  const days = [...groupBy(all, (e) => e.local_date).entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  $("history-hint").textContent = days.length
    ? `All time, newest first: ${fmt(days.length)} ${days.length === 1 ? "day" : "days"}. The range buttons don't filter this list. Click a date to open that whole day.`
    : "";
  if (!days.length) { view.replaceChildren(el("p", "chart-empty", "Nothing logged for this exercise.")); return; }
  const nodes = days.slice(0, historyDays).map(([day, items]) => {
    const block = el("div", "history-day");
    const head = el("h4");
    const link = el("a", "", new Date(dateMs(day)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }));
    link.href = `?day=${day}#day`;
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      showDay(day);
      $("day").scrollIntoView({ behavior: "smooth" });
    });
    head.append(link, el("span", "", ` · ${daySummary(items)}`));
    block.append(head, entryTable(items));
    return block;
  });
  if (days.length > historyDays) {
    const more = el("button", "more", `Show ${fmt(Math.min(HISTORY_PAGE, days.length - historyDays))} more days (${fmt(days.length - historyDays)} left)`);
    more.addEventListener("click", () => { historyDays += HISTORY_PAGE; renderHistory(); });
    nodes.push(more);
  }
  view.replaceChildren(...nodes);
}

/** "3 sets · 2,360 lbs lifted", "4 efforts", "31 min" for one exercise's day. */
function daySummary(items) {
  const parts = [];
  const count = (kind) => items.filter((e) => e.kind === kind).length;
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  if (count("Isometric")) parts.push(plural(count("Isometric"), "effort", "efforts"));
  if (count("Set")) parts.push(plural(count("Set"), "set", "sets"));
  if (count("Hold")) parts.push(plural(count("Hold"), "hold", "holds"));
  const lifted = items.map(tonnage).reduce(sum, 0);
  if (lifted) parts.push(`${fmt(lifted)} lbs lifted`);
  const minutes = items.filter((e) => e.kind === "Cardio").reduce((s, e) => s + (e.seconds || 0), 0) / 60;
  if (minutes) parts.push(`${fmt(minutes)} min`);
  return parts.join(" · ");
}

/** Entries as a table: time, side, result (with PR tags), calories, notes. */
function entryTable(items) {
  const columns = [
    ["Time", (e) => timeLabel(e.performed_at)],
    ["Side", (e) => (e.side === "Bilateral" ? "" : e.side)],
    ["Result", (e) => {
      const span = el("span", "", entryResult(e));
      const record = prOn(e);
      if (record) {
        const tag = el("span", "pr", "PR");
        tag.title = `Best ${record} so far`;
        span.append(tag);
      }
      return span;
    }],
    ["Calories", (e) => num(e.calories), true],
    ["Notes", (e) => e.notes || ""],
  ].filter(([name, get]) => name === "Result" || items.some((e) => get(e) !== ""));
  const table = dataTable(columns, items);
  const notesAt = columns.findIndex((c) => c[0] === "Notes");
  if (notesAt >= 0) [...table.tBodies[0].rows].forEach((tr) => tr.cells[notesAt].classList.add("wrap"));
  const wrap = el("div", "table-wrap");
  wrap.append(table);
  return wrap;
}

function exerciseEntries() {
  const id = $("exercise").value;
  return data.entries.filter((e) => e.exercise_id === id && inRange(e.local_date));
}

/** The measures that make sense for what was logged under this exercise. */
function metricsFor(list) {
  const iso = list.filter((e) => e.kind === "Isometric");
  const sets = list.filter((e) => e.kind === "Set");
  const cardio = list.filter((e) => e.kind === "Cardio");
  const holds = list.filter((e) => e.kind === "Hold");
  const out = [];
  if (iso.length) {
    out.push(
      { id: "peak", label: "Peak force", y: "Peak force (lbs)", unit: "lbs", hint: "Best peak force each day, per side, from the load cell.", series: () => bySide(iso, (e) => e.peak_lbs, Math.max) },
      { id: "avg", label: "Average force", y: "Average force (lbs)", unit: "lbs", hint: "Best average force through one effort each day.", series: () => bySide(iso, (e) => e.avg_lbs, Math.max) },
      { id: "held", label: "Force held (average ÷ peak)", y: "Average ÷ peak (%)", unit: "%", hint: "How evenly force is held through an effort: 100% would be flat at the peak the whole time. Best each day.", series: () => bySide(iso, (e) => (e.peak_lbs > 0 && e.avg_lbs > 0 ? (e.avg_lbs / e.peak_lbs) * 100 : null), Math.max) },
    );
    if (iso.some((e) => data.sampled.has(e.id))) {
      out.push({ id: "rfd", label: "Time to 90% of peak", y: "Time to 90% of peak (ms)", unit: "ms", lowerBetter: true, hint: "Rate of force development: how fast an effort reaches 90% of its own peak, from the raw samples. Lower is faster; the fastest each day. Older efforts were sampled about every 200 ms, so they're coarse.", series: () => bySide(iso, (e) => timeToFraction(e.id, 0.9), Math.min) });
    }
    out.push(
      { id: "tut", label: "Time under tension", y: "Time under tension (s)", unit: "s", hint: "Total effort time each day.", series: () => bySide(iso, (e) => e.seconds, sum) },
      { id: "efforts", label: "Efforts per day", y: "Efforts", unit: "efforts", hint: "Load-cell efforts each day.", series: () => bySide(iso, () => 1, sum) },
    );
  }
  if (sets.length) {
    if (sets.some((e) => oneRm(e) !== null)) {
      out.push({ id: "1rm", label: "Estimated 1RM", y: "Estimated 1RM (lbs)", unit: "lbs", hint: "Best estimated one-rep max each day (Epley), from loaded sets of 12 reps or fewer.", series: () => bySide(sets, oneRm, Math.max) });
    }
    if (sets.some((e) => e.load_lbs > 0)) {
      out.push(
        { id: "heaviest", label: "Heaviest set", y: "Load (lbs)", unit: "lbs", hint: "Heaviest load lifted each day, for any number of reps.", series: () => bySide(sets, (e) => (e.load_lbs > 0 ? e.load_lbs : null), Math.max) },
        { id: "volume", label: "Volume (load × reps)", y: "Volume (lbs)", unit: "lbs", hint: "Load × reps summed over each day's sets.", series: () => bySide(sets, (e) => tonnage(e) || null, sum) },
      );
    }
    out.push(
      { id: "reps", label: "Most reps in a set", y: "Reps", unit: "reps", hint: "Most reps in one set each day.", series: () => bySide(sets, (e) => e.reps, Math.max) },
      { id: "totalreps", label: "Total reps", y: "Reps", unit: "reps", hint: "Every rep each day, all sets added up.", series: () => bySide(sets, (e) => e.reps, sum) },
      { id: "sets", label: "Sets per day", y: "Sets", unit: "sets", hint: "Sets each day.", series: () => bySide(sets, () => 1, sum) },
    );
  }
  if (cardio.length) {
    const name = data.exercises.get(cardio[0].exercise_id)?.name || "Cardio";
    const one = (points) => [{ name, points }];
    out.push({ id: "minutes", label: "Minutes", y: "Minutes", unit: "min", hint: "Minutes each day.", series: () => one(daily(cardio, (e) => (e.seconds || 0) / 60, sum)) });
    if (cardio.some((e) => e.miles > 0)) {
      out.push(
        { id: "miles", label: "Distance", y: "Distance (miles)", unit: "mi", hint: "Distance each day, where it was logged.", series: () => one(daily(cardio, (e) => (e.miles > 0 ? e.miles : null), sum)) },
        { id: "pace", label: "Pace", y: "Pace (min per mile)", unit: "min/mi", lowerBetter: true, hint: "Fastest pace each day, where distance was logged. Lower is faster.", series: () => one(daily(cardio, (e) => (e.miles > 0 && e.seconds > 0 ? e.seconds / 60 / e.miles : null), Math.min)) },
      );
    }
    out.push({ id: "kcal", label: "Calories", y: "Calories (kcal)", unit: "kcal", hint: "Calories each day.", series: () => one(daily(cardio, (e) => e.calories, sum)) });
    if (cardio.some((e) => e.load_lbs > 0)) {
      out.push({ id: "carried", label: "Carried weight", y: "Carried weight, e.g. a vest (lbs)", unit: "lbs", hint: "Heaviest carried weight each day (a weighted vest or pack).", series: () => one(daily(cardio, (e) => (e.load_lbs > 0 ? e.load_lbs : null), Math.max)) });
    }
  }
  if (holds.length) {
    out.push(
      { id: "hold", label: "Longest hold", y: "Hold (seconds)", unit: "s", hint: "Longest hold each day.", series: () => bySide(holds, (e) => e.seconds, Math.max) },
      { id: "holdtotal", label: "Total hold time", y: "Hold time (seconds)", unit: "s", hint: "All holds each day, added up.", series: () => bySide(holds, (e) => e.seconds, sum) },
    );
  }
  return out;
}

function renderExercise() {
  const list = exerciseEntries();
  const metrics = metricsFor(list);
  const select = $("metric");
  const previous = select.value;
  select.replaceChildren(...metrics.map((m) => { const o = el("option", "", m.label); o.value = m.id; return o; }));
  select.value = metrics.some((m) => m.id === previous) ? previous : (metrics[0]?.id || "");
  select.disabled = !metrics.length;
  renderExerciseChart();
  renderEffortOptions(list);
  renderAbout();
  renderHistory();
}

function renderExerciseChart() {
  const list = exerciseEntries();
  const metric = metricsFor(list).find((m) => m.id === $("metric").value);
  if (!metric) {
    $("exercise-hint").textContent = "No entries in this range.";
    $("exercise-chart").replaceChildren();
    return;
  }
  const series = metric.series();
  lineChart($("exercise-chart"), series, { yLabel: metric.y, unit: metric.unit });
  const changes = series.filter((s) => s.points.length > 1).map((s) => {
    const a = s.points[0];
    const b = s.points[s.points.length - 1];
    const pct = a.y ? ((b.y - a.y) / Math.abs(a.y)) * 100 : null;
    const who = series.length > 1 ? `${s.name}: ` : "";
    return `${who}${fmt(a.y, 1)} → ${fmt(b.y, 1)} ${metric.unit}${pct === null ? "" : ` (${pct >= 0 ? "+" : "−"}${fmt(Math.abs(pct))}%)`}`;
  });
  $("exercise-hint").textContent = metric.hint + (changes.length ? ` First day in range to latest: ${changes.join("; ")}.` : "");
}


const oneRm = (e) => {
  if (e.kind !== "Set" || e.method === "BODYWEIGHT" || !(e.load_lbs > 0) || !(e.reps >= 1 && e.reps <= MAX_1RM_REPS)) return null;
  return e.reps === 1 ? e.load_lbs : e.load_lbs * (1 + e.reps / 30);
};

/** One series per side (Left / Right / Both), each point the day's combined value. */
function bySide(list, value, combine) {
  const sides = [...new Set(list.map((e) => e.side))].sort((a, b) => sideOrder(a) - sideOrder(b));
  return sides.map((side) => {
    const name = side === "Bilateral" ? "Both" : side;
    return { name, color: SIDE_COLORS[name], points: daily(list.filter((e) => e.side === side), value, combine) };
  });
}
const sideOrder = (s) => ({ Left: 0, Right: 1, Bilateral: 2 }[s] ?? 3);

function daily(list, value, combine) {
  const byDay = new Map();
  list.forEach((e) => {
    const v = value(e);
    if (v === null || v === undefined || Number.isNaN(v)) return;
    byDay.set(e.local_date, byDay.has(e.local_date) ? combine(byDay.get(e.local_date), v) : v);
  });
  return [...byDay.entries()].sort().map(([d, v]) => ({ x: d, y: v }));
}

// ── Force curves (raw samples) ───────────────────────────────────────────────

function samples(effortId) {
  if (!sampleCache.has(effortId)) {
    sampleCache.set(effortId, rows("SELECT t_ms, force_lbs FROM fitness_iso_samples WHERE effort_id = ? ORDER BY sample_index", [effortId]));
  }
  return sampleCache.get(effortId);
}

/** Milliseconds from the first sample until force first reaches this fraction of the effort's peak. */
function timeToFraction(effortId, fraction) {
  if (!data.sampled.has(effortId)) return null;
  const list = samples(effortId);
  if (list.length < 2) return null;
  const peak = Math.max(...list.map((s) => s.force_lbs));
  const hit = list.find((s) => s.force_lbs >= peak * fraction);
  return hit ? hit.t_ms - list[0].t_ms : null;
}

function renderEffortOptions(list) {
  const efforts = list.filter((e) => e.kind === "Isometric" && data.sampled.has(e.id)).reverse();
  $("curve-block").hidden = !efforts.length;
  if (!efforts.length) return;
  const select = $("effort");
  const previous = select.value;
  select.replaceChildren(...efforts.map((e) => {
    const side = e.side === "Bilateral" ? "" : ` · ${e.side}`;
    const o = el("option", "", `${new Date(e.performed_at).toLocaleString()}${side} · ${fmt(e.peak_lbs, 1)} lbs`);
    o.value = e.id;
    return o;
  }));
  if (efforts.some((e) => e.id === previous)) select.value = previous;
  renderCurve();
}

function renderCurve() {
  const list = exerciseEntries().filter((e) => e.kind === "Isometric" && data.sampled.has(e.id));
  const chosen = list.find((e) => e.id === $("effort").value);
  if (!chosen) { $("curve-chart").replaceChildren(); return; }
  const curve = (e) => {
    const s = samples(e.id);
    return s.map((p) => ({ x: (p.t_ms - s[0].t_ms) / 1000, y: p.force_lbs }));
  };
  const series = [{ name: "This effort", color: "--s1", points: curve(chosen) }];
  const best = list.filter((e) => e.side === chosen.side).reduce((a, b) => (b.peak_lbs > a.peak_lbs ? b : a));
  if (best.id !== chosen.id) {
    series.push({ name: `Best, ${dateLabel(best.local_date)} (${fmt(best.peak_lbs, 1)} lbs)`, color: "--text-3", dash: true, points: curve(best) });
  }
  xyChart($("curve-chart"), series, { yLabel: "Force (lbs)", unit: "lbs", xUnit: "s" });
}

// ── Left vs right ────────────────────────────────────────────────────────────

/** How an exercise is best compared: the first measure its entries support. */
function bestMeasure(list) {
  const iso = list.filter((e) => e.kind === "Isometric" && e.peak_lbs > 0);
  if (iso.length) return { label: "Peak force", unit: "lbs", list: iso, value: (e) => e.peak_lbs };
  const sets = list.filter((e) => e.kind === "Set");
  if (sets.some((e) => oneRm(e) !== null)) return { label: "Estimated 1RM", unit: "lbs", list: sets.filter((e) => oneRm(e) !== null), value: oneRm };
  if (sets.some((e) => e.load_lbs > 0)) return { label: "Heaviest set", unit: "lbs", list: sets.filter((e) => e.load_lbs > 0), value: (e) => e.load_lbs };
  if (sets.some((e) => e.reps > 0)) return { label: "Most reps", unit: "reps", list: sets.filter((e) => e.reps > 0), value: (e) => e.reps };
  const holds = list.filter((e) => e.kind === "Hold" && e.seconds > 0);
  if (holds.length) return { label: "Longest hold", unit: "s", list: holds, value: (e) => e.seconds };
  const cardio = list.filter((e) => e.kind === "Cardio" && e.seconds > 0);
  if (cardio.length) return { label: "Longest session", unit: "min", list: cardio, value: (e) => e.seconds / 60 };
  return null;
}

function renderLeftRight(entries) {
  const byExercise = groupBy(entries.filter((e) => e.side === "Left" || e.side === "Right"), (e) => e.exercise_id);
  const out = [];
  byExercise.forEach((list, id) => {
    const measure = bestMeasure(list);
    if (!measure) return;
    const best = (side) => Math.max(0, ...measure.list.filter((e) => e.side === side).map(measure.value));
    const left = best("Left");
    const right = best("Right");
    if (!left || !right) return;
    const gap = (Math.abs(left - right) / Math.max(left, right)) * 100;
    out.push({ id, name: data.exercises.get(id)?.name || id, measure, left, right, gap });
  });
  if (!out.length) { $("lr").replaceChildren(el("p", "chart-empty", "No exercise was done on both sides in this range.")); return; }
  const bar = (r) => {
    const wrap = el("div", "lr");
    const l = el("span", "l");
    const rgt = el("span", "r");
    const width = `${Math.min(100, (r.gap / 30) * 100)}%`;
    if (r.left > r.right) l.style.width = width; else rgt.style.width = width;
    const lc = el("div");
    lc.append(l);
    lc.style.display = "flex";
    lc.style.justifyContent = "flex-end";
    const rc = el("div", "lr-axis");
    rc.append(rgt);
    wrap.append(lc, rc);
    wrap.setAttribute("aria-label", r.left > r.right ? "Left stronger" : r.right > r.left ? "Right stronger" : "Even");
    return wrap;
  };
  sortableTable($("lr"), [
    ["Exercise", (r) => exerciseLink(r.id, r.name), false, (r) => r.name],
    ["Measure", (r) => r.measure.label],
    ["Left", (r) => `${fmt(r.left, 1)} ${r.measure.unit}`, true, (r) => r.left],
    ["Right", (r) => `${fmt(r.right, 1)} ${r.measure.unit}`, true, (r) => r.right],
    ["Gap", (r) => `${fmt(r.gap)}%`, true, (r) => r.gap],
    ["L ◂ ▸ R", bar],
  ], out, { column: 4, descending: true });
}

// ── Every exercise ───────────────────────────────────────────────────────────

function renderSummary(entries) {
  const out = [];
  groupBy(entries, (e) => e.exercise_id).forEach((list, id) => {
    const ex = data.exercises.get(id);
    const measure = bestMeasure(list);
    const best = measure ? Math.max(...measure.list.map(measure.value)) : null;
    const lifted = list.map(tonnage).reduce(sum, 0);
    const minutes = list.filter((e) => e.kind === "Cardio").reduce((s, e) => s + (e.seconds || 0), 0) / 60;
    out.push({
      id,
      name: ex?.name || id,
      pattern: PATTERNS[ex?.pattern] || "",
      kind: [...new Set(list.map((e) => KINDS[e.kind]))].join(", "),
      days: new Set(list.map((e) => e.local_date)).size,
      entries: list.length,
      lifted,
      minutes,
      measure,
      best,
      first: list[0].local_date,
      last: list[list.length - 1].local_date,
    });
  });
  if (!out.length) { $("summary-table").replaceChildren(el("p", "chart-empty", "Nothing logged in this range.")); return; }
  sortableTable($("summary-table"), [
    ["Exercise", (r) => exerciseLink(r.id, r.name), false, (r) => r.name],
    ["Pattern", (r) => r.pattern, false, (r) => r.pattern],
    ["Logged as", (r) => r.kind, false, (r) => r.kind],
    ["Days", (r) => fmt(r.days), true, (r) => r.days],
    ["Entries", (r) => fmt(r.entries), true, (r) => r.entries],
    ["Volume lbs", (r) => (r.lifted ? fmt(r.lifted) : ""), true, (r) => r.lifted],
    ["Cardio min", (r) => (r.minutes ? fmt(r.minutes) : ""), true, (r) => r.minutes],
    ["Best", (r) => (r.measure ? `${fmt(r.best, 1)} ${r.measure.unit}` : ""), true, (r) => r.best ?? -1],
    ["Best is", (r) => r.measure?.label || ""],
    ["First", (r) => dateLabel(r.first), false, (r) => r.first],
    ["Last", (r) => dateLabel(r.last), false, (r) => r.last],
  ], out, { column: 4, descending: true });
}

// ── Body weight ──────────────────────────────────────────────────────────────

function renderBodyweight() {
  const bw = data.bodyweight.filter((b) => inRange(b.local_date));
  const points = daily(bw, (b) => b.weight_lbs, (a, b) => b);
  const average = points.map((p) => {
    const from = addDays(p.x, -6);
    const week = points.filter((q) => q.x >= from && q.x <= p.x);
    return { x: p.x, y: week.map((q) => q.y).reduce(sum, 0) / week.length };
  });
  const series = [{ name: "Weigh-ins", color: "--s1", points }];
  if (points.length > 2) series.push({ name: "7-day average", color: "--text-3", dash: true, points: average });
  lineChart($("bw-chart"), series, { yLabel: "Body weight (lbs)", unit: "lbs", zero: false });
  const slope = trendPerDay(points);
  $("bw-hint").textContent = slope === null
    ? "Log at least two weigh-ins to see a trend."
    : `Trend: ${slope >= 0 ? "+" : "−"}${fmt(Math.abs(slope * 7), 2)} lbs a week (straight-line fit over ${points.length} weigh-in days).`;
}

/** Least-squares slope of the points, in units per day. */
function trendPerDay(points) {
  if (points.length < 2) return null;
  const xs = points.map((p) => dateMs(p.x) / DAY);
  const mx = xs.reduce(sum, 0) / xs.length;
  const my = points.map((p) => p.y).reduce(sum, 0) / points.length;
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (points[i].y - my); den += (x - mx) ** 2; });
  return den ? num / den : null;
}

// ── Records ──────────────────────────────────────────────────────────────────

function renderPrs(entries) {
  const best = new Map();
  const consider = (key, ex, metric, value, e) => {
    const current = best.get(key);
    if (!current || value > current.value) best.set(key, { ex, metric, value, side: e.side, date: e.local_date });
  };
  entries.forEach((e) => {
    const ex = data.exercises.get(e.exercise_id);
    if (!ex) return;
    const side = e.side === "Bilateral" ? "" : e.side;
    if (e.kind === "Isometric") consider(`${ex.id}|${side}|peak`, ex, "Peak force", e.peak_lbs, e);
    if (e.kind === "Set") {
      const rm = oneRm(e);
      if (rm !== null) consider(`${ex.id}|${side}|1rm`, ex, "Estimated 1RM", rm, e);
      else if ((e.method === "BODYWEIGHT" || !(e.load_lbs > 0)) && e.reps > 0) consider(`${ex.id}|${side}|reps`, ex, "Most reps", e.reps, e);
    }
    if (e.kind === "Hold") consider(`${ex.id}|${side}|hold`, ex, "Longest hold", e.seconds, e);
  });
  const list = [...best.values()];
  if (!list.length) { $("prs-table").replaceChildren(el("p", "chart-empty", "No records in this range.")); return; }
  const value = (r) => (r.metric === "Most reps" ? `${fmt(r.value)} reps` : r.metric === "Longest hold" ? duration(r.value) : `${fmt(r.value, 1)} lbs`);
  sortableTable($("prs-table"), [
    ["Exercise", (r) => exerciseLink(r.ex.id, r.ex.name), false, (r) => r.ex.name],
    ["Side", (r) => (r.side === "Bilateral" ? "" : r.side), false, (r) => r.side],
    ["Record", (r) => r.metric, false, (r) => r.metric],
    ["Best", value, true, (r) => r.value],
    ["Date", (r) => dateLabel(r.date), false, (r) => r.date],
  ], list, { column: 0 });
}

// ── Raw data explorer ────────────────────────────────────────────────────────

function setupExplorer() {
  const tables = rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => t.name);
  const list = tables.map((name) => ({ name, count: rows(`SELECT COUNT(*) AS n FROM "${name}"`)[0].n }));
  $("tables").replaceChildren(dataTable([
    ["Table", (t) => t.name],
    ["Rows", (t) => fmt(t.count), true],
    ["", (t) => {
      const a = el("a", "", "CSV");
      a.href = "#";
      a.addEventListener("click", (ev) => { ev.preventDefault(); downloadCsv(`SELECT * FROM "${t.name}"`, `${t.name}.csv`); });
      return a;
    }],
  ], list));
  const examples = $("examples");
  examples.replaceChildren(el("option", "", "Example queries…"), ...EXAMPLES.map(([name], i) => {
    const o = el("option", "", name);
    o.value = String(i);
    return o;
  }));
  examples.firstChild.value = "";
  examples.addEventListener("change", () => {
    if (examples.value === "") return;
    $("sql").value = EXAMPLES[Number(examples.value)][1];
    runQuery();
  });
  $("sql").value = EXAMPLES[0][1];
  $("run").addEventListener("click", runQuery);
  $("run-csv").addEventListener("click", () => downloadCsv($("sql").value, "query.csv"));
  $("sql").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runQuery(); });
}

function runQuery() {
  try {
    const result = db.exec($("sql").value);
    const last = result[result.length - 1];
    if (!last) { $("sql-status").textContent = "No rows."; $("sql-result").replaceChildren(); return; }
    const shown = last.values.slice(0, 500);
    $("sql-status").textContent = `${fmt(last.values.length)} rows` + (last.values.length > 500 ? " (showing the first 500; download for all)" : "");
    $("sql-result").replaceChildren(dataTable(last.columns.map((c, i) => [c, (r) => (r[i] === null ? "" : String(r[i])), typeof shown[0]?.[i] === "number"]), shown));
  } catch (e) {
    $("sql-status").textContent = e.message;
    $("sql-result").replaceChildren();
  }
}

function downloadCsv(sql, filename) {
  try {
    const result = db.exec(sql);
    const last = result[result.length - 1] || { columns: [], values: [] };
    const cell = (v) => {
      if (v === null || v === undefined) return "";
      if (v instanceof Uint8Array) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [last.columns.map(cell).join(","), ...last.values.map((r) => r.map(cell).join(","))].join("\n") + "\n";
    const a = el("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    $("sql-status").textContent = e.message;
  }
}

// ── Charts (SVG) ─────────────────────────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";
const PAD = { top: 28, right: 16, bottom: 28, left: 48 };

function svg(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
  if (parent) parent.append(node);
  return node;
}

function frame(container, height) {
  const width = Math.max(320, container.clientWidth || 640);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  return { root, width, height, w: width - PAD.left - PAD.right, h: height - PAD.top - PAD.bottom };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function yAxis(f, min, max, label, ticks) {
  const g = svg("g", { class: "axis" }, f.root);
  const values = ticks || [0, 1, 2, 3, 4].map((i) => min + ((max - min) * i) / 4);
  for (const v of values) {
    const y = PAD.top + f.h - ((v - min) / (max - min || 1)) * f.h;
    svg("line", { class: "gridline", x1: PAD.left, x2: PAD.left + f.w, y1: y, y2: y }, g);
    svg("text", { x: PAD.left - 6, y: y + 4, "text-anchor": "end" }, g).textContent = compact(v);
  }
  const t = svg("text", { class: "axis-title", x: PAD.left - 6, y: 12, "text-anchor": "start" }, f.root);
  t.textContent = label;
  f.root.setAttribute("aria-label", label);
}

function xDates(f, minT, maxT) {
  const g = svg("g", { class: "axis" }, f.root);
  const spanDays = Math.round((maxT - minT) / DAY);
  const ticks = Math.min(6, Math.max(2, Math.floor(f.w / 110)), spanDays + 1);
  for (let i = 0; i < ticks; i++) {
    const t = minT + Math.round((spanDays * i) / (ticks - 1 || 1)) * DAY;
    const x = PAD.left + ((t - minT) / (maxT - minT || 1)) * f.w;
    svg("text", { x, y: PAD.top + f.h + 18, "text-anchor": i === 0 ? "start" : i === ticks - 1 ? "end" : "middle" }, g)
      .textContent = shortDate(isoDate(new Date(t)), maxT - minT > 300 * DAY);
  }
}

function legend(series) {
  const box = el("div", "legend");
  series.forEach((s, i) => {
    const item = el("span");
    const key = el("i");
    key.style.background = `var(${s.color || SERIES[i]})`;
    if (s.dash) key.style.opacity = "0.7";
    item.append(key, document.createTextNode(s.name));
    box.append(item);
  });
  return box;
}

function drawLine(f, points, x, y, color, dash) {
  if (points.length < 2) return;
  svg("path", {
    d: points.map((p, j) => `${j ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(""),
    fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
    ...(dash ? { "stroke-dasharray": "5 4" } : {}),
  }, f.root);
}

function lineChart(container, series, opts) {
  series = series.filter((s) => s.points.length).slice(0, 3);
  if (!series.length) { container.replaceChildren(el("p", "chart-empty", "Nothing logged in this range.")); return; }
  const all = series.flatMap((s) => s.points);
  const ts = all.map((p) => dateMs(p.x));
  let minT = Math.min(...ts); let maxT = Math.max(...ts);
  if (minT === maxT) { minT -= DAY; maxT += DAY; }
  const ys = all.map((p) => p.y);
  let lo = opts.zero === false ? Math.min(...ys) : 0;
  let hi = Math.max(...ys);
  if (opts.zero === false) { const pad = Math.max(1, (hi - lo) * 0.15); lo = Math.floor(lo - pad); hi = hi + pad; }
  hi = opts.zero === false ? Math.ceil(hi) : niceMax(hi);
  const f = frame(container, 240);
  const x = (d) => PAD.left + ((dateMs(d) - minT) / (maxT - minT)) * f.w;
  const y = (v) => PAD.top + f.h - ((v - lo) / (hi - lo || 1)) * f.h;
  yAxis(f, lo, hi, opts.yLabel);
  xDates(f, minT, maxT);
  series.forEach((s, i) => {
    const color = `var(${s.color || SERIES[i]})`;
    drawLine(f, s.points, x, y, color, s.dash);
    if (s.dash) return;
    const dots = s.points.length <= 40 ? s.points : [s.points[s.points.length - 1]];
    dots.forEach((p) => svg("circle", { cx: x(p.x), cy: y(p.y), r: 4, fill: color, stroke: "var(--surface)", "stroke-width": 2 }, f.root));
  });
  // Crosshair + tooltip: the nearest day across all series.
  const days = [...new Set(all.map((p) => p.x))].sort();
  const cross = svg("line", { x1: 0, x2: 0, y1: PAD.top, y2: PAD.top + f.h, stroke: "var(--text-3)", "stroke-width": 1, visibility: "hidden" }, f.root);
  const hit = svg("rect", { x: PAD.left, y: PAD.top, width: f.w, height: f.h, fill: "transparent" }, f.root);
  const pick = (ev) => {
    const box = f.root.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * f.width;
    let best = days[0];
    days.forEach((d) => { if (Math.abs(x(d) - px) < Math.abs(x(best) - px)) best = d; });
    return best;
  };
  hit.addEventListener("pointermove", (ev) => {
    const d = pick(ev);
    cross.setAttribute("x1", x(d)); cross.setAttribute("x2", x(d)); cross.setAttribute("visibility", "visible");
    const lines = series.map((s) => {
      const p = s.points.find((q) => q.x === d);
      return p ? `${series.length > 1 ? `${s.name}: ` : ""}${fmt(p.y, 1)} ${opts.unit}` : null;
    }).filter(Boolean);
    showTip(ev, `<b>${dateLabel(d)}</b><br>${lines.join("<br>")}`);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  container.replaceChildren(...(series.length > 1 ? [legend(series)] : []), f.root);
}

/** A line chart over a numeric x axis (seconds into an effort). */
function xyChart(container, series, opts) {
  series = series.filter((s) => s.points.length);
  if (!series.length) { container.replaceChildren(el("p", "chart-empty", "No samples for this effort.")); return; }
  const all = series.flatMap((s) => s.points);
  const maxX = Math.max(0.1, ...all.map((p) => p.x));
  const hi = niceMax(Math.max(...all.map((p) => p.y)));
  const f = frame(container, 240);
  const x = (v) => PAD.left + (v / maxX) * f.w;
  const y = (v) => PAD.top + f.h - (Math.max(0, v) / hi) * f.h;
  yAxis(f, 0, hi, opts.yLabel);
  const g = svg("g", { class: "axis" }, f.root);
  const step = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => maxX / s <= 6) || 120;
  for (let v = 0; v <= maxX + 1e-9; v += step) {
    svg("text", { x: x(v), y: PAD.top + f.h + 18, "text-anchor": v === 0 ? "start" : "middle" }, g).textContent = `${fmt(v, 2)} ${opts.xUnit}`;
  }
  [...series].reverse().forEach((s) => drawLine(f, s.points, x, y, `var(${s.color})`, s.dash));
  const main = series[0].points;
  if (main.length <= 60) main.forEach((p) => svg("circle", { cx: x(p.x), cy: y(p.y), r: 3, fill: `var(${series[0].color})` }, f.root));
  const cross = svg("line", { x1: 0, x2: 0, y1: PAD.top, y2: PAD.top + f.h, stroke: "var(--text-3)", "stroke-width": 1, visibility: "hidden" }, f.root);
  const hit = svg("rect", { x: PAD.left, y: PAD.top, width: f.w, height: f.h, fill: "transparent" }, f.root);
  const nearest = (points, px) => points.reduce((a, b) => (Math.abs(x(b.x) - px) < Math.abs(x(a.x) - px) ? b : a));
  hit.addEventListener("pointermove", (ev) => {
    const box = f.root.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * f.width;
    const p = nearest(main, px);
    cross.setAttribute("x1", x(p.x)); cross.setAttribute("x2", x(p.x)); cross.setAttribute("visibility", "visible");
    const lines = series.map((s) => {
      const q = nearest(s.points, x(p.x));
      return `${s.name}: ${fmt(q.y, 1)} ${opts.unit}`;
    });
    showTip(ev, `<b>${fmt(p.x, 2)} ${opts.xUnit}</b><br>${lines.join("<br>")}`);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  container.replaceChildren(...(series.length > 1 ? [legend(series)] : []), f.root);
}

function columnChart(container, bars, opts) {
  if (!bars.length) { container.replaceChildren(el("p", "chart-empty", "Nothing logged in this range.")); return; }
  const f = frame(container, 200);
  const hi = opts.yMax || niceMax(Math.max(...bars.map((b) => b.y)));
  yAxis(f, 0, hi, opts.yLabel, opts.ticks);
  const slot = f.w / bars.length;
  const width = Math.max(1, Math.min(24, slot - 2));
  const base = PAD.top + f.h;
  bars.forEach((b, i) => {
    const cx = PAD.left + slot * i + slot / 2;
    const hgt = (b.y / hi) * f.h;
    if (hgt > 0) {
      const r = Math.min(4, width / 2, hgt);
      svg("path", {
        d: `M${cx - width / 2},${base} V${base - hgt + r} Q${cx - width / 2},${base - hgt} ${cx - width / 2 + r},${base - hgt} H${cx + width / 2 - r} Q${cx + width / 2},${base - hgt} ${cx + width / 2},${base - hgt + r} V${base} Z`,
        fill: "var(--s1)",
      }, f.root);
    }
  });
  if (opts.avg > 0) {
    const ay = base - (opts.avg / hi) * f.h;
    svg("line", { x1: PAD.left, x2: PAD.left + f.w, y1: ay, y2: ay, stroke: "var(--text-2)", "stroke-width": 1, "stroke-dasharray": "4 3" }, f.root);
  }
  bars.forEach((b, i) => {
    const target = svg("rect", { x: PAD.left + slot * i, y: PAD.top, width: slot, height: f.h, fill: "transparent" }, f.root);
    target.addEventListener("pointermove", (ev) => showTip(ev, opts.tip(b)));
    target.addEventListener("pointerleave", hideTip);
  });
  xDates(f, dateMs(bars[0].x), dateMs(bars[bars.length - 1].x));
  container.replaceChildren(f.root);
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

function showTip(ev, html) {
  const tip = $("tip");
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 12;
  const r = tip.getBoundingClientRect();
  let left = ev.clientX + pad;
  if (left + r.width > window.innerWidth - 8) left = ev.clientX - r.width - pad;
  let top = ev.clientY - r.height - pad;
  if (top < 8) top = ev.clientY + pad;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${top}px`;
}

function hideTip() { $("tip").hidden = true; }

function hover(node, html) {
  node.addEventListener("pointermove", (ev) => showTip(ev, html()));
  node.addEventListener("pointerleave", hideTip);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function parseList(text) {
  try {
    const list = JSON.parse(text || "[]");
    return Array.isArray(list) ? list.map(String) : [];
  } catch (e) {
    return [];
  }
}

function setParam(key, value) {
  try {
    const url = new URL(location.href);
    url.searchParams.set(key, value);
    url.hash = key === "day" ? "day" : "progress";
    history.replaceState(null, "", url);
  } catch (e) { /* not allowed here */ }
}

function groupBy(list, key) {
  const out = new Map();
  list.forEach((item) => {
    const k = key(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  });
  return out;
}

const heatColor = (v, max) => `var(--heat-${v <= 0 ? 0 : Math.min(6, 1 + Math.floor((v / max) * 5.999))})`;

function dataTable(columns, list) {
  const table = el("table", "data");
  const head = el("tr");
  columns.forEach(([name, , numeric]) => head.append(el("th", numeric ? "num" : "", name)));
  table.append(el("thead"));
  table.tHead.append(head);
  const body = el("tbody");
  list.forEach((item) => {
    const tr = el("tr");
    columns.forEach(([, get, numeric]) => {
      const v = get(item);
      const td = el("td", numeric ? "num" : "");
      if (v instanceof Node) td.append(v); else td.textContent = v;
      tr.append(td);
    });
    body.append(tr);
  });
  table.append(body);
  return table;
}

/**
 * A data table whose columns with a sort key (the 4th entry) sort when their
 * header is clicked; clicking again flips the order.
 */
function sortableTable(container, columns, list, initial = { column: columns.length - 1 }) {
  let state = container.sortState && container.sortState.columns === columns.length ? container.sortState : null;
  if (!state) {
    const column = columns[initial.column]?.[3] ? initial.column : columns.findIndex((c) => c[3]);
    state = { column, descending: initial.descending ?? !!columns[column]?.[2], columns: columns.length };
  }
  const draw = () => {
    container.sortState = state;
    const key = columns[state.column][3];
    const sorted = [...list].sort((a, b) => {
      const va = key(a);
      const vb = key(b);
      const c = typeof va === "string" ? va.localeCompare(vb) : va - vb;
      return state.descending ? -c : c;
    });
    const table = dataTable(columns, sorted);
    [...table.tHead.rows[0].cells].forEach((th, i) => {
      if (!columns[i][3]) return;
      th.classList.add("sortable");
      th.setAttribute("aria-sort", i === state.column ? (state.descending ? "descending" : "ascending") : "none");
      if (i === state.column) th.textContent += state.descending ? " ↓" : " ↑";
      th.addEventListener("click", () => {
        state = { column: i, descending: i === state.column ? !state.descending : !!columns[i][2], columns: columns.length };
        draw();
      });
    });
    container.replaceChildren(table);
  };
  draw();
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const dateMs = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };

function addDays(iso, n) {
  const d = new Date(dateMs(iso));
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/** Monday of the week holding this local date. */
function weekStart(iso) {
  const d = new Date(dateMs(iso));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}

/** Every week from the first entry in range (or the range start) to this week. */
function weekList(entries) {
  const c = cutoff();
  const first = c || (entries.length ? entries[0].local_date : null);
  if (!first) return [];
  const out = [];
  const d = new Date(dateMs(weekStart(first)));
  const end = weekStart(isoDate(new Date()));
  while (isoDate(d) <= end) { out.push(isoDate(d)); d.setDate(d.getDate() + 7); }
  return out;
}

const dateLabel = (iso) => new Date(dateMs(iso)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const shortDate = (iso, withYear) => new Date(dateMs(iso)).toLocaleDateString(undefined, withYear ? { month: "short", year: "2-digit" } : { month: "short", day: "numeric" });
const timeLabel = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const shortMonth = (iso) => new Date(dateMs(iso)).toLocaleDateString(undefined, { month: "short" });
const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" }).replace(":00", "").replace(" ", "").toLowerCase();
const fmt = (v, digits = 0) => Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });
const num = (v) => (v === null || v === undefined || v === 0 ? "" : fmt(v, 1));
const compact = (v) => (Math.abs(v) >= 1000 ? `${fmt(v / 1000, 1)}K` : fmt(v, 1));

function duration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 60)} h`;
}

let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => data && render(), 150); });

main();
