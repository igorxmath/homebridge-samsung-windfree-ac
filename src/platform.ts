import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { AirConditionerPlatformAccessory } from './platformAccessory';

export class HomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

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
    const baseURL = this.config.BaseURL;
    const accessToken = this.config.AccessToken;

    if (!baseURL || typeof baseURL !== 'string' || baseURL.trim() === '') {
      this.log.error('BaseURL is missing or empty in config. Plugin will not attempt device discovery.');
      return;
    }

    let url: URL;
    try {
      url = new URL(baseURL);
    } catch {
      this.log.error('BaseURL in config is not a valid URL:', baseURL);
      return;
    }

    if (!accessToken || typeof accessToken !== 'string' || accessToken.trim() === '') {
      this.log.error('AccessToken is missing or empty in config. Plugin will not attempt device discovery.');
      return;
    }

    let response: any;
    try {
      response = await fetch(`${url.toString()}/devices`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });
    } catch {
      this.log.error('Failed to fetch devices from API');
      return;
    }

    if (!response.ok) {
      this.log.error('Failed to get devices from API. Status:', response.status, response.statusText);
      return;
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      this.log.error('Failed to parse devices response as JSON');
      return;
    }

    if (!data.items || !Array.isArray(data.items)) {
      this.log.error('API response does not contain a valid items array.');
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
