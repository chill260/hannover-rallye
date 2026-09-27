const cfg=window.RALLYE_CONFIG||{};
const db=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey);
let profile=null,player=null,adminTab="teams",editorMap=null,editorMarker=null;

const app=()=>document.getElementById("app");
const esc=v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const uuid=()=>crypto.randomUUID();

async function sessionProfile(){
 const {data:{session}}=await db.auth.getSession();
 if(!session)return null;
 const {data,error}=await db.from("profiles").select("username,team,role").eq("id",session.user.id).single();
 if(error)return null;
 return data;
}
async function boot(){
 try{profile=await sessionProfile();if(profile?.role==="player")await loadPlayer();render()}
 catch(e){console.error(e);app().innerHTML='<section class="card"><h1>⚠️ Fehler</h1><div class="status bad">Die Rallye konnte nicht geladen werden.</div></section>'}
}
function loginView(){return `<section class="card"><span class="badge">Live</span><h1>🎄 Hannover City Challenge</h1><p>Knobeln, Hannover entdecken und gemeinsam am Vietal ankommen.</p><label>Benutzername</label><input id="loginUser" autocomplete="username" placeholder="team-a"><label>Passwort</label><input id="loginPass" type="password" autocomplete="current-password"><button class="primary" id="loginBtn" style="margin-top:14px">Einloggen</button><div id="loginStatus" class="status info">🔐 Geschützter Team-Login</div></section>`}
async function login(){
 const u=document.getElementById("loginUser").value.trim().toLowerCase(),p=document.getElementById("loginPass").value,s=document.getElementById("loginStatus");
 if(!u||!p){s.className="status bad";s.textContent="Benutzername und Passwort eingeben.";return}
 s.className="status info";s.textContent="Anmeldung läuft …";
 const {error}=await db.auth.signInWithPassword({email:u+"@"+cfg.loginDomain,password:p});
 if(error){s.className="status bad";s.textContent="Login fehlgeschlagen.";return}
 profile=await sessionProfile();
 if(profile?.role==="player")await loadPlayer();
 render();
}
async function logout(){await db.auth.signOut();profile=null;player=null;render()}

