import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { AirConditionerPlatformAccessory } from './platformAccessory';
import { AuthService } from './authService';
import { Component, SmartThingsClient } from '@smartthings/core-sdk';
import { Authenticator} from '@smartthings/core-sdk';
import { Device } from '@smartthings/core-sdk/dist/endpoint/devices';

export class HomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  public readonly authService!: AuthService;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,

  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    this.authService = new AuthService(this.config, this.log);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    this.accessories.push(accessory);
  }

  async discoverDevices() {
    const authenticator: Authenticator = await this.authService.getAuthenticator();

    const client: SmartThingsClient = new SmartThingsClient(authenticator);

    let devices: Device[] = [];

    try {
      devices = await client.devices.list();
    } catch (error) {
      let errorMessage = 'Problem with retrieving devices. ';
      if (error instanceof Error) {
        errorMessage = `${errorMessage} ${error.message}`;
      }
      this.log.error(errorMessage);
    }

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.deviceId);

      const deviceComponents: Component[] = device.components ?? [];

      const capabilities = deviceComponents[0]?.capabilities
        .map((capability: { id: string }) => capability.id) ?? [];

      const label = device.label ?? device.deviceId;

      this.log.debug('Discovered device:', label, capabilities);

      if (!this.doesDeviceSupportCapabilities(capabilities)) {
        this.log.warn('Device has unsupported capabilities:', label);
        continue;
      }

      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        new AirConditionerPlatformAccessory(this, existingAccessory, capabilities, client);
      } else {
        this.log.info('Adding new accessory:', label);

        const accessory = new this.api.platformAccessory(label, uuid);

        accessory.context.device = device;

        new AirConditionerPlatformAccessory(this, accessory, capabilities, client);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  doesDeviceSupportCapabilities(capabilities: string[]): boolean {
    const supportedCapabilities = AirConditionerPlatformAccessory.supportedCapabilities;

    return supportedCapabilities.every(capability => {
      this.log.debug('Checking if device supports capability:', capability);

      return capabilities.includes(capability);
    });
  }
}
