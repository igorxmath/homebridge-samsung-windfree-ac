#!/usr/bin/env node

/**
 * One-time OAuth setup helper for homebridge-samsung-windfree-ac.
 *
 * It walks you through the SmartThings authorization-code flow and prints the
 * RefreshToken to paste into the plugin config. Run it on a machine with a
 * browser reachable at http://localhost:<port>.
 *
 * Prerequisites: an OAuth-In app created with the SmartThings CLI, e.g.
 *
 *   smartthings apps:create
 *     -> "OAuth-In App"
 *     -> Redirect URI:   http://localhost:8000/callback
 *     -> Scopes:         r:devices:* x:devices:*
 *
 * which yields the OAuth Client ID and Client Secret used below.
 */

import http from 'node:http';
import readline from 'node:readline';
import { URL } from 'node:url';

const AUTHORIZE_URL = 'https://api.smartthings.com/oauth/authorize';
const TOKEN_URL = 'https://api.smartthings.com/oauth/token';
const SCOPES = ['r:devices:*', 'x:devices:*'];
const DEFAULT_PORT = 8000;
const CALLBACK_PATH = '/callback';

function ask(rl, question, fallback) {
  return new Promise((resolve) => {
    const suffix = fallback ? ` [${fallback}]` : '';
    rl.question(`${question}${suffix}: `, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed === '' && fallback !== undefined ? fallback : trimmed);
    });
  });
}

async function waitForCode(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, `http://localhost:${port}`);
      if (requestUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = requestUrl.searchParams.get('code');
      const error = requestUrl.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<html><body style="font-family:sans-serif">'
        + (code
          ? '<h2>Authorization complete</h2><p>You can close this tab and return to the terminal.</p>'
          : `<h2>Authorization failed</h2><p>${error || 'No code returned.'}</p>`)
        + '</body></html>',
      );

      server.close();
      if (code) {
        resolve(code);
      } else {
        reject(new Error(error || 'No authorization code returned'));
      }
    });

    server.on('error', reject);
    server.listen(port);
  });
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token exchange failed (HTTP ${response.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\nSmartThings OAuth setup for homebridge-samsung-windfree-ac\n');

    const clientId = await ask(rl, 'OAuth Client ID');
    const clientSecret = await ask(rl, 'OAuth Client Secret');
    const port = Number(await ask(rl, 'Local callback port', String(DEFAULT_PORT)));
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

    if (!clientId || !clientSecret) {
      throw new Error('Client ID and Client Secret are required.');
    }

    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('scope', SCOPES.join(' '));
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);

    console.log('\nMake sure this exact redirect URI is registered on your OAuth app:');
    console.log(`  ${redirectUri}\n`);
    console.log('Open this URL in your browser and approve access:\n');
    console.log(`  ${authorizeUrl.toString()}\n`);
    console.log(`Waiting for the SmartThings redirect on port ${port} ...`);

    const code = await waitForCode(port);
    const tokens = await exchangeCode({ clientId, clientSecret, code, redirectUri });

    console.log('\nSuccess! Add these to your plugin config (config.schema OAuth fields):\n');
    console.log(`  "ClientID": "${clientId}",`);
    console.log(`  "ClientSecret": "${clientSecret}",`);
    console.log(`  "RefreshToken": "${tokens.refresh_token}"\n`);
    console.log('The plugin renews the access token automatically from here on.');
  } catch (error) {
    console.error('\nSetup failed:', error.message);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
