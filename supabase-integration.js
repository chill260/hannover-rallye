// Supabase integration for Hannover City Challenge
// supabase-js is pinned in index.html.

const rallyConfig = window.RALLYE_CONFIG || {};
const rallySupabase = window.supabase.createClient(
  rallyConfig.supabaseUrl,
  rallyConfig.supabasePublishableKey
);

let dbReady = false;
let currentUserId = null;

async function dbLoadState() {
  const { data: sessionData } = await rallySupabase.auth.getSession();
  const session = sessionData?.session;
  if (!session) return false;

  currentUserId = session.user.id;

  const { data: profile, error: profileError } = await rallySupabase
    .from("profiles")
    .select("username,team,role")
    .eq("id", currentUserId)
    .single();

  if (profileError || !profile || !profile.team) {
    await rallySupabase.auth.signOut();
    return false;
  }

  const { data: teamProgress, error: teamError } = await rallySupabase
    .from("team_progress")
    .select("current_station,hints,attempts,finished")
    .eq("team", profile.team)
    .single();

  if (teamError) throw teamError;

  const { data: stations, error: stationError } = await rallySupabase
    .from("station_progress")
    .select("station_index,hint_used,completed")
    .eq("team", profile.team);

  if (stationError) throw stationError;

  state = newState();
  state.loggedIn = true;
  state.username = profile.username;
  state.team = profile.team;
  state.step = teamProgress.finished ? TARGETS.length : teamProgress.current_station;
  state.hints = teamProgress.hints || 0;
  state.attempts = teamProgress.attempts || 0;

  for (const row of stations || []) {
    if (row.completed) state.passed[row.station_index] = true;
    if (row.hint_used) state["hint_" + profile.team + "_" + row.station_index] = true;
  }

  localStorage.setItem(KEY, JSON.stringify(state));
  dbReady = true;
  return true;
}

async function dbSaveTeamProgress() {
  if (!dbReady || !state.loggedIn || !state.team) return;

  const finished = state.step >= TARGETS.length;
  const currentStation = finished ? TARGETS.length : state.step;

  const { error } = await rallySupabase
    .from("team_progress")
    .update({
      current_station: currentStation,
      hints: state.hints,
      attempts: state.attempts,
      finished,
      updated_at: new Date().toISOString()
    })
    .eq("team", state.team);

  if (error) console.error("team_progress update failed", error);
}

async function dbUpsertStation(index) {
  if (!dbReady || !state.loggedIn || !state.team || index < 0 || index >= TARGETS.length) return;

  const hintKey = "hint_" + state.team + "_" + index;
  const completed = !!state.passed[index];

  // Read existing row first so retries do not reset the station attempt counter.
  const { data: existing } = await rallySupabase
    .from("station_progress")
    .select("attempts")
    .eq("team", state.team)
    .eq("station_index", index)
    .maybeSingle();

  const attemptsForStation = existing?.attempts ?? 0;

  const payload = {
    team: state.team,
    station_index: index,
    attempts: attemptsForStation,
    hint_used: !!state[hintKey],
    completed,
    completed_at: completed ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  };

  const { error } = await rallySupabase
    .from("station_progress")
    .upsert(payload, { onConflict: "team,station_index" });

  if (error) console.error("station_progress upsert failed", error);
}

async function dbIncrementStationAttempt(index) {
  if (!dbReady || !state.loggedIn || !state.team) return;

  const { data: existing } = await rallySupabase
    .from("station_progress")
    .select("attempts,hint_used,completed,completed_at")
    .eq("team", state.team)
    .eq("station_index", index)
    .maybeSingle();

  const payload = {
    team: state.team,
    station_index: index,
    attempts: (existing?.attempts || 0) + 1,
    hint_used: existing?.hint_used || !!state["hint_" + state.team + "_" + index],
    completed: existing?.completed || !!state.passed[index],
    completed_at: existing?.completed_at || (state.passed[index] ? new Date().toISOString() : null),
    updated_at: new Date().toISOString()
  };

  const { error } = await rallySupabase
    .from("station_progress")
    .upsert(payload, { onConflict: "team,station_index" });

  if (error) console.error("station attempt update failed", error);
}

// Replace local-only persistence with local + Supabase persistence.
window.save = function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
  void dbSaveTeamProgress();
};

window.login = async function login() {
  const username = document.getElementById("username").value.trim().toLowerCase();
  const password = document.getElementById("password").value;
  const box = document.getElementById("loginStatus");

  if (!username || !password) {
    box.className = "status bad";
    box.innerHTML = "<strong>❌ Benutzername und Passwort eingeben.</strong>";
    return;
  }

  box.className = "status info";
  box.innerHTML = "🔐 Anmeldung läuft …";

  const email = username + "@" + rallyConfig.loginDomain;
  const { error } = await rallySupabase.auth.signInWithPassword({ email, password });

  if (error) {
    box.className = "status bad";
    box.innerHTML = "<strong>❌ Login fehlgeschlagen.</strong><br><span class='small'>Benutzername oder Passwort stimmt nicht.</span>";
    return;
  }

  try {
    const ok = await dbLoadState();
    if (!ok) throw new Error("Kein Teamprofil gefunden");
    render();
  } catch (e) {
    console.error(e);
    box.className = "status bad";
    box.innerHTML = "<strong>❌ Teamprofil konnte nicht geladen werden.</strong>";
  }
};

window.resetAll = async function resetAll() {
  await rallySupabase.auth.signOut();
  dbReady = false;
  currentUserId = null;
  localStorage.removeItem(KEY);
  state = newState();
  render();
};

const originalRenderLogin = renderLogin;
window.renderLogin = function renderLogin() {
  return `
  <section class="card">
    <span class="badge">Live mit Datenbank</span>
    <h1>🌲 Hannover City Challenge</h1>
    <p>Von der Eilenriede durch die List bis zum Vietal.</p>

    <div class="mission">
      <strong>Startpunkt</strong>
      <p>${START.text}</p>
      <p class="small">Meldet euch mit eurem Team-Zugang an. Euer Fortschritt wird online gespeichert.</p>
    </div>

    <label for="username">Benutzername</label>
    <input id="username" autocomplete="username" placeholder="team-a">

    <label for="password">Passwort</label>
    <input id="password" type="password" autocomplete="current-password" placeholder="Passwort">

    <div class="row" style="margin-top:14px">
      <button class="primary" id="loginBtn">Einloggen</button>
    </div>

    <div id="loginStatus" class="status info">
      🔐 Supabase-Login aktiv
    </div>
  </section>`;
};

// Wrap location checks so each press is also counted for the current station in the DB.
const originalCheckLocation = checkLocation;
window.checkLocation = function checkLocation() {
  const stationIndex = state.step;
  void dbIncrementStationAttempt(stationIndex);
  return originalCheckLocation();
};

// Persist station details whenever a hint is used.
const originalUseHint = useHint;
window.useHint = function useHint() {
  const stationIndex = state.step;
  originalUseHint();
  void dbUpsertStation(stationIndex);
};

// Persist completion immediately after GPS success.
const originalShowCorrect = showCorrect;
window.showCorrect = function showCorrect() {
  const stationIndex = state.step;
  originalShowCorrect();
  void dbUpsertStation(stationIndex);
};

// Restore an existing Supabase session after reload.
(async () => {
  try {
    const restored = await dbLoadState();
    render();
  } catch (e) {
    console.error("Supabase session restore failed", e);
    await rallySupabase.auth.signOut();
    dbReady = false;
    state = newState();
    render();
  }
})();
