const PAGE_HEIGHT_PX = 1267.2;
const AUTOSAVE_INTERVAL_MS = 30000;  // save to chrome.storage every 30 seconds
const STORAGE_KEY_PREFIX = "rs_session_";


function isContextValid() {
  try { return !!chrome.runtime?.id; } catch(_) { return false; }
}


function storageSafeSet(obj) {
  try {
    if (isContextValid()) {
      chrome.storage.local.set(obj);
      return;
    }
  } catch(_) {}
  // Fallback: write each key to localStorage as JSON
  try {
    Object.entries(obj).forEach(([k, v]) => {
      localStorage.setItem("rs_fallback_" + k, JSON.stringify(v));
    });
  } catch(_) {}
}

// Safe chrome.storage.local.get
function storageSafeGet(cb) {
  try {
    if (isContextValid()) {
      chrome.storage.local.get(null, cb);
      return;
    }
  } catch(_) {}
  // Fallback: read from localStorage
  try {
    const result = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("rs_fallback_")) {
        const realKey = k.slice("rs_fallback_".length);
        try { result[realKey] = JSON.parse(localStorage.getItem(k)); } catch(_) {}
      }
    }
    cb(result);
  } catch(_) { cb({}); }
}

// Safe chrome.storage.local.remove
function storageSafeRemove(key) {
  try { if (isContextValid()) { chrome.storage.local.remove(key); return; } } catch(_) {}
  try { localStorage.removeItem("rs_fallback_" + key); } catch(_) {}
}

// Safe chrome.runtime.sendMessage — returns a promise that resolves to null on failure
function sendSafe(message) {
  return new Promise(resolve => {
    try {
      if (!isContextValid()) { resolve(null); return; }
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response);
      });
    } catch(_) { resolve(null); }
  });
}

// ─── STATE ────────────────────────────────────────────────────────────────────
let SESSION = null;
let scrollInterval = null;
let autosaveInterval = null;
let lastScrollY = 0;
let _panelEl = null;
let _activeMark = null;
let _activeClaimIdx = null;
let _panelFirstKeyTime = null;
let _panelRevealTime = null;
let _panelOpenTime = null;
let _panelInteractionLog = [];

// ─── ENTRY ────────────────────────────────────────────────────────────────────

waitForReader().then(() => {
  checkForAbandonedSession().then(recovered => {
    if (!recovered) showSetupModal();
  });
});

function waitForReader() {
  return new Promise(resolve => {
    const check = setInterval(() => {
      if (document.querySelectorAll('[data-test-id="reader-pdf-page"]').length > 0) {
        clearInterval(check); resolve();
      }
    }, 500);
    setTimeout(() => { clearInterval(check); resolve(); }, 12000);
  });
}

// ─── ABANDONED SESSION RECOVERY ───────────────────────────────────────────────
// On load, check if a previous session for this paper was interrupted.
// If found, offer to submit it to Forms or discard it.

async function checkForAbandonedSession() {
  return new Promise(resolve => {
    const paperId = extractPaperId();
    storageSafeGet(allItems => {
      // Find any unfinished sessions for this paper (no endTime set)
      const abandoned = Object.entries(allItems)
        .filter(([k, v]) => k.startsWith(STORAGE_KEY_PREFIX) && !v.endTime)
        .sort(([,a],[,b]) => b.startTime - a.startTime); // newest first

      if (!abandoned.length) { resolve(false); return; }

      const [key, saved] = abandoned[0];
      const age = Math.round((Date.now() - saved.startTime) / 60000);

      const overlay = el("div", "rs-overlay");
      const box = el("div", "rs-modal");
      box.innerHTML = `
        <div class="rs-modal-title">Previous Session Found</div>
        <div class="rs-modal-sub">
          An unfinished session for <strong>${saved.participantName}</strong>
          (${saved.condition}, ${age} min ago) was found in local storage.
          Submit it now or start fresh?
        </div>
        <button class="rs-btn-primary" id="rs-recover" style="margin-bottom:10px">
          Submit previous session
        </button>
        <button class="rs-btn-download" id="rs-download-prev" style="margin-bottom:10px">
          Download as JSON backup
        </button>
        <button class="rs-btn-secondary" id="rs-fresh">Discard and start new session</button>
      `;
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      box.querySelector("#rs-recover").addEventListener("click", () => {
        overlay.remove();
        saved.endTime = Date.now();
        saved.endTimeISO = new Date().toISOString();
        saved.totalDurationSeconds = Math.round((saved.endTime - saved.startTime) / 1000);
        saved.note = "Recovered from storage after interrupted session";
        submitSession(saved, key, () => showSetupModal());
        resolve(false);
      });

      box.querySelector("#rs-download-prev").addEventListener("click", () => {
        downloadJson(saved, saved.sessionId + "_recovered.json");
        // Keep in storage in case they also want to submit
      });

      box.querySelector("#rs-fresh").addEventListener("click", () => {
        overlay.remove();
        storageSafeRemove(key);
        showSetupModal();
        resolve(false);
      });
    });
  });
}

