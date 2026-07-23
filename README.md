<p align="center">
<img src="https://res.cloudinary.com/govimg/image/upload/v1544183273/5b294f9467c0d0489028b276/wind-free.svg" alt="WindFree Logo" style="height: 150px; width:150px;"/>
</p>
<p align="center">
<a href="https://www.npmjs.com/package/homebridge-samsung-windfree-ac"><img title="npm version" src="https://badgen.net/npm/v/homebridge-samsung-windfree-ac?label=stable"></a>
<a href="https://www.npmjs.com/package/homebridge-samsung-windfree-ac"><img title="npm downloads" src="https://badgen.net/npm/dt/homebridge-samsung-windfree-ac"></a>
<a href="https://github.com/igorxmath/homebridge-samsung-windfree-ac/actions/workflows/build.yml"><img title="Node Build" src="https://github.com/igorxmath/homebridge-samsung-windfree-ac/actions/workflows/build.yml/badge.svg"></a>
</p>

# Homebridge Samsung WindFree AC
This is a Homebridge plugin for Samsung WindFree AC.

## Description
This plugin allows you to control your Samsung WindFree AC through Homebridge.

## Installation
Install this plugin using: `hb-service add homebridge-samsung-windfree-ac`

## Authentication

You can authenticate in one of two ways.

### Option A — Personal Access Token (PAT)

Simplest, but note that **PATs created after 2024-12-30 expire 24 hours after creation** and cannot be extended, so you would have to regenerate the token every day. Create one on the [personal access tokens page](https://account.smartthings.com/login?redirect=https%3A%2F%2Faccount.smartthings.com%2Ftokens) (scopes: read/execute devices) and set it as `AccessToken`.

### Option B — OAuth2 (recommended, renews automatically)

Because a new PAT expires after 24 hours (see Option A), OAuth2 is the only way to keep the plugin authenticated without regenerating a token every day. You create your own OAuth-In app once; the plugin then uses its refresh token to obtain and renew access tokens automatically.

#### 1. Create an OAuth-In app (one time)

Install the [SmartThings CLI](https://github.com/SmartThingsCommunity/smartthings-cli), then run:

```
smartthings apps:create
```

- Choose **OAuth-In App** (may be shown as "API-only").
- Grant the scopes `r:devices:*` and `x:devices:*` (read + control devices).
- Set the redirect URI to a **public HTTPS URL**. SmartThings rejects `localhost`/`http` redirect URIs with a `403 Forbidden` on the authorize endpoint, so a local callback does not work. A convenient choice is `https://httpbin.org/get`, which simply echoes back the authorization code.

The command prints an **OAuth Client ID** and **Client Secret** (the secret is shown only once). To edit the redirect URI or scopes of an existing app later: `smartthings apps:oauth:update <AppId>`.

#### 2. Obtain the refresh token (one time)

Do this on a machine with a browser. Pick either method.

**Method A — helper script (recommended).** Download `bin/oauth-setup.mjs` from this repository (it has no dependencies) and run it:

```
node oauth-setup.mjs
```

Paste the Client ID/Secret and the redirect URI when prompted, open the printed authorization URL, approve access, then copy the `code` from the redirect page (the `httpbin` JSON, or the browser address bar after `code=`) and paste it back. The script prints the `RefreshToken`.

**Method B — manual.** Open this URL in a browser (replace `CLIENT_ID`; keep the redirect URI identical to the one registered on the app):

```
https://api.smartthings.com/oauth/authorize?client_id=CLIENT_ID&response_type=code&scope=r:devices:*%20x:devices:*&redirect_uri=https://httpbin.org/get
```

After approving, copy the `code` from the redirect and exchange it for tokens (the code is single-use and expires within minutes):

```
curl -s -u "CLIENT_ID:CLIENT_SECRET" \
  -d grant_type=authorization_code \
  -d code=THE_CODE \
  -d "redirect_uri=https://httpbin.org/get" \
  https://api.smartthings.com/oauth/token
```

Copy the `refresh_token` from the JSON response.

#### 3. Configure the plugin

Put `ClientID`, `ClientSecret` and `RefreshToken` in the config and leave `AccessToken` empty. The refresh token rotates on every use and the newest one is persisted to disk (in the Homebridge storage directory), so you never need to update it manually.

## Configuration
Configuration parameters:

- `name`: The name of the platform.
- `BaseURL`: The base URL for the API.
- `AccessToken`: PAT auth (Option A). Leave empty when using OAuth.
- `ClientID` / `ClientSecret` / `RefreshToken`: OAuth auth (Option B).
- `OptionalWindFreeSwitch`: expose a switch for WindFree mode.
- `OptionalDisplaySwitch`: expose a switch for the display light.

Sample configuration (PAT):

```json
{
    "platforms": [
        {
            "platform": "Homebridge Samsung WindFree AC",
            "name": "Samsung WindFree AC",
            "BaseURL": "https://api.smartthings.com/v1/",
            "AccessToken": "your_access_token"
        }
    ]
}
```

Sample configuration (OAuth):

```json
{
    "platforms": [
        {
            "platform": "Homebridge Samsung WindFree AC",
            "name": "Samsung WindFree AC",
            "BaseURL": "https://api.smartthings.com/v1/",
            "ClientID": "your_oauth_client_id",
            "ClientSecret": "your_oauth_client_secret",
            "RefreshToken": "your_oauth_refresh_token"
        }
    ]
}
```

## Notes on stability

Device status is cached briefly and refreshed on a background poll, so many
simultaneous HomeKit reads collapse into a single SmartThings request. This
avoids the API rate limits (HTTP 429) that previously caused `Failed to get
device status` errors. On an expired/invalid token you will see a clear HTTP
401 message in the log instead.

## Supported Modes
- `off`
- `cool`
- `heat`
- `auto`

## Supported Optional Modes
- `windFree`
> To enable this mode, you need to select the `windFree` option in the plugin settings.

## Roadmap
- [x] Add support for `windFree` mode.
- [ ] Add automated tests and CI/CD.
