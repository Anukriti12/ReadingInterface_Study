// server.js — EI Study Backend
// Holds ALL secrets. Run this on your machine or deploy to Railway/Render.
// The extension calls this server; participants never see these credentials.
//
// Setup:
//   npm install express cors node-fetch
//   node server.js
//
// Deploy free to Railway: https://railway.app
//   1. Push this file + package.json to a GitHub repo
//   2. Connect repo to Railway → it deploys automatically
//   3. Set environment variables in Railway dashboard (see below)
//   4. Copy the Railway URL into background.js as SERVER_URL




require('dotenv').config(); // Add this line at the very top
const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch"); // Add this line
const app     = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ─── Secrets (set as environment variables, never hardcode in shared code) ────
// On Railway: Settings → Variables → add each one
// Locally: create a .env file or export them in your terminal before running

const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY  ;
const DRIVE_FOLDER_ID      = process.env.DRIVE_FOLDER_ID     ;
const OAUTH_CLIENT_ID      = process.env.OAUTH_CLIENT_ID    ;
const OAUTH_CLIENT_SECRET  = process.env.OAUTH_CLIENT_SECRET  ;
const RESEARCHER_REFRESH_TOKEN = process.env.RESEARCHER_REFRESH_TOKEN ;
const CLAIMS_TO_HIGHLIGHT  = parseInt(process.env.CLAIMS_TO_HIGHLIGHT || "10");

const SERVER_URL = "readinginterfacestudy-production.up.railway.app";

// Simple request log
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "EI Study Backend" });
});

// ─── GET/POST /upload/ping ────────────────────────────────────────────────────
// Used by popup to verify server + Drive credentials are working

app.post("/upload/ping", async (_req, res) => {
  try {
    await getDriveToken();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /claims ──────────────────────────────────────────────────────────────
// Body: { paperText: string }
// Returns: { claims: string[] }

app.post("/claims", async (req, res) => {
  const { paperText } = req.body;
  if (!paperText) return res.status(400).json({ error: "paperText required" });

  try {
    const claims = await identifyClaims(paperText);
    res.json({ ok: true, claims });
  } catch (err) {
    console.error("[claims]", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /expert ──────────────────────────────────────────────────────────────
// Body: { claim: string, context: string }
// Returns: { answer: string }

app.post("/expert", async (req, res) => {
  const { claim, context } = req.body;
  if (!claim) return res.status(400).json({ error: "claim required" });

  try {
    const answer = await getExpertAnswer(claim, context || "");
    res.json({ ok: true, answer });
  } catch (err) {
    console.error("[expert]", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /upload ──────────────────────────────────────────────────────────────
// Body: { filename: string, content: string (JSON) }
// Returns: { fileId: string }
// Also handles file update if fileId is provided:
// Body: { fileId: string, content: string }

app.post("/upload", async (req, res) => {
  const { filename, content, fileId } = req.body;
  if (!content) return res.status(400).json({ error: "content required" });

  try {
    let result;
    if (fileId) {
      result = await updateDriveFile(fileId, content);
    } else {
      if (!filename) return res.status(400).json({ error: "filename required for new upload" });
      result = await uploadToDrive(filename, content);
    }
    res.json({ ok: true, fileId: result.id });
  } catch (err) {
    console.error("[upload]", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Claude: identify claims ──────────────────────────────────────────────────

async function identifyClaims(paperText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `You are helping a reading comprehension study. From the paper below, identify exactly ${CLAIMS_TO_HIGHLIGHT} important empirical claims or key findings that would benefit from elaborative interrogation.

Paper text:
---
${paperText.slice(0, 8000)}
---

Rules:
- Copy each claim EXACTLY word-for-word from the paper (20–60 words)
- Pick specific, non-obvious findings or theoretical assertions
- Avoid background sentences, definitions, or methodology descriptions

Return ONLY a valid JSON array of strings. No markdown, no explanation.`
      }]
    })
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || "Claude API error " + res.status); }
  const data = await res.json();
  const text = data.content[0].text.trim();
  try { return JSON.parse(text); } catch (_) {
    const m = text.match(/\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Could not parse claims JSON");
  }
}

// ─── Claude: expert answer ────────────────────────────────────────────────────

async function getExpertAnswer(claim, context) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 350,
      messages: [{
        role: "user",
        content: `A researcher reading a scientific paper encountered this claim:
"${claim}"

Context: "${context.slice(0, 400)}"

Write a concise expert explanation (3-4 sentences):
1. Why this is true — the underlying mechanism or evidence
2. How it connects to broader concepts in the field
3. What makes it significant or non-obvious

Audience: advanced graduate student.`
      }]
    })
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || "Claude API error " + res.status); }
  const data = await res.json();
  return data.content[0].text.trim();
}

// ─── Google Drive: get access token ──────────────────────────────────────────

let _cachedToken = null;
let _tokenExpiry = 0;

async function getDriveToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 60000) return _cachedToken;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: RESEARCHER_REFRESH_TOKEN,
      grant_type:    "refresh_token"
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error("Drive token error: " + (e.error_description || e.error || res.status));
  }
  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;
  return _cachedToken;
}

// ─── Google Drive: create file ────────────────────────────────────────────────

async function uploadToDrive(filename, content) {
  const token = await getDriveToken();
  const metadata = JSON.stringify({
    name: filename,
    mimeType: "application/json",
    parents: [DRIVE_FOLDER_ID]
  });
  const boundary = "ei_boundary_" + Date.now();
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadata,
    `--${boundary}`,
    "Content-Type: application/json",
    "",
    content,
    `--${boundary}--`
  ].join("\r\n");

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body
    }
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `Drive API error ${res.status}`);
  }
  return await res.json();
}

// ─── Google Drive: update file in place ──────────────────────────────────────

async function updateDriveFile(fileId, content) {
  const token = await getDriveToken();
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: content
    }
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `Drive update error ${res.status}`);
  }
  return await res.json();
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n[EI Study Backend] Running on http://localhost:${PORT}`);
  console.log(`Drive folder: ${DRIVE_FOLDER_ID || "(not set)"}`);
  console.log(`Claude key:   ${ANTHROPIC_API_KEY ? "✓ set" : "✗ missing"}`);
  console.log(`Drive token:  ${RESEARCHER_REFRESH_TOKEN ? "✓ set" : "✗ missing"}\n`);
});
