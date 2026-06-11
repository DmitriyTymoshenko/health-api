#!/usr/bin/env node
// whoop-reauth.js — Re-authenticate WHOOP OAuth
// Run: node scripts/whoop-reauth.js
// Then open the URL, authorize, paste the code back

const https = require('https')
const http = require('http')
const fs = require('fs')
const { URL } = require('url')

const CREDS_PATH = '/root/.openclaw/workspace/integrations/whoop.json'
const REDIRECT_URI = 'http://localhost:9876/callback'
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token'
const SCOPES = 'offline read:recovery read:sleep read:workout read:profile read:body_measurement read:cycles'

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'))

const authUrl = `https://api.prod.whoop.com/oauth/oauth2/auth?` +
  `response_type=code` +
  `&client_id=${creds.client_id}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPES)}`

console.log('\n🔐 WHOOP Re-authentication\n')
console.log('1. Open this URL in your browser:\n')
console.log(authUrl)
console.log('\n2. Authorize and wait for redirect...\n')

// Start local server to catch callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:9876')
  const code = url.searchParams.get('code')

  if (!code) {
    res.writeHead(400)
    res.end('No code received')
    return
  }

  console.log(`\n✅ Got code: ${code.substring(0, 20)}...`)

  // Exchange code for tokens
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    redirect_uri: REDIRECT_URI,
  }).toString()

  const u = new URL(WHOOP_TOKEN_URL)
  const options = {
    hostname: u.hostname,
    path: u.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }

  const tokenData = await new Promise((resolve, reject) => {
    const req2 = https.request(options, (r) => {
      let data = ''
      r.on('data', c => data += c)
      r.on('end', () => {
        if (r.statusCode >= 400) reject(new Error(`HTTP ${r.statusCode}: ${data}`))
        else resolve(JSON.parse(data))
      })
    })
    req2.on('error', reject)
    req2.write(body)
    req2.end()
  })

  creds.access_token = tokenData.access_token
  creds.refresh_token = tokenData.refresh_token
  creds.token_expires_at = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString()
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2))

  console.log('✅ Tokens saved!')
  console.log(`   Expires at: ${creds.token_expires_at}`)

  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end('<h1>✅ WHOOP авторизація успішна! Можна закрити це вікно.</h1>')

  server.close()
  process.exit(0)
})

server.listen(9876, () => {
  console.log('⏳ Listening for callback on port 9876...\n')
})
