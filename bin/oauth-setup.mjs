#!/usr/bin/env node

/**
 * One-time OAuth setup helper for homebridge-samsung-windfree-ac.
 *
 * It walks you through the SmartThings authorization-code flow and prints the
 * RefreshToken to paste into the plugin config.
 *
 * IMPORTANT: SmartThings does NOT allow localhost redirect URIs — the
 * /authorize endpoint returns HTTP 403 for them. You must use a public HTTPS
 * URL as the redirect. A convenient one is https://httpbin.org/get, which just
 * echoes back the query string so you can read the `code`. You then paste that
 * code here to exchange it for tokens.
 *
 * Prerequisites: an OAuth-In app created with the SmartThings CLI, e.g.
 *
 *   smartthings apps:create
 *     -> "OAuth-In App"
 *     -> Redirect URI:   https://httpbin.org/get
 *     -> Scopes:         r:devices:* x:devices:*
 *
 * which yields the OAuth Client ID and Client Secret used below. To change the
 * redirect URI / scopes of an existing app: smartthings apps:oauth:update <id>
 */

import readline from 'node:readline';
import { URL } from 'node:url';

const AUTHORIZE_URL = 'https://api.smartthings.com/oauth/authorize';
const TOKEN_URL = 'https://api.smartthings.com/oauth/token';
const SCOPES = ['r:devices:*', 'x:devices:*'];
const DEFAULT_REDIRECT_URI = 'https://httpbin.org/get';

function ask(rl, question, fallback) {
  return new Promise((resolve) => {
    const suffix = fallback ? ` [${fallback}]` : '';
    rl.question(`${question}${suffix}: `, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed === '' && fallback !== undefined ? fallback : trimmed);
    });
  });
}

/** Accepts either a raw code or the full redirect URL and extracts the code. */
function parseCode(input) {
  const value = input.trim();
  if (value.includes('code=')) {
    try {
      const url = new URL(value);
      const code = url.searchParams.get('code');
      if (code) {
        return code;
      }
    } catch {
      // not a URL, fall through
    }
    const match = value.match(/[?&]code=([^&\s]+)/);
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }
  return value;
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
    const redirectUri = await ask(rl, 'Redirect URI (must match your app, public HTTPS)', DEFAULT_REDIRECT_URI);

    if (!clientId || !clientSecret) {
      throw new Error('Client ID and Client Secret are required.');
    }

    if (redirectUri.startsWith('http://') || redirectUri.includes('localhost')) {
      throw new Error(
        'SmartThings rejects localhost/http redirect URIs (403). Use a public HTTPS URL '
        + '(e.g. https://httpbin.org/get) and register it on the app first.',
      );
    }

    const authorizeUrl = new URL(AUTHORIZE_URL);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('scope', SCOPES.join(' '));
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);

    console.log('\n1) Open this URL in your browser and approve access:\n');
    console.log(`   ${authorizeUrl.toString()}\n`);
    console.log(`2) You will be redirected to ${redirectUri} — copy the "code" value`);
    console.log('   from the page (or from the browser address bar, after "code=").');
    console.log('   The code is single-use and expires within a few minutes.\n');

    const codeInput = await ask(rl, 'Paste the authorization code (or the full redirect URL)');
    const code = parseCode(codeInput);
    if (!code) {
      throw new Error('No authorization code provided.');
    }

    const tokens = await exchangeCode({ clientId, clientSecret, code, redirectUri });

    console.log('\nSuccess! Add these to your plugin config (OAuth fields):\n');
    console.log(`  "ClientID": "${clientId}",`);
    console.log(`  "ClientSecret": "${clientSecret}",`);
    console.log(`  "RefreshToken": "${tokens.refresh_token}"\n`);
    console.log('Remove the "AccessToken" (PAT) field and restart Homebridge.');
    console.log('The plugin renews the access token automatically from here on.');
  } catch (error) {
    console.error('\nSetup failed:', error.message);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