async function loadPlayer(){
 const {data,error}=await db.rpc("get_rally_player_state");
 if(error)throw error;
 player=data;
}
function playerBad(msg){return `<div class="status bad"><strong>❌ ${esc(msg)}</strong></div>`}
function playerHeader(){
 return `<span class="badge">Team ${esc(player.team)}</span><span class="badge">✅ ${player.correct_answers||0}</span><span class="badge">⚠️ ${player.penalty_points||0}</span><span class="badge">💡 ${player.hints||0}</span>`;
}
function questionView(){
 const q=player.current||{},wrong=q.wrong_attempts||0,revealed=wrong>=3&&q.solution;
 const mc=q.question_type==="multiple_choice",teamTask=q.question_type==="team_challenge",opts=Array.isArray(q.options)?q.options:[];
 return `<section class="card">${playerHeader()}<h1>${teamTask?"🤝 Teamaufgabe":mc?"🎯 Multiple Choice":"🧩 Rätselgeschichte"}</h1>
 ${q.fun_fact?`<div class="mission"><h3>📍 Hannover-Fakt</h3><p>${esc(q.fun_fact)}</p></div>`:""}
 <div class="mission"><h3>${teamTask?"Gemeinsam lösen":mc?"Frage":"Der Fall"}</h3><p>${esc(q.question)}</p></div>
 ${revealed?`<div class="status bad"><strong>Auflösung</strong><br>${esc(q.solution)}</div><p class="small">Dafür gibt es einen Strafpunkt. Die Route bleibt unverändert.</p><button class="secondary" id="continueRevealBtn">Nächstes Ziel →</button>`:
 mc?`<div style="display:grid;gap:10px">${opts.map((o,i)=>`<button class="ghost mcBtn" data-i="${i}">${String.fromCharCode(65+i)} · ${esc(o)}</button>`).join("")}</div><div class="status info">${wrong?"Fehlversuche: <strong>"+wrong+"</strong>":"Wählt gemeinsam eine Antwort."}</div>${q.hint?`<div class="status info">💡 <strong>Hinweis:</strong> ${esc(q.hint)}</div>`:""}`:
 `<label>${teamTask?"Euer gemeinsamer Satz":"Eure Lösung"}</label><input id="answerText" autocomplete="off" placeholder="${teamTask?"Euren Satz eingeben …":"Schreibt eure Theorie …"}"><button class="primary" id="answerBtn" style="margin-top:12px">${teamTask?"Aufgabe erledigt ✓":"Lösung prüfen"}</button><div class="status info">${teamTask?"Hier gibt es bewusst keine falsche Antwort.":wrong?"Fehlversuche: <strong>"+wrong+"</strong>":"Diskutiert gemeinsam und gebt eure Lösung ein."}</div>${q.hint?`<div class="status info">💡 <strong>Hinweis:</strong> ${esc(q.hint)}</div>`:""}`}
 <hr><button class="ghost" id="logoutBtn">Abmelden</button></section>`;
}
async function answer(text=null,sel=null){
 const q=player.current;
 const {data,error}=await db.rpc("submit_rally_answer",{p_question_id:q.question_id,p_answer_text:text,p_selected_option:sel});
 if(error){alert("Antwort konnte nicht geprüft werden.");console.error(error);return}
 await loadPlayer();render();
}
async function continueReveal(){
 const {error}=await db.rpc("continue_rally_after_reveal",{p_question_id:player.current.question_id});
 if(error){alert("Weitergehen fehlgeschlagen.");return}
 await loadPlayer();render();
}
function travelView(){
 const s=player.current||{};
 return `<section class="card">${playerHeader()}<span class="badge">Ziel ${Number(s.sort_order)+1}/${player.total_stations}</span><h1>🧭 Findet den Ort</h1>
 <div class="mission"><p>${esc(s.clue)}</p></div>
 <button class="primary" id="gpsBtn">📍 Standort prüfen</button>
 <div id="gpsStatus" class="status info">Lauft zum vermuteten Ziel und prüft dort euren Standort.</div>
 <button class="warn" id="stationHintBtn" style="margin-top:12px">💡 Hinweis</button>
 <div id="stationHintBox"></div>
 <hr><button class="ghost" id="logoutBtn">Abmelden</button></section>`;
}
async function gpsCheck(){
 const b=document.getElementById("gpsBtn"),s=document.getElementById("gpsStatus");b.disabled=true;s.className="status info";s.textContent="📡 Standort wird geprüft …";
 if(!navigator.geolocation){s.className="status bad";s.textContent="Standortabfrage wird nicht unterstützt.";b.disabled=false;return}
 navigator.geolocation.getCurrentPosition(async p=>{
   const {data,error}=await db.rpc("check_rally_location",{p_station_id:player.current.station_id,p_latitude:p.coords.latitude,p_longitude:p.coords.longitude,p_accuracy_m:p.coords.accuracy||0});
   if(error){s.className="status bad";s.textContent="Standort konnte nicht geprüft werden.";console.error(error);b.disabled=false;return}
   if(data?.status==="wrong_location"){s.className="status bad";s.innerHTML="<strong>❌ Noch nicht richtig.</strong><br>Weiter suchen.";b.disabled=false;return}
   await loadPlayer();render();
 },e=>{s.className="status bad";s.textContent=e.code===1?"Standortfreigabe wurde abgelehnt.":"Standort konnte nicht ermittelt werden.";b.disabled=false},{enableHighAccuracy:true,timeout:12000,maximumAge:0});
}
async function stationHint(){
 const {data,error}=await db.rpc("use_rally_station_hint",{p_station_id:player.current.station_id});
 if(error){alert("Hinweis konnte nicht geladen werden.");return}
 document.getElementById("stationHintBox").innerHTML=`<div class="status info">💡 ${esc(data)}</div>`;
 await loadPlayer();
}
function finishedView(){return `<section class="card">${playerHeader()}<h1>🏁 Geschafft!</h1><p class="big">Ihr seid am Ziel angekommen.</p><div class="mission"><p>🧠 Gelöste Rätsel: <strong>${player.correct_answers}</strong></p><p>⚠️ Strafpunkte: <strong>${player.penalty_points}</strong></p><p>💡 Hinweise: <strong>${player.hints}</strong></p><p>📍 GPS-Prüfungen: <strong>${player.gps_attempts}</strong></p></div><button class="ghost" id="logoutBtn">Abmelden</button></section>`}

