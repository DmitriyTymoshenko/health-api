#!/usr/bin/env node
// whoop-reauth.js — print the WHOOP authorize URL for an interactive re-auth.
// Run: node /root/chuttyevo-agent/health-api/scripts/whoop-reauth.js
//
// The token exchange itself is handled by the LIVE callback endpoint
// (health-api routes/whoop.js → GET /api/whoop/callback), which writes the new
// tokens to /root/.config/whoop/whoop.json. This script only builds the URL.
//
// Do NOT reintroduce a local http://localhost:9876/callback listener here: that
// redirect_uri is NOT whitelisted in the WHOOP app, so the authorize step fails
// with `invalid_request` (see rules/lessons-learned.md, 2026-07-09).

const fs = require('fs')

const CREDS_PATH = '/root/.config/whoop/whoop.json'
const REDIRECT_URI = 'https://srv1532186.hstgr.cloud/health-api/api/whoop/callback'
const SCOPES = 'offline read:recovery read:sleep read:workout read:profile read:body_measurement read:cycles'

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'))

// WHOOP rejects an authorize request whose `state` is shorter than 8 characters.
const state = require('crypto').randomBytes(16).toString('hex')

const authUrl = 'https://api.prod.whoop.com/oauth/oauth2/auth?' + new URLSearchParams({
  response_type: 'code',
  client_id: creds.client_id,
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  state,
}).toString()

const expired = new Date(creds.token_expires_at).getTime() < Date.now()

console.log('\n🔐 WHOOP re-authentication\n')
console.log(`Поточний токен: ${expired ? '❌ протух' : '✅ живий'} (expires ${creds.token_expires_at})\n`)
console.log('1. Відкрий це посилання в браузері (де ти залогінений у WHOOP):\n')
console.log(authUrl)
console.log('\n2. Натисни Approve — колбек сам збереже нові токени в', CREDS_PATH)
console.log('3. Перевір:  . /root/.config/chuttyevo/mongo.env && node ' +
  '/root/chuttyevo-agent/health-api/scripts/sync-whoop.js\n')
