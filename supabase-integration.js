// Hannover City Challenge - Supabase live game logic
const rallyConfig = window.RALLYE_CONFIG || {};
const rallySupabase = window.supabase.createClient(
  rallyConfig.supabaseUrl,
  rallyConfig.supabasePublishableKey
);

let dbReady = false;
let currentUserId = null;
let routeQuestions = {};
let teamAnswers = {};

function freshState() {
  return {
    loggedIn: false,
    username: null,
    team: null,
    step: 0,
    hints: 0,
    attempts: 0,
    passed: {},
    phase: "travel-main",
    branchFromStation: null,
    correctAnswers: 0,
    detours: 0,
    demoMode: false,
    simulateWrong: false
  };
}

async function loadGameData() {
  const { data: sessionData } = await rallySupabase.auth.getSession();
  const session = sessionData?.session;
  if (!session) return false;

  currentUserId = session.user.id;

  const { data: profile, error: profileError } = await rallySupabase
    .from("profiles")
    .select("username,team,role")
    .eq("id", currentUserId)
    .single();

  if (profileError || !profile?.team) {
    await rallySupabase.auth.signOut();
    return false;
  }

  const [
    stationRes,
    questionRes,
    progressRes,
    stationProgressRes,
    answersRes
  ] = await Promise.all([
    rallySupabase.from("stations")
      .select("station_index,name,latitude,longitude,radius_m")
      .order("station_index"),
    rallySupabase.from("route_questions")
      .select("from_station_index,question,options,correct_option,correct_target_index,decoy_name,decoy_latitude,decoy_longitude,decoy_radius_m,wrong_reveal"),
    rallySupabase.from("team_progress")
      .select("current_station,hints,attempts,finished,phase,branch_from_station,correct_answers,detours")
      .eq("team", profile.team)
      .single(),
    rallySupabase.from("station_progress")
      .select("station_index,hint_used,completed")
      .eq("team", profile.team),
    rallySupabase.from("team_answers")
      .select("from_station_index,selected_option,answer_correct,detour_completed")
      .eq("team", profile.team)
  ]);

  if (stationRes.error) throw stationRes.error;
  if (questionRes.error) throw questionRes.error;
  if (progressRes.error) throw progressRes.error;
  if (stationProgressRes.error) throw stationProgressRes.error;
  if (answersRes.error) throw answersRes.error;

  for (const row of stationRes.data || []) {
    if (TARGETS[row.station_index]) {
      TARGETS[row.station_index].name = row.name;
      TARGETS[row.station_index].lat = row.latitude;
      TARGETS[row.station_index].lon = row.longitude;
      TARGETS[row.station_index].radius = row.radius_m;
    }
  }

  routeQuestions = {};
  for (const q of questionRes.data || []) routeQuestions[q.from_station_index] = q;

  teamAnswers = {};
  for (const a of answersRes.data || []) teamAnswers[a.from_station_index] = a;

  const p = progressRes.data;
  state = freshState();
  state.loggedIn = true;
  state.username = profile.username;
  state.team = profile.team;
  state.step = p.finished ? TARGETS.length : p.current_station;
  state.hints = p.hints || 0;
  state.attempts = p.attempts || 0;
  state.phase = p.finished ? "finished" : (p.phase || "travel-main");
  state.branchFromStation = p.branch_from_station;
  state.correctAnswers = p.correct_answers || 0;
  state.detours = p.detours || 0;

  for (const row of stationProgressRes.data || []) {
    if (row.completed) state.passed[row.station_index] = true;
    if (row.hint_used) state["hint_" + profile.team + "_" + row.station_index] = true;
  }

  localStorage.setItem(KEY, JSON.stringify(state));
  dbReady = true;
  return true;
}

async function persistTeam() {
  if (!dbReady || !state.loggedIn || !state.team) return;

  const finished = state.phase === "finished" || state.step >= TARGETS.length;
  const { error } = await rallySupabase.from("team_progress").update({
    current_station: finished ? TARGETS.length : state.step,
    hints: state.hints,
    attempts: state.attempts,
    finished,
    phase: finished ? "finished" : state.phase,
    branch_from_station: state.branchFromStation,
    correct_answers: state.correctAnswers,
    detours: state.detours,
    updated_at: new Date().toISOString()
  }).eq("team", state.team);

  if (error) console.error("team_progress update failed", error);
}

function saveLocal() {
  localStorage.setItem(KEY, JSON.stringify(state));
  void persistTeam();
}

