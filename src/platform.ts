import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import axios from 'axios';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { AirConditionerPlatformAccessory } from './platformAccessory';

export class HomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  private axInstace = axios.create(
    {
      baseURL: this.config.BaseURL,
      headers: { 'Authorization': 'Bearer ' + this.config.AccessToken },
    },
  );

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,

  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

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
    const { status, data } = await this.axInstace.get('/devices');

    if (status !== 200) {
      this.log.error('Failed to get devices from API');
      return;
    }

    for (const device of data.items) {
      const uuid = this.api.hap.uuid.generate(device.deviceId);

      const capabilities = device.components[0].capabilities
        .map((capability: { id: string }) => capability.id);

      this.log.debug('Discovered device:', device.label, capabilities);

      if (!this.doesDeviceSupportCapabilities(capabilities)) {
        this.log.warn('Device has unsupported capabilities:', device.label);
        continue;
      }

      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        new AirConditionerPlatformAccessory(this, existingAccessory, capabilities);
      } else {
        this.log.info('Adding new accessory:', device.label);

        const accessory = new this.api.platformAccessory(device.label, uuid);

        accessory.context.device = device;

        new AirConditionerPlatformAccessory(this, accessory, capabilities);

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
