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
  public static readonly supportedCapabilities = [
    'switch',
    'airConditionerMode',
    'thermostatCoolingSetpoint',
  ];

  protected name: string;

  constructor(
    private readonly platform: HomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly capabilities: string[],
    protected readonly client: SmartThingsClient,
  ) {
    this.name = accessory.context.device.label;

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

    if (this.platform.config.OptionalWindFreeSwitch) {
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
        this.accessory.removeService(windFreeSwitchService);
      }
    }

    if (this.platform.config.OptionalDisplaySwitch) {
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
        this.accessory.removeService(displaySwitchService);
      }
    }
  }

  private async handleWindFreeSwitchGet(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const windFreeSwitchStatus = deviceStatus['custom.airConditionerOptionalMode'].acOptionalMode.value as AirConditionerOptionalMode;
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;
    if (airConditionerMode === AirConditionerMode.Auto) {
      return false;
    }
    return windFreeSwitchStatus === AirConditionerOptionalMode.WindFree;
  }

  private async handleWindFreeSwitchSet(value: CharacteristicValue) {
    const deviceStatus = await this.getDeviceStatus();
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;
    if (airConditionerMode === AirConditionerMode.Auto) {
      return;
    }
    await this.client.devices.executeCommand(this.accessory.context.device.deviceId, {
      capability: 'custom.airConditionerOptionalMode',
      command: 'setAcOptionalMode',
      arguments: value ? [AirConditionerOptionalMode.WindFree] : [AirConditionerOptionalMode.Off],
    });
  }

  private async handleDisplaySwitchGet(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const displaySwitchStatus = deviceStatus['samsungce.airConditionerLighting'].lighting.value;
    return displaySwitchStatus === SwitchState.On;
  }

  private async handleDisplaySwitchSet(value: CharacteristicValue) {
    await this.client.devices.executeCommand(this.accessory.context.device.deviceId, {
      capability: 'execute',
      command: 'execute',
      arguments: ['mode/vs/0', {
        'x.com.samsung.da.options': [
          value ? AirConditionerDisplayState.On : AirConditionerDisplayState.Off,
        ],
      }],
    });
  }

  private handleTemperatureDisplayUnitsGet(): CharacteristicValue {
    return this.temperatureUnit === TemperatureUnit.Celsius
      ? this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS
      : this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
  }

  private async handleCurrentHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState;
    const airConditionerSwitchStatus = deviceStatus.switch.switch.value as SwitchState;
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;
    const coolingSetpoint = deviceStatus.thermostatCoolingSetpoint.coolingSetpoint.value as number;
    const temperature = deviceStatus.temperatureMeasurement.temperature.value as number;
    if (airConditionerSwitchStatus === SwitchState.Off) {
      return currentHeatingCoolingState.OFF;
    } else if (airConditionerMode === AirConditionerMode.Cool) {
      return currentHeatingCoolingState.COOL;
    } else if (airConditionerMode === AirConditionerMode.Auto) {
      return temperature > coolingSetpoint ? currentHeatingCoolingState.COOL : currentHeatingCoolingState.HEAT;
    } else if (airConditionerMode === AirConditionerMode.Heat) {
      return currentHeatingCoolingState.HEAT;
    } else {
      return currentHeatingCoolingState.OFF;
    }
  }

  private async handleTargetHeatingCoolingStateGet(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const airConditionerSwitchStatus = deviceStatus.switch.switch.value as SwitchState;
    const targetHeatingCoolingState = this.platform.Characteristic.TargetHeatingCoolingState;
    const airConditionerMode = deviceStatus.airConditionerMode.airConditionerMode.value as AirConditionerMode;
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
    await this.client.devices.executeCommands(this.accessory.context.device.deviceId, commands);
  }

  private async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const temperature = deviceStatus.temperatureMeasurement.temperature.value;
    return temperature as CharacteristicValue;
  }

  private async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    const deviceStatus = await this.getDeviceStatus();
    const temperature = deviceStatus.thermostatCoolingSetpoint.coolingSetpoint.value;
    return temperature as CharacteristicValue;
  }

  private async handleTargetTemperatureSet(value: CharacteristicValue) {
    await this.client.devices.executeCommand(this.accessory.context.device.deviceId, {
      capability: 'thermostatCoolingSetpoint',
      command: 'setCoolingSetpoint',
      arguments: [value as number],
    });
  }

  private async getDeviceStatus() {
    const data = await this.client.devices.getStatus(this.accessory.context.device.deviceId);
    if (!data.components?.main) {
      throw new Error('Failed to get device status');
    }
    return data.components.main;
  }
}