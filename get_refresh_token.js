/**
 * get_refresh_token.js
 * Run once on YOUR machine to get the refresh token to bake into background.js.
 * Participants never run this — only you do, before distributing the extension.
 *
 * Prerequisites:
 *   node get_refresh_token.js
 *   (requires Node.js — install from nodejs.org if needed)
 *
 * Setup (one-time, ~5 minutes):
 *   1. Go to console.cloud.google.com → your project
 *   2. APIs & Services → Credentials → your OAuth 2.0 Client ID
 *      (the one you created for the Chrome extension)
 *   3. Under "Authorized redirect URIs", add:
 *        http://localhost:4242
 *   4. Download the credentials JSON or just copy the Client ID and Client Secret
 *   5. Paste them into the two constants below
 *   6. Run: node get_refresh_token.js
 *   7. A browser tab opens — sign in with YOUR Google account
 *   8. Copy the printed refresh token into background.js
 */

const CLIENT_ID     = "YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com";
const CLIENT_SECRET = "YOUR_CLIENT_SECRET";
const REDIRECT_URI  = "http://localhost:4242";
const SCOPE         = "https://www.googleapis.com/auth/drive.file";

// ─────────────────────────────────────────────────────────────────────────────

const http  = require("http");
const https = require("https");
const url   = require("url");

if (CLIENT_ID.includes("YOUR_OAUTH")) {
  console.error("\n❌  Paste your CLIENT_ID and CLIENT_SECRET into get_refresh_token.js first.\n");
  process.exit(1);
}

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth` +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&access_type=offline` +
  `&prompt=consent`;   // force consent screen so we always get a refresh token

console.log("\n─────────────────────────────────────────────────────────");
console.log("  EI Study — Get Refresh Token");
console.log("─────────────────────────────────────────────────────────");
console.log("\n1. Opening browser for Google sign-in…");
console.log("   Sign in with YOUR researcher Google account.");
console.log("\n   If the browser doesn't open, visit this URL manually:");
console.log("   " + authUrl + "\n");

// Try to open the browser automatically
try {
  const { execSync } = require("child_process");
  const cmd = process.platform === "darwin" ? "open"
            : process.platform === "win32"  ? "start"
            : "xdg-open";
  execSync(`${cmd} "${authUrl}"`);
} catch (_) {}

// Start a local server to receive the OAuth redirect
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const code   = parsed.query.code;
  const error  = parsed.query.error;

  if (error) {
    res.writeHead(400);
    res.end(`<h2>Error: ${error}</h2>`);
    console.error("\n❌  OAuth error:", error);
    server.close();
    return;
  }

  if (!code) {
    res.writeHead(400);
    res.end("<h2>No code received.</h2>");
    return;
  }

  // Exchange code for tokens
  const tokenBody = new URLSearchParams({
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    grant_type:    "authorization_code"
  }).toString();

  const tokenRes = await new Promise((resolve, reject) => {
    const req2 = https.request({
      hostname: "oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(tokenBody)
      }
    }, r => {
      let data = "";
      r.on("data", chunk => data += chunk);
      r.on("end", () => resolve(JSON.parse(data)));
    });
    req2.on("error", reject);
    req2.write(tokenBody);
    req2.end();
  });

  if (tokenRes.error) {
    res.writeHead(400);
    res.end(`<h2>Token error: ${tokenRes.error_description}</h2>`);
    console.error("\n❌  Token error:", tokenRes.error_description);
    server.close();
    return;
  }

  const refreshToken = tokenRes.refresh_token;

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`
    <h2 style="font-family:sans-serif;color:#059669">✓ Got your refresh token!</h2>
    <p style="font-family:sans-serif">Copy it from your terminal and close this tab.</p>
  `);

  console.log("\n─────────────────────────────────────────────────────────");
  console.log("  ✓ SUCCESS — copy the refresh token below into background.js");
  console.log("─────────────────────────────────────────────────────────\n");
  console.log("  CLIENT_ID:     " + CLIENT_ID);
  console.log("  CLIENT_SECRET: " + CLIENT_SECRET);
  console.log("  REFRESH_TOKEN: " + refreshToken);
  console.log("\n─────────────────────────────────────────────────────────");
  console.log("  In background.js, set:");
  console.log(`  const OAUTH_CLIENT_ID     = "${CLIENT_ID}";`);
  console.log(`  const OAUTH_CLIENT_SECRET = "${CLIENT_SECRET}";`);
  console.log(`  const RESEARCHER_REFRESH_TOKEN = "${refreshToken}";`);
  console.log("─────────────────────────────────────────────────────────\n");

  server.close();
});

server.listen(4242, () => {
  console.log("2. Waiting for Google to redirect back… (listening on port 4242)");
});