async function loadAdminRoute(status="draft"){
 const {data:r,error:re}=await db.from("rally_routes").select("*").eq("status",status).maybeSingle();if(re)throw re;if(!r)return null;
 const [s,q]=await Promise.all([
  db.from("rally_stations").select("*").eq("route_id",r.id).order("sort_order"),
  db.from("rally_questions").select("*").eq("route_id",r.id)
 ]);
 if(s.error)throw s.error;if(q.error)throw q.error;
 return {route:r,stations:s.data||[],questions:q.data||[]};
}
function adminShell(title,body){
 return `<section class="card"><span class="badge">Orga</span><h1>🛠️ ${title}</h1><div class="admin-tabs"><button class="ghost ${adminTab==="teams"?"active":""}" data-tab="teams">📊 Teams</button><button class="ghost ${adminTab==="stations"?"active":""}" data-tab="stations">📍 Stationen</button><button class="ghost ${adminTab==="questions"?"active":""}" data-tab="questions">🧩 Rätsel</button><button class="ghost ${adminTab==="preview"?"active":""}" data-tab="preview">👁 Vorschau</button><button class="ghost ${adminTab==="publish"?"active":""}" data-tab="publish">🚀 Veröffentlichen</button></div>${body}<hr><button class="ghost" id="logoutBtn">Abmelden</button></section>`;
}
function wireAdmin(){
 document.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{adminTab=b.dataset.tab;renderAdmin()});
 document.getElementById("logoutBtn")?.addEventListener("click",logout);
}
function elapsedMs(r){return r.started_at&&r.finished_at?new Date(r.finished_at)-new Date(r.started_at):null}
function fmtDuration(ms){if(ms==null)return "läuft";const m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000);return m+" min "+String(s).padStart(2,"0")+" s"}
function rankRuns(runs){return [...runs].sort((a,b)=>(a.penalty_points-b.penalty_points)||(a.hints-b.hints)||((elapsedMs(a)??Infinity)-(elapsedMs(b)??Infinity)))}
async function renderTeams(){
 const [runs,controls]=await Promise.all([
  db.from("rally_team_runs").select("*").order("team"),
  db.from("admin_controls").select("*").order("team")
 ]);
 if(runs.error)throw runs.error;if(controls.error)throw controls.error;
 const cm=Object.fromEntries((controls.data||[]).map(x=>[x.team,x]));
 const ranking=rankRuns(runs.data||[]); const places=Object.fromEntries(ranking.map((r,i)=>[r.team,i+1]));
 const body=(runs.data||[]).map(r=>`<div class="mission"><div class="row" style="justify-content:space-between"><h2>Team ${r.team}</h2><span class="badge">${esc(r.phase)}</span></div><p>🏆 Rang: <strong>${places[r.team]||"-"}</strong><br>✅ Gelöst: <strong>${r.correct_answers}</strong><br>⚠️ Strafpunkte: <strong>${r.penalty_points}</strong><br>💡 Hinweise: <strong>${r.hints}</strong><br>⏱️ Zeit: <strong>${fmtDuration(elapsedMs(r))}</strong><br>📍 GPS: <strong>${r.gps_attempts}</strong></p><div class="row"><button class="warn bypassBtn" data-team="${r.team}" data-on="${cm[r.team]?.gps_bypass_once?"0":"1"}">${cm[r.team]?.gps_bypass_once?"GPS-Freigabe zurücknehmen":"Nächsten GPS-Check freigeben"}</button><button class="danger resetTeamBtn" data-team="${r.team}">↺ Team zurücksetzen</button></div></div>`).join("");
 app().innerHTML=adminShell("Orga-Dashboard",body||'<div class="status info">Noch keine Teamläufe vorhanden.</div>');wireAdmin();
 document.querySelectorAll(".bypassBtn").forEach(b=>b.onclick=async()=>{await db.from("admin_controls").update({gps_bypass_once:b.dataset.on==="1",updated_at:new Date().toISOString()}).eq("team",b.dataset.team);renderAdmin()});
 document.querySelectorAll(".resetTeamBtn").forEach(b=>b.onclick=()=>resetTeam(b.dataset.team));
}
async function resetTeam(team){
 if(!confirm("Team "+team+" wirklich zurücksetzen?"))return;
 const pub=await loadAdminRoute("published");const first=pub.questions.find(q=>q.from_station_id===null);
 await Promise.all([
  db.from("rally_team_station_progress").delete().eq("team",team),
  db.from("rally_team_question_progress").delete().eq("team",team),
  db.from("admin_controls").update({gps_bypass_once:false,updated_at:new Date().toISOString()}).eq("team",team)
 ]);
 await db.from("rally_team_runs").update({route_id:pub.route.id,phase:"question",current_question_id:first.question_id,current_station_id:null,correct_answers:0,penalty_points:0,hints:0,gps_attempts:0,finished:false,started_at:null,finished_at:null,updated_at:new Date().toISOString()}).eq("team",team);
 renderAdmin();
}
function initMap(lat,lon){
 if(editorMap)editorMap.remove();
 editorMap=L.map("stationMap").setView([lat,lon],16);L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap contributors"}).addTo(editorMap);
 editorMarker=L.marker([lat,lon],{draggable:true}).addTo(editorMap);
 const sync=ll=>{document.getElementById("stLat").value=ll.lat.toFixed(6);document.getElementById("stLon").value=ll.lng.toFixed(6)};
 editorMarker.on("dragend",e=>sync(e.target.getLatLng()));editorMap.on("click",e=>{editorMarker.setLatLng(e.latlng);sync(e.latlng)});
}
async function renderStations(selected=null){
 const d=await loadAdminRoute("draft");if(!d){app().innerHTML=adminShell("Stationseditor",'<div class="status bad">Kein Entwurf vorhanden.</div>');wireAdmin();return}
 const st=d.stations,cur=selected==="new"?{station_id:"",sort_order:st.length,name:"",latitude:52.3745,longitude:9.7385,radius_m:55,clue:"",hint:""}:(st.find(x=>x.station_id===(selected||st[0]?.station_id))||st[0]);
 const list=st.map(x=>`<div class="admin-item ${cur&&x.station_id===cur.station_id?"active":""}" data-st="${x.station_id}"><strong>${x.sort_order+1}. ${esc(x.name)}</strong></div>`).join("");
 const form=cur?`<div class="mission"><input id="stId" type="hidden" value="${esc(cur.station_id)}"><label>Name</label><input id="stName" value="${esc(cur.name)}"><div class="two-col"><div><label>Breitengrad</label><input id="stLat" type="number" step=".000001" value="${cur.latitude}"></div><div><label>Längengrad</label><input id="stLon" type="number" step=".000001" value="${cur.longitude}"></div></div><label>GPS-Radius</label><input id="stRadius" type="number" value="${cur.radius_m}"><label>Zielhinweis für beide Teams</label><textarea id="stClue">${esc(cur.clue)}</textarea><label>Hilfe-Hinweis für beide Teams</label><textarea id="stHint">${esc(cur.hint)}</textarea><div id="stationMap"></div><div class="row" style="margin-top:12px"><button class="secondary" id="myPosBtn">📍 Mein Standort</button><button class="primary" id="saveStBtn">💾 Speichern</button>${cur.station_id?'<button class="ghost" id="upStBtn">↑</button><button class="ghost" id="downStBtn">↓</button><button class="danger" id="delStBtn">Löschen</button>':""}</div></div>`:"";
 app().innerHTML=adminShell("Stationseditor",`<div class="admin-list">${list}<button class="secondary" id="newStBtn">＋ Neue Station</button></div>${form}`);wireAdmin();
 document.querySelectorAll("[data-st]").forEach(e=>e.onclick=()=>renderStations(e.dataset.st));document.getElementById("newStBtn").onclick=()=>renderStations("new");
 if(!cur)return;
 setTimeout(()=>initMap(Number(cur.latitude),Number(cur.longitude)),0);
 document.getElementById("myPosBtn").onclick=()=>navigator.geolocation.getCurrentPosition(p=>{const ll={lat:p.coords.latitude,lng:p.coords.longitude};editorMarker.setLatLng(ll);editorMap.setView(ll,17);document.getElementById("stLat").value=ll.lat.toFixed(6);document.getElementById("stLon").value=ll.lng.toFixed(6)});
 document.getElementById("saveStBtn").onclick=async()=>{const id=document.getElementById("stId").value||uuid();const row={route_id:d.route.id,station_id:id,sort_order:cur.sort_order,name:document.getElementById("stName").value.trim(),latitude:Number(document.getElementById("stLat").value),longitude:Number(document.getElementById("stLon").value),radius_m:Number(document.getElementById("stRadius").value),clue:document.getElementById("stClue").value.trim(),hint:document.getElementById("stHint").value.trim(),updated_at:new Date().toISOString()};const {error}=await db.from("rally_stations").upsert(row,{onConflict:"route_id,station_id"});if(error){alert(error.message);return}renderStations(id)};
 if(cur.station_id){
  document.getElementById("delStBtn").onclick=async()=>{if(!confirm("Station wirklich löschen? Zugeordnete Rätsel werden ebenfalls entfernt."))return;await db.from("rally_stations").delete().eq("route_id",d.route.id).eq("station_id",cur.station_id);await normalizeOrders(d.route.id);renderStations()};
  document.getElementById("upStBtn").onclick=()=>moveStation(d,cur,-1);document.getElementById("downStBtn").onclick=()=>moveStation(d,cur,1);
 }
}
async function normalizeOrders(routeId){const {data}=await db.from("rally_stations").select("station_id,sort_order").eq("route_id",routeId).order("sort_order");for(let i=0;i<(data||[]).length;i++)if(data[i].sort_order!==i)await db.from("rally_stations").update({sort_order:i}).eq("route_id",routeId).eq("station_id",data[i].station_id)}
async function moveStation(d,cur,dir){
 const i=d.stations.findIndex(x=>x.station_id===cur.station_id),j=i+dir;if(j<0||j>=d.stations.length)return;const other=d.stations[j],tmp=10000+i;
 await db.from("rally_stations").update({sort_order:tmp}).eq("route_id",d.route.id).eq("station_id",cur.station_id);
 await db.from("rally_stations").update({sort_order:i}).eq("route_id",d.route.id).eq("station_id",other.station_id);
 await db.from("rally_stations").update({sort_order:j}).eq("route_id",d.route.id).eq("station_id",cur.station_id);renderStations(cur.station_id);
}
async function getSecret(routeId,qid){const {data,error}=await db.rpc("admin_get_answer_config",{p_route_id:routeId,p_question_id:qid});if(error)throw error;return data||{}}
async function renderQuestions(selected=null){
 const d=await loadAdminRoute("draft");if(!d){app().innerHTML=adminShell("Rätseleditor",'<div class="status bad">Kein Entwurf vorhanden.</div>');wireAdmin();return}
 const qs=d.questions,cur=selected==="new"?{question_id:"",from_station_id:null,target_station_id:d.stations[0]?.station_id,question_type:"free_text",fun_fact:"",question:"",options:null,hint_text:""}:(qs.find(x=>x.question_id===(selected||qs[0]?.question_id))||qs[0]);
 let secret={accepted_answers:[],correct_option:null,solution_text:""};if(cur?.question_id)secret=await getSecret(d.route.id,cur.question_id);
 const list=qs.map(q=>`<div class="admin-item ${cur&&q.question_id===cur.question_id?"active":""}" data-q="${q.question_id}"><strong>${q.from_station_id?esc(d.stations.find(s=>s.station_id===q.from_station_id)?.name):"Start"}</strong><br><span class="small">${esc(q.question.slice(0,90))}</span></div>`).join("");
 const opts=Array.isArray(cur?.options)?cur.options:["","",""];
 const fromOpts=['<option value="">Start</option>',...d.stations.slice(0,-1).map(s=>`<option value="${s.station_id}" ${cur?.from_station_id===s.station_id?"selected":""}>Nach ${esc(s.name)}</option>`)].join("");
 const targetOpts=d.stations.map(s=>`<option value="${s.station_id}" ${cur?.target_station_id===s.station_id?"selected":""}>${esc(s.name)}</option>`).join("");
 const form=cur?`<div class="mission"><input id="qId" type="hidden" value="${esc(cur.question_id)}"><label>Nach welcher Station?</label><select id="qFrom">${fromOpts}</select><label>Typ</label><select id="qType"><option value="free_text" ${cur.question_type==="free_text"?"selected":""}>Freitext</option><option value="multiple_choice" ${cur.question_type==="multiple_choice"?"selected":""}>Multiple Choice</option><option value="team_challenge" ${cur.question_type==="team_challenge"?"selected":""}>Teamaufgabe</option></select><label>Fun Fact</label><textarea id="qFact">${esc(cur.fun_fact)}</textarea><label>Frage</label><textarea id="qText">${esc(cur.question)}</textarea><div id="freeFields"><label>Akzeptierte Begriffe, einer pro Zeile</label><textarea id="accepted">${esc((secret.accepted_answers||[]).join("\n"))}</textarea></div><div id="mcFields"><label>Antworten</label><div id="mcList">${opts.map((o,i)=>`<div class="option-row"><input type="radio" name="correct" value="${i}" ${Number(secret.correct_option)===i?"checked":""}><input class="mcOpt" value="${esc(o)}"><button class="danger rmOpt" type="button">×</button></div>`).join("")}</div><button class="ghost" id="addOpt" type="button">＋ Antwort</button></div><label>Hinweis nach zwei Fehlversuchen</label><textarea id="qHint">${esc(cur.hint_text)}</textarea><label>Auflösung</label><textarea id="qSolution">${esc(secret.solution_text)}</textarea><label>Nächstes Ziel</label><select id="qTarget">${targetOpts}</select><div class="row" style="margin-top:12px"><button class="primary" id="saveQBtn">💾 Speichern</button>${cur.question_id?'<button class="danger" id="delQBtn">Löschen</button>':""}</div></div>`:"";
 app().innerHTML=adminShell("Rätseleditor",`<div class="admin-list">${list}<button class="secondary" id="newQBtn">＋ Neues Rätsel</button></div>${form}`);wireAdmin();
 document.querySelectorAll("[data-q]").forEach(e=>e.onclick=()=>renderQuestions(e.dataset.q));document.getElementById("newQBtn").onclick=()=>renderQuestions("new");if(!cur)return;
 const toggle=()=>{const t=document.getElementById("qType").value;document.getElementById("freeFields").classList.toggle("hidden",t!=="free_text");document.getElementById("mcFields").classList.toggle("hidden",t!=="multiple_choice")};document.getElementById("qType").onchange=toggle;toggle();
 const wireRm=()=>document.querySelectorAll(".rmOpt").forEach(b=>b.onclick=()=>{if(document.querySelectorAll(".mcOpt").length<=2)return;b.parentElement.remove();document.querySelectorAll('input[name="correct"]').forEach((r,i)=>r.value=i)});
 document.getElementById("addOpt").onclick=()=>{const i=document.querySelectorAll(".mcOpt").length,dv=document.createElement("div");dv.className="option-row";dv.innerHTML=`<input type="radio" name="correct" value="${i}"><input class="mcOpt"><button class="danger rmOpt" type="button">×</button>`;document.getElementById("mcList").appendChild(dv);wireRm()};wireRm();
 document.getElementById("saveQBtn").onclick=async()=>{const id=document.getElementById("qId").value||uuid(),type=document.getElementById("qType").value,options=type==="multiple_choice"?[...document.querySelectorAll(".mcOpt")].map(x=>x.value.trim()).filter(Boolean):null,checked=document.querySelector('input[name="correct"]:checked'),accepted=document.getElementById("accepted").value.split("\n").map(x=>x.trim()).filter(Boolean);if(type==="multiple_choice"&&(!checked||options.length<2)){alert("Bitte mindestens zwei Antworten und eine richtige markieren.");return}if(type==="free_text"&&!accepted.length){alert("Bitte mindestens einen Lösungsbegriff eintragen.");return}const row={route_id:d.route.id,question_id:id,from_station_id:document.getElementById("qFrom").value||null,target_station_id:document.getElementById("qTarget").value,question_type:type,fun_fact:document.getElementById("qFact").value.trim(),question:document.getElementById("qText").value.trim(),options,hint_text:document.getElementById("qHint").value.trim(),updated_at:new Date().toISOString()};const {error}=await db.from("rally_questions").upsert(row,{onConflict:"route_id,question_id"});if(error){alert(error.message);return}const sr=await db.rpc("admin_save_answer_config",{p_route_id:d.route.id,p_question_id:id,p_accepted_answers:accepted,p_correct_option:type==="multiple_choice"?Number(checked.value):null,p_solution_text:document.getElementById("qSolution").value.trim()});if(sr.error){alert(sr.error.message);return}renderQuestions(id)};
 if(cur.question_id)document.getElementById("delQBtn").onclick=async()=>{if(!confirm("Rätsel wirklich löschen?"))return;await db.from("rally_questions").delete().eq("route_id",d.route.id).eq("question_id",cur.question_id);renderQuestions()};
}