async function persistStation(index) {
  if (!dbReady || index == null || index < 0 || index >= TARGETS.length) return;

  const { data: existing } = await rallySupabase
    .from("station_progress")
    .select("attempts,hint_used,completed,completed_at")
    .eq("team", state.team)
    .eq("station_index", index)
    .maybeSingle();

  const payload = {
    team: state.team,
    station_index: index,
    attempts: existing?.attempts || 0,
    hint_used: existing?.hint_used || !!state["hint_" + state.team + "_" + index],
    completed: existing?.completed || !!state.passed[index],
    completed_at: existing?.completed_at || (state.passed[index] ? new Date().toISOString() : null),
    updated_at: new Date().toISOString()
  };

  const { error } = await rallySupabase
    .from("station_progress")
    .upsert(payload, { onConflict: "team,station_index" });

  if (error) console.error("station_progress upsert failed", error);
}

async function incrementMainAttempt(index) {
  state.attempts++;
  saveLocal();

  const { data: existing } = await rallySupabase
    .from("station_progress")
    .select("attempts,hint_used,completed,completed_at")
    .eq("team", state.team)
    .eq("station_index", index)
    .maybeSingle();

  const { error } = await rallySupabase.from("station_progress").upsert({
    team: state.team,
    station_index: index,
    attempts: (existing?.attempts || 0) + 1,
    hint_used: existing?.hint_used || !!state["hint_" + state.team + "_" + index],
    completed: existing?.completed || !!state.passed[index],
    completed_at: existing?.completed_at || null,
    updated_at: new Date().toISOString()
  }, { onConflict: "team,station_index" });

  if (error) console.error("station attempt update failed", error);
}

