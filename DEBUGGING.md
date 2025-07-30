# Debugging Homebridge Samsung WindFree AC Plugin

This guide explains how to debug the Homebridge Samsung WindFree AC plugin using WebStorm or VS Code with breakpoints.

## Prerequisites

- WebStorm IDE or VS Code
- Node.js installed
- Homebridge installed (globally or locally)
- This plugin installed and configured

## WebStorm Debug Configurations

Two run configurations have been set up for debugging in WebStorm:

1. **Debug Homebridge** - Runs Homebridge directly with debugging enabled
2. **Watch and Debug Homebridge** - Runs Homebridge in watch mode, automatically recompiling and restarting when code changes

### How to Debug with WebStorm

#### Option 1: Debug Homebridge

1. Open the project in WebStorm
2. Set breakpoints in your code by clicking in the gutter next to the line numbers
3. From the run configurations dropdown in the top-right, select "Debug Homebridge"
4. Click the debug button (green bug icon)
5. Homebridge will start in debug mode
6. When execution reaches your breakpoints, WebStorm will pause execution and allow you to inspect variables

#### Option 2: Watch and Debug Homebridge

1. Open the project in WebStorm
2. Set breakpoints in your code
3. From the run configurations dropdown, select "Watch and Debug Homebridge"
4. Click the debug button
5. Homebridge will start in watch mode
6. When you make changes to your code, it will automatically recompile and restart
7. Your breakpoints will be hit when the code execution reaches them

## VS Code Debug Configurations

Similar configurations have been set up for VS Code:

1. **Debug Homebridge** - Runs Homebridge directly with debugging enabled
2. **Watch and Debug Homebridge** - Runs Homebridge in watch mode

### How to Debug with VS Code

#### Option 1: Debug Homebridge

1. Open the project in VS Code
2. Set breakpoints in your code by clicking in the gutter next to the line numbers
3. Go to the Run and Debug view (Ctrl+Shift+D or Cmd+Shift+D)
4. Select "Debug Homebridge" from the dropdown
5. Click the green play button or press F5
6. Homebridge will start in debug mode
7. When execution reaches your breakpoints, VS Code will pause execution and allow you to inspect variables

#### Option 2: Watch and Debug Homebridge

1. Open the project in VS Code
2. Set breakpoints in your code
3. Go to the Run and Debug view
4. Select "Watch and Debug Homebridge" from the dropdown
5. Click the green play button
6. Homebridge will start in watch mode
7. When you make changes to your code, it will automatically recompile and restart
8. Your breakpoints will be hit when the code execution reaches them

## Debugging Tips

- Use the debugger console to evaluate expressions
- Inspect variables in the Variables panel
- Use the Call Stack to navigate through the execution path
- Add watches for specific variables you want to monitor
- Use conditional breakpoints for complex debugging scenarios by right-clicking on a breakpoint

## Troubleshooting

If breakpoints are not being hit:

1. Make sure source maps are enabled in tsconfig.json (they are by default)
2. Verify that the compiled JavaScript in the dist folder matches your TypeScript source
3. Try restarting your IDE
4. Ensure you're running the debug configuration, not just the run configuration

## Accessing the Homebridge WebUI

When debugging, the Homebridge WebUI will be available at:

- URL: http://localhost:8581
- Default credentials: admin/admin (if you haven't changed them)

> **Note:** The homebridge-config-ui-x plugin must be installed for the WebUI to work. This plugin is included as a dev dependency in this project's package.json file. Make sure to run `npm install` before debugging to ensure it's installed.

The WebUI provides a convenient way to:
- View and manage your Homebridge instance
- See connected accessories
- View logs in real-time
- Change configuration settings
