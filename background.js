// background.js — EI Study Extension
// NO secrets here. All API calls go to the researcher's server.
// Participants can read this file and learn nothing sensitive.

// ─── Only thing to set: your server URL ───────────────────────────────────────
// While running locally during piloting:  "http://localhost:3001"
// After deploying to Railway/Render:      "https://your-app.railway.app"
// const SERVER_URL = "http://localhost:3001";
const SERVER_URL = "https://readinginterfacestudy-production.up.railway.app";

const CLAIMS_TO_HIGHLIGHT = 10;

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "getConfig") {
    sendResponse({ claimCount: CLAIMS_TO_HIGHLIGHT });
    return false;
  }

  if (message.type === "identifyClaims") {
    serverPost("/claims", { paperText: message.paperText })
      .then(data => sendResponse({ ok: true, claims: data.claims }))
      .catch(err  => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "getExpertAnswer") {
    serverPost("/expert", { claim: message.claim, context: message.context })
      .then(data => sendResponse({ ok: true, answer: data.answer }))
      .catch(err  => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "uploadToDrive") {
    serverPost("/upload", { filename: message.filename, content: message.content })
      .then(data => sendResponse({ ok: true, fileId: data.fileId, filename: message.filename }))
      .catch(err  => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "updateDriveFile") {
    serverPost("/upload", { fileId: message.fileId, content: message.content })
      .then(data => sendResponse({ ok: true, fileId: data.fileId }))
      .catch(err  => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "checkDriveReady") {
    serverPost("/upload/ping", {})
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // List locally saved sessions (for popup)
  if (message.type === "listLocalSessions") {
    chrome.storage.local.get(null, items => {
      const sessions = Object.entries(items)
        .filter(([k]) => k.startsWith("rs_active_session_"))
        .map(([k, v]) => ({
          storageKey: k,
          sessionId: v.sessionId,
          participantName: v.participantName,
          condition: v.condition,
          paperId: v.paperId,
          startTimeISO: v.startTimeISO,
          endTime: v.endTime,
          totalDurationSeconds: v.totalDurationSeconds,
          claimCount: v.claims?.length ?? 0,
        }));
      sendResponse({ ok: true, sessions });
    });
    return true;
  }

  // Upload a specific locally-saved session (from popup recovery)
  if (message.type === "uploadLocalSession") {
    chrome.storage.local.get([message.storageKey], items => {
      const session = items[message.storageKey];
      if (!session) { sendResponse({ ok: false, error: "Session not found in storage" }); return; }
      const filename = (session.sessionId || message.storageKey) + ".json";
      const content  = JSON.stringify(session, null, 2);
      // Use existing fileId if we have one, otherwise create new
      const body = session._driveFileId
        ? { fileId: session._driveFileId, content }
        : { filename, content };
      serverPost("/upload", body)
        .then(data => {
          chrome.storage.local.remove(message.storageKey);
          sendResponse({ ok: true, fileId: data.fileId, filename });
        })
        .catch(err => sendResponse({ ok: false, error: err.message }));
    });
    return true;
  }
});

// ─── Server helper ────────────────────────────────────────────────────────────

async function serverPost(path, body) {
  const res = await fetch(SERVER_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Server error ${res.status}`);
  }
  return data;
}
