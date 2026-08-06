import { Service, PlatformAccessory, CharacteristicValue, Characteristic, WithUUID } from 'homebridge';

import { HomebridgePlatform } from './platform';

enum AirConditionerMode {
  Auto = 'auto',
  Cool = 'cool',
  Dry = 'dry',
  Heat = 'heat',
  Wind = 'wind'
}

enum SwitchState {
  On = 'on',
  Off = 'off'
}

enum TemperatureUnit {
  Celsius = 'C',
  Farenheit = 'F'
}

enum AirConditionerOptionalMode {
  WindFree = 'windFree',
  Off = 'off'
}

// The vendor `execute` options are named after the "light off" feature, not
// after the display: sending `Light_Off` turns the display *on*. The inversion
// is intentional — the enum keys are the HomeKit meaning, the values are what
// SmartThings expects.
enum AirConditionerDisplayState {
  On = 'Light_Off',
  Off = 'Light_On'
}

enum FanMode {
  Auto = 'auto',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Turbo = 'turbo'
}

enum OscillationMode {
  Fixed = 'fixed',
  All = 'all',
  Vertical = 'vertical',
  Horizontal = 'horizontal'
}

type DeviceStatus = Record<string, any>;

// Serve cached status for this long before hitting the API again. A single read
// cycle in HomeKit triggers many characteristic reads at once; the cache turns
// them into one request instead of one per characteristic.
const STATUS_TTL_MS = 4000;

// Background poll interval. One request per device per tick, pushed to HomeKit.
const POLL_INTERVAL_MS = 15000;

// After sending a command, wait a moment for SmartThings to apply it, then
// refresh and push the resulting state.
const REFRESH_AFTER_SET_MS = 1500;

// How long to stop issuing status requests after SmartThings answers with a 429.
// Used only when the response carries no usable Retry-After header.
const RATE_LIMIT_BACKOFF_MS = 60000;

// Upper bound on a server-supplied Retry-After, so a bogus value cannot wedge
// the plugin for hours.
const MAX_BACKOFF_MS = 15 * 60 * 1000;

// Shorter pause after any other failed read, so a broken API or an expired
// token does not turn the poll timer into a request flood.
const ERROR_BACKOFF_MS = 30000;

// SmartThings capabilities backing each optional feature.
const FAN_MODE_CAPABILITY = 'airConditionerFanMode';
const OSCILLATION_CAPABILITY = 'fanOscillationMode';
const HUMIDITY_CAPABILITY = 'relativeHumidityMeasurement';
const AUTO_CLEAN_CAPABILITY = 'custom.autoCleaningMode';
const WINDFREE_CAPABILITY = 'custom.airConditionerOptionalMode';
const LIGHTING_CAPABILITY = 'samsungce.airConditionerLighting';

export class AirConditionerPlatformAccessory {
  private service: Service;
  private windFreeSwitchService?: Service;
  private displaySwitchService?: Service;
  private humiditySensorService?: Service;
  private fanService?: Service;
  private swingVerticalService?: Service;
  private swingHorizontalService?: Service;
  private autoCleanService?: Service;

  private temperatureUnit: TemperatureUnit = TemperatureUnit.Celsius;

  // Whether the unit reports its own display state. When it does the reported
  // value is authoritative and a missing one is a read failure; when it does
  // not, the only feedback available is what we last sent.
  private reportsDisplayState = false;
  private fanModeSupported = false;
  private oscillationSupported = false;

  // Last speed the unit was seen running at outside Auto. Used to give the
  // RotationSpeed slider something meaningful to show while in Auto and to pick
  // a speed when HomeKit switches the fan back to manual.
  private lastManualFanMode: FanMode = FanMode.Medium;

  private cachedStatus: DeviceStatus | null = null;
  private statusFetchedAt = 0;
  private inFlightStatus: Promise<DeviceStatus | null> | null = null;
  private backoffUntil = 0;
  private pollTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;

  public static readonly supportedCapabilities =
    [
      'switch',
      'airConditionerMode',
      'thermostatCoolingSetpoint',
    ];

  protected name: string;
  protected commandURL: string;
  protected statusURL: string;
  protected healthURL: string;

  constructor(
    private readonly platform: HomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly capabilities: string[],
  ) {

    this.name = accessory.context.device.label;
    this.commandURL = this.platform.config.BaseURL + '/devices/' + accessory.context.device.deviceId + '/commands';
    this.statusURL = this.platform.config.BaseURL + '/devices/' + accessory.context.device.deviceId + '/status';
    this.healthURL = this.platform.config.BaseURL + '/devices/' + accessory.context.device.deviceId + '/health';

    this.reportsDisplayState = this.capabilities.includes(LIGHTING_CAPABILITY);

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(this.platform.Characteristic.Model, 'WindFree')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, '1.0.0');