async function draftSecrets(draft){const out={};for(const q of draft.questions)out[q.question_id]=await getSecret(draft.route.id,q.question_id);return out}
function validateDraft(draft,secrets){
 const errors=[],warnings=[],stations=draft?.stations||[],questions=draft?.questions||[];
 if(stations.length<2)errors.push("Mindestens zwei Stationen erforderlich.");
 const orders=stations.map(s=>s.sort_order);if(orders.some((v,i)=>v!==i))errors.push("Stationsreihenfolge enthält Lücken oder Duplikate.");
 const starts=questions.filter(q=>q.from_station_id===null);if(starts.length!==1)errors.push("Es muss genau ein Starträtsel geben.");
 const qByFrom=new Map(questions.filter(q=>q.from_station_id).map(q=>[q.from_station_id,q]));
 stations.slice(0,-1).forEach((s,i)=>{const q=qByFrom.get(s.station_id);if(!q)errors.push("Nach „"+s.name+"“ fehlt ein Rätsel.");else if(q.target_station_id!==stations[i+1].station_id)errors.push("Rätsel nach „"+s.name+"“ führt nicht zur direkt nächsten Station.")});
 questions.forEach(q=>{const sec=secrets[q.question_id]||{};if(!q.question?.trim())errors.push("Ein Rätsel hat keinen Fragetext.");if(!q.target_station_id)errors.push("Ein Rätsel hat kein Ziel.");if(q.question_type==="free_text"&&!(sec.accepted_answers||[]).length)errors.push("Freitext-Rätsel ohne akzeptierte Lösung.");if(q.question_type==="multiple_choice"){if(!Array.isArray(q.options)||q.options.length<2)errors.push("Multiple Choice braucht mindestens zwei Antworten.");if(sec.correct_option==null||sec.correct_option<0||sec.correct_option>=q.options.length)errors.push("Multiple Choice ohne gültige richtige Antwort.")}if(q.question_type==="team_challenge"&&!q.question?.trim())errors.push("Teamaufgabe ohne Text.")});
 stations.forEach(s=>{if(!s.clue?.trim())warnings.push("Station „"+s.name+"“ hat keinen Zielhinweis.");if(s.radius_m<35)warnings.push("GPS-Radius bei „"+s.name+"“ ist mit "+s.radius_m+" m recht knapp.");if(s.radius_m>100)warnings.push("GPS-Radius bei „"+s.name+"“ ist mit "+s.radius_m+" m sehr großzügig.")});
 return {errors:[...new Set(errors)],warnings:[...new Set(warnings)]};
}
let previewIndex=0;
async function renderPreview(){
 const d=await loadAdminRoute("draft");if(!d){app().innerHTML=adminShell("Vorschau",'<div class="status bad">Kein Entwurf vorhanden.</div>');wireAdmin();return}
 const seq=[];const start=d.questions.find(q=>q.from_station_id===null);if(start)seq.push({kind:"question",q:start});for(const s of d.stations){seq.push({kind:"station",s});const q=d.questions.find(x=>x.from_station_id===s.station_id);if(q)seq.push({kind:"question",q})}
 previewIndex=Math.max(0,Math.min(previewIndex,seq.length-1));const item=seq[previewIndex];
 let body='<div class="status info">Entwurfs-Testlauf '+(previewIndex+1)+' / '+seq.length+'</div>';
 if(item?.kind==="station")body+=`<div class="mission"><span class="badge">Ziel ${item.s.sort_order+1}/${d.stations.length}</span><h2>🧭 Spieleransicht</h2><p>${esc(item.s.clue)}</p><div class="small">Orga-Test: GPS wird hier bewusst nicht geprüft.</div></div>`;
 if(item?.kind==="question"){const q=item.q;body+=`<div class="mission"><span class="badge">${esc(q.question_type)}</span><h2>${q.question_type==="team_challenge"?"🤝 Teamaufgabe":q.question_type==="multiple_choice"?"🎯 Multiple Choice":"🧩 Rätsel"}</h2>${q.fun_fact?`<div class="status info">📍 ${esc(q.fun_fact)}</div>`:""}<p>${esc(q.question)}</p>${Array.isArray(q.options)?q.options.map((o,i)=>`<div class="admin-item">${String.fromCharCode(65+i)} · ${esc(o)}</div>`).join(""):""}</div>`}
 body+=`<div class="row"><button class="ghost" id="prevPreview" ${previewIndex===0?"disabled":""}>← Zurück</button><button class="secondary" id="nextPreview" ${previewIndex===seq.length-1?"disabled":""}>Weiter →</button></div>`;
 app().innerHTML=adminShell("Entwurf testen",body);wireAdmin();document.getElementById("prevPreview").onclick=()=>{previewIndex--;renderPreview()};document.getElementById("nextPreview").onclick=()=>{previewIndex++;renderPreview()};
}
async function renderPublish(){
 const [draft,pub]=await Promise.all([loadAdminRoute("draft"),loadAdminRoute("published")]);const secrets=draft?await draftSecrets(draft):{};const check=draft?validateDraft(draft,secrets):{errors:["Kein Entwurf vorhanden."],warnings:[]};
 const checks=[...check.errors.map(x=>"❌ "+x),...check.warnings.map(x=>"⚠️ "+x)];if(!checks.length)checks.push("✅ Route ist vollständig und bereit zum Veröffentlichen.");
 const body=`<p>Änderungen im Editor betreffen nur den <strong>Entwurf</strong>. Die Teams spielen weiter die veröffentlichte Version.</p><div class="mission"><h2>Live</h2><p>${pub?esc(pub.route.name):"Keine veröffentlichte Route"}<br>${pub?pub.stations.length:0} Stationen · ${pub?pub.questions.length:0} Rätsel</p></div><div class="mission"><h2>Entwurf</h2><p>${draft?esc(draft.route.name):"Kein Entwurf"}<br>${draft?draft.stations.length:0} Stationen · ${draft?draft.questions.length:0} Rätsel</p></div><div class="mission"><h2>🔍 Rallye prüfen</h2>${checks.map(x=>`<div>${esc(x)}</div>`).join("")}</div><div class="row"><button class="secondary" id="previewFromPublish">👁 Entwurf testen</button><button class="primary" id="publishBtn" ${check.errors.length?"disabled":""}>🚀 Entwurf veröffentlichen</button></div><div class="status info">Veröffentlichen setzt beide Teams auf den Start der neuen Version zurück.</div>`;
 app().innerHTML=adminShell("Veröffentlichen",body);wireAdmin();document.getElementById("previewFromPublish")?.addEventListener("click",()=>{adminTab="preview";previewIndex=0;renderPreview()});document.getElementById("publishBtn")?.addEventListener("click",()=>publishDraft(draft,pub));
}
async function publishDraft(draft,pub){
 if(!draft||!confirm("Entwurf wirklich veröffentlichen? Beide Teams starten danach neu."))return;
 const secrets={};for(const q of draft.questions)secrets[q.question_id]=await getSecret(draft.route.id,q.question_id);
 if(pub)await db.rpc("admin_set_route_status",{p_route_id:pub.route.id,p_status:"archived"});
 const sw=await db.rpc("admin_set_route_status",{p_route_id:draft.route.id,p_status:"published"});if(sw.error){alert(sw.error.message);return}
 const cr=await db.rpc("admin_create_route",{p_name:draft.route.name+" – Entwurf",p_status:"draft"});if(cr.error){alert(cr.error.message);return}
 const newId=cr.data;
 if(draft.stations.length){const rows=draft.stations.map(({route_id,created_at,updated_at,...s})=>({...s,route_id:newId,updated_at:new Date().toISOString()}));const x=await db.from("rally_stations").insert(rows);if(x.error){alert(x.error.message);return}}
 if(draft.questions.length){const rows=draft.questions.map(({route_id,created_at,updated_at,...q})=>({...q,route_id:newId,updated_at:new Date().toISOString()}));const x=await db.from("rally_questions").insert(rows);if(x.error){alert(x.error.message);return}for(const q of draft.questions){const s=secrets[q.question_id]||{};await db.rpc("admin_save_answer_config",{p_route_id:newId,p_question_id:q.question_id,p_accepted_answers:s.accepted_answers||[],p_correct_option:s.correct_option??null,p_solution_text:s.solution_text||""})}}
 const first=draft.questions.find(q=>q.from_station_id===null);for(const team of ["A","B"]){await db.from("rally_team_station_progress").delete().eq("team",team);await db.from("rally_team_question_progress").delete().eq("team",team);await db.from("rally_team_runs").update({route_id:draft.route.id,phase:"question",current_question_id:first?.question_id||null,current_station_id:null,correct_answers:0,penalty_points:0,hints:0,gps_attempts:0,finished:false,started_at:null,finished_at:null,updated_at:new Date().toISOString()}).eq("team",team)}
 alert("Neue Rallye-Version ist live.");renderPublish();
}
async function renderAdmin(){
 try{if(adminTab==="stations")return renderStations();if(adminTab==="questions")return renderQuestions();if(adminTab==="preview")return renderPreview();if(adminTab==="publish")return renderPublish();return renderTeams()}
 catch(e){console.error(e);app().innerHTML=adminShell("Orga-Dashboard",'<div class="status bad">Der Orga-Bereich konnte nicht geladen werden.</div>');wireAdmin()}
}
function render(){
 if(!profile){app().innerHTML=loginView();document.getElementById("loginBtn").onclick=login;document.getElementById("loginPass").onkeydown=e=>{if(e.key==="Enter")login()};return}
 if(profile.role==="admin"){renderAdmin();return}
 if(!player){app().innerHTML='<section class="card"><div class="status info">Spielstand wird geladen …</div></section>';return}
 if(player.finished||player.phase==="finished")app().innerHTML=finishedView();
 else if(player.phase==="question")app().innerHTML=questionView();
 else app().innerHTML=travelView();
 document.getElementById("logoutBtn")?.addEventListener("click",logout);
 document.getElementById("answerBtn")?.addEventListener("click",()=>answer(document.getElementById("answerText").value.trim(),null));
 document.getElementById("answerText")?.addEventListener("keydown",e=>{if(e.key==="Enter")answer(e.target.value.trim(),null)});
 document.querySelectorAll(".mcBtn").forEach(b=>b.onclick=()=>answer(null,Number(b.dataset.i)));
 document.getElementById("continueRevealBtn")?.addEventListener("click",continueReveal);
 document.getElementById("gpsBtn")?.addEventListener("click",gpsCheck);
 document.getElementById("stationHintBtn")?.addEventListener("click",stationHint);
}
boot();