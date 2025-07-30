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

## Configuration
Configuration parameters:

- `name`: The name of the platform.
- `BaseURL`: The base URL for the API.
- `authMethod`: The authentication method to use. Options are:
  - `oauth2` (Recommended): Uses OAuth2 authentication with a refresh token for permanent access.
  - `pat`: Uses a Personal Access Token that expires after 24 hours.

### OAuth2 Authentication (Recommended)
For OAuth2 authentication, you need to provide the following parameters:

- `clientId`: Your SmartThings client ID.
- `clientSecret`: Your SmartThings client secret.
- `refreshToken`: Your SmartThings refresh token.

To obtain these credentials:
1. Go to the [SmartThings CLI](https://github.com/SmartThingsCommunity/smartthings-cli) and install it by `brew install smartthingscommunity/smartthings/smartthings` or `npm install -g @smartthings/cli`.
2. Run `smartthings apps:create`
  - add Display Name
  - add Description
  - skip icon
  - skip target
  - select `r:device:*`, `w:device:*`, `x:device:*` 
  - move up to select `Add Redirect URI`
  - add: `https://httpbin.org/get` as redirect URI
3. Enter web page - please replace `CLIENT_ID` with your `OAuth Client ID` from step 2: `https://api.smartthings.com/oauth/authorize?response_type=code&client_id=CLIENT_ID&redirect_uri=https%3A%2F%2Fhttpbin.org%2Fget&scope=x%3Adevices%3A*+w%3Adevices%3A*+r%3Adevices%3A*`
4. Copy code from args object, eg. `ZmZ2Z_`

Here is a sample configuration for OAuth2 authentication:

```json
{
    "platforms": [
        {
            "platform": "Homebridge Samsung WindFree AC",
            "name": "Samsung WindFree AC",
            "BaseURL": "https://api.smartthings.com/v1/",
            "authMethod": "oauth2",
            "clientId": "your_client_id",
            "clientSecret": "your_client_secret",
            "refreshToken": "your_refresh_token"
        }
    ]
}
```

### Personal Access Token Authentication
For Personal Access Token authentication, you need to provide the following parameter:

- `AccessToken`: Your access token. They can be created and managed on the [personal access tokens page.](https://account.smartthings.com/login?redirect=https%3A%2F%2Faccount.smartthings.com%2Ftokens)

**Note**: Personal Access Tokens expire after 24 hours and are intended for temporary development use.

Here is a sample configuration for Personal Access Token authentication:

```json
{
    "platforms": [
        {
            "platform": "Homebridge Samsung WindFree AC",
            "name": "Samsung WindFree AC",
            "BaseURL": "https://api.smartthings.com/v1/",
            "authMethod": "pat",
            "AccessToken": "your_access_token"
        }
    ]
}
```

## Supported Modes
- `off`
- `cool`
- `heat`
- `auto`

## Supported Optional Modes
- `windFree`
> To enable this mode, you need to select the `windFree` option in the plugin settings.

## Debugging

For detailed instructions on how to debug this plugin with breakpoints in WebStorm or VS Code, please see the [DEBUGGING.md](DEBUGGING.md) file.

> **Note:** To access the Homebridge WebUI during debugging (http://localhost:8581), make sure the homebridge-config-ui-x plugin is installed. Run `npm install` before debugging to ensure all dependencies are installed.

## Roadmap
- [x] Add support for `windFree` mode.
- [x] Add support for Schema App integration.
- [ ] Add automated tests and CI/CD.
- [x] Support for OAuth2.