    this.service =
      this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.label);

    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    if (this.isOptionalFeatureEnabled('OptionalWindFreeSwitch', 'WindFree Switch', [WINDFREE_CAPABILITY])) {
      this.platform.log.debug('Adding WindFree Switch');

      this.windFreeSwitchService =
      this.accessory.getService('WindFree') ||
      this.accessory.addService(this.platform.Service.Switch, 'WindFree', `windfree-${accessory.context.device.deviceId}`);

      this.windFreeSwitchService.setCharacteristic(this.platform.Characteristic.Name, 'WindFree');

      this.windFreeSwitchService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.handleWindFreeSwitchGet.bind(this))
        .onSet(this.handleWindFreeSwitchSet.bind(this));
    } else {
      this.removeServiceByName('WindFree');
    }

    // Not gated on a capability: the display is driven through the vendor
    // `execute` command, which units accept whether or not they report the
    // resulting state back.
    this.platform.log.debug('Optional Display Switch: ', this.platform.config.OptionalDisplaySwitch);
    if (this.platform.config.OptionalDisplaySwitch) {
      this.platform.log.debug('Adding Display Switch');

      this.displaySwitchService =
      this.accessory.getService('Display') ||
      this.accessory.addService(this.platform.Service.Switch, 'Display', `display-${accessory.context.device.deviceId}`);

      this.displaySwitchService.setCharacteristic(this.platform.Characteristic.Name, 'Display');

      this.displaySwitchService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.handleDisplaySwitchGet.bind(this))
        .onSet(this.handleDisplaySwitchSet.bind(this));

      if (!this.reportsDisplayState) {
        this.platform.log.debug('Unit does not report its display state; falling back to the last state we set');
      }
    } else {
      this.removeServiceByName('Display');
    }

    if (this.isOptionalFeatureEnabled('OptionalHumiditySensor', 'Humidity Sensor', [HUMIDITY_CAPABILITY])) {
      this.platform.log.debug('Adding Humidity Sensor');

      // A separate service, so a humidity read failure can never mark the
      // thermostat itself as unresponsive.
      this.humiditySensorService =
      this.accessory.getService('Humidity') ||
      this.accessory.addService(this.platform.Service.HumiditySensor, 'Humidity', `humidity-${accessory.context.device.deviceId}`);

      this.humiditySensorService.setCharacteristic(this.platform.Characteristic.Name, 'Humidity');

      this.humiditySensorService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(this.handleCurrentRelativeHumidityGet.bind(this));
    } else {
      this.removeServiceByName('Humidity');
    }

    this.fanModeSupported = this.capabilities.includes(FAN_MODE_CAPABILITY);
    this.oscillationSupported = this.capabilities.includes(OSCILLATION_CAPABILITY);

    this.platform.log.debug('Optional Fan Control: ', this.platform.config.OptionalFanControl);
    if (this.platform.config.OptionalFanControl) {
      this.platform.log.debug('Adding Fan Control');

      this.fanService =
      this.accessory.getService('Fan') ||
      this.accessory.addService(this.platform.Service.Fanv2, 'Fan', `fan-${accessory.context.device.deviceId}`);

      this.fanService.setCharacteristic(this.platform.Characteristic.Name, 'Fan');

      this.fanService.getCharacteristic(this.platform.Characteristic.Active)
        .onGet(this.handleFanActiveGet.bind(this))
        .onSet(this.handleFanActiveSet.bind(this));

      this.fanService.getCharacteristic(this.platform.Characteristic.CurrentFanState)
        .onGet(this.handleCurrentFanStateGet.bind(this));

      // Speed and auto/manual only exist for units that expose a fan mode.
      // Advertising them anyway gives a fan tile whose commands always fail.
      if (this.fanModeSupported) {
        this.fanService.getCharacteristic(this.platform.Characteristic.TargetFanState)
          .onGet(this.handleTargetFanStateGet.bind(this))
          .onSet(this.handleTargetFanStateSet.bind(this));

        this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
          .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
          .onGet(this.handleRotationSpeedGet.bind(this))
          .onSet(this.handleRotationSpeedSet.bind(this));
      } else {
        this.platform.log.info(
          `${this.name} does not report ${FAN_MODE_CAPABILITY}; the fan is exposed as on/off only.`,
        );

        this.removeCharacteristic(this.fanService, this.platform.Characteristic.TargetFanState);
        this.removeCharacteristic(this.fanService, this.platform.Characteristic.RotationSpeed);
      }

      if (this.oscillationSupported) {
        this.fanService.getCharacteristic(this.platform.Characteristic.SwingMode)
          .onGet(this.handleSwingModeGet.bind(this))
          .onSet(this.handleSwingModeSet.bind(this));
      } else {
        this.platform.log.info(`${this.name} does not report ${OSCILLATION_CAPABILITY}; the fan has no swing control.`);

        this.removeCharacteristic(this.fanService, this.platform.Characteristic.SwingMode);
      }
    } else {
      this.removeServiceByName('Fan');
    }

    if (this.isOptionalFeatureEnabled('OptionalSwingDirectionSwitches', 'Swing Direction Switches', [OSCILLATION_CAPABILITY])) {
      this.platform.log.debug('Adding Swing Direction Switches');

      this.swingVerticalService = this.setupSwingDirectionSwitch(
        'Swing Vertical', `swing-vertical-${accessory.context.device.deviceId}`, OscillationMode.Vertical);
      this.swingHorizontalService = this.setupSwingDirectionSwitch(
        'Swing Horizontal', `swing-horizontal-${accessory.context.device.deviceId}`, OscillationMode.Horizontal);
    } else {
      this.removeServiceByName('Swing Vertical');
      this.removeServiceByName('Swing Horizontal');
    }

    if (this.isOptionalFeatureEnabled('OptionalAutoCleanSwitch', 'Auto Clean Switch', [AUTO_CLEAN_CAPABILITY])) {
      this.platform.log.debug('Adding Auto Clean Switch');

      this.autoCleanService =
      this.accessory.getService('Auto Clean') ||
      this.accessory.addService(this.platform.Service.Switch, 'Auto Clean', `autoclean-${accessory.context.device.deviceId}`);

      this.autoCleanService.setCharacteristic(this.platform.Characteristic.Name, 'Auto Clean');

      this.autoCleanService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.handleAutoCleanGet.bind(this))
        .onSet(this.handleAutoCleanSet.bind(this));
    } else {
      this.removeServiceByName('Auto Clean');
    }

    // Warm the cache and start pushing state changes to HomeKit so values stay
    // fresh without every characteristic read hitting the API. Skipped when no
    // credentials are configured, to avoid spamming errors on cached accessories.
    if (this.platform.tokenManager.mode !== 'none') {
      this.refreshAndPush().catch(() => { /* logged in fetch */ });
      this.pollTimer = setInterval(() => {
        this.refreshAndPush().catch(() => { /* logged in fetch */ });
      }, POLL_INTERVAL_MS);

      this.platform.onShutdown(() => {
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = undefined;
        }
        if (this.refreshTimer) {
          clearTimeout(this.refreshTimer);
          this.refreshTimer = undefined;
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Optional service wiring
  // ---------------------------------------------------------------------------

  /**
   * An optional feature is only wired up when the unit actually reports the
   * capabilities behind it. Exposing a control the unit cannot answer for turns
   * every read into a "No Response" accessory and every write into a silent
   * failure, so we log once and leave the control out instead.
   */
  private isOptionalFeatureEnabled(configKey: string, feature: string, requiredCapabilities: string[]): boolean {
    const requested = Boolean(this.platform.config[configKey]);
    this.platform.log.debug(`Optional ${feature}: `, this.platform.config[configKey]);

    if (!requested) {
      return false;
    }

    const missing = requiredCapabilities.filter(capability => !this.capabilities.includes(capability));
    if (missing.length > 0) {
      this.platform.log.warn(
        `${feature} is enabled in the config but ${this.name} does not report ${missing.join(', ')}; skipping it.`,
      );
      return false;
    }

    return true;
  }

  private removeServiceByName(name: string): void {
    const service = this.accessory.getService(name);
    if (service) {
      this.platform.log.debug(`Removing ${name}`);

      this.accessory.removeService(service);
    }
  }

  private removeCharacteristic(service: Service, characteristic: WithUUID<new () => Characteristic>): void {
    // Looked up by UUID rather than with getCharacteristic(), which would add
    // the optional characteristic back if it isn't there.
    const existing = service.characteristics.find(candidate => candidate.UUID === characteristic.UUID);
    if (existing) {
      service.removeCharacteristic(existing);
    }
  }

  private setupSwingDirectionSwitch(name: string, subtype: string, direction: OscillationMode): Service {
    const service =
      this.accessory.getService(name) ||
      this.accessory.addService(this.platform.Service.Switch, name, subtype);

    service.setCharacteristic(this.platform.Characteristic.Name, name);

    service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(async () => {
        const status = await this.requireStatus();
        return this.expect(this.computeSwingDirection(status, direction));
      })
      .onSet(async (value) => {
        await this.setSwingDirection(name, direction, Boolean(value));
      });

    return service;
  }

  // ---------------------------------------------------------------------------
  // Characteristic handlers
  // ---------------------------------------------------------------------------

  private async handleWindFreeSwitchGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET WindFreeSwitch');

    const status = await this.requireStatus();
    return this.expect(this.computeWindFree(status));
  }

  private async handleWindFreeSwitchSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET WindFreeSwitch:', value);

    // The decision below rejects the user's request, so it must not rest on a
    // possibly stale cache.
    const status = await this.requireFreshStatus('WindFreeSwitch');

    const airConditionerMode = this.readAttr(status, 'airConditionerMode', 'airConditionerMode') as AirConditionerMode | undefined;

    if (airConditionerMode === AirConditionerMode.Auto) {
      this.rejectRequest('WindFree is not supported in Auto mode; ignoring the requested change.', status);
    }

    await this.runCommands('WindFreeSwitch', [
      {
        capability: WINDFREE_CAPABILITY,
        command: 'setAcOptionalMode',
        arguments: value ? [AirConditionerOptionalMode.WindFree] : [AirConditionerOptionalMode.Off],
      },
    ]);
  }

  private async handleDisplaySwitchGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET DisplaySwitch');

    const status = await this.requireStatus();
    const reported = this.computeDisplay(status);

    // Units that report the lighting capability give the real state, and a
    // missing value there is a genuine read failure worth surfacing. Only the
    // units that never report it fall back to the last state we set.
    if (this.reportsDisplayState) {
      return this.expect(reported);
    }

    return reported ?? this.displayState;
  }

  private async handleDisplaySwitchSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET DisplaySwitch:', value);

    await this.runCommands('DisplaySwitch', [
      {
        capability: 'execute',
        command: 'execute',
        arguments: ['mode/vs/0', {
          'x.com.samsung.da.options': [
            value ? AirConditionerDisplayState.On : AirConditionerDisplayState.Off,
          ],
        }],
      },
    ]);

    this.displayState = Boolean(value);
  }

  private async handleCurrentRelativeHumidityGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET CurrentRelativeHumidity');

    const status = await this.requireStatus();
    return this.expect(this.computeCurrentRelativeHumidity(status));
  }

  private async handleAutoCleanGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET Auto Clean');

    const status = await this.requireStatus();
    return this.expect(this.computeAutoClean(status));
  }

  private async handleAutoCleanSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET Auto Clean:', value);

    await this.runCommands('Auto Clean', [
      {
        capability: AUTO_CLEAN_CAPABILITY,
        command: 'setAutoCleaningMode',
        arguments: [value ? SwitchState.On : SwitchState.Off],
      },
    ]);
  }

  private async handleFanActiveGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET Fan Active');

    const status = await this.requireStatus();
    return this.expect(this.computeActive(status));
  }

  private async handleFanActiveSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET Fan Active:', value);

    const on = value === this.platform.Characteristic.Active.ACTIVE;

    await this.runCommands('Fan Active', [
      {
        capability: 'switch',
        command: on ? SwitchState.On : SwitchState.Off,
      },
    ]);
  }

  private async handleCurrentFanStateGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET CurrentFanState');

    const status = await this.requireStatus();
    return this.expect(this.computeCurrentFanState(status));
  }

  private async handleTargetFanStateGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET TargetFanState');

    const status = await this.requireStatus();
    return this.expect(this.computeTargetFanState(status));
  }

  private async handleTargetFanStateSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET TargetFanState:', value);

    const auto = value === this.platform.Characteristic.TargetFanState.AUTO;
    if (auto) {
      await this.setFanMode(FanMode.Auto);
      return;
    }

    const status = await this.requireFreshStatus('TargetFanState');
    const current = this.computeFanMode(status);

    // Without a reliable current mode, switching to manual would have to guess
    // a speed — and guessing wrong drops a running unit to a slower one.
    if (current === undefined) {
      this.platform.log.error('Cannot switch the fan to manual: the current fan mode is unknown');
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    // Already on a fixed speed; HomeKit is just echoing the state back.
    if (current !== FanMode.Auto) {
      return;
    }

    await this.setFanMode(this.lastManualFanMode);
  }

  private async handleRotationSpeedGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET RotationSpeed');

    const status = await this.requireStatus();
    return this.expect(this.computeRotationSpeed(status));
  }

  private async handleRotationSpeedSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET RotationSpeed:', value);

    const percent = value as number;

    if (percent <= 0) {
      // Slider at zero turns the unit off.
      await this.runCommands('RotationSpeed', [{ capability: 'switch', command: SwitchState.Off }]);
      return;
    }

    const status = await this.requireFreshStatus('RotationSpeed');

    // The slider has no position of its own for Auto, so it shows the last
    // manual speed. Writing that same value back — a scene restore, or HomeKit
    // echoing a read — must not silently drop the unit out of Auto.
    if (this.computeFanMode(status) === FanMode.Auto && percent === this.computeRotationSpeed(status)) {
      this.platform.log.debug('RotationSpeed unchanged while in Auto; leaving the fan mode alone');
      return;
    }

    const commands: unknown[] = [];

    // A speed set against a powered-off unit has to power it on, otherwise the
    // command is accepted and nothing happens.
    if (this.readAttr(status, 'switch', 'switch') !== SwitchState.On) {
      commands.push({ capability: 'switch', command: SwitchState.On });
    }

    const mode = this.percentToFanMode(percent);
    commands.push({ capability: FAN_MODE_CAPABILITY, command: 'setFanMode', arguments: [mode] });

    await this.runCommands('RotationSpeed', commands);

    this.lastManualFanMode = mode;
  }

  private async handleSwingModeGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET SwingMode');

    const status = await this.requireStatus();
    return this.expect(this.computeSwingMode(status));
  }

  private async handleSwingModeSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET SwingMode:', value);

    const enabled = value === this.platform.Characteristic.SwingMode.SWING_ENABLED;

    if (!enabled) {
      await this.setOscillationMode(OscillationMode.Fixed, 'SwingMode');
      return;
    }

    const status = await this.requireFreshStatus('SwingMode');
    const current = this.computeOscillation(status);

    // Already swinging along some axis — don't widen it to `all` just because
    // HomeKit echoed the state back.
    if (current !== undefined && current !== OscillationMode.Fixed) {
      return;
    }

    const target = this.resolveOscillationMode(
      status, [OscillationMode.All, OscillationMode.Vertical, OscillationMode.Horizontal]);

    if (target === undefined) {
      this.rejectRequest(`${this.name} does not support any swing mode; ignoring the requested change.`, status);
    }

    await this.setOscillationMode(target, 'SwingMode');
  }

  private async setSwingDirection(name: string, direction: OscillationMode, on: boolean): Promise<void> {
    const status = await this.requireFreshStatus(name);
    const current = this.computeOscillation(status);

    // Every write here is relative to the other axis, so acting on an unknown
    // current mode risks cancelling a swing the user never touched.
    if (current === undefined) {
      this.platform.log.error(`Cannot set ${name}: the current oscillation mode is unknown`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const other = direction === OscillationMode.Vertical ? OscillationMode.Horizontal : OscillationMode.Vertical;
    let preferred: OscillationMode[];

    if (on) {
      // Combine with the other axis when the unit can swing both ways.
      preferred = current === other || current === OscillationMode.All
        ? [OscillationMode.All, direction]
        : [direction];
    } else if (current === OscillationMode.All) {
      // Only this axis was turned off; keep the other one swinging.
      preferred = [other, OscillationMode.Fixed];
    } else if (current === direction) {
      preferred = [OscillationMode.Fixed];
    } else {
      // This axis is already off. Sending `fixed` here would cancel the other
      // direction's swing instead.
      this.platform.log.debug(`${name} is already off; nothing to do`);
      return;
    }

    const target = this.resolveOscillationMode(status, preferred);

    if (target === undefined) {
      this.rejectRequest(`${this.name} supports none of: ${preferred.join(', ')}; ignoring the requested change.`, status);
    }

    if (target === current) {
      return;
    }

    await this.setOscillationMode(target, name);
  }

  private async setFanMode(mode: FanMode): Promise<void> {
    await this.runCommands('FanMode', [
      {
        capability: FAN_MODE_CAPABILITY,
        command: 'setFanMode',
        arguments: [mode],
      },
    ]);

    if (mode !== FanMode.Auto) {
      this.lastManualFanMode = mode;
    }
  }

  private async setOscillationMode(mode: OscillationMode, label: string): Promise<void> {
    await this.runCommands(label, [
      {
        capability: OSCILLATION_CAPABILITY,
        command: 'setFanOscillationMode',
        arguments: [mode],
      },
    ]);
  }

  private handleTemperatureDisplayUnitsGet(): CharacteristicValue {
    this.platform.log.debug('Triggered GET TemperatureDisplayUnits');

    return this.temperatureUnit === TemperatureUnit.Celsius
      ? this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS
      : this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
  }

  private async handleCurrentHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET CurrentHeatingCoolingState');

    const status = await this.requireStatus();
    return this.expect(this.computeCurrentHeatingCoolingState(status));
  }

  private async handleTargetHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET TargetHeatingCoolingState');

    const status = await this.requireStatus();
    return this.expect(this.computeTargetHeatingCoolingState(status));
  }

  private async handleTargetHeatingCoolingStateSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET TargetHeatingCoolingState:', value);

    const TargetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState;

    const targetHeatingCoolingStateToAirConditionerMode = () => {
      switch (value) {
        case TargetHeatingCoolingState.AUTO:
          return AirConditionerMode.Auto;
        case TargetHeatingCoolingState.COOL:
          return AirConditionerMode.Cool;
        case TargetHeatingCoolingState.HEAT:
          return AirConditionerMode.Heat;
        default:
          return undefined;
      }
    };

    const airConditionerMode = targetHeatingCoolingStateToAirConditionerMode();

    const commands = airConditionerMode ? [
      {
        capability: 'switch',
        command: SwitchState.On,
      },
      {
        capability: 'airConditionerMode',
        command: 'setAirConditionerMode',
        arguments: [airConditionerMode],
      },
    ] : [
      {
        capability: 'switch',
        command: SwitchState.Off,
      },
    ];

    await this.runCommands('TargetHeatingCoolingState', commands);
  }

  private async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET CurrentTemperature');

    const status = await this.requireStatus();
    return this.expect(this.computeCurrentTemperature(status));
  }

  private async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET TargetTemperature');

    const status = await this.requireStatus();
    return this.expect(this.computeTargetTemperature(status));
  }

  private async handleTargetTemperatureSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET TargetTemperature:', value);

    await this.runCommands('TargetTemperature', [
      {
        capability: 'thermostatCoolingSetpoint',
        command: 'setCoolingSetpoint',
        arguments: [value],
      },
    ]);
  }

  // ---------------------------------------------------------------------------
  // Status computation (pure: derive a characteristic value from a status object)
  // Each returns `undefined` when the required data is missing, so callers can
  // decide whether to throw (on-demand read) or skip (background push).
  // ---------------------------------------------------------------------------

  private computeCurrentHeatingCoolingState(status: DeviceStatus): CharacteristicValue | undefined {
    const currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState;
    const airConditionerSwitchStatus = this.readAttr(status, 'switch', 'switch') as SwitchState | undefined;
    const airConditionerMode = this.readAttr(status, 'airConditionerMode', 'airConditionerMode') as AirConditionerMode | undefined;

    if (airConditionerSwitchStatus === undefined || airConditionerMode === undefined) {
      return undefined;
    }

    if (airConditionerSwitchStatus === SwitchState.Off) {
      return currentHeatingCoolingState.OFF;
    } else if (airConditionerMode === AirConditionerMode.Cool) {
      return currentHeatingCoolingState.COOL;
    } else if (airConditionerMode === AirConditionerMode.Auto) {
      const coolingSetpoint = this.readAttr(status, 'thermostatCoolingSetpoint', 'coolingSetpoint');
      const temperature = this.readAttr(status, 'temperatureMeasurement', 'temperature');
      if (typeof coolingSetpoint !== 'number' || typeof temperature !== 'number') {
        return currentHeatingCoolingState.COOL;
      }
      return temperature > coolingSetpoint ? currentHeatingCoolingState.COOL : currentHeatingCoolingState.HEAT;
    } else if (airConditionerMode === AirConditionerMode.Heat) {
      return currentHeatingCoolingState.HEAT;
    } else {
      return currentHeatingCoolingState.OFF;
    }
  }

  private computeTargetHeatingCoolingState(status: DeviceStatus): CharacteristicValue | undefined {
    const targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState;
    const airConditionerSwitchStatus = this.readAttr(status, 'switch', 'switch') as SwitchState | undefined;
    const airConditionerMode = this.readAttr(status, 'airConditionerMode', 'airConditionerMode') as AirConditionerMode | undefined;

    if (airConditionerSwitchStatus === undefined || airConditionerMode === undefined) {
      return undefined;
    }

    if (airConditionerSwitchStatus === SwitchState.Off) {
      return targetHeatingCoolingState.OFF;
    } else if (airConditionerMode === AirConditionerMode.Cool) {
      return targetHeatingCoolingState.COOL;
    } else if (airConditionerMode === AirConditionerMode.Auto) {
      return targetHeatingCoolingState.AUTO;
    } else if (airConditionerMode === AirConditionerMode.Heat) {
      return targetHeatingCoolingState.HEAT;
    } else {
      return targetHeatingCoolingState.OFF;
    }
  }

  private computeCurrentTemperature(status: DeviceStatus): CharacteristicValue | undefined {
    const temperature = this.readAttr(status, 'temperatureMeasurement', 'temperature');
    return typeof temperature === 'number' ? temperature : undefined;
  }

  private computeTargetTemperature(status: DeviceStatus): CharacteristicValue | undefined {
    const temperature = this.readAttr(status, 'thermostatCoolingSetpoint', 'coolingSetpoint');
    return typeof temperature === 'number' ? temperature : undefined;
  }

  private computeCurrentRelativeHumidity(status: DeviceStatus): CharacteristicValue | undefined {
    const humidity = this.readAttr(status, HUMIDITY_CAPABILITY, 'humidity');
    return typeof humidity === 'number' ? humidity : undefined;
  }

  private computeWindFree(status: DeviceStatus): CharacteristicValue | undefined {
    const airConditionerMode = this.readAttr(status, 'airConditionerMode', 'airConditionerMode') as AirConditionerMode | undefined;

    if (airConditionerMode === AirConditionerMode.Auto) {
      this.platform.log.debug('WindFreeSwitch is not supported in Auto mode');
      return false;
    }

    const windFreeSwitchStatus =
      this.readAttr(status, WINDFREE_CAPABILITY, 'acOptionalMode') as AirConditionerOptionalMode | undefined;

    if (windFreeSwitchStatus === undefined) {
      return undefined;
    }

    return windFreeSwitchStatus === AirConditionerOptionalMode.WindFree;
  }

  private computeDisplay(status: DeviceStatus): CharacteristicValue | undefined {
    const displaySwitchStatus = this.readAttr(status, LIGHTING_CAPABILITY, 'lighting') as SwitchState | undefined;

    if (displaySwitchStatus === undefined) {
      return undefined;
    }

    return displaySwitchStatus === SwitchState.On;
  }

  private computeAutoClean(status: DeviceStatus): CharacteristicValue | undefined {
    const mode = this.readAttr(status, AUTO_CLEAN_CAPABILITY, 'autoCleaningMode') as SwitchState | undefined;

    if (mode === undefined) {
      return undefined;
    }

    return mode === SwitchState.On;
  }

  private computeActive(status: DeviceStatus): CharacteristicValue | undefined {
    const switchStatus = this.readAttr(status, 'switch', 'switch') as SwitchState | undefined;

    if (switchStatus === undefined) {
      return undefined;
    }

    const active = this.platform.Characteristic.Active;
    return switchStatus === SwitchState.On ? active.ACTIVE : active.INACTIVE;
  }

  private computeCurrentFanState(status: DeviceStatus): CharacteristicValue | undefined {
    const switchStatus = this.readAttr(status, 'switch', 'switch') as SwitchState | undefined;

    if (switchStatus === undefined) {
      return undefined;
    }

    const currentFanState = this.platform.Characteristic.CurrentFanState;
    return switchStatus === SwitchState.On ? currentFanState.BLOWING_AIR : currentFanState.INACTIVE;
  }

  /** The unit's fan mode, or `undefined` when it was not read. */
  private computeFanMode(status: DeviceStatus | null): FanMode | undefined {
    const fanMode = this.readAttr(status, FAN_MODE_CAPABILITY, 'fanMode');
    return typeof fanMode === 'string' ? fanMode as FanMode : undefined;
  }

  private computeTargetFanState(status: DeviceStatus): CharacteristicValue | undefined {
    const fanMode = this.computeFanMode(status);

    if (fanMode === undefined) {
      return undefined;
    }

    const targetFanState = this.platform.Characteristic.TargetFanState;
    return fanMode === FanMode.Auto ? targetFanState.AUTO : targetFanState.MANUAL;
  }

  private computeRotationSpeed(status: DeviceStatus | null): number | undefined {
    // Off reads as 0% so the slider round-trips: writing 0 turns the unit off.
    if (this.readAttr(status, 'switch', 'switch') === SwitchState.Off) {
      return 0;
    }

    const fanMode = this.computeFanMode(status);
    return fanMode === undefined ? undefined : this.fanModeToPercent(fanMode);
  }

  private computeOscillation(status: DeviceStatus | null): OscillationMode | undefined {
    const mode = this.readAttr(status, OSCILLATION_CAPABILITY, 'fanOscillationMode');
    return typeof mode === 'string' ? mode as OscillationMode : undefined;
  }

  private computeSwingMode(status: DeviceStatus): CharacteristicValue | undefined {
    const mode = this.computeOscillation(status);

    if (mode === undefined) {
      return undefined;
    }

    const swingMode = this.platform.Characteristic.SwingMode;
    return mode === OscillationMode.Fixed ? swingMode.SWING_DISABLED : swingMode.SWING_ENABLED;
  }

  /** `all` means both axes are swinging, so both direction switches read On. */
  private computeSwingDirection(status: DeviceStatus, direction: OscillationMode): CharacteristicValue | undefined {
    const mode = this.computeOscillation(status);

    if (mode === undefined) {
      return undefined;
    }

    return mode === direction || mode === OscillationMode.All;
  }

  private supportedOscillationModes(status: DeviceStatus | null): OscillationMode[] {
    const modes = this.readAttr(status, OSCILLATION_CAPABILITY, 'supportedFanOscillationModes');
    return Array.isArray(modes) ? modes as OscillationMode[] : [];
  }

  /**
   * Picks the first of `preferred` the unit actually supports. Units that don't
   * advertise their supported modes get the first preference, which is what we
   * did before the list was consulted at all.
   */
  private resolveOscillationMode(status: DeviceStatus | null, preferred: OscillationMode[]): OscillationMode | undefined {
    const supported = this.supportedOscillationModes(status);

    if (supported.length === 0) {
      return preferred[0];
    }

    return preferred.find(mode => supported.includes(mode));
  }

  private fanModeToPercent(fanMode: FanMode): number {
    switch (fanMode) {
      case FanMode.Low: return 25;
      case FanMode.Medium: return 50;
      case FanMode.High: return 75;
      case FanMode.Turbo: return 100;
      // Auto has no speed of its own; TargetFanState reports the auto mode and
      // the slider shows the last manual speed so the two stay consistent.
      default: return this.fanModeToPercent(this.lastManualFanMode);
    }
  }

  private percentToFanMode(percent: number): FanMode {
    if (percent <= 25) {
      return FanMode.Low;
    }
    if (percent <= 50) {
      return FanMode.Medium;
    }
    if (percent <= 75) {
      return FanMode.High;
    }
    return FanMode.Turbo;
  }

  /**
   * Last display state we know of, persisted in the accessory context so units
   * that never report it don't come back from a restart claiming the display is
   * on. Stored in HomeKit polarity (true = display lit).
   */
  private get displayState(): boolean {
    const stored = this.accessory.context.displayState;
    return typeof stored === 'boolean' ? stored : true;
  }

  private set displayState(value: boolean) {
    if (this.accessory.context.displayState === value) {
      return;
    }

    this.accessory.context.displayState = value;
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  // ---------------------------------------------------------------------------
  // Status fetching, caching and pushing
  // ---------------------------------------------------------------------------

  /** Reads `status[capability][attribute].value`, tolerating missing pieces. */
  private readAttr(status: DeviceStatus | null, capability: string, attribute: string): unknown {
    return status?.[capability]?.[attribute]?.value;
  }

  /** Throws a clean HAP communication error when data is unavailable. */
  private expect(value: CharacteristicValue | undefined): CharacteristicValue {
    if (value === undefined) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return value;
  }

  private async requireStatus(): Promise<DeviceStatus> {
    const status = await this.getDeviceStatus();
    if (!status) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return status;
  }

  private async refreshAndPush(forceRefresh = false): Promise<void> {
    const status = await this.getDeviceStatus(forceRefresh);
    if (status) {
      this.pushStatus(status);
    }
  }

  private pushStatus(status: DeviceStatus): void {
    const chr = this.platform.Characteristic;

    const currentState = this.computeCurrentHeatingCoolingState(status);
    if (currentState !== undefined) {
      this.service.updateCharacteristic(chr.CurrentHeatingCoolingState, currentState);
    }

    const targetState = this.computeTargetHeatingCoolingState(status);
    if (targetState !== undefined) {
      this.service.updateCharacteristic(chr.TargetHeatingCoolingState, targetState);
    }

    const currentTemp = this.computeCurrentTemperature(status);
    if (currentTemp !== undefined) {
      this.service.updateCharacteristic(chr.CurrentTemperature, currentTemp);
    }

    const targetTemp = this.computeTargetTemperature(status);
    if (targetTemp !== undefined) {
      this.service.updateCharacteristic(chr.TargetTemperature, targetTemp);
    }

    if (this.humiditySensorService) {
      const humidity = this.computeCurrentRelativeHumidity(status);
      if (humidity !== undefined) {
        this.humiditySensorService.updateCharacteristic(chr.CurrentRelativeHumidity, humidity);
      }
    }

    if (this.windFreeSwitchService) {
      const windFree = this.computeWindFree(status);
      if (windFree !== undefined) {
        this.windFreeSwitchService.updateCharacteristic(chr.On, windFree);
      }
    }

    if (this.displaySwitchService) {
      const display = this.computeDisplay(status);
      if (display !== undefined) {
        this.displayState = display as boolean;
        this.displaySwitchService.updateCharacteristic(chr.On, display);
      }
    }

    if (this.autoCleanService) {
      const autoClean = this.computeAutoClean(status);
      if (autoClean !== undefined) {
        this.autoCleanService.updateCharacteristic(chr.On, autoClean);
      }
    }

    // Remember the speed the unit is actually running at, so Auto has something
    // truthful to show on the slider.
    const fanMode = this.computeFanMode(status);
    if (fanMode !== undefined && fanMode !== FanMode.Auto) {
      this.lastManualFanMode = fanMode;
    }

    if (this.fanService) {
      const active = this.computeActive(status);
      if (active !== undefined) {
        this.fanService.updateCharacteristic(chr.Active, active);
      }

      const currentFanState = this.computeCurrentFanState(status);
      if (currentFanState !== undefined) {
        this.fanService.updateCharacteristic(chr.CurrentFanState, currentFanState);
      }

      if (this.fanModeSupported) {
        const targetFanState = this.computeTargetFanState(status);
        if (targetFanState !== undefined) {
          this.fanService.updateCharacteristic(chr.TargetFanState, targetFanState);
        }

        const rotationSpeed = this.computeRotationSpeed(status);
        if (rotationSpeed !== undefined) {
          this.fanService.updateCharacteristic(chr.RotationSpeed, rotationSpeed);
        }
      }

      if (this.oscillationSupported) {
        const swingMode = this.computeSwingMode(status);
        if (swingMode !== undefined) {
          this.fanService.updateCharacteristic(chr.SwingMode, swingMode);
        }
      }
    }

    if (this.swingVerticalService) {
      const vertical = this.computeSwingDirection(status, OscillationMode.Vertical);
      if (vertical !== undefined) {
        this.swingVerticalService.updateCharacteristic(chr.On, vertical);
      }
    }

    if (this.swingHorizontalService) {
      const horizontal = this.computeSwingDirection(status, OscillationMode.Horizontal);
      if (horizontal !== undefined) {
        this.swingHorizontalService.updateCharacteristic(chr.On, horizontal);
      }
    }
  }

  /**
   * Sends a set of commands and, on success, schedules the follow-up refresh.
   * Throws a HAP error on failure so HomeKit reverts the control instead of
   * showing a value the AC never accepted.
   */
  private async runCommands(what: string, commands: unknown[]): Promise<void> {
    const ok = await this.sendCommands(commands);

    if (!ok) {
      this.platform.log.error(`Failed to set ${what}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.scheduleRefresh();
  }

  /**
   * Status for a write whose outcome depends on what the unit is doing now —
   * which command to send, or whether to send one at all. A cached read can be
   * seconds stale (or, after a failed fetch, arbitrarily old), so these force a
   * fresh one rather than acting on a guess.
   */
  private async requireFreshStatus(what: string): Promise<DeviceStatus> {
    const status = await this.getDeviceStatus(true);

    if (!status) {
      this.platform.log.error(`Cannot set ${what}: device status is unavailable`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    return status;
  }

  /**
   * Reports a request the unit cannot honour, instead of silently dropping it:
   * HomeKit would otherwise keep showing a control position the AC never
   * accepted. Pushes the real state back so the control snaps to it.
   */
  private rejectRequest(message: string, status: DeviceStatus): never {
    this.platform.log.warn(message);
    this.pushStatus(status);
    throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
  }

  /** Invalidate the cache and schedule a fresh read once the command applied. */
  private scheduleRefresh(): void {
    this.statusFetchedAt = 0;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshAndPush(true).catch(() => { /* logged in fetch */ });
    }, REFRESH_AFTER_SET_MS);
  }

  /**
   * Returns the device status, served from a short-lived cache and coalescing
   * concurrent callers into a single HTTP request. Never returns `undefined`;
   * on failure it returns the last-known status (or `null`).
   *
   * `forceRefresh` bypasses both the TTL and any request already in flight —
   * see below for why joining one would be wrong.
   */
  private async getDeviceStatus(forceRefresh = false): Promise<DeviceStatus | null> {
    if (!forceRefresh) {
      if (this.cachedStatus && Date.now() - this.statusFetchedAt < STATUS_TTL_MS) {
        return this.cachedStatus;
      }

      // While backing off (see fetchDeviceStatus) serve the cache rather than
      // adding to the load that triggered the backoff in the first place.
      if (Date.now() < this.backoffUntil) {
        return this.cachedStatus;
      }

      // An ordinary read is happy with whatever request is already running.
      if (this.inFlightStatus) {
        return this.inFlightStatus;
      }
    }

    // A forced read follows a command we just sent. A request already in flight
    // was issued *before* that command, so its response describes the old state
    // and would push the user's change straight back out of the Home app. Queue
    // behind it instead of adopting its result.
    const previous = this.inFlightStatus;
    const request = (async () => {
      if (previous) {
        await previous.catch(() => undefined);
      }
      return this.fetchDeviceStatus();
    })();

    this.inFlightStatus = request;
    // Settle handlers only; the promise itself is returned to (and awaited by)
    // the caller, so this never swallows a rejection.
    request.then(
      () => this.clearInFlight(request),
      () => this.clearInFlight(request),
    );

    return request;
  }

  private clearInFlight(request: Promise<DeviceStatus | null>): void {
    if (this.inFlightStatus === request) {
      this.inFlightStatus = null;
    }
  }

  /**
   * Pauses status requests for a while after a failure. Without this the TTL
   * cache stops suppressing requests exactly when the API is struggling: a
   * failed fetch leaves `statusFetchedAt` untouched, so every characteristic
   * read and every poll tick goes straight back to the network.
   */
  private backOff(durationMs: number, reason: string): void {
    const until = Date.now() + durationMs;
    if (until <= this.backoffUntil) {
      return;
    }
    this.backoffUntil = until;
    this.platform.log.warn(`Pausing device status requests for ${Math.round(durationMs / 1000)}s (${reason}).`);
  }

  /** Retry-After is either a delay in seconds or an HTTP date. */
  private parseRetryAfter(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (!header) {
      return undefined;
    }

    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      return seconds > 0 ? Math.min(seconds * 1000, MAX_BACKOFF_MS) : undefined;
    }

    const date = Date.parse(header);
    if (Number.isNaN(date)) {
      return undefined;
    }

    const delay = date - Date.now();
    return delay > 0 ? Math.min(delay, MAX_BACKOFF_MS) : undefined;
  }

  private async fetchDeviceStatus(): Promise<DeviceStatus | null> {
    this.platform.log.debug('Triggered GET DeviceStatus');

    let token: string;
    try {
      token = await this.platform.getAccessToken();
    } catch (error) {
      this.platform.log.error('Cannot get access token for device status:', (error as Error).message);
      this.backOff(ERROR_BACKOFF_MS, 'no usable access token');
      return this.cachedStatus;
    }

    let response = await this.doStatusFetch(token);

    // A 401 usually means the token rotated/expired; refresh once and retry.
    // Only in OAuth mode: a PAT is static, so forceRefresh() would hand back the
    // exact same token and the retry would replay the identical failing request.
    if (response && response.status === 401 && this.platform.tokenManager.mode === 'oauth') {
      this.platform.log.warn('Device status returned 401; refreshing token and retrying.');
      try {
        token = await this.platform.tokenManager.forceRefresh();
        response = await this.doStatusFetch(token);
      } catch (error) {
        this.platform.log.error('Token refresh after 401 failed:', (error as Error).message);
      }
    }

    if (!response) {
      this.backOff(ERROR_BACKOFF_MS, 'network error');
      return this.cachedStatus;
    }

    if (response.status === 429) {
      const backoff = this.parseRetryAfter(response) ?? RATE_LIMIT_BACKOFF_MS;
      this.backOff(backoff, 'SmartThings rate limit, HTTP 429');
      return this.cachedStatus;
    }

    if (!response.ok) {
      this.platform.log.error(`Failed to get device status (HTTP ${response.status} ${response.statusText})`);
      if (response.status === 401) {
        this.platform.log.error(
          'HTTP 401 Unauthorized: the SmartThings token is invalid or expired. '
          + 'A PAT created after 2024-12-30 expires 24h after creation — switch to OAuth to renew automatically.',
        );
      }
      this.backOff(ERROR_BACKOFF_MS, `HTTP ${response.status}`);
      return this.cachedStatus;
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      this.platform.log.error('Failed to parse device status response as JSON');
      this.backOff(ERROR_BACKOFF_MS, 'unparseable response');
      return this.cachedStatus;
    }

    const main = data?.components?.main;
    if (!main) {
      this.platform.log.error('Device status response is missing components.main');
      this.backOff(ERROR_BACKOFF_MS, 'response missing components.main');
      return this.cachedStatus;
    }

    this.cachedStatus = main;
    this.statusFetchedAt = Date.now();
    this.backoffUntil = 0;
    return main;
  }

  private async doStatusFetch(token: string): Promise<Response | null> {
    try {
      return await fetch(this.statusURL, {
        headers: {
          'Authorization': 'Bearer ' + token,
        },
      });
    } catch (error) {
      this.platform.log.error('Network error while reading device status:', (error as Error).message);
      return null;
    }
  }

  /** Sends commands, refreshing the token once on a 401. Returns success. */
  private async sendCommands(commands: unknown[]): Promise<boolean> {
    let token: string;
    try {
      token = await this.platform.getAccessToken();
    } catch (error) {
      this.platform.log.error('Cannot get access token to send command:', (error as Error).message);
      return false;
    }

    let response = await this.doCommand(token, commands);

    // OAuth only — see the matching note in fetchDeviceStatus.
    if (response && response.status === 401 && this.platform.tokenManager.mode === 'oauth') {
      this.platform.log.warn('Command returned 401; refreshing token and retrying.');
      try {
        token = await this.platform.tokenManager.forceRefresh();
        response = await this.doCommand(token, commands);
      } catch (error) {
        this.platform.log.error('Token refresh after 401 failed:', (error as Error).message);
      }
    }

    if (!response) {
      return false;
    }

    if (!response.ok) {
      this.platform.log.error(`Command failed (HTTP ${response.status} ${response.statusText})`);
      return false;
    }

    return true;
  }

  private async doCommand(token: string, commands: unknown[]): Promise<Response | null> {
    try {
      return await fetch(this.commandURL, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ commands }),
      });
    } catch (error) {
      this.platform.log.error('Network error while sending command:', (error as Error).message);
      return null;
    }
  }
}
