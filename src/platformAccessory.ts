import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

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
  All = 'all'
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

export class AirConditionerPlatformAccessory {
  private service: Service;
  private windFreeSwitchService?: Service;
  private displaySwitchService?: Service;
  private fanService?: Service;

  private temperatureUnit: TemperatureUnit = TemperatureUnit.Celsius;

  private cachedStatus: DeviceStatus | null = null;
  private statusFetchedAt = 0;
  private inFlightStatus: Promise<DeviceStatus | null> | null = null;
  private pollTimer?: NodeJS.Timeout;

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

    this.platform.log.debug('Optional WindFree Switch: ', this.platform.config.OptionalWindFreeSwitch);
    if (this.platform.config.OptionalWindFreeSwitch) {
      this.platform.log.debug('Adding WindFree Switch');

      this.windFreeSwitchService =
      this.accessory.getService('WindFree') ||
      this.accessory.addService(this.platform.Service.Switch, 'WindFree', `windfree-${accessory.context.device.deviceId}`);

      this.windFreeSwitchService.setCharacteristic(this.platform.Characteristic.Name, 'WindFree');

      this.windFreeSwitchService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.handleWindFreeSwitchGet.bind(this))
        .onSet(this.handleWindFreeSwitchSet.bind(this));
    } else {
      const windFreeSwitchService = this.accessory.getService('WindFree');
      if (windFreeSwitchService) {
        this.platform.log.debug('Removing WindFree Switch');

        this.accessory.removeService(windFreeSwitchService);
      }
    }

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
    } else {
      const displaySwitchService = this.accessory.getService('Display');
      if (displaySwitchService) {
        this.platform.log.debug('Removing Display Switch');

        this.accessory.removeService(displaySwitchService);
      }
    }

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

      this.fanService.getCharacteristic(this.platform.Characteristic.TargetFanState)
        .onGet(this.handleTargetFanStateGet.bind(this))
        .onSet(this.handleTargetFanStateSet.bind(this));

      this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
        .onGet(this.handleRotationSpeedGet.bind(this))
        .onSet(this.handleRotationSpeedSet.bind(this));

      this.fanService.getCharacteristic(this.platform.Characteristic.SwingMode)
        .onGet(this.handleSwingModeGet.bind(this))
        .onSet(this.handleSwingModeSet.bind(this));
    } else {
      const fanService = this.accessory.getService('Fan');
      if (fanService) {
        this.platform.log.debug('Removing Fan Control');

        this.accessory.removeService(fanService);
      }
    }

    // Warm the cache and start pushing state changes to HomeKit so values stay
    // fresh without every characteristic read hitting the API. Skipped when no
    // credentials are configured, to avoid spamming errors on cached accessories.
    if (this.platform.tokenManager.mode !== 'none') {
      this.refreshAndPush().catch(() => { /* logged in fetch */ });
      this.pollTimer = setInterval(() => {
        this.refreshAndPush().catch(() => { /* logged in fetch */ });
      }, POLL_INTERVAL_MS);

      this.platform.api.on('shutdown', () => {
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
        }
      });
    }
  }

  private async handleWindFreeSwitchGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET WindFreeSwitch');

    const status = await this.requireStatus();
    return this.expect(this.computeWindFree(status));
  }

  private async handleWindFreeSwitchSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET WindFreeSwitch:', value);

    const status = await this.getDeviceStatus();
    const airConditionerMode = this.readAttr(status, 'airConditionerMode', 'airConditionerMode') as AirConditionerMode | undefined;

    if (airConditionerMode === AirConditionerMode.Auto) {
      this.platform.log.debug('WindFreeSwitch is not supported in Auto mode');
      return;
    }

    const ok = await this.sendCommands([
      {
        capability: 'custom.airConditionerOptionalMode',
        command: 'setAcOptionalMode',
        arguments: value ? [AirConditionerOptionalMode.WindFree] : [AirConditionerOptionalMode.Off],
      },
    ]);

    if (!ok) {
      this.platform.log.error('Failed to set WindFreeSwitch');
    } else {
      this.scheduleRefresh();
    }
  }

  private async handleDisplaySwitchGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET DisplaySwitch');

    const status = await this.requireStatus();
    return this.expect(this.computeDisplay(status));
  }

  private async handleDisplaySwitchSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET DisplaySwitch:', value);

    const ok = await this.sendCommands([
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

    if (!ok) {
      this.platform.log.error('Failed to set DisplaySwitch');
    } else {
      this.scheduleRefresh();
    }
  }

  private async handleFanActiveGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET Fan Active');

    const status = await this.requireStatus();
    return this.expect(this.computeActive(status));
  }

  private async handleFanActiveSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET Fan Active:', value);

    const on = value === this.platform.Characteristic.Active.ACTIVE;
    const ok = await this.sendCommands([
      {
        capability: 'switch',
        command: on ? SwitchState.On : SwitchState.Off,
      },
    ]);

    if (!ok) {
      this.platform.log.error('Failed to set Fan Active');
    } else {
      this.scheduleRefresh();
    }
  }

  private async handleCurrentFanStateGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET CurrentFanState');

    const status = await this.requireStatus();
    return this.expect(this.computeCurrentFanState(status));
  }

  private async handleTargetFanStateGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET TargetFanState');

    const status = await this.requireStatus();
    return this.computeTargetFanState(status);
  }

  private async handleTargetFanStateSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET TargetFanState:', value);

    const auto = value === this.platform.Characteristic.TargetFanState.AUTO;
    if (auto) {
      await this.setFanMode(FanMode.Auto);
      return;
    }

    // Manual: if the unit was in auto, start from a sensible fixed speed.
    const status = await this.getDeviceStatus();
    if (this.computeFanMode(status) === FanMode.Auto) {
      await this.setFanMode(FanMode.Medium);
    }
  }

  private async handleRotationSpeedGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET RotationSpeed');

    const status = await this.requireStatus();
    return this.fanModeToPercent(this.computeFanMode(status));
  }

  private async handleRotationSpeedSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET RotationSpeed:', value);

    const percent = value as number;
    if (percent <= 0) {
      // Slider at zero turns the unit off.
      const ok = await this.sendCommands([{ capability: 'switch', command: SwitchState.Off }]);
      if (!ok) {
        this.platform.log.error('Failed to set RotationSpeed');
      } else {
        this.scheduleRefresh();
      }
      return;
    }

    await this.setFanMode(this.percentToFanMode(percent));
  }

  private async handleSwingModeGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET SwingMode');

    const status = await this.requireStatus();
    return this.expect(this.computeSwingMode(status));
  }

  private async handleSwingModeSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET SwingMode:', value);

    const enabled = value === this.platform.Characteristic.SwingMode.SWING_ENABLED;
    await this.setOscillationMode(enabled ? OscillationMode.All : OscillationMode.Fixed);
  }

  private async setFanMode(mode: FanMode): Promise<void> {
    const ok = await this.sendCommands([
      {
        capability: 'airConditionerFanMode',
        command: 'setFanMode',
        arguments: [mode],
      },
    ]);

    if (!ok) {
      this.platform.log.error('Failed to set FanMode');
    } else {
      this.scheduleRefresh();
    }
  }

  private async setOscillationMode(mode: OscillationMode): Promise<void> {
    const ok = await this.sendCommands([
      {
        capability: 'fanOscillationMode',
        command: 'setFanOscillationMode',
        arguments: [mode],
      },
    ]);

    if (!ok) {
      this.platform.log.error('Failed to set FanOscillationMode');
    } else {
      this.scheduleRefresh();
    }
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

    const ok = await this.sendCommands(commands);

    if (!ok) {
      this.platform.log.error('Failed to set TargetHeatingCoolingState');
    } else {
      this.scheduleRefresh();
    }
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

    const ok = await this.sendCommands([
      {
        capability: 'thermostatCoolingSetpoint',
        command: 'setCoolingSetpoint',
        arguments: [value],
      },
    ]);

    if (!ok) {
      this.platform.log.error('Failed to set TargetTemperature');
    } else {
      this.scheduleRefresh();
    }
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

  private computeWindFree(status: DeviceStatus): CharacteristicValue | undefined {
    const airConditionerMode = this.readAttr(status, 'airConditionerMode', 'airConditionerMode') as AirConditionerMode | undefined;

    if (airConditionerMode === AirConditionerMode.Auto) {
      this.platform.log.debug('WindFreeSwitch is not supported in Auto mode');
      return false;
    }

    const windFreeSwitchStatus =
      this.readAttr(status, 'custom.airConditionerOptionalMode', 'acOptionalMode') as AirConditionerOptionalMode | undefined;

    if (windFreeSwitchStatus === undefined) {
      return undefined;
    }

    return windFreeSwitchStatus === AirConditionerOptionalMode.WindFree;
  }

  private computeDisplay(status: DeviceStatus): CharacteristicValue | undefined {
    const displaySwitchStatus = this.readAttr(status, 'samsungce.airConditionerLighting', 'lighting') as SwitchState | undefined;

    if (displaySwitchStatus === undefined) {
      return undefined;
    }

    return displaySwitchStatus === SwitchState.On;
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

  private computeFanMode(status: DeviceStatus | null): FanMode {
    return (this.readAttr(status, 'airConditionerFanMode', 'fanMode') as FanMode) ?? FanMode.Auto;
  }

  private computeTargetFanState(status: DeviceStatus): CharacteristicValue {
    const targetFanState = this.platform.Characteristic.TargetFanState;
    return this.computeFanMode(status) === FanMode.Auto ? targetFanState.AUTO : targetFanState.MANUAL;
  }

  private computeSwingMode(status: DeviceStatus): CharacteristicValue | undefined {
    const mode = this.readAttr(status, 'fanOscillationMode', 'fanOscillationMode') as OscillationMode | undefined;

    if (mode === undefined) {
      return undefined;
    }

    const swingMode = this.platform.Characteristic.SwingMode;
    return mode === OscillationMode.Fixed ? swingMode.SWING_DISABLED : swingMode.SWING_ENABLED;
  }

  private fanModeToPercent(fanMode: FanMode): number {
    switch (fanMode) {
      case FanMode.Low: return 25;
      case FanMode.Medium: return 50;
      case FanMode.High: return 75;
      case FanMode.Turbo: return 100;
      // Auto has no fixed speed; TargetFanState reports the auto mode instead.
      default: return 50;
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

    if (this.windFreeSwitchService) {
      const windFree = this.computeWindFree(status);
      if (windFree !== undefined) {
        this.windFreeSwitchService.updateCharacteristic(chr.On, windFree);
      }
    }

    if (this.displaySwitchService) {
      const display = this.computeDisplay(status);
      if (display !== undefined) {
        this.displaySwitchService.updateCharacteristic(chr.On, display);
      }
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

      if (this.readAttr(status, 'airConditionerFanMode', 'fanMode') !== undefined) {
        this.fanService.updateCharacteristic(chr.TargetFanState, this.computeTargetFanState(status));
        this.fanService.updateCharacteristic(chr.RotationSpeed, this.fanModeToPercent(this.computeFanMode(status)));
      }

      const swingMode = this.computeSwingMode(status);
      if (swingMode !== undefined) {
        this.fanService.updateCharacteristic(chr.SwingMode, swingMode);
      }
    }
  }

  /** Invalidate the cache and schedule a fresh read once the command applied. */
  private scheduleRefresh(): void {
    this.statusFetchedAt = 0;
    setTimeout(() => {
      this.refreshAndPush(true).catch(() => { /* logged in fetch */ });
    }, REFRESH_AFTER_SET_MS);
  }

  /**
   * Returns the device status, served from a short-lived cache and coalescing
   * concurrent callers into a single HTTP request. Never returns `undefined`;
   * on failure it returns the last-known status (or `null`).
   */
  private async getDeviceStatus(forceRefresh = false): Promise<DeviceStatus | null> {
    if (!forceRefresh && this.cachedStatus && Date.now() - this.statusFetchedAt < STATUS_TTL_MS) {
      return this.cachedStatus;
    }

    if (this.inFlightStatus) {
      return this.inFlightStatus;
    }

    this.inFlightStatus = this.fetchDeviceStatus().finally(() => {
      this.inFlightStatus = null;
    });

    return this.inFlightStatus;
  }

  private async fetchDeviceStatus(): Promise<DeviceStatus | null> {
    this.platform.log.debug('Triggered GET DeviceStatus');

    let token: string;
    try {
      token = await this.platform.getAccessToken();
    } catch (error) {
      this.platform.log.error('Cannot get access token for device status:', (error as Error).message);
      return this.cachedStatus;
    }

    let response = await this.doStatusFetch(token);

    // A 401 usually means the token rotated/expired; refresh once and retry.
    if (response && response.status === 401) {
      this.platform.log.warn('Device status returned 401; refreshing token and retrying.');
      try {
        token = await this.platform.tokenManager.forceRefresh();
        response = await this.doStatusFetch(token);
      } catch (error) {
        this.platform.log.error('Token refresh after 401 failed:', (error as Error).message);
      }
    }

    if (!response) {
      return this.cachedStatus;
    }

    if (response.status === 429) {
      this.platform.log.warn(
        'SmartThings rate limit hit (HTTP 429) while reading device status; using cached values and backing off.',
      );
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
      return this.cachedStatus;
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      this.platform.log.error('Failed to parse device status response as JSON');
      return this.cachedStatus;
    }

    const main = data?.components?.main;
    if (!main) {
      this.platform.log.error('Device status response is missing components.main');
      return this.cachedStatus;
    }

    this.cachedStatus = main;
    this.statusFetchedAt = Date.now();
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

    if (response && response.status === 401) {
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
