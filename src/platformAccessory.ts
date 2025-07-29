import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HomebridgePlatform } from './platform';
import {SmartThingsClient} from '@smartthings/core-sdk';

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

export class AirConditionerPlatformAccessory {
  private service: Service;

  private temperatureUnit: TemperatureUnit = TemperatureUnit.Celsius;

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
    protected readonly client: SmartThingsClient,
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

      const windFreeSwitchService =
      this.accessory.getService('WindFree') ||
      this.accessory.addService(this.platform.Service.Switch, 'WindFree', `windfree-${accessory.context.device.deviceId}`);

      windFreeSwitchService.setCharacteristic(this.platform.Characteristic.Name, 'WindFree');

      windFreeSwitchService.getCharacteristic(this.platform.Characteristic.On)
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

      const displaySwitchService =
      this.accessory.getService('Display') ||
      this.accessory.addService(this.platform.Service.Switch, 'Display', `display-${accessory.context.device.deviceId}`);

      displaySwitchService.setCharacteristic(this.platform.Characteristic.Name, 'Display');

      displaySwitchService.getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.handleDisplaySwitchGet.bind(this))
        .onSet(this.handleDisplaySwitchSet.bind(this));
    } else {
      const displaySwitchService = this.accessory.getService('Display');
      if (displaySwitchService) {
        this.platform.log.debug('Removing Display Switch');

        this.accessory.removeService(displaySwitchService);
      }
    }
  }

  private async handleWindFreeSwitchGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET WindFreeSwitch');

    const deviceStatus = await this.getDeviceStatus();
    const windFreeSwitchStatus = deviceStatus['custom.airConditionerOptionalMode'].acOptionalMode.value as AirConditionerOptionalMode;
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;

    if (airConditionerMode === AirConditionerMode.Auto) {
      this.platform.log.debug('WindFreeSwitch is not supported in Auto mode');
      return false;
    }

    return windFreeSwitchStatus === AirConditionerOptionalMode.WindFree;
  }

  private async handleWindFreeSwitchSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET WindFreeSwitch:', value);

    const deviceStatus = await this.getDeviceStatus();
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;

    if (airConditionerMode === AirConditionerMode.Auto) {
      this.platform.log.debug('WindFreeSwitch is not supported in Auto mode');
      return;
    }

    const response = await this.client.devices.executeCommand(this.accessory.context.device.deviceId, {
      capability: 'custom.airConditionerOptionalMode',
      command: 'setAcOptionalMode',
      arguments: value ? [AirConditionerOptionalMode.WindFree] : [AirConditionerOptionalMode.Off],
    });

    if (!response.results.length) {
      this.platform.log.error('Failed to set WindFreeSwitch');
    }
  }

  private async handleDisplaySwitchGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET DisplaySwitch');

    const deviceStatus = await this.getDeviceStatus();
    const displaySwitchStatus = deviceStatus['samsungce.airConditionerLighting'].lighting.value;

    return displaySwitchStatus === SwitchState.On;
  }

  private async handleDisplaySwitchSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET DisplaySwitch:', value);

    const response = await this.client.devices.executeCommand(this.accessory.context.device.deviceId, {
      capability: 'execute',
      command: 'execute',
      arguments: ['mode/vs/0', {
        'x.com.samsung.da.options': [
          value ? AirConditionerDisplayState.On : AirConditionerDisplayState.Off,
        ],
      }],
    });

    if (!response.results.length) {
      this.platform.log.error('Failed to set DisplaySwitch');
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

    const deviceStatus = await this.getDeviceStatus();
    const currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState;
    const airConditionerSwitchStatus = deviceStatus.switch.switch.value as SwitchState;
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;
    const coolingSetpoint = deviceStatus.thermostatCoolingSetpoint.coolingSetpoint.value;
    const temperature = deviceStatus.temperatureMeasurement.temperature.value;

    this.platform.log.debug('CurrentHeatingCoolingState:', airConditionerMode);

    if (airConditionerSwitchStatus === SwitchState.Off) {
      return currentHeatingCoolingState.OFF;
    } else if (airConditionerMode === AirConditionerMode.Cool) {
      return currentHeatingCoolingState.COOL;
    } else if (airConditionerMode === AirConditionerMode.Auto) {
      // @ts-ignore
      return temperature > coolingSetpoint ? currentHeatingCoolingState.COOL : currentHeatingCoolingState.HEAT;
    } else if (airConditionerMode === AirConditionerMode.Heat) {
      return currentHeatingCoolingState.HEAT;
    } else {
      return currentHeatingCoolingState.OFF;
    }
  }

  private async handleTargetHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET TargetHeatingCoolingState');

    const deviceStatus = await this.getDeviceStatus();
    const airConditionerSwitchStatus = deviceStatus.switch.switch.value as SwitchState;
    const targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState;
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;

    this.platform.log.debug('TargetHeatingCoolingState:', airConditionerMode);

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

  private async handleTargetHeatingCoolingStateSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET TargetHeatingCoolingState:', value);

    const TargetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState;

    this.platform.log.debug('TargetHeatingCoolingState:', TargetHeatingCoolingState);

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

    const response = await this.client.devices.executeCommands(this.accessory.context.device.deviceId, commands);

    if (!response.results.length) {
      this.platform.log.error('Failed to set TargetHeatingCoolingState');
    }
  }

  private async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET CurrentTemperature');

    const deviceStatus = await this.getDeviceStatus();
    const temperature = deviceStatus.temperatureMeasurement.temperature.value;

    return temperature as CharacteristicValue;
  }

  private async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET TargetTemperature');

    const deviceStatus = await this.getDeviceStatus();
    const temperature = deviceStatus.thermostatCoolingSetpoint.coolingSetpoint.value;

    return temperature as CharacteristicValue;
  }

  private async handleTargetTemperatureSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET TargetTemperature:', value);

    const response = await this.client.devices.executeCommand(this.accessory.context.device.deviceId, {
      capability: 'thermostatCoolingSetpoint',
      command: 'setCoolingSetpoint',
      arguments: [value as number],
    });

    if (!response.results.length) {
      this.platform.log.error('Failed to set TargetTemperature');
    }
  }

  private async getDeviceStatus() {
    this.platform.log.debug('Triggered GET DeviceStatus');
    const data = await this.client.devices.getStatus(this.accessory.context.device.deviceId);

    if (!data.components?.main) {
      this.platform.log.error('Failed to get device status');
      throw new Error('Failed to get device status');
    }

    return data.components.main;
  }
}
