// popup.js — researcher-only session monitor
// Participants never open this popup; it's just the extension icon click for the researcher.

const driveDot    = document.getElementById("drive-dot");
const driveStatus = document.getElementById("drive-status");
const sessionsList = document.getElementById("sessions-list");
const sessionsEmpty = document.getElementById("sessions-empty");
const btnAll = document.getElementById("btn-all");
const footerNote = document.getElementById("footer-note");

let localSessions = [];

// ─── Init ─────────────────────────────────────────────────────────────────────

checkDrive();
loadSessions();

// ─── Drive connection check ───────────────────────────────────────────────────

function checkDrive() {
  // Try a dummy upload-readiness check: just get a token
  chrome.runtime.sendMessage({ type: "checkDriveReady" }, response => {
    if (response?.ok) {
      driveDot.className = "dot dot-ok";
      driveStatus.textContent = "Drive connected";
    } else {
      driveDot.className = "dot dot-error";
      driveStatus.textContent = "Drive error: " + (response?.error || "token not configured");
    }
  });
}

// ─── Sessions list ────────────────────────────────────────────────────────────

function loadSessions() {
  chrome.runtime.sendMessage({ type: "listLocalSessions" }, response => {
    if (!response?.ok) { sessionsEmpty.textContent = "Could not load sessions."; return; }
    localSessions = response.sessions || [];
    renderSessions();
  });
}

function renderSessions() {
  sessionsList.querySelectorAll(".session-item").forEach(e => e.remove());
  sessionsEmpty.style.display = "none";

  if (localSessions.length === 0) {
    sessionsEmpty.style.display = "block";
    sessionsEmpty.textContent = "No sessions waiting for upload";
    btnAll.disabled = true;
    footerNote.textContent = "Auto-saves to Drive every 30s";
    return;
  }

  footerNote.textContent = `${localSessions.length} session${localSessions.length > 1 ? "s" : ""} in local storage`;
  btnAll.disabled = false;

  localSessions.forEach(s => {
    const condClass = { baseline: "badge-baseline", frictionless: "badge-frictionless", friction: "badge-friction" }[s.condition] || "badge-baseline";
    const date = s.startTimeISO ? new Date(s.startTimeISO).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "?";
    const dur  = s.totalDurationSeconds ? Math.round(s.totalDurationSeconds / 60) + " min" : "in progress";

    const item = document.createElement("div");
    item.className = "session-item";
    item.dataset.key = s.storageKey;
    item.innerHTML = `
      <div class="session-info">
        <div class="session-name">${s.participantName || "Unknown"}</div>
        <div class="session-meta">
          <span class="badge ${condClass}">${s.condition}</span>
          ${date} · ${dur}
        </div>
        <div id="st-${s.storageKey}"></div>
      </div>
      <button class="btn btn-upload" id="btn-${s.storageKey}">Upload</button>
    `;
    sessionsList.appendChild(item);
    document.getElementById(`btn-${s.storageKey}`)
      .addEventListener("click", () => uploadOne(s.storageKey));
  });
}

function uploadOne(key) {
  const btn = document.getElementById(`btn-${key}`);
  const st  = document.getElementById(`st-${key}`);
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  chrome.runtime.sendMessage({ type: "uploadLocalSession", storageKey: key }, res => {
    if (res?.ok) {
      btn.textContent = "✓";
      btn.style.background = "#064e3b";
      st.className = "status-ok";
      st.textContent = res.filename;
      localSessions = localSessions.filter(s => s.storageKey !== key);
      if (localSessions.length === 0) {
        footerNote.textContent = "All uploaded";
        btnAll.disabled = true;
      }
    } else {
      btn.disabled = false;
      btn.textContent = "Retry";
      st.className = "status-err";
      st.textContent = res?.error || "failed";
    }
  });
}

btnAll.addEventListener("click", () => {
  btnAll.disabled = true;
  btnAll.innerHTML = '<span class="spinner"></span>Uploading…';
  const keys = [...localSessions.map(s => s.storageKey)];
  let i = 0;
  function next() {
    if (i >= keys.length) { btnAll.textContent = "Done"; return; }
    uploadOne(keys[i++]);
    setTimeout(next, 700);
  }
  next();
});