/**
 * COMING BACK INTO THE OS AFTER LINKING GOOGLE.
 *
 * The callback rendered a plain HTML page on prod.server.wedsy.in — "Google
 * connected, you can close this tab and head back" — leaving the person on a
 * server page, outside the product, to navigate back by hand.
 *
 * Asserted here:
 *   1  the origin path rides in the EXISTING signed state, not a second channel
 *   2  success redirects into the OS, to the page they started from
 *   3  the base is read from env — never a hardcoded URL
 *   4  no origin in state (an old link in flight) still lands somewhere real
 *   5  an origin cannot be turned into an open redirect
 *   6  EVERY failure path also returns to the OS and says what went wrong
 *
 * Google is mocked through the env seams the service already exposes
 * (GOOGLE_TOKEN_URL / GOOGLE_USERINFO_URL), so nothing here reaches Google.
 *
 *   node tests/google-oauth-return.test.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const express = require("express");
const bp = require("body-parser");
const jwt = require("jsonwebtoken");
const http = require("http");

const Admin = require("../models/Admin");
const GoogleAccount = require("../models/GoogleAccount");

const TAG = `goauth-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.error(`  ✗ ${l}`); } };
const eq = (g, w, l) => ok(g === w, `${l}${g === w ? "" : `\n      expected ${JSON.stringify(w)}\n      got      ${JSON.stringify(g)}`}`);

const created = [];
const SAVED = {};
const save = (k) => { SAVED[k] = process.env[k]; };
const restore = () => Object.entries(SAVED).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });

(async () => {
  let srv, mock;
  try {
    await mongoose.connect(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
    ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TOKEN_URL", "GOOGLE_USERINFO_URL", "OS_FRONTEND_URL"].forEach(save);

    // ── Mock Google ────────────────────────────────────────────────────────
    let tokenBehaviour = "ok";
    mock = http.createServer((req, res) => {
      if (req.url.startsWith("/token")) {
        if (tokenBehaviour === "fail") { res.writeHead(400); return res.end("{}"); }
        if (tokenBehaviour === "norefresh") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ access_token: "at", scope: "x" }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ access_token: "at", refresh_token: "rt-secret", scope: "calendar.events" }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ email: "linked@wedsy.in" }));
    });
    await new Promise((r) => mock.listen(0, r));
    const mockBase = `http://127.0.0.1:${mock.address().port}`;
    process.env.GOOGLE_CLIENT_ID = "test-client";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    process.env.GOOGLE_TOKEN_URL = `${mockBase}/token`;
    process.env.GOOGLE_USERINFO_URL = `${mockBase}/userinfo`;
    process.env.OS_FRONTEND_URL = "https://os.example";

    const GoogleWorkspaceService = require("../services/GoogleWorkspaceService");

    const app = express();
    app.use(bp.json());
    app.use("/", require("../routes/router"));
    srv = app.listen(0);
    const base = `http://127.0.0.1:${srv.address().port}`;

    const admin = await Admin.create({
      name: `${TAG}-admin`, email: `${TAG}@wedsy.in`, phone: `9198${String(Date.now()).slice(-8)}`,
      password: "x", roles: ["sales"], status: "active", isDisabled: false, joinedAt: new Date(),
    });
    created.push(admin._id);

    // Follow no redirects — the Location header IS the assertion.
    const hit = (qs) => fetch(`${base}/google/oauth/callback?${qs}`, { redirect: "manual" });
    const loc = (res) => res.headers.get("location") || "";

    console.log("\n1. THE ORIGIN RIDES IN THE EXISTING SIGNED STATE");
    {
      const url = GoogleWorkspaceService.startUrl(admin._id, "/leads/abc123");
      const state = new URL(url).searchParams.get("state");
      const claims = jwt.verify(state, process.env.JWT_SECRET);
      eq(String(claims.g), String(admin._id), "the state still carries the adminId it always did");
      ok(Object.values(claims).includes("/leads/abc123"),
        "…and now the origin path too, in the SAME token");

      // No second mechanism: the consent URL gains no extra parameter.
      const params = [...new URL(url).searchParams.keys()].sort();
      eq(params.join(","), "access_type,client_id,prompt,redirect_uri,response_type,scope,state",
        "the consent URL carries no NEW parameter — one mechanism, not two");
    }

    console.log("\n2. SUCCESS RETURNS TO THE PAGE THEY STARTED FROM");
    {
      tokenBehaviour = "ok";
      const state = jwt.verify(new URL(GoogleWorkspaceService.startUrl(admin._id, "/leads/abc123")).searchParams.get("state"), process.env.JWT_SECRET);
      const s = jwt.sign(state, process.env.JWT_SECRET);
      const res = await hit(`code=good&state=${encodeURIComponent(s)}`);
      eq(res.status, 302, "it REDIRECTS rather than rendering a page");
      ok(loc(res).startsWith("https://os.example/leads/abc123"),
        `…back into the OS, to the originating page (got ${loc(res)})`);
      ok(/[?&]google=connected/.test(loc(res)), "…with a flag the page can read");
      ok(!/prod\.server\.wedsy\.in/.test(loc(res)), "…and not to a server page");

      const acc = await GoogleAccount.findOne({ adminId: admin._id }).lean();
      ok(!!acc, "and the account really was linked");
      if (acc) created.push(null);
    }

    console.log("\n3. THE BASE COMES FROM ENV");
    {
      process.env.OS_FRONTEND_URL = "https://staging.os.example";
      const s = GoogleWorkspaceService.startUrl(admin._id, "/settings/account");
      const state = new URL(s).searchParams.get("state");
      const res = await hit(`code=good&state=${encodeURIComponent(state)}`);
      ok(loc(res).startsWith("https://staging.os.example/"),
        "changing OS_FRONTEND_URL changes where the callback returns to");
      ok(!loc(res).includes("os.example/leads"), "…and the old base is gone");
      process.env.OS_FRONTEND_URL = "https://os.example";
    }

    console.log("\n4. AN OLD LINK IN FLIGHT STILL LANDS SOMEWHERE REAL");
    {
      // A state minted before this change carries only { g }. It must not
      // dead-end mid-deploy.
      const legacy = jwt.sign({ g: String(admin._id) }, process.env.JWT_SECRET, { expiresIn: "15m" });
      const res = await hit(`code=good&state=${encodeURIComponent(legacy)}`);
      eq(res.status, 302, "a legacy state still redirects");
      ok(loc(res).startsWith("https://os.example/settings/account"),
        `…falling back to account settings (got ${loc(res)})`);
      ok(/[?&]google=connected/.test(loc(res)), "…still flagged as connected");
    }

    console.log("\n5. AN ORIGIN CANNOT BECOME AN OPEN REDIRECT");
    {
      for (const [evil, why] of [
        ["https://evil.example/steal", "an absolute URL"],
        ["//evil.example/steal", "a protocol-relative path"],
        ["http://evil.example", "a bare http origin"],
        ["/\\evil.example", "a backslash trick"],
      ]) {
        const url = GoogleWorkspaceService.startUrl(admin._id, evil);
        const state = new URL(url).searchParams.get("state");
        const res = await hit(`code=good&state=${encodeURIComponent(state)}`);
        ok(loc(res).startsWith("https://os.example/"), `${why} is refused — redirect stays on the OS host`);
        ok(!loc(res).includes("evil.example"), `…and evil.example appears nowhere (${why})`);
      }
    }

    console.log("\n6. EVERY FAILURE ALSO RETURNS TO THE OS");
    {
      const goodState = new URL(GoogleWorkspaceService.startUrl(admin._id, "/leads/abc123")).searchParams.get("state");

      // (a) The user pressed Cancel. Google sends error=access_denied and NO code.
      const denied = await hit(`error=access_denied&state=${encodeURIComponent(goodState)}`);
      eq(denied.status, 302, "a DENIED consent redirects rather than rendering");
      ok(loc(denied).startsWith("https://os.example/leads/abc123"), "…back to where they started");
      ok(/[?&]google=error/.test(loc(denied)), "…flagged as an error");
      ok(/denied/i.test(loc(denied)), `…saying it was DENIED, not "missing code" (got ${loc(denied)})`);

      // (b) An expired or tampered state cannot be trusted for a destination.
      const bad = await hit(`code=good&state=not-a-real-jwt`);
      eq(bad.status, 302, "an invalid state redirects");
      ok(loc(bad).startsWith("https://os.example/settings/account"),
        "…to the safe default, since its origin cannot be trusted");
      ok(/[?&]google=error/.test(loc(bad)), "…flagged as an error");

      // (c) Google accepted the code but returned no refresh token.
      tokenBehaviour = "norefresh";
      const nr = await hit(`code=good&state=${encodeURIComponent(goodState)}`);
      eq(nr.status, 302, "a missing refresh token redirects");
      ok(loc(nr).startsWith("https://os.example/leads/abc123"), "…back to the originating page");
      ok(/[?&]google=error/.test(loc(nr)), "…flagged as an error");

      // (d) The token exchange itself failed.
      tokenBehaviour = "fail";
      const tf = await hit(`code=good&state=${encodeURIComponent(goodState)}`);
      eq(tf.status, 302, "a failed token exchange redirects");
      ok(/[?&]google=error/.test(loc(tf)), "…flagged as an error");
      tokenBehaviour = "ok";

      // Nothing raw is echoed into the URL.
      for (const r of [denied, bad, nr, tf]) {
        ok(!/<|>|script/i.test(loc(r)), "no failure echoes markup into the redirect");
      }
    }

    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error("suite crashed:", e && e.stack ? e.stack : e);
    fail++;
  } finally {
    if (srv) srv.close();
    if (mock) mock.close();
    restore();
    const ids = created.filter(Boolean);
    if (ids.length) {
      await GoogleAccount.deleteMany({ adminId: { $in: ids } });
      await Admin.deleteMany({ _id: { $in: ids } });
    }
    await mongoose.disconnect();
    process.exit(fail === 0 ? 0 : 1);
  }
})();