// ─── SETUP MODAL ──────────────────────────────────────────────────────────────

function showSetupModal() {
  const overlay = el("div", "rs-overlay");
  const box = el("div", "rs-modal");
  box.innerHTML = `
    <div class="rs-modal-title">Reading Study</div>
    <div class="rs-modal-sub">Please fill in before you start reading.</div>
    <label class="rs-label">Your name</label>
    <input class="rs-input" id="rs-name" type="text" placeholder="e.g. Alex" autocomplete="off" />
    <label class="rs-label" style="margin-top:14px">Your assigned condition</label>
    <div class="rs-radio-group">
      <label class="rs-radio"><input type="radio" name="condition" value="baseline" /><span>A</span></label>
      <label class="rs-radio"><input type="radio" name="condition" value="frictionless" /><span>B</span></label>
      <label class="rs-radio"><input type="radio" name="condition" value="friction" /><span>C</span></label>
    </div>
    <button class="rs-btn-primary" id="rs-start">Start Reading</button>
    <div class="rs-error" id="rs-error"></div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.getElementById("rs-name").focus();

  document.getElementById("rs-start").addEventListener("click", () => {
    const name = document.getElementById("rs-name").value.trim();
    const condEl = document.querySelector('input[name="condition"]:checked');
    if (!name)   { document.getElementById("rs-error").textContent = "Please enter your name."; return; }
    if (!condEl) { document.getElementById("rs-error").textContent = "Please select a condition."; return; }
    overlay.remove();
    setupSession(name, condEl.value);
  });
}

// ─── SESSION SETUP ────────────────────────────────────────────────────────────

function setupSession(name, condition) {
  const paperId   = extractPaperId();
  const sessionId = name.replace(/\s+/g, "_") + "_" + Date.now();

  SESSION = {
    sessionId, participantName: name, condition, paperId,
    paperUrl: window.location.href,
    startTime: Date.now(), startTimeISO: new Date().toISOString(),
    endTime: null, endTimeISO: null, totalDurationSeconds: null,
    scrollLog: [], backwardScrolls: [],
    totalBackwardScrolls: 0, totalLargeReReads: 0,
    pageVisits: [], currentPage: 1,
    sectionDwellTimes: {},
    frictionlessEvents: [],
    claims: [],
    summary: {}
  };

  startScrollLogging();
  startAccuratePageTracking();
  startSectionTracking();
  startAutosave();
  addEndSessionButton();

  if (condition === "baseline") {
    suppressFrictionlessUI();
    // addBaselineCitationBehavior();
  } else if (condition === "frictionless") {
    startFrictionlessTracking();
  } else if (condition === "friction") {
    suppressFrictionlessUI();
    runFrictionCondition();
  }
}

// ─── AUTOSAVE ─────────────────────────────────────────────────────────────────
// Every 30s: write SESSION to chrome.storage.local (crash safety net) AND
// sync to Drive (so you can monitor live data without waiting for End Session).
//
// Drive sync strategy:
//   - First autosave: create the file (uploadToDrive) → store fileId in SESSION
//   - Subsequent saves: update the same file (updateDriveFile) → no new files
//   - End Session: one final update to mark session complete
//
// This means one file per session on Drive, updated in place every 30s.

function startAutosave() {
  const key = storageKey();

  async function save() {
    if (!SESSION) return;

    // Always write to local storage first (instant, crash-safe)
    storageSafeSet({ [key]: SESSION });

    const jsonStr = JSON.stringify(SESSION, null, 2);
    const filename = (SESSION.sessionId || "session") + ".json";

    if (!SESSION._driveFileId) {
      // First save - create the file on Drive
      chrome.runtime.sendMessage(
        { type: "uploadToDrive", filename, content: jsonStr },
        response => {
          if (response?.ok) {
            SESSION._driveFileId = response.fileId;
            console.log("[Study] Drive file created:", response.fileId);
          } else {
            console.warn("[Study] Initial Drive create failed:", response?.error);
          }
        }
      );
    } else {
      // File already exists — update it in place
      chrome.runtime.sendMessage(
        { type: "updateDriveFile", fileId: SESSION._driveFileId, content: jsonStr },
        response => {
          if (response?.ok) {
            console.log("[Study] Drive file updated:", SESSION._driveFileId);
          } else {
            console.warn("[Study] Drive update failed:", response?.error);
            // If update fails (e.g. file deleted), try creating a new file
            if (response?.error?.includes("404") || response?.error?.includes("not found")) {
              SESSION._driveFileId = null; // will trigger re-create on next tick
            }
          }
        }
      );
    }
  }

  autosaveInterval = setInterval(save, AUTOSAVE_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });
  window.addEventListener("beforeunload", save);

  // First save after a short delay (let session initialize fully)
  setTimeout(save, 3000);
}

function storageKey() {
  return STORAGE_KEY_PREFIX + (SESSION?.sessionId || extractPaperId() + "_" + Date.now());
}

function clearAutosave() {
  clearInterval(autosaveInterval);
  storageSafeRemove(storageKey());
}

// ─── SESSION SUBMISSION ───────────────────────────────────────────────────────
// Fallback: show download button for local JSON backup.

function submitSession(sessionData, storageKeyToRemove, onComplete) {
  const jsonStr = JSON.stringify(sessionData, null, 2);
  const participantId = sessionData.participantName + "_" + sessionData.sessionId;
  const condition = sessionData.condition;

  chrome.runtime.sendMessage(
    { type: "uploadToDrive", filename: (sessionData.sessionId || "session") + ".json", content: jsonStr },
    response => {
      if (response?.ok) {
        if (storageKeyToRemove) chrome.storage.local.remove(storageKeyToRemove);
        showToast("Session saved to Drive (" + response.filename + ")", false, 5000);
        if (onComplete) onComplete();
      } else {
        const errMsg = response?.error || "unknown error";
        console.error("[Study] Drive upload failed:", errMsg);
        showSubmissionFailedUI(sessionData, errMsg);
        if (onComplete) onComplete();
      }
    }
  );
}

function showSubmissionFailedUI(sessionData, errMsg) {
  // Remove any existing failure notice
  document.getElementById("rs-fail-notice")?.remove();

  const notice = document.createElement("div");
  notice.id = "rs-fail-notice";
  notice.innerHTML = `
    <div class="rs-fail-title">⚠ Submission failed</div>
    <div class="rs-fail-msg">${errMsg}</div>
    <div class="rs-fail-hint">Your session is safely stored in the browser. Options:</div>
    <button class="rs-fail-btn" id="rs-fail-download">Download JSON backup</button>
    <button class="rs-fail-btn rs-fail-btn--retry" id="rs-fail-retry">Retry submission</button>
  `;
  document.body.appendChild(notice);

  notice.querySelector("#rs-fail-download").addEventListener("click", () => {
    downloadJson(sessionData, sessionData.sessionId + ".json");
    notice.querySelector("#rs-fail-download").textContent = "Downloaded";
  });

  notice.querySelector("#rs-fail-retry").addEventListener("click", () => {
    notice.remove();
    submitSession(sessionData, storageKey(), null);
  });
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── END SESSION BUTTON ───────────────────────────────────────────────────────

function addEndSessionButton() {
  const btn = document.createElement("button");
  btn.className   = "rs-end-btn";
  btn.textContent = "End Reading Session";

  btn.addEventListener("click", () => {
    btn.disabled    = true;
    btn.textContent = "Submitting…";

    // Snapshot any open EI panel
    if (_activeClaimIdx !== null) snapshotInteraction();
    if (_panelEl) _panelEl.style.display = "none";

    SESSION.endTime = Date.now();
    SESSION.endTimeISO = new Date().toISOString();
    SESSION.totalDurationSeconds = Math.round((SESSION.endTime - SESSION.startTime) / 1000);
    SESSION.summary = computeSummary();
    clearInterval(scrollInterval);

    // Save final state to storage before submitting
    chrome.storage.local.set({ [storageKey()]: SESSION });

    const jsonStr = JSON.stringify(SESSION, null, 2);
    const filename = (SESSION.sessionId || "session") + ".json";

    function onDriveResponse(response) {
      if (response?.ok) {
        btn.textContent      = "Saved to Drive";
        btn.style.background = "#059669";
        clearAutosave();
        showToast("Session saved to Drive", false, 4000);
      } else {
        btn.textContent = "Retry";
        btn.disabled    = false;
        btn.style.background = "#b45309";
        showSubmissionFailedUI(SESSION, response?.error || "unknown");
        showToast("Drive save failed but data preserved in browser. See options below.", true, 8000);
      }
    }

    if (SESSION._driveFileId) {
      // File already exists from autosave — just update it with the final state
      btn.textContent = "Finalizing on Drive…";
      chrome.runtime.sendMessage(
        { type: "updateDriveFile", fileId: SESSION._driveFileId, content: jsonStr },
        onDriveResponse
      );
    } else {
      // No autosave file yet — create it now
      btn.textContent = "Saving to Drive…";
      chrome.runtime.sendMessage(
        { type: "uploadToDrive", filename, content: jsonStr },
        onDriveResponse
      );
    }
  });

  document.body.appendChild(btn);
}

// ─── ACCURATE PAGE TRACKING ───────────────────────────────────────────────────

function startAccuratePageTracking() {
  let currentPage = 1;
  let pageEnterTime = Date.now();

  function recordExit(page) {
    SESSION.pageVisits.push({ page, enterTime: pageEnterTime, exitTime: Date.now(), dwellMs: Date.now() - pageEnterTime });
  }

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const pageNum = parseInt(entry.target.getAttribute("data-page-number") || "1");
      if (pageNum !== currentPage) {
        recordExit(currentPage);
        currentPage = pageNum;
        pageEnterTime = Date.now();
        SESSION.currentPage = pageNum;
      }
    });
  }, { threshold: 0.5 });

  function observePages() {
    document.querySelectorAll('[data-test-id="reader-pdf-page"]').forEach(p => observer.observe(p));
  }
  observePages();
  new MutationObserver(observePages).observe(document.body, { childList: true, subtree: true });
}

// ─── SCROLL LOGGING ───────────────────────────────────────────────────────────

function startScrollLogging() {
  scrollInterval = setInterval(() => {
    const y = Math.round(window.scrollY);
    const pageEst = Math.max(1, Math.ceil((y + window.innerHeight / 2) / PAGE_HEIGHT_PX));
    SESSION.scrollLog.push({ t: Date.now(), y, pageEst });
    const delta = lastScrollY - y;
    if (delta > 50) {
      const isLarge = delta > window.innerHeight * 0.5;
      SESSION.backwardScrolls.push({ t: Date.now(), fromY: Math.round(lastScrollY), toY: y, distancePx: Math.round(delta), isLargeJump: isLarge });
      SESSION.totalBackwardScrolls++;
      if (isLarge) SESSION.totalLargeReReads++;
    }
    lastScrollY = y;
  }, 2000);
}

// ─── SECTION DWELL ────────────────────────────────────────────────────────────

function startSectionTracking() {
  setTimeout(() => {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3")).filter(h => h.textContent.trim().length > 2);
    if (!headings.length) return;
    const entryTimes = {};
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const label = entry.target.textContent.trim().slice(0, 60);
        if (entry.isIntersecting) {
          entryTimes[label] = Date.now();
          if (!SESSION.sectionDwellTimes[label]) SESSION.sectionDwellTimes[label] = { firstEnter: Date.now(), totalDwellMs: 0, visitCount: 0 };
          SESSION.sectionDwellTimes[label].visitCount++;
        } else if (entryTimes[label]) {
          SESSION.sectionDwellTimes[label].totalDwellMs += Date.now() - entryTimes[label];
          delete entryTimes[label];
        }
      });
    }, { threshold: 0.3 });
    headings.forEach(h => observer.observe(h));
  }, 2000);
}

// ─── SUPPRESS FRICTIONLESS UI ─────────────────────────────────────────────────

function suppressFrictionlessUI() {
  const style = document.createElement("style");
  style.id = "rs-suppress";
  style.textContent = `
    .reader__widget-panel,
    [class*="widget-panel"] {
      display: none !important; visibility: hidden !important;
      opacity: 0 !important; pointer-events: none !important;
    }
    [data-heap-id*="skimming_page_flag"],
    [data-heap-id*="reader_page_flag"],
    [class*="skimming_arrow"], [class*="arrow-flag"], [class*="skimming-flag"],
    [class*="skimming-box"], [skimming-box-id], [skimming-snippet-id],
    [class*="citation_bounding"], [class*="citation-bounding"], [class*="CitationBounding"],
    button[aria-label*="Skimming"], button[aria-label*="skimming"],
    button[aria-label*="Citation"], [class*="SkimmingButton"], [class*="skimming-button"] {
      display: none !important;
    }
  `;
  document.head.appendChild(style);

  let suppressTimeout = null;
  const sels = [
    '.reader__widget-panel',
    '[data-heap-id*="skimming_page_flag"]', '[data-heap-id*="reader_page_flag"]',
    '[class*="skimming_arrow"]', '[class*="arrow-flag"]',
    '[class*="skimming-box"]', '[skimming-box-id]', '[skimming-snippet-id]',
    '[class*="citation_bounding"]', '[class*="citation-bounding"]',
  ];

  function suppressAll() {
    sels.forEach(sel => {
      try { document.querySelectorAll(sel).forEach(e => { e.style.setProperty("display","none","important"); e.style.setProperty("visibility","hidden","important"); }); } catch(_) {}
    });
    document.querySelectorAll('button, [role="button"]').forEach(btn => {
      const txt = (btn.textContent || "").trim();
      const lbl = btn.getAttribute("aria-label") || "";
      if (txt.includes("Skimming") || txt.includes("Citation") || lbl.includes("Skimming") || lbl.includes("Citation"))
        btn.style.setProperty("display","none","important");
    });
  }

  const mo = new MutationObserver(() => { clearTimeout(suppressTimeout); suppressTimeout = setTimeout(suppressAll, 50); });
  mo.observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:["class","style","data-heap-id"] });
  suppressAll(); setTimeout(suppressAll,500); setTimeout(suppressAll,1500); setTimeout(suppressAll,3000);
}

// ─── BASELINE CITATION BEHAVIOR ───────────────────────────────────────────────

function addBaselineCitationBehavior() {
  document.addEventListener("click", e => {
    const span = e.target.closest('[data-heap-id*="citation"], [class*="citation_bounding"]');
    if (!span) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const numMatch = span.textContent.trim().match(/\d+/);
    if (!numMatch) return;
    const bibEl = findBibEntry(numMatch[0]);
    if (bibEl) {
      bibEl.scrollIntoView({ behavior: "smooth", block: "center" });
      bibEl.style.background = "#fef9c3";
      setTimeout(() => { bibEl.style.background = ""; }, 2000);
    }
  }, true);
}

function findBibEntry(citNum) {
  const bib = document.querySelector(".bibtex-citation");
  if (bib) return bib;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const txt = node.textContent.trim();
    if (txt.startsWith(`[${citNum}]`) || txt.startsWith(`${citNum}.`)) return node.parentElement;
  }
  return null;
}

// ─── FRICTIONLESS FEATURE TRACKING ───────────────────────────────────────────

function startFrictionlessTracking() {
  function logF(type, detail = {}) {
    SESSION.frictionlessEvents.push({ t: Date.now(), type, page: SESSION.currentPage, ...detail });
  }
  document.addEventListener("click", e => {
    if (e.target.closest('[data-heap-id*="skimming_page_flag"],[data-heap-id*="reader_page_flag"]'))
      logF("skimming_flag_click", { text: e.target.closest('[data-heap-id]')?.textContent?.trim().slice(0,40) });
    if (e.target.closest('[class*="citation_bounding"],[class*="citation-bounding"]'))
      logF("citation_click", { text: e.target.textContent?.trim().slice(0,40) });
    if (e.target.closest('[class*="skimming-box"],[skimming-box-id]'))
      logF("skimming_box_click");
    if (e.target.closest('[aria-label*="Skimming"],[aria-label*="Citation"],.reader__widget-panel button'))
      logF("toolbar_click", { label: e.target.getAttribute("aria-label") || e.target.textContent?.trim().slice(0,30) });
  }, true);

  let lastHover = null;
  document.addEventListener("mouseover", e => {
    const flag = e.target.closest('[data-heap-id*="skimming_page_flag"]');
    if (flag && flag !== lastHover) { lastHover = flag; logF("skimming_flag_hover"); }
    const cite = e.target.closest('[class*="citation_bounding"]');
    if (cite && cite !== lastHover) { lastHover = cite; logF("citation_hover", { text: cite.textContent?.trim().slice(0,40) }); }
  }, true);

  const panelObs = new MutationObserver(() => {
    const panel = document.querySelector('.reader__widget-panel');
    if (panel) logF(panel.classList.contains('reader__widget-panel--closed') ? "sidebar_closed" : "sidebar_opened");
  });
  panelObs.observe(document.body, { subtree:true, attributes:true, attributeFilter:["class"] });
}

// ─── FRICTION: TEXT + CLAIMS ──────────────────────────────────────────────────

function extractText() {
  const skipCls = ["skimming-box","skimming_arrow","arrow-flag","citation_bounding","widget-panel","rs-claim"];
  function skip(el) { const c = typeof el?.className==="string"?el.className:""; return skipCls.some(s=>c.includes(s)); }
  function collect(container) {
    const chunks = []; const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT); let node;
    while ((node=walker.nextNode())) {
      let e=node.parentElement, s=false;
      while(e&&e!==container){if(skip(e)){s=true;break;}e=e.parentElement;}
      if(s)continue; const txt=node.textContent.trim(); if(txt.length>3)chunks.push(txt);
    }
    return chunks;
  }
  const overlays = Array.from(document.querySelectorAll(".pdf-reader__overlay"));
  if (overlays.length) {
    const chunks=[]; overlays.forEach(o=>chunks.push(...collect(o)));
    const seen=new Set(); const clean=chunks.filter(c=>{if(c.length<10||seen.has(c))return false;seen.add(c);return true;});
    const joined=clean.join(" "); if(joined.length>500) return {paperText:joined.slice(0,15000)};
  }
  return {paperText:(document.body.innerText||"").slice(0,12000)};
}

function runFrictionCondition() {
  const {paperText}=extractText();
  if(!paperText||paperText.length<300){showToast("Not enough text found on page.",true);return;}
  showToast("Analyzing paper… ~10 seconds");
  chrome.runtime.sendMessage({type:"identifyClaims",paperText},response=>{
    hideToast();
    if(!response?.ok){showToast("Error: "+(response?.error||"unknown"),true);return;}
    response.claims.forEach((claimText,idx)=>{
      SESSION.claims.push({
        claimIdx:idx, claimText, highlightedAt:Date.now(), highlightSucceeded:false,
        totalPanelOpenCount:0, interactions:[], finalResponse:"",
        finalResponseChars:0, finalResponseWords:0, totalRevealCount:0,
        expertAnswerText:null, status:"unseen"
      });
    });
    let count=0;
    response.claims.forEach((claim,idx)=>{
      if(highlightClaim(claim,idx)){SESSION.claims[idx].highlightSucceeded=true;count++;}
    });
    showToast(`${count} claims highlighted, click any to engage`,false,4000);
  });
}

function highlightClaim(claimText,claimIdx) {
  const words=claimText.trim().split(/\s+/);
  const probes=[words.slice(0,5).join(" "),words.slice(0,4).join(" "),words.slice(0,3).join(" ")];
  for(const probe of probes){
    if(probe.length<6)continue;
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT); let node;
    while((node=walker.nextNode())){
      const tag=node.parentElement?.tagName?.toLowerCase();
      if(tag==="script"||tag==="style"||tag==="mark")continue;
      const i=node.textContent.indexOf(probe); if(i===-1)continue;
      if(insertMark(node,i,probe.length,claimText,claimIdx))return true;
    }
  }
  return false;
}

function insertMark(textNode,startOffset,matchLength,claimText,claimIdx){
  try{
    const parent=textNode.parentNode;
    if(!parent||!document.body.contains(textNode))return false;
    const preview=claimText.trim().split(/\s+/).slice(0,6).join(" ");
    const afterNode=textNode.splitText(startOffset);
    const mark=document.createElement("mark");
    mark.className="rs-claim"; mark.dataset.claim=claimText; mark.dataset.idx=String(claimIdx);
    mark.textContent=preview+" …"; mark.title="Click to engage with this claim";
    mark.addEventListener("click",()=>openEIPanel(mark));
    parent.insertBefore(mark,afterNode); return true;
  }catch(e){return false;}
}

// ─── EI PANEL ─────────────────────────────────────────────────────────────────

function getOrCreatePanel(){
  if(_panelEl)return _panelEl;
  const panel=document.createElement("div"); panel.id="rs-panel"; panel.style.display="none";
  panel.innerHTML=`
    <div class="rs-panel-header">
      <span class="rs-panel-icon">🔍</span>
      <span class="rs-panel-title">Elaborative Interrogation</span>
      <button class="rs-panel-close" title="Close">✕</button>
    </div>
    <div class="rs-panel-claim-label">THE CLAIM</div>
    <div class="rs-panel-claim" id="rs-panel-claim-text"></div>
    <div class="rs-panel-question">Why is this true? How does it connect to what you already know?</div>
    <textarea class="rs-panel-textarea" id="rs-response" placeholder="Write your explanation here before seeing the expert answer…" rows="5"></textarea>
    <div class="rs-panel-row">
      <button class="rs-btn-reveal" id="rs-reveal" disabled>Reveal Expert Answer</button>
      <span class="rs-char-count" id="rs-chars">0 characters</span>
    </div>
    <div id="rs-expert-section" style="display:none">
      <div class="rs-expert-label">EXPERT EXPLANATION</div>
      <div class="rs-expert-text" id="rs-expert-text"></div>
    </div>
    <div class="rs-reopen-notice" id="rs-reopen-notice" style="display:none">↩ Your previous response has been restored.</div>
    <button class="rs-btn-done" id="rs-done">Done.. Continue Reading</button>
  `;
  document.body.appendChild(panel); _panelEl=panel;

  const textarea=panel.querySelector("#rs-response");
  const revealBtn=panel.querySelector("#rs-reveal");
  const charSpan=panel.querySelector("#rs-chars");

  textarea.addEventListener("keydown",()=>{
    if(!_panelFirstKeyTime){_panelFirstKeyTime=Date.now();_panelInteractionLog.push({t:Date.now(),action:"first_keypress"});}
  });
  textarea.addEventListener("input",()=>{
    const len=textarea.value.trim().length; charSpan.textContent=`${len} characters`; revealBtn.disabled=len<20;
    _panelInteractionLog.push({t:Date.now(),action:"typing",charCount:len});
  });

  revealBtn.addEventListener("click",()=>{
    if(_activeClaimIdx===null)return;
    const record=SESSION.claims[_activeClaimIdx];
    _panelRevealTime=Date.now(); _panelInteractionLog.push({t:Date.now(),action:"reveal_clicked"});
    revealBtn.disabled=true; revealBtn.textContent="Loading…";
    panel.querySelector("#rs-expert-section").style.display="block";
    record.totalRevealCount++; record.status="revealed";
    record.finalResponse=textarea.value; record.finalResponseChars=textarea.value.length;
    record.finalResponseWords=textarea.value.trim().split(/\s+/).filter(Boolean).length;
    if(record.expertAnswerText){
      panel.querySelector("#rs-expert-text").textContent=record.expertAnswerText;
      revealBtn.textContent="Expert Answer Revealed"; _panelInteractionLog.push({t:Date.now(),action:"expert_shown_from_cache"});
    } else {
      const context=(_activeMark?.closest("p,div")||_activeMark)?.textContent.slice(0,500)||"";
      chrome.runtime.sendMessage({type:"getExpertAnswer",claim:record.claimText,context},res=>{
        const answer=res?.ok?res.answer:"Error: "+(res?.error||"unknown");
        panel.querySelector("#rs-expert-text").textContent=answer;
        revealBtn.textContent="Expert Answer Revealed";
        if(res?.ok)record.expertAnswerText=answer;
        _panelInteractionLog.push({t:Date.now(),action:"expert_loaded"});
      });
    }
  });

  function closePanel(){
    snapshotInteraction(); panel.style.display="none";
    if(_activeMark){
      _activeMark.classList.remove("rs-claim--active");
      const r=SESSION.claims[_activeClaimIdx];
      if(r.status==="revealed"||textarea.value.trim().length>=20)_activeMark.classList.add("rs-claim--done");
    }
    _activeMark=null; _activeClaimIdx=null; _panelFirstKeyTime=null; _panelRevealTime=null; _panelOpenTime=null; _panelInteractionLog=[];
  }
  panel.querySelector(".rs-panel-close").addEventListener("click",closePanel);
  panel.querySelector("#rs-done").addEventListener("click",closePanel);
  return panel;
}

function snapshotInteraction(){
  if(_activeClaimIdx===null)return;
  const record=SESSION.claims[_activeClaimIdx];
  const textarea=_panelEl.querySelector("#rs-response"); const now=Date.now();
  record.interactions.push({
    openCount:record.totalPanelOpenCount, openTime:_panelOpenTime, closeTime:now,
    dwellMs:now-(_panelOpenTime||now),
    firstKeypressLatencyMs:_panelFirstKeyTime?_panelFirstKeyTime-_panelOpenTime:null,
    writingDurationMs:(_panelFirstKeyTime&&_panelRevealTime)?_panelRevealTime-_panelFirstKeyTime:null,
    responseAtClose:textarea.value, responseChars:textarea.value.length,
    responseWords:textarea.value.trim().split(/\s+/).filter(Boolean).length,
    revealClicked:!!_panelRevealTime, expertAnswerText:record.expertAnswerText,
    expertReadMs:(_panelRevealTime&&now)?now-_panelRevealTime:null,
    skipped:!_panelRevealTime&&textarea.value.trim().length<20,
    actionsLog:[..._panelInteractionLog]
  });
  if(textarea.value.trim().length>0){
    record.finalResponse=textarea.value; record.finalResponseChars=textarea.value.length;
    record.finalResponseWords=textarea.value.trim().split(/\s+/).filter(Boolean).length;
  }
}

function openEIPanel(markEl){
  const claimIdx=parseInt(markEl.dataset.idx); const record=SESSION.claims[claimIdx];
  if(_activeClaimIdx!==null&&_activeClaimIdx!==claimIdx){snapshotInteraction();if(_activeMark)_activeMark.classList.remove("rs-claim--active");}
  const panel=getOrCreatePanel();
  const textarea=panel.querySelector("#rs-response"); const revealBtn=panel.querySelector("#rs-reveal");
  const expertSec=panel.querySelector("#rs-expert-section"); const expertText=panel.querySelector("#rs-expert-text");
  const reopenNote=panel.querySelector("#rs-reopen-notice"); const charSpan=panel.querySelector("#rs-chars");
  panel.querySelector("#rs-panel-claim-text").textContent=record.claimText;
  const isReopen=record.totalPanelOpenCount>0;
  textarea.value=record.finalResponse||""; charSpan.textContent=`${textarea.value.trim().length} characters`;
  revealBtn.disabled=textarea.value.trim().length<20; revealBtn.textContent="Reveal Expert Answer";
  if(record.expertAnswerText){expertSec.style.display="block";expertText.textContent=record.expertAnswerText;revealBtn.textContent="Expert Answer Revealed";revealBtn.disabled=true;}
  else{expertSec.style.display="none";expertText.textContent="";}
  reopenNote.style.display=isReopen?"block":"none";
  record.totalPanelOpenCount++; if(record.status==="unseen")record.status="opened";
  _activeMark=markEl; _activeClaimIdx=claimIdx; _panelFirstKeyTime=null; _panelRevealTime=null; _panelOpenTime=Date.now();
  _panelInteractionLog=[{t:Date.now(),action:"panel_open",openCount:record.totalPanelOpenCount,isReopen}];
  markEl.classList.add("rs-claim--active"); panel.style.display="block"; textarea.focus();
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────

function computeSummary(){
  const c=SESSION.claims;
  const avg=arr=>arr.length?Math.round(arr.reduce((a,b)=>a+b,0)/arr.length):0;
  return {
    totalClaimsIdentified:c.length, totalHighlighted:c.filter(x=>x.highlightSucceeded).length,
    totalOpened:c.filter(x=>x.status!=="unseen").length,
    totalEngaged:c.filter(x=>x.status==="engaged"||x.status==="revealed").length,
    totalRevealed:c.filter(x=>x.status==="revealed").length,
    totalSkipped:c.filter(x=>x.status==="skipped").length,
    totalUnseen:c.filter(x=>x.status==="unseen").length,
    totalReopens:c.reduce((a,x)=>a+Math.max(0,x.totalPanelOpenCount-1),0),
    avgResponseChars:avg(c.filter(x=>x.finalResponseChars>0).map(x=>x.finalResponseChars)),
    totalBackwardScrolls:SESSION.totalBackwardScrolls, totalLargeReReads:SESSION.totalLargeReReads,
    uniqueSectionsVisited:Object.keys(SESSION.sectionDwellTimes).length,
    frictionlessEventCount:SESSION.frictionlessEvents?.length??0,
    durationSeconds:SESSION.totalDurationSeconds, pageCount:SESSION.pageVisits.length,
  };
}

// ─── TOAST ────────────────────────────────────────────────────────────────────

let toastTimeout=null;
function showToast(msg,isError=false,autoDismiss=0){
  hideToast(); const t=document.createElement("div"); t.id="rs-toast"; t.textContent=msg;
  if(isError)t.classList.add("rs-toast--error"); document.body.appendChild(t);
  if(autoDismiss)toastTimeout=setTimeout(hideToast,autoDismiss);
}
function hideToast(){clearTimeout(toastTimeout);document.getElementById("rs-toast")?.remove();}

// ─── UTILS ────────────────────────────────────────────────────────────────────

function el(tag,cls){const e=document.createElement(tag);if(cls)e.className=cls;return e;}
function extractPaperId(){const m=window.location.pathname.match(/reader\/([^/?#]+)/i);return m?m[1]:"unknown";}