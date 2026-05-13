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
    // Silently discard any leftover local sessions and always start fresh.
    // Drive autosave (every 30s) already has the data — no recovery modal needed.
    storageSafeGet(allItems => {
      Object.keys(allItems)
        .filter(k => k.startsWith(STORAGE_KEY_PREFIX))
        .forEach(k => storageSafeRemove(k));
      resolve(false);
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

// ─── CURATED CLAIMS MAP ───────────────────────────────────────────────────────
// Keys are Semantic Scholar paper IDs (from the URL /reader/<id>).
// Values are arrays of claim strings exactly as they appear (or nearly) in the paper.
// For these papers, claims are used directly instead of asking Claude.

const CURATED_CLAIMS = {
  "f8f7a8ff789061126c827398e48c41d612e2cbc6": [
    "The highly individuating nature of photos broke the social category-based identification between observers and the support seeker in the interaction and thereby obstructed the observers' vicarious interaction with the support provider.",
    "These results suggest that another boundary condition to social identification-based vicarious interaction might be the presence of both ingroup and outgroup members in the observed interaction.",
    "It is possible that the limited persuasive effect of the support provider's message in the observed interaction on male participants was caused by a lack of initial favorable attitude toward seeking professional counseling in the first place.",
    "Even without direct contact, visual anonymity was still shown to facilitate social identification based on context-dependent group category, and, in turn, vicarious interaction with the observed interactants.",
    "When a female observer saw a female support seeker receiving support from a male, it led to greater identification between the observer and the seeker when the support seeker was also a female rather than a male.",
  ],
  "212b791e79f9d12b2319ac771612ad2254115dd3": [
    "Baseline depression and anxiety severity were not associated with smartphone use nor was treatment response",
    "Most patients reported checking their phone at least once per hour but posting rarely, potentially suggesting that our sample may primarily use social media passively and perhaps experience it as a platform for social comparison rather than for social connection or support.",
    "Although technology-driven interventions have the potential to reduce barriers to mental health treatment, they might also unintentionally further existing disparities in access.",
    "It may be that individuals in our sample are more prone to ruminative response styles and more likely to engage in social comparisons through social media, thereby perceiving a negative impact of social media on their mental health.",
    "Individuals with bipolar disorder made more frequent status posts relative to individuals with other primary diagnoses",
  ],
  "41c5be0c4574cea3a158a8ca333251b293921b2d": [
    "The sixth affect-related statement was, 'Photoshop helps me deal with the anxiety from the judgment of others,' had a significant strong, negative correlation, r = .858, p < .05",
    "Furthermore, age and gender were ignored when analyzing the data set and future studies can place emphasis on these factors.",
    "Each affect-related statement related to negative ideals about the self-perception of each subject that participated.",
    "A larger sample size could yield greater results, offer more detail on how subjects perceive themselves and the extent they will go to achieve fabricated perfectionism on social media platforms.",
    "It is crucial to note that the statistical significance of these findings is agreeing to negative statements on a 5-point Likert scale, with 5 being strongly agree, thus a negative correlation and/or inverse relationship among the variables.",
  ],
  "2b30b8bc91e4a2bf6df53f6f2707fd36aa7a67e7": [
    "From the viewpoint of stock market individual investors, by far the most significant criteria of companies' reputation assessment are Credibility of financial information (4.59) and Transparency of financial information (4.33) in the informational aspects area.",
    "The lowest rated in importance was Company's involvement in socially responsible activities (CSR).",
    "Firstly, it may result from a rather superficial and stereotypical understanding of the company's social commitment and CSR activities, which in Poland is usually associated mainly with charity and even sponsorship, and this is considered a manifestation of a specific financial mismanagement of the enterprise.",
    "The vast majority of the surveyed investors (75%) indicated a period of at least five years, which seems most understandable due to the fact that reputation is a long-term category, i.e., it takes many years to build it.",
    "Taking into account the structure of the research sample (Table 2), it can be said that these results mainly reflect the opinion of male investors (75.8%), aged up to 45 (81.8%) and with investment experience of up to 5 years (59.2%).",
  ],
  "89039e7d8b8af5fddddbcb7b893f6e2b7200a908": [
    "We find that informative introductions that were not perceived as interesting actually have a negative effect on Taste-Broadening Serendipity compared to no introduction",
    "However, in contrast to what we expected, the introductions actually work to a significant degree through both mechanisms. Furthermore, transportation and cognitive elaboration are strongly correlated (r = 0.51).",
    "SEM analysis shows that the direct effect of transportation on Taste-Broadening Serendipity makes perceived coping potential redundant.",
    "Immersive introductions proved to be a riskier method to increase Taste-Broadening Serendipity because their effect is less consistent.",
    "Our study reflects an inherent trade-off between experimental control and ecological validity. The requirement to listen to introductions and complete survey questions inevitably made the listening experience less naturalistic.",
  ],
  "97bcd84a7d104d79af94e7d7905c0e5f4f5b9205": [
    "This clearly indicates that more care should be taken while developing a website for a wide diversity of visitors when utilising colour in the web page content.",
    "Thus deviations in the neutrality of websites can clearly be seen, based on the geographical region where the website is compiled.",
    "The sample evidence indicates that the English version of webpages has no difference in readability over the Non-English version.",
    "The authors of this paper are of the opinion that the usage of this theory can be further extended for usability testing and enhancement of other IS products as well.",
    "The participants were specifically chosen to be users of English as a second language: they reported that the English sites were superior overall in terms of various parameters such as design and interactivity.",
  ],
  "16e4891ca090b073b0e9ea5628b4feb06af53db4": [
    "From Phase I to Phase II, the average accuracy across all participants increased from 63.30% to 67.98%",
    "of the 41% of \"fake\" responses, 16% believed that there were two manipulation modes",
    "there is no significant correlation between human audiovisual deepfake detection and their IT skill level",
    "forewarning of these artifacts and the potential adverse effects of audiovisual deepfake technology did not have any significant impact on participants' performance",
    "AI models excel humans at integrating information from multiple modalities",
  ],
  "e29f2a753c217938c5af04b092f8f06d73f38dbc": [
    "staying in touch with friends, sharing restaurants and spots as recommendations to friends, and sharing accomplishments were highly correlated and form one major component",
    "We noticed some of the risks also coincided and could be both personal and security simultaneously",
    "During the analysis of our pilot study, we removed items with low correlation(<0.5) and did a reliability analysis to remove items that contribute negatively to Cronbach's alpha value",
    "The lower three were also correlated, assuming they have something to do in common and we will name them societal benefits.",
    "Most of our participants reported that their engagement does not increase based on how their content is engaged or not",
  ],
  "51a4702a602dc6e48b9b946cffeb338f2d2a1ab0": [
    "compared to at-risk students who exclusively received evidence-based academic stress management content, at-risk students who interacted with therapy dogs, exclusively or in combination with content exposure, had significantly higher scores of WILL after the intervention, which remained 6 weeks later",
    "it is possible that exposure to ASM content exclusively, i.e., without engagement in HAI, may have had the effect of increasing participant focus on academic challenges which would likely include a corresponding increase in fear, anxiety, and stress.",
    "the presence of animals created a more positive and calming environment that allowed for optimal onboarding of ASM content and discussion about stressful topics such as academic stress, academic goal setting, and motivation, and discussion about test taking and study strategies.",
    "HAI may indirectly influence learning by increasing self-regulation and stress coping, or through the promotion of social behaviors, increased calmness, and reduced fear and anxiety",
    "at-risk students who interacted with therapy dogs in combination with content exposure had significantly higher scores of SELFREGULATION after the intervention that remained 6 weeks later",
  ],
  "b53bdf4562c06d78f260036c3f62dc34eaa0a6b8": [
    "students mostly turned to GenAI to seek programming help and to understand code, rather than writing new code itself",
    "among first-generation students (Figure 1b), trust correlates stronger to improving motivation (0.57) and confidence (0.4), compared to continuing-generation students, which are (0.37) and (0.35), respectively",
    "The users also generally believed that \"professionals use AI\" compared to their non-user counterparts",
    "Students' trust in GenAI is generally moderate and not blind.",
    "Students' trust in GenAI is positively associated with increased motivation and confidence, especially for first-generation students.",
  ],
  "da546ea3e7545efbeeb2b3931c20b7ee5ee745a5": [
    "The mean is sensitive to extreme values, and it provides a balanced representation of the data when the distribution is approximately symmetric.",
    "The independent variable is the use of ChatGPT, while the dependent variable is student engagement and learning outcomes.",
    "Students in the ChatGPT (experimental) group achieved higher average learning outcomes than those in the control group.",
    "It is less influenced by extreme values and is often used when dealing with skewed or non-normally distributed data",
    "By utilizing the capabilities of Chat GPT, students can have an interactive and personalized learning experience that encourages active participation and student learning outcomes in the technology learning process",
  ],
  "c7f9523717b643d4cb3541041671ebe607f58c93": [
    "individuals reporting high levels of the motives Social Compensation (OR=9.20 [CI 95%; 5.49\u201315.42]), Self-status (OR=9.24 [CI 95%; 5.79\u201314.74]), or Escape (OR=6.38 [CI 95%; 4.28\u20139.50]) were much more likely to meet the criteria for SMD compared to those with low or medium levels",
    "Individuals with bipolar disorder made more frequent status posts relative to individuals with other primary diagnoses",
    "The most common motives for social media use were entertainment, social maintenance, and information/skills.",
    "Social compensation, self-status, and escape are the strongest predictors of social media disorder (SMD).",
    "Motives for using social media are important targets for prevention and intervention of problematic use.",
  ],
  "fb8d46815cdb8316cca3cd8ac9e34eee3220ebb1": [
    "Most participants (52%) reported that they had purchased loot boxes using real money and had indifferent (32%) or bad (23%) experiences with loot boxes.",
    "Players experiences and perceptions of loot boxes were suggested to be more negative highlighted from the subthemes such as Costly, Negative talk, Perception of odds stacked against them, Negative talk towards in-game advantage, and Lack of real-life value",
    "loot boxes seem to relate to the following behaviours mentioned previously: spending for excitement, negative feelings, participants, reporting others may find it difficult to stop, and could be chasing items",
    "loot boxes are the secondary focus, in that players will want to play the game rather than specifically play for the loot boxes.",
    "Participants also highlighted the role of social influence but suggested they were not as susceptible to this like others, but it is acknowledged this is most likely a bias",
  ],
  "b88209f74aac05592eb39f2830d97f4e9f384221": [
    "After passing the peak-age of sensitivity to music, women remained more sensitive than men at the same age to the most recent music trends.",
    "The gender gap in users' musical preferences decreased with an increasing provincial economic development.",
    "a few popular songs typically attract the attention of most users, while a relatively small number of active users are actually the carriers of the majority of musical preferences",
    "the decay of music preferences that we observed in the NCM dataset is much slower than in any other case previously observed in online social media",
    "higher homogenization of musical tastes among college students and young professionals could therefore be attributed to the more homogeneous social structures in these environments",
  ],
  "16e4891ca090b073b0e9ea5628b4feb06af53db4": [
    "We divided the task into two phases. This division allows participants to experience a sense of accomplishment after completing the first phase",
    "Participants continued to correctly identify fabricated videos as deepfake; however, they might experience confusion and struggle to detect genuine videos as real.",
    "Human performance at detecting audiovisual deepfakes is marginally better than random chance.",
    "Once participants classified a video, they were provided with the correct label; in this way, participants could track their performance.",
    "Another factor may be that participants interpret their familiarity with certain faces or voices as evidence of authenticity.",
  ],
  "332081c3f7b206a81e7e7c399b28c56cc2f14797": [
    "two posts could be fully visible in the browser window—in such cases, we assumed participants were viewing both because it was impossible to determine exactly which post they were looking at.",
    "more sensational posts were associated with more \"trying,\" but more credible posts were associated with less \"trying.\"",
    "There was also an interaction effect, such participants dwelled even longer on sensational posts they engaged with",
    "As shown in Table 3, longer dwell times were associated with an increased probability of engagement",
    "algorithmic systems that explicitly optimize for dwell time may prioritize sensational content over credible content and therefore inadvertently proliferate misinformation",
  ],
  "34dfc953b378b2e2d80dd9ac082a9d3418711310": [
    "moderate and high MASB levels were associated with a lower sdHR for dementia development in the high-PA group.",
    "MASB can improve cognitive reserves because of the high cognitive demands it imposes.",
    "PA and MASB may differentially affect cognitive function: while PA preserves neuronal structural integrity and brain volume, MASB improves neural circuit functioning and plasticity.",
    "physically active individuals tend to have rich social networks, providing various opportunities to meet and communicate with people.",
    "Learning new things demands greater cognitive activity, which increases cognitive reserves even in later life.",
  ],
  "5d7a8ed31d438ff8824114be4292400839432e94": [
    "Feedback given by customers for sharing experience regarding certain brand, product, or service will increase preference of other customers for the product, resulting in decision to purchase which will further increase sales.",
    "Social media for marketing had the greatest indirect effect on business performance through entrepreneurial marketing",
    "The ability to interprete consumers' needs and wants from the data obtained on social media is an essential business skill to master",
    "Social media will also create various innovations in business organization since it is supported by good communication with customers, input from customers, and feedback",
    "Online sales system with minimum physical interaction has greatly help business to maintain the sales rate of product amidst the limited activity to do during pandemic and consumer awareness to maintain immunity",
  ],
  "63ab475438aeecc3f67af078500ef373129eb987": [
    "In line with expectations, no statistically significant main or interaction effects could be observed for the measures voice realism and body movement realism as we were only changing the facial animations and appearance but not the body movement or the voice",
    "there was a noticeably different Social Presence rating for the appearance condition Photorealistic (estimated x\u0305 = 4.879, SE = 0.703) as compared to the Semi-realistic condition (estimated x\u0305 = 2.876, SE = 0.703), indicating that social presence was indeed higher for the photorealistic appearance condition",
    "Subsequent post hoc pairwise comparisons highlighted that the Emotion Scenarios Angry and Sad scored significantly lower than the Emotion Scenarios Neutral and Happy",
    "Complete removal of upper face motion did indeed led to significantly lower intensity ratings. However, the lack of eyebrow motion only didn't lead to significantly different perceptions of emotion intensity",
    "Both of these studies suggests that the uncanny valley with today's photo-realistic virtual humans has been crossed, as more photorealistic renders were perceived as more appealing in user studies",
  ],
  "292839cb8e5c601be8cd467184939de7873fdd44": [
    "Urban development patterns often feature lower rents in areas near large roads and buildings [57], both of which can amplify urban heat effects",
    "This aggregation method simplifies the UHI dataset, however this alteration of the raw data is deemed worthwhile in order to assess relationships with demographic data",
    "These three urban heat models were created using random forest machine learning on temperature data collected using vehicle-based traverse measurements. Multiple land uses are included in the model (e.g., tree cover, building volume), and the temperatures derived are representative of the underlying urban form",
    "Black/African American populations tend to have better accessibility to public heat refuges, which may prove helpful if they are concentrated in high-heat census block groups",
    "The network distance analysis of public refuge access shows that 3.4\u201332.7% of the city's population can access a refuge on foot, depending upon walking speed",
  ],
  "027906dd8367ca911a034c996b305ea75c0b71e5": [
    "Urban development patterns often feature lower rents in areas near large roads and buildings [57], both of which can amplify urban heat effects",
    "This aggregation method simplifies the UHI dataset, however this alteration of the raw data is deemed worthwhile in order to assess relationships with demographic data",
    "These three urban heat models were created using random forest machine learning on temperature data collected using vehicle-based traverse measurements. Multiple land uses are included in the model (e.g., tree cover, building volume), and the temperatures derived are representative of the underlying urban form",
    "Black/African American populations tend to have better accessibility to public heat refuges, which may prove helpful if they are concentrated in high-heat census block groups",
    "The network distance analysis of public refuge access shows that 3.4\u201332.7% of the city's population can access a refuge on foot, depending upon walking speed",
  ],
  "ffbec12381e774c592f87f5c00c28b6f832526af": [
    "The sample size of the present study was 13, and semi-structured interviews were utilised as the method of data collection.",
    "Semi-structured, face-to-face interviews were used as the method of data collection in the present study.",
    "The interview guide included seven questions that were explored during the interview.",
    "The data obtained was analysed using thematic analysis and six main themes were identified.",
    "The findings of this study demonstrated that personality in relation to extroversion, trust, intimacy, reciprocity, anonymity and gender are psychosocial factors that impacts upon online self-disclosure.",
  ],
  "c794c543316f20e8c28ca33be1cb0043dc5297dd": [
    "The interview protocol covered the following topics: stress, the effect of COVID-19 on mental health, general life, coping mechanisms, barriers and enablers to mental health treatment and preferences for a tool to help cope with mental health",
    "A convenient sample of one hundred and fifty-three students were recruited for participation in the study; none of the participants refused to participate or dropped out of the study.",
    "The interviews were all conducted virtually via telephone, Zoom, or Google Meet during the Spring 2020 semester.",
    "The transcribed interviews were analyzed using thematic analysis in three phases: initial coding, focused coding and thematic coding.",
    "The participants mentioned several features including coping techniques, artificial intelligence, time management, tracking, and communication with others.",
  ],
  "61242fe828c96787b1ab7528fd48227dd744c7fa": [
    "We conducted semi-structured interviews with 29 BeReal users aged 13 to 18.",
    "We used a combination of convenience and snowball sampling to recruit participants.",
    "The interviews lasted between 30 and 45 minutes.",
    "We conducted a reflexive thematic analysis of the 29 interview transcripts.",
    "BeReal's features and affordances are effective in encouraging users to share casual, uncurated snapshots of their daily lives.",
  ],
  "d0cb0dd6ddcb7691951e0ee5a0eba7fc988b8c3a": [
    "The paper followed member checking to determine the accuracy of the qualitative findings through forwarding the final report or specific descriptions back to interviewees via Gmail and determining whether they feel that they are accurate.",
    "Investment experiences and level of academic qualifications have no concern in the diversification of the investors' portfolio.",
    "Based on the interviewee's responses also the fundamentals of the listed companies were a major factor while selecting a company for investment.",
    "The paper revealed that lack of proper information followed by panic sell or buy after rumours made investors go for a wrong decision.",
    "The paper found that political instability is the major challenge and the overloaded information, which is difficult to filter, made decision-making harder for Nepalese investors, which was contradictory to Risal and Khatiwada (2019).",
  ],
  "7069971543af9af2b56e2f92af550af829507244": [
    "The order of set presentation was randomized with a random number generator for each group of participants to avoid presentation bias.",
    "Nygard [38] mentioned that the use of reminders can aid in data collection for those with declining memories; thus, visibility of all devices was important during discussions.",
    "Deductive analysis was selected as the research explored perceptions in relation to specific questions.",
    "Use of familiar embodiment thus seems important for older adults to enhance positive response and recognizability, and to reduce infantilization and chances of rejection.",
    "Evidence suggests the most important design requirements to be familiar animal embodiment and a soft furry shell, congruent with previous work [27,32].",
  ],
  "c1d3d306808557d34c0e667c53c8ef3a22a3dfc5": [
    "To minimize potential order effects and ensure a robust assessment of each theme, the order of prompts was randomized for each participant in the study.",
    "A pilot test involving two students was initially conducted to refine the study design and procedures.",
    "They generated images based on pre-defined prompts that were developed after extensive discussions with experts in computer science, psychology, and education.",
    "Students noted that AI images are unsuitable for technical purposes, such as producing accurate technical diagrams, indicating a significant limitation in detail and specificity.",
    "They used the Technology Acceptance Model (TAM), adapted from Aburbeian et al. (2022), which evaluates self-efficacy, social norms, and perceived usefulness, among others",
  ],
  "d4e6d26c411abfa1d29d2b6bea6b86678f7892df": [
    "Their AI usage is propelled by an education system that evaluates and rewards output instead of the learning process.",
    "Students' engagement with AI relies significantly on their immediate community norms and the feeling of FOMO rather than school policies or teachers' rules.",
    "Such implicit culture created an atmosphere where nearly universal AI usage remained covert due to AI shame and potential reputational risk. Students worried that open AI use could signal laziness or dishonesty.",
    "Current policies fail to align student practices with institution's policy goals",
    "Individual willpower alone is not sufficient to counteract the temptation of using AI under pressures.",
  ],
  "fa94bd18519fd666a233ecbb0c3fe4e24880c506": [
    "Symptomatic expressions of suicide ideation and loneliness showed the most pronounced and concerning effects.",
    "This perspective highlights how the nature of psychosocial impacts depends on the stage of the relationship, rather than being static outcomes of use",
    "AICCs occupy a paradoxical space in users' social ecosystems—offering both new pathways to social engagement and risks of withdrawal from human relationships",
    "Similarly, symptomatic expressions of loneliness showed substantial negative effects, with treatment group participants demonstrating marked increases compared to Control-LLM: ATE=91.02%, Control-VA (ATE = 105.92%) and ControlNAI (ATE = 63.26%), with DiD confirming significant post-treatment rises across groups.",
    "These examples show that while AICCs may offer immediate comfort, their inability to foster reciprocal, sustained human connection can inadvertently reinforce cycles of isolation and withdrawal.",
  ],
  "79091a20d6d1aa79979fc3284046bd73008ad51d": [
    "The first author then reviewed these codes and newly found themes to refine the codebook further.",
    "Our survey results also confirmed the presence of dysfunctional fear in teens; the survey revealed that among our survey respondents with a private account, 15.3% experience dysfunctional fear.",
    "These concerns were particularly challenging to address, as participants felt the need to anticipate judgment by a collapsed time of the future with potentially vastly different cultural or social norms.",
    "The core rationale behind our designs was to empower users with enhanced privacy control, offering them more choices and greater autonomy than existing features on mainstream platforms or those explored in prior research.",
    "The features that were perceived as most effective shared common characteristics: They minimized impact on other users, had low trade-offs with existing functionality, required minimal user effort, and functioned independently of community behavior.",
  ],
  "721c9408924851a756574e8dfd69f62755eea22a": [
    "We conducted a lab experiment with 84 participants (21 per condition).",
    "Participants were invited to a lab and instructed to watch Shorts as they would in their everyday lives.",
    "Qualitative data were gathered through semi-structured interviews with 20 randomly selected participants (5 per condition).",
    "Behavioral and survey data were analyzed using one-way ANCOVA with baseline daily YouTube viewing time as a covariate.",
    "Participants noted in the follow-up interview that they preferred the subtler reflection on a black screen over the explicit image from a live camera.",
  ],
  "d9af7c41119ac4626fe36b341c78d27bc51f8cfd": [
    "The informants of this research were selected by purposive sampling.",
    "Through the internet, they find various information needed from Google and Youtube, as well as group accounts they follow, such as Facebook and WhatsApp.",
    "Openness to cyberspace was not in line with their willingness to innovate by switching to crystal coconut sugar.",
    "Therefore, through this interactive process, farmers tend to realize their functions to improve their capability by obtaining new information, expanding their economic opportunity, affiliation, besides play and emotion.",
    "However, the information received from the new media does not directly improve the capabilities of the farmers, rather the social interaction carried out with related parties mutually motivate and foster empathy among them with a complete and clearer ideology.",
  ],
  "c0c06e65d454d2befb41923836a0fcdbece3c3f0": [
    "The sample determination in this study used the Lemeshow formula, with the population of actors related to the adoption of Green Building in East Java, covering developers, contractors, architects, and government agencies.",
    "Respondents were asked to provide ratings using a Likert scale (1-5), which facilitated quantitative analysis of their perceptions on various important issues.",
    "Government Policy is closely related to Attitude (0.763) and Intention (0.754), indicating that government policy plays an important role in shaping the intention to adopt technology.",
    "Attitude is proven to have a positive effect on Intention with a significance value (p-value 0.000), and Intention also has a negative effect on Adoption (p-value 0.000).",
    "The R Square value of Perceived Ease of Use and Perceived Usefulness of 0.648 and 0.635 respectively indicates that perceived ease of use and usefulness also affect the adoption of green buildings.",
  ],

  "2d4f170709ef443b2f64f7503791297ca607d2a4": [
    "Reflexive thematic analysis was carried out, following Braun and Clarke's six steps, and was wholly inductive, with themes dictated by the data.",
    "It has been argued that increasingly digitalised forms of \"repeat play\" gambling [49] may be characterised by different symptoms than those of traditional gambling [16].",
    "Those who described feeling urges, temptation, or lack of control over their loot box purchasing were not consistently characterised by high scores on gaming (IGD) symptom scales—scores varied, with most in the 200s on the IGD (below the 'disordered gaming' threshold), and only one scoring above threshold for problem gambling.",
    "None of these things in isolation would likely spur a player to purchase a box if they had no existing interest, and they were not the sole motivator for anyone, but they were potent in increasing the purchasing likelihood for players who had an underlying interest or motivation.",
    "the enjoyment of opening the box is difficult to separate from the contents and their value.",
  ],
  "67927951d1498756fba6a2d551d6b4e760ed23d7": [
    "We choose to collect qualitative data through focus group interviews because the interviewees shared the experience of having previously participated in the aforementioned study.",
    "We started the analysis of the transcripts by doing open coding, annotating the several themes and categories touched by the interviewees.",
    "People who don't know much about a particular genre, probably would agree on some things that are a bit more generic.",
    "This supports the idea that to be exposed to a diverse list of music can be a method to stimulate a self-reflection about prior beliefs, in line with the findings presented by Clarke et al.",
    "The diversity of recommendations can make people aware of the nuances of music previously unknown or unfamiliar, or with a negative attachment, facilitating the discovery and leading to serendipity.",
  ],
  "af0207d024bfd6e2135630db662cc75ed2ed6af5": [
    "Advisors were not study participants and did not provide experiential data for thematic analysis. Instead, they were methodological partners who helped surface ethical concerns, identify practical challenges, and guide the refinement of interview tools and framing.",
    "Meetings were held once a month for over a year, enabling sustained, longitudinal engagement that differentiates this work from short-term participatory or consultative studies and supports the anticipatory validity of advisor input.",
    "All advisor meetings were transcribed in full, and these transcripts served as the primary source of advisor input.",
    "Advisor transcripts were analyzed inductively to identify methodological contributions, including warnings, context-setting, and practical insights that shaped interview preparation and interpretation.",
    "We argue that lived experience functions as methodological infrastructure, extending participatory principles beyond technology design into the core conditions under which qualitative inquiry is conducted.",
  ],
  "3ac1717d1449bcb53e52b7114bdcc3a1bf5d6903": [
    "We conducted 15 semi-structured interviews with women aged 18–45 from diverse educational and professional backgrounds.",
    "Participants were recruited using purposive and snowball sampling to ensure diversity in age, education, occupation, and familiarity with digital technologies.",
    "The interview guide was iteratively refined during early data collection to better capture emerging issues such as fear of retaliation, family reactions, and the perceived irreversibility of deepfake harm.",
    "We analyzed the data using reflexive thematic analysis, which enabled us to identify recurring patterns while remaining attentive to sociocultural context.",
    "Our findings show that deepfake harm for Bangladeshi women is not primarily a problem of technical deception, but one of sociocultural interpretation and power.",
  ],

  "7d632a8f1b33c90a9ef3173cefe6e0a526ff6b35": [
    "We assign the initial weights to the detected keywords from the posts based on trials and errors on multiple example mental health self-disclosing posts selected from Reddit r/depression.",
    "The flexible keyword editor allow users to modify, delete, and add keywords and adjust their weights for image generation, which means that it allows users to input any keywords, e.g., about age, gender, occupation, major, etc. to guide the model to generate related images.",
    "These results suggest the user needs for MentalImager to interactively generate topical- and emotional-relevant images based on the user's drafted post or specified keywords.",
    "These results suggest that MentalImager can improve users' satisfaction with their mental health self-disclosing posts and help the posts invoke support-providers' empathy and willingness to reply.",
    "As such, we recommend that tools like MentalImager should provide healthcare content in the process of facilitating mental health self-disclosure.",
  ],
  "5a13127f6ac6c486b7888f6ad22bf58656d63ee6": [
    "We followed this order so that participants had a progressive familiarity and learning of additional features, from no interaction, to added interaction, and finally added guidance features.",
    "We also ensured that GPT would output dialogue from individual characters so they spoke one-at-a-time in order to not overwhelm the user.",
    "Participants consistently expressed a need for customizable avatars and environments to better reflect real-life scenarios.",
    "While participants found our prototypes to generally be immersive, they wanted the simulation to produce higher stress levels to more closely emulate real life.",
    "Interestingly, participants also expressed a general distrust in the accuracy and universality of AI-driven mental health guidance.",
  ],
  "836b54cb537a86e0b90d3ee9840abadb37bf84bb": [
    "By juxtaposing SoD and EoD estimations with their actual usage, WellScreen aimed to make discrepancies visible while encouraging participants to critically evaluate their digital habits.",
    "Participants significantly over-estimated Entertainment app use by 11.32%, while under-estimating Productivity use by 16.77% and Social app use by 9.49%.",
    "These results indicate that individuals with higher self-control tended to have smaller E–A gaps, suggesting that self-regulatory capacity may be linked to more accurate awareness of digital use.",
    "This observation highlights a key paradox that while accurate self-estimation may enhance satisfaction and control, it may simultaneously amplify the burden or stress associated with adhering to one's goals.",
    "Structured daily reflections may have also functioned as a form of meaning-making, allowing participants to create narratives around their technology use in ways that fostered emotional coherence and self-understanding.",
  ],
  "c88836ab80f20c4a03e59bb9d7bfa5e67fe06935": [
    "This use case is grounded in the reality that many individuals may be new to investing and therefore there is value in an environment which is responsive and able to support their learning.",
    "Our design began with low fidelity prototypes which were iterated over through brainstorming sessions with persons with varying stock market and investing experience.",
    "DialogFlow acted as a pivotal component in meeting our requirements, particularly through its use of machine learning to recognise variations of expressions using training data.",
    "one finding that was particularly interesting was that all participants used typing as their predominant mode of interaction as opposed to voice input.",
    "This can be interpreted more generally to highlight the importance of agents to be transparent and provide reasons behind certain guidance or suggestions; these actions can help to build user trust.",
  ],
  "4a71f6c539e1d3b4c865e47f5ceea7f5f97ce9e9": [
    "We leveraged a VR prototyping approach to allow new modalities and the existing tail to be rapidly prototyped, controlled and compared without obstructive modification of the robot.",
    "Expression were displayed for seven seconds (informed by pilot testing), during which time participants were free to touch the robot as they wished before the rating scales appeared.",
    "Shapiro-Wilk tests confirmed that accuracy, effectiveness and empathy data (p < 0.001) were not normally distributed, so we used the Aligned Ranked Transform (ART)",
    "The most accurate modes, text and speech, were only considered 'Somewhat Effective', potentially due to their less emotive nature.",
    "VR offers practical benefits compared to physical or even AR prototyping, allowing total control of the robot's current or prospective capabilities without obstructive physical modification.",
  ],
  "20b3a804f2c6d168f6bc6922de54d22548229df5": [
    "We chose to teach students about generative AI misinformation because there is a lack of K12 curriculum which covers this topic.",
    "We designed this activity around the idea that the student would not mark all of the misleading summaries as \"False,\" or even all of the accurate summaries as \"True.\"",
    "There were thoughts to place these correction summaries at the very end of the activity, but we determined that wiping away any trace of belief in the misinformation as quickly as possible was more important than not informing the user of their performance until the end.",
    "The backend first passes the historical figure to a smaller ChatGPT model and asks for the 3 most meaningful and important facts about the person, which are used in the instructions given to a larger and more advanced model with instructions not to change those widely known details.",
    "The negative effects and significance of misinformation can be difficult to explain properly to K-12 students, but utilizing known, potentially beloved, figures and presenting information that unfairly diminishes or changes their accomplishments can be an effective method to promote third-party verification of generative conversational AI answers.",
  ],
  "7a37d2e1ada7b6324dfcfd3043b1ee16b521c75e": [
    "While most students (6 out of 8) found these tools helpful (Q8), frequently switching between multiple resources often led to distractions (Q9).",
    "Together, these assets form a library of reusable building blocks that can be integrated later.",
    "These findings suggest that participants experienced less strain and were able to study more smoothly with our system.",
    "Overall, there was no evidence of system- or subject-level differences in learning gain.",
    "Future work should explore validation mechanisms, transparency features such as citations or confidence indicators, and workflows that enable instructors to curate or approve generated content.",
  ],
  "25f3bbae89b81d4db23e4afd9f829773c03b2669": [
    "The first two authors conducted workshops from March to July 2024 until theoretical saturation was reached [15].",
    "Themes emerged from analyzing the researchers' notes and the artifacts collected from the two tasks.",
    "Participants believed the same algorithmic mechanism both imposed emotional burdens and provided support.",
    "This framework was developed during a secondary analysis phase to reinterpret emergent themes in participants' experiences arising from interactions with social media algorithmic curation.",
    "Addressing entanglement requires a fundamental reconceptualization of how algorithmic curation supports users rather than \"one-size-fits-all\" interface changes or algorithmic updates.",
  ],

  "a8701e65c32a6f85a058f83fac01e0d4bd28a572": [
    "On the basis of interviews, we improved and extended the content of the app by (1) adding a limited chat function with predesigned stickers to motivate team members, (2) allowing users to choose from 3 challenges a day for 6 weeks, and (3) adding a tour in which game mechanics are explained.",
    "Our ESM approach's novelty is that it is gamified to increase motivation, which intends to result in a higher rate of compliance (percentage completed self-evaluations) as well as improved data quality",
    "As a game mechanic, selecting a random gift creates surprise and moments of anticipation essential to maintaining a state of play",
    "The difficulty level is scaffolded by incrementally increasing difficulty, which supports retention by continuously challenging the participants as they progress through the game.",
    "The ambition is to further improve the app after each research study by including new features and resolving usability issues.",
  ],
  "777090cbcde4296fd261f01b2d7157fa59b28e43": [
    "The frontend allows users to capture real-time images using a canvas element, modify prompts, and interact with the music player.",
    "The backend processes image data through the ChatGPT API to generate descriptive keywords, refining them into music prompts, and sends these prompts to the Suno API for music generation.",
    "The result suggests that participants in the two AI conditions display notably larger mean value decreases in stress compared to those in the NoAI conditions, suggesting that personalized music tended to relieve stress more effectively than pre-recorded tracks in both environments.",
    "These results suggest that tailoring music to both environmental factors and self-reported stress may amplify the relaxation effect.",
    "Nonetheless, the lack of a statistically significant difference for environment alone implies that CAT's adaptive features may offset some stressors in busier contexts.",
  ],
  "d0a0d247aa99c8dfe7390609e43a80830f3858d5": [
    "The first and most important role of lo-fi prototypes is to check and test functionality rather than the visual appearance of the product.",
    "More elaborately, we adopted an interactive strategy, in which we created a design sketch led by the HCI researcher on the team, obtained feedback on it from the clinician collaborators, and then adjusted it accordingly to create a modified or new sketch.",
    "The second analysis yielded the 3 categories that summarized clinicians' mental models of how they navigate patients' information to make a clinical decision.",
    "Clinical researchers suggested just letting them know whether the severity of symptoms has changed since the last visit using plain text, rather than visuals such as bar graphs.",
    "We believe this is one of the positive results of the iterative co-design of prototypes; conceptualizing what we need from new technology is difficult even using needs-affordances analysis because domain experts have to ideate several different possible needs while dealing with an unfamiliar and complicated concept for a new, futuristic technology.",
  ],
  "f4da059975933b25ad8fdd862af5e1f4818b4d0c": [
    "According to this model—which we return to in the Discussion—'self-control' is the capacity of conscious System 2 control to override System 1 responses when the two are in conflict.",
    "extension did not record what participants typed when prompted for their goal, as we wanted to study effects of goal reminders without participants adapting or self-censoring from knowing responses might be read by the researchers.",
    "The reported p-values are not corrected for multiple comparisons — these should be considered exploratory results to be followed-up with confirmatory studies.",
    "scores on this measure trended towards decrease during the intervention in all conditions (Ccontrol: t(18) = 2.37, p = 0.03, d = 0.54, Cno-feed: t(13) = 1.99, p = 0.07, d = 0.53, Cgoal: t(14) = 1.75, p = 0.1, d = 0.45), perhaps suggesting that the study procedure across conditions made participants reflect on use.",
    "We therefore expect removing the newsfeed to be more generally effective than goal reminders, because it reduces the amount of potentially distracting information and thus the need for in-the-moment conscious control.",
  ],
  "334d9d71db604904578615e7bb06f8d88ea0e5fe": [
    "These findings indicate that involving the target users from the early stages of development can be crucial for the success and acceptance of social robots.",
    "In order to rapidly get feedback from participants, a Wizard of Oz prototype has been developed where participants can interact with the embodied agent.",
    "Using all of these modalities simultaneously allows the wizard to convey a highly engaging and believable embodiment of a clinician who can understand the user's actions and responses, and respond appropriately, just as a real clinician would.",
    "Spoken interaction offers clues to cognitive functioning that are not usually measured or rated in clinical assessment.",
    "deep probabilistic approaches, such as [8], provide both more interpretability and lowers the needed amount of training data – important aspects for a diagnostics method.",
  ],
  "275372575e4d9ec217b8c23999b0e9bf0ab2ca29": [
    "even with the toggle off, others' annotations remain visible. This design choice stimulate critical engagement and prompt users to assess video authenticity, thereby encouraging contribution.",
    "Unlike Non-Maximum Suppression (NMS), our approach retains collective intelligence by weighting contributions rather than solely selecting the highest confidence region, thus mitigating risks from potential errors in top-confidence annotations.",
    "We employed a one-way Analysis of Variance (ANOVA) for metrics that conformed to a normal distribution, such as accuracy and confidence scores, followed by Tukey's HSD for post-hoc comparisons. For the ordinal data from subjective ratings on 7-point Likert scales, which did not meet normality assumptions, we used the non-parametric Kruskal-Wallis test, with Dunn's test and a Bonferroni correction for post-hoc analyses.",
    "We found that Collab has the lowest mean confidence at 86.9% (SD=13.7%), while No-label has the highest mean confidence at 93.44% (SD=18.04%)... Contrary to intuition, we found users in No Agg usually would feel confident about their labeling even when their labels may not be correct.",
    "We interpret mixed user feedback regarding social annotations as indicative of productive cognitive friction rather than a design flaw.",
  ],
  "6a5eee564c03335393dfc0f2727af0c9343eed5d": [
    "While GenAI can output visuals, we chose to focus participant feedback on the textual Ad brief and not use GenAI to generate the accompanying visual advertisement given the limitations of multimodal prompting at the time.",
    "This suggests that for novice designers, a structured interface that scaffolds inputs to generate the final AI prompt could support the creative design process while preserving—and potentially enhancing—perceived user agency.",
    "We believe this approach embodies co-creation in its true sense: users contribute their contextual understanding of brand identity, while the AI provides technical design descriptions of visual elements to user.",
    "Without clarification on how the AI system is leveraging data input into the model by all users, some participants, like P16, expressed concerns about whether outputs from ACAI would result in similar outputs for everyone and make it harder to stand out.",
    "Future research could include concrete performance metrics, such as click-through rates, views, and conversions, to measure the practical impact of AI-generated advertisements.",
  ],
  "5d798e1005ba62e5b3ecfb6a70622f614e2bc4c7": [
    "To mitigate potential bias towards design aspects, we allowed participants to share any deviations in the life cycle of their data physicalization from our proposed interview framework.",
    "Our proposed physicalization life cycle offers a framework for considering sustainability in Data Physicalization.",
    "In summary, our findings indicate that there is not a universally accepted definition of a sustainable physicalization, nor is there an objective set of guidelines to guarantee sustainability.",
    "The need to create physical representations that match the data and are visually captivating often conflicts with the need to reduce environmental impact.",
    "This work is preliminary and meant to be sensitizing not prescriptive to the point that it can help quantify the environmental impact of physicalizations.",
  ],

};

// ─── CURATED CLAIM HIGHLIGHTING ───────────────────────────────────────────────
// Semantic Scholar renders PDF text as many tiny <span> elements, each holding
// a word or syllable fragment. No single text node ever contains 5 consecutive
// words, so probing individual nodes fails. Instead we:
//   1. Collect ALL text nodes from the PDF overlay into a flat array with their
//      cumulative character offsets ("virtual string").
//   2. Search the virtual string for the 5-word probe (normalised).
//   3. Extend forward to the next sentence-ending period.
//   4. Wrap every DOM node that falls inside that range with a <mark>.

function normStr(s) {
  return s.toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function highlightCuratedClaim(claimText, claimIdx) {
  // Build a virtual string across ALL body text nodes, tracking offsets.
  // Then find the 5-word probe, identify which text nodes it spans,
  // and surgically wrap just those characters in <mark> elements.

  const skipTags = new Set(['script','style','noscript','mark']);
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (skipTags.has(n.parentElement?.tagName?.toLowerCase())) continue;
    if (n.parentElement?.closest('#rs-panel,.rs-overlay,.rs-end-btn,#rs-toast,.rs-claim-proxy')) continue;
    if (n.textContent.trim().length < 1) continue;
    nodes.push(n);
  }

  if (!nodes.length) { console.log('[Study] no text nodes found'); return false; }

  // Build virtual string (raw, not normalized — we'll normalize separately)
  const offsets = [];
  let cursor = 0;
  for (const node of nodes) {
    offsets.push(cursor);
    cursor += node.textContent.length + 1; // +1 for join space
  }
  const virtual = nodes.map(n => n.textContent).join(' ');
  const virtualNorm = normStr(virtual);

  const claimNorm = normStr(claimText);
  const words = claimNorm.split(' ').filter(Boolean);
  const probes = [
    words.slice(0, 5).join(' '),
    words.slice(0, 4).join(' '),
    words.slice(0, 3).join(' '),
  ].filter(p => p.length >= 6);

  for (const probe of probes) {
    // Find probe in normalized virtual string
    const normStart = virtualNorm.indexOf(probe);
    console.log('[Study] probe:', JSON.stringify(probe.slice(0,40)), '→', normStart);
    if (normStart === -1) continue;

    // Extend end forward to next sentence-ending punctuation (. ! ?)
    let normEnd = normStart + probe.length;
    const ahead = virtualNorm.slice(normEnd, normEnd + 600);
    const sentenceEnd = ahead.search(/[.!?]/);
    if (sentenceEnd !== -1) normEnd = normEnd + sentenceEnd + 1; // include the punctuation

    const rawStart = normStart;
    const rawEnd = normEnd;

    // Find which nodes overlap [rawStart, rawEnd)
    const matched = [];
    for (let i = 0; i < nodes.length; i++) {
      const nodeStart = offsets[i];
      const nodeEnd = nodeStart + nodes[i].textContent.length;
      if (nodeEnd > rawStart && nodeStart < rawEnd) {
        matched.push({ node: nodes[i], nodeStart, nodeEnd });
      }
    }
    if (!matched.length) continue;
    console.log('[Study] matched', matched.length, 'nodes');

    // Create proxy for click handler
    let proxy = document.querySelector(`.rs-claim-proxy[data-idx="${claimIdx}"]`);
    if (!proxy) {
      proxy = document.createElement('span');
      proxy.className = 'rs-claim-proxy';
      proxy.dataset.claim = claimText;
      proxy.dataset.idx = String(claimIdx);
      proxy.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
      document.body.appendChild(proxy);
    }
    const proxyEl = proxy;

    // Wrap matched text portions with <mark>
    // Process in reverse order so earlier splits don't invalidate later offsets
    let successCount = 0;
    for (let m = matched.length - 1; m >= 0; m--) {
      const { node, nodeStart, nodeEnd } = matched[m];
      if (!document.body.contains(node)) continue;

      // Calculate which characters within this node to highlight
      const sliceStart = Math.max(0, rawStart - nodeStart);
      const sliceEnd   = Math.min(node.textContent.length, rawEnd - nodeStart);
      if (sliceStart >= sliceEnd) continue;

      try {
        // Split into: before | highlighted | after
        // splitText(sliceEnd) gives us the "after" node, leaving "before+highlighted" in node
        const afterNode = sliceEnd < node.textContent.length ? node.splitText(sliceEnd) : null;
        // Now split off the "before" part
        const markNode = sliceStart > 0 ? node.splitText(sliceStart) : node;

        const mark = document.createElement('mark');
        mark.className = 'rs-claim';
        mark.dataset.claim = claimText;
        mark.dataset.idx = String(claimIdx);
        mark.title = 'Click to engage with this claim';
        mark.addEventListener('click', () => openEIPanel(proxyEl));

        markNode.parentNode.insertBefore(mark, markNode);
        mark.appendChild(markNode);
        successCount++;
      } catch(e) {
        console.warn('[Study] wrap error:', e);
      }
    }

    console.log('[Study] wrapped', successCount, 'text segments for claim', claimIdx);
    return successCount > 0;
  }

  console.log('[Study] no probe matched for:', claimText.slice(0,40));
  return false;
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
  const paperId = extractPaperId();
  const curatedClaims = CURATED_CLAIMS[paperId];

  if (curatedClaims) {
    // Use researcher-chosen claims — no Claude call needed
    curatedClaims.forEach((claimText, idx) => {
      SESSION.claims.push({
        claimIdx: idx, claimText, highlightedAt: Date.now(), highlightSucceeded: false,
        totalPanelOpenCount: 0, interactions: [], finalResponse: "",
        finalResponseChars: 0, finalResponseWords: 0, totalRevealCount: 0,
        expertAnswerText: null, status: "unseen", source: "curated"
      });
    });

    // Attempt highlighting — retry up to 3 times with increasing delays
    // to ensure the PDF overlay text nodes are fully rendered.
    function attemptHighlight(attempt) {
      let count = 0;
      curatedClaims.forEach((claim, idx) => {
        if (SESSION.claims[idx].highlightSucceeded) { count++; return; }
        if (highlightCuratedClaim(claim, idx)) {
          SESSION.claims[idx].highlightSucceeded = true;
          count++;
        }
      });
      console.log(`[Study] Curated highlight attempt ${attempt}: ${count}/${curatedClaims.length} succeeded`);
      if (count < curatedClaims.length && attempt < 4) {
        const delays = [0, 3000, 5000, 10000];
        setTimeout(() => attemptHighlight(attempt + 1), delays[attempt] || 5000);
      } else {
        showToast(`${count} claims highlighted, click any to engage`, false, 4000);
      }
    }

    showToast("Loading claims…", false, 3000);
    // PDF text nodes render lazily — retry at 2s, 5s, 10s, 20s
    setTimeout(() => attemptHighlight(1), 2000);
    return;
  }

  // Fallback: ask Claude to identify claims for unrecognised papers
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
        expertAnswerText:null, status:"unseen", source:"claude"
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
    if(_activeClaimIdx!==null){
      const r=SESSION.claims[_activeClaimIdx];
      const isDone=r.status==="revealed"||textarea.value.trim().length>=20;
      document.querySelectorAll(`.rs-claim[data-idx="${_activeClaimIdx}"]`).forEach(m=>{
        m.classList.remove("rs-claim--active");
        if(isDone) m.classList.add("rs-claim--done");
      });
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
  if(_activeClaimIdx!==null&&_activeClaimIdx!==claimIdx){snapshotInteraction();}
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
  // Mark active claim highlights
  document.querySelectorAll('.rs-claim').forEach(m=>{
    m.classList.remove("rs-claim--active");
  });
  document.querySelectorAll(`.rs-claim[data-idx="${claimIdx}"]`).forEach(m=>{
    m.classList.add("rs-claim--active");
  });
  panel.style.display="block"; textarea.focus();
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