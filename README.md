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
- `AccessToken`: Your access token. They can be created and managed on the [personal access tokens page.](https://account.smartthings.com/login?redirect=https%3A%2F%2Faccount.smartthings.com%2Ftokens)

Here is a sample configuration:

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
