import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import axios from 'axios';

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

export class AirConditionerPlatformAccessory {
  private service: Service;

  private temperatureUnit: TemperatureUnit = TemperatureUnit.Celsius;

  public static readonly supportedCapabilities =
    [
      'switch',
      'airConditionerMode',
      'thermostatCoolingSetpoint',
      'custom.airConditionerOptionalMode',
    ];

  protected name: string;
  protected commandURL: string;
  protected statusURL: string;
  protected healthURL: string;

  private axInstace = axios.create(
    {
      baseURL: this.platform.config.BaseURL,
      headers: { 'Authorization': 'Bearer ' + this.platform.config.AccessToken },
    },
  );

  constructor(
    private readonly platform: HomebridgePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly capabilities: string[],
  ) {

    this.name = accessory.context.device.label;
    this.commandURL = 'devices/' + accessory.context.device.deviceId + '/commands';
    this.statusURL = 'devices/' + accessory.context.device.deviceId + '/status';
    this.healthURL = 'devices/' + accessory.context.device.deviceId + '/health';

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

    const { status } = await this.axInstace.post(this.commandURL, {
      commands: [
        {
          capability: 'custom.airConditionerOptionalMode',
          command: 'setAcOptionalMode',
          arguments: value ? [AirConditionerOptionalMode.WindFree] : [AirConditionerOptionalMode.Off],
        },
      ],
    });

    if (status !== 200) {
      this.platform.log.error('Failed to set WindFreeSwitch');
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

    const { status } = await this.axInstace.post(this.commandURL, {
      commands,
    });

    if (status !== 200) {
      this.platform.log.error('Failed to set TargetHeatingCoolingState');
    }
  }

  private async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET CurrentTemperature');

    const deviceStatus = await this.getDeviceStatus();
    const temperature = deviceStatus.temperatureMeasurement.temperature.value;

    return temperature;
  }

  private async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    this.platform.log.debug('Triggered GET TargetTemperature');

    const deviceStatus = await this.getDeviceStatus();
    const temperature = deviceStatus.thermostatCoolingSetpoint.coolingSetpoint.value;

    return temperature;
  }

  private async handleTargetTemperatureSet(value: CharacteristicValue) {
    this.platform.log.debug('Triggered SET TargetTemperature:', value);

    const { status } = await this.axInstace.post(this.commandURL, {
      commands: [
        {
          capability: 'thermostatCoolingSetpoint',
          command: 'setCoolingSetpoint',
          arguments: [value],
        },
      ],
    });

    if (status !== 200) {
      this.platform.log.error('Failed to set TargetTemperature');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getDeviceStatus(): Promise<any> {
    this.platform.log.debug('Triggered GET DeviceStatus');

    const { data } = await this.axInstace.get(this.statusURL);

    return data.components.main;
  }
}