async function persistAnswer(fromStation, selectedOption, correct) {
  const existing = teamAnswers[fromStation];
  const payload = {
    team: state.team,
    from_station_index: fromStation,
    selected_option: selectedOption,
    answer_correct: correct,
    detour_completed: existing?.detour_completed || false,
    answered_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { error } = await rallySupabase
    .from("team_answers")
    .upsert(payload, { onConflict: "team,from_station_index" });

  if (!error) teamAnswers[fromStation] = payload;
  else console.error("team answer save failed", error);
}

async function markDetourComplete(fromStation) {
  const existing = teamAnswers[fromStation];
  if (!existing) return;
  const payload = { ...existing, detour_completed: true, updated_at: new Date().toISOString() };

  const { error } = await rallySupabase
    .from("team_answers")
    .upsert(payload, { onConflict: "team,from_station_index" });

  if (!error) teamAnswers[fromStation] = payload;
  else console.error("detour completion save failed", error);
}

function questionForTeam(target) {
  return state.team === "A" ? target.questionA : target.questionB;
}

function hintForTeam(target) {
  return state.team === "A" ? target.hintA : target.hintB;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderLoginLive() {
  return `
  <section class="card">
    <span class="badge">Live mit Datenbank</span>
    <h1>🌲 Hannover City Challenge</h1>
    <p>Rätseln, entscheiden, laufen. Falsche Antwort? Dann gibt es eine kleine Ehrenrunde. 😄</p>

    <div class="mission">
      <strong>Startpunkt</strong>
      <p>${START.text}</p>
      <p class="small">Der komplette Fortschritt wird online gespeichert.</p>
    </div>

    <label for="username">Benutzername</label>
    <input id="username" autocomplete="username" placeholder="team-a">
    <label for="password">Passwort</label>
    <input id="password" type="password" autocomplete="current-password" placeholder="Passwort">

    <div class="row" style="margin-top:14px">
      <button class="primary" id="loginBtn">Einloggen</button>
    </div>

    <div id="loginStatus" class="status info">🔐 Supabase-Login aktiv</div>
  </section>`;
}

function renderTravelMain() {
  const target = TARGETS[state.step];
  const progress = Math.round((state.step / TARGETS.length) * 100);
  const hintUsed = !!state["hint_" + state.team + "_" + state.step];

  return `
  <section class="card">
    <span class="badge">Team ${state.team}</span>
    <span class="badge">Ziel ${state.step + 1}/${TARGETS.length}</span>
    <span class="badge">✅ ${state.correctAnswers} richtige Antworten</span>
    <span class="badge">↪️ ${state.detours} Ehrenrunde${state.detours === 1 ? "" : "n"}</span>

    <div class="progress"><div style="width:${progress}%"></div></div>

    <h1>🧭 Findet den Ort</h1>
    <div class="mission">
      <h3>Mission ${state.step + 1}</h3>
      <p>${questionForTeam(target)}</p>
    </div>

    <button class="primary" id="checkBtn">📍 Standort prüfen</button>
    <div id="status" class="status info">
      Lauft zum vermuteten Ziel und prüft dort euren Standort.
    </div>

    <div class="row" style="margin-top:12px">
      <button class="warn" id="hintBtn">💡 Hinweis</button>
    </div>

    <div id="hintBox" class="status ${hintUsed ? "" : "hidden"}">
      ${hintUsed ? "💡 " + hintForTeam(target) : ""}
    </div>

    <details>
      <summary>🧪 Testmodus</summary>
      <label style="display:flex;gap:10px;align-items:center;margin-top:12px">
        <input id="demoMode" type="checkbox" style="width:auto" ${state.demoMode ? "checked" : ""}>
        <span>GPS-Treffer simulieren</span>
      </label>
      <label style="display:flex;gap:10px;align-items:center">
        <input id="simulateWrong" type="checkbox" style="width:auto" ${state.simulateWrong ? "checked" : ""}>
        <span>GPS absichtlich als falsch simulieren</span>
      </label>
    </details>

    <hr>
    <button class="ghost" id="logoutBtn">Abmelden</button>
  </section>`;
}

function renderQuestion() {
  const from = state.step;
  const q = routeQuestions[from];
  if (!q) return renderStationComplete();

  const options = Array.isArray(q.options) ? q.options : [];

  return `
  <section class="card">
    <span class="badge">Team ${state.team}</span>
    <span class="badge">Entscheidungsfrage</span>
    <h1>🧠 Wohin geht es weiter?</h1>

    <div class="status ok">
      ✅ Standort gefunden: <strong>${escapeHtml(TARGETS[from].name)}</strong>
    </div>

    <div class="mission">
      <h3>Frage</h3>
      <p>${escapeHtml(q.question)}</p>
    </div>

    <div style="display:grid;gap:10px">
      ${options.map((o, i) =>
        `<button class="ghost answerBtn" data-answer="${i}">${String.fromCharCode(65+i)} · ${escapeHtml(o)}</button>`
      ).join("")}
    </div>

    <p class="small">Die Antwort bestimmt euer nächstes GPS-Ziel. Ihr erfahrt erst dort, ob eure Entscheidung richtig war.</p>
  </section>`;
}

function renderStationComplete() {
  const target = TARGETS[state.step];
  return `
  <section class="card">
    <span class="badge">Team ${state.team}</span>
    <h1>✅ Ziel gefunden</h1>
    <div class="mission">
      <strong>${escapeHtml(target.name)}</strong>
      <p>Diese Station hat keine Entscheidungsfrage. Ihr könnt direkt weitermachen.</p>
    </div>
    <button class="secondary" id="continueBtn">
      ${state.step === TARGETS.length - 1 ? "🏁 Rallye abschließen" : "Nächste Mission →"}
    </button>
  </section>`;
}

function renderTravelDecoy() {
  const from = state.branchFromStation;
  const q = routeQuestions[from];

  return `
  <section class="card">
    <span class="badge">Team ${state.team}</span>
    <span class="badge">Antwort abgegeben</span>
    <h1>🧭 Neues Ziel</h1>

    <div class="mission">
      <p>Findet jetzt diesen Ort:</p>
      <p class="big">📍 ${escapeHtml(q.decoy_name)}</p>
      <p class="small">Ob eure Antwort richtig war, erfahrt ihr erst dort.</p>
    </div>

    <button class="primary" id="checkDecoyBtn">📍 Standort prüfen</button>
    <div id="status" class="status info">Noch wird nichts verraten. 😈</div>

    <details>
      <summary>🧪 Testmodus</summary>
      <label style="display:flex;gap:10px;align-items:center;margin-top:12px">
        <input id="demoMode" type="checkbox" style="width:auto" ${state.demoMode ? "checked" : ""}>
        <span>GPS-Treffer simulieren</span>
      </label>
      <label style="display:flex;gap:10px;align-items:center">
        <input id="simulateWrong" type="checkbox" style="width:auto" ${state.simulateWrong ? "checked" : ""}>
        <span>GPS absichtlich als falsch simulieren</span>
      </label>
    </details>
  </section>`;
}

function renderDetourReveal() {
  const from = state.branchFromStation;
  const q = routeQuestions[from];

  return `
  <section class="card">
    <span class="badge">Ehrenrunde beendet</span>
    <h1>❌ Antwort leider falsch</h1>
    <div class="status bad">
      ${escapeHtml(q.wrong_reveal)}
    </div>
    <div class="mission">
      <p>Jetzt bekommt ihr das eigentliche nächste Ziel.</p>
      <p><strong>Nächste Mission freischalten und weiter geht’s.</strong></p>
    </div>
    <button class="secondary" id="continueFromDetourBtn">Nächste Mission →</button>
  </section>`;
}

function renderFinishedLive() {
  return `
  <section class="card">
    <span class="badge">Team ${state.team}</span>
    <h1>🏁 Geschafft!</h1>
    <p class="big">Ihr seid am Vietal angekommen.</p>

    <div class="mission">
      <p>🧠 Richtige Antworten: <strong>${state.correctAnswers}</strong></p>
      <p>↪️ Ehrenrunden: <strong>${state.detours}</strong></p>
      <p>💡 Hinweise: <strong>${state.hints}</strong></p>
      <p>📍 Standortprüfungen: <strong>${state.attempts}</strong></p>
    </div>

    <p>Jetzt ist Schluss mit GPS. 🍜</p>
    <button class="ghost" id="logoutBtn">Abmelden</button>
  </section>`;
}

async function loginLive() {
  const username = document.getElementById("username").value.trim().toLowerCase();
  const password = document.getElementById("password").value;
  const box = document.getElementById("loginStatus");

  if (!username || !password) {
    box.className = "status bad";
    box.innerHTML = "<strong>❌ Benutzername und Passwort eingeben.</strong>";
    return;
  }

  box.className = "status info";
  box.textContent = "🔐 Anmeldung läuft …";

  const { error } = await rallySupabase.auth.signInWithPassword({
    email: username + "@" + rallyConfig.loginDomain,
    password
  });

  if (error) {
    box.className = "status bad";
    box.innerHTML = "<strong>❌ Login fehlgeschlagen.</strong>";
    return;
  }

  try {
    const ok = await loadGameData();
    if (!ok) throw new Error("Kein Teamprofil");
    renderLive();
  } catch (e) {
    console.error(e);
    box.className = "status bad";
    box.innerHTML = "<strong>❌ Spielstand konnte nicht geladen werden.</strong>";
  }
}

async function logoutLive() {
  await rallySupabase.auth.signOut();
  dbReady = false;
  currentUserId = null;
  routeQuestions = {};
  teamAnswers = {};
  localStorage.removeItem(KEY);
  state = freshState();
  renderLive();
}

function useHintLive() {
  const key = "hint_" + state.team + "_" + state.step;
  if (!state[key]) {
    state[key] = true;
    state.hints++;
    saveLocal();
    void persistStation(state.step);
  }
  renderLive();
}

function getGps(callback) {
  if (state.demoMode) {
    setTimeout(() => callback(!state.simulateWrong), 250);
    return;
  }

  if (!navigator.geolocation) {
    callback(false, "Standortabfrage wird von diesem Browser nicht unterstützt.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    pos => callback(pos),
    err => {
      let msg = "Standort konnte nicht geprüft werden.";
      if (err.code === 1) msg = "Standortfreigabe wurde abgelehnt.";
      if (err.code === 2) msg = "Standort ist momentan nicht verfügbar.";
      if (err.code === 3) msg = "Standortabfrage hat zu lange gedauert.";
      callback(false, msg);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

function isAtPosition(result, lat, lon, radius) {
  if (result === true) return true;
  if (!result || typeof result !== "object" || !result.coords) return false;
  const dist = distanceMeters(result.coords.latitude, result.coords.longitude, lat, lon);
  const allowed = Math.max(radius, Math.min(110, result.coords.accuracy || 0));
  return dist <= allowed;
}

async function checkMainLocation() {
  const btn = document.getElementById("checkBtn");
  const status = document.getElementById("status");
  const index = state.step;
  const target = TARGETS[index];

  btn.disabled = true;
  status.className = "status info";
  status.textContent = "📡 Standort wird geprüft …";
  await incrementMainAttempt(index);

  getGps(async (result, errorMsg) => {
    const hit = isAtPosition(result, target.lat, target.lon, target.radius);

    if (!hit) {
      status.className = "status bad";
      status.innerHTML = "<strong>❌ Noch nicht richtig.</strong><br>" + (errorMsg || "Weiter suchen.");
      btn.disabled = false;
      return;
    }

    state.passed[index] = true;
    await persistStation(index);

    if (routeQuestions[index]) {
      state.phase = "question";
    } else {
      state.phase = "station-complete";
    }

    saveLocal();
    renderLive();
  });
}

async function answerQuestion(selected) {
  const from = state.step;
  const q = routeQuestions[from];
  const correct = selected === q.correct_option;

  await persistAnswer(from, selected, correct);

  if (correct) {
    state.correctAnswers++;
    state.step = q.correct_target_index;
    state.phase = "travel-main";
    state.branchFromStation = null;
  } else {
    state.detours++;
    state.step = q.correct_target_index;
    state.phase = "travel-decoy";
    state.branchFromStation = from;
  }

  saveLocal();
  renderLive();
}

async function checkDecoyLocation() {
  const from = state.branchFromStation;
  const q = routeQuestions[from];
  const btn = document.getElementById("checkDecoyBtn");
  const status = document.getElementById("status");

  btn.disabled = true;
  status.className = "status info";
  status.textContent = "📡 Standort wird geprüft …";
  state.attempts++;
  saveLocal();

  getGps(async (result, errorMsg) => {
    const hit = isAtPosition(result, q.decoy_latitude, q.decoy_longitude, q.decoy_radius_m);

    if (!hit) {
      status.className = "status bad";
      status.innerHTML = "<strong>❌ Noch nicht am zugeteilten Ziel.</strong><br>" + (errorMsg || "Weiter suchen.");
      btn.disabled = false;
      return;
    }

    await markDetourComplete(from);
    state.phase = "detour-reveal";
    saveLocal();
    renderLive();
  });
}

function continueNormal() {
  if (state.step === TARGETS.length - 1) {
    state.step = TARGETS.length;
    state.phase = "finished";
  } else {
    state.step++;
    state.phase = "travel-main";
  }
  saveLocal();
  renderLive();
}

function continueFromDetour() {
  state.phase = "travel-main";
  state.branchFromStation = null;
  saveLocal();
  renderLive();
}

function wireDemoToggles() {
  const dm = document.getElementById("demoMode");
  const sw = document.getElementById("simulateWrong");
  if (dm) dm.addEventListener("change", e => { state.demoMode = e.target.checked; localStorage.setItem(KEY, JSON.stringify(state)); });
  if (sw) sw.addEventListener("change", e => { state.simulateWrong = e.target.checked; localStorage.setItem(KEY, JSON.stringify(state)); });
}

function renderLive() {
  const app = document.getElementById("app");

  if (!state.loggedIn) {
    app.innerHTML = renderLoginLive();
    document.getElementById("loginBtn").addEventListener("click", loginLive);
    document.getElementById("password").addEventListener("keydown", e => {
      if (e.key === "Enter") loginLive();
    });
    return;
  }

  if (state.phase === "finished" || state.step >= TARGETS.length) {
    app.innerHTML = renderFinishedLive();
    document.getElementById("logoutBtn").addEventListener("click", logoutLive);
    return;
  }

  if (state.phase === "question") {
    app.innerHTML = renderQuestion();
    document.querySelectorAll(".answerBtn").forEach(btn => {
      btn.addEventListener("click", () => answerQuestion(Number(btn.dataset.answer)));
    });
    return;
  }

  if (state.phase === "travel-decoy") {
    app.innerHTML = renderTravelDecoy();
    document.getElementById("checkDecoyBtn").addEventListener("click", checkDecoyLocation);
    wireDemoToggles();
    return;
  }

  if (state.phase === "detour-reveal") {
    app.innerHTML = renderDetourReveal();
    document.getElementById("continueFromDetourBtn").addEventListener("click", continueFromDetour);
    return;
  }

  if (state.phase === "station-complete") {
    app.innerHTML = renderStationComplete();
    document.getElementById("continueBtn").addEventListener("click", continueNormal);
    return;
  }

  app.innerHTML = renderTravelMain();
  document.getElementById("checkBtn").addEventListener("click", checkMainLocation);
  document.getElementById("hintBtn").addEventListener("click", useHintLive);
  document.getElementById("logoutBtn").addEventListener("click", logoutLive);
  wireDemoToggles();
}

// Take over rendering from the prototype code.
window.render = renderLive;
window.login = loginLive;
window.resetAll = logoutLive;

(async () => {
  state = freshState();
  try {
    await loadGameData();
  } catch (e) {
    console.error("Session restore failed", e);
    await rallySupabase.auth.signOut();
    state = freshState();
  }
  renderLive();
})();
