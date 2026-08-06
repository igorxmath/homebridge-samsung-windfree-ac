import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { AirConditionerPlatformAccessory } from './platformAccessory';
import { TokenManager } from './tokenManager';

export class HomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  public readonly tokenManager: TokenManager;

  // A single 'shutdown' listener fans out to every accessory. Registering one
  // listener per accessory trips Node's default max-listeners warning at 11
  // devices, which looks like a leak in the Homebridge log.
  private readonly shutdownHandlers: (() => void)[] = [];
  private shutdownListenerRegistered = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,

  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    this.tokenManager = new TokenManager(this.log, this.config, this.api.user.storagePath());

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  /**
   * Returns a valid SmartThings bearer token, transparently refreshing it in
   * OAuth mode. Shared by discovery and every accessory.
   */
  getAccessToken(): Promise<string> {
    return this.tokenManager.getAccessToken();
  }

  /**
   * Registers a teardown callback to run when Homebridge shuts down. All
   * callbacks share one underlying 'shutdown' listener.
   */
  onShutdown(handler: () => void): void {
    this.shutdownHandlers.push(handler);

    if (this.shutdownListenerRegistered) {
      return;
    }
    this.shutdownListenerRegistered = true;

    this.api.on('shutdown', () => {
      for (const shutdownHandler of this.shutdownHandlers) {
        try {
          shutdownHandler();
        } catch (error) {
          this.log.debug('Shutdown handler failed:', (error as Error).message);
        }
      }
      this.shutdownHandlers.length = 0;
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    this.accessories.push(accessory);
  }

  async discoverDevices() {
    const baseURL = this.config.BaseURL;

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

    if (this.tokenManager.mode === 'none') {
      this.log.error(
        'No SmartThings credentials configured. Provide either AccessToken (PAT) or '
        + 'ClientID + ClientSecret + RefreshToken (OAuth). Plugin will not attempt device discovery.',
      );
      return;
    }

    let accessToken: string;
    try {
      accessToken = await this.getAccessToken();
    } catch (error) {
      this.log.error('Could not obtain a SmartThings access token:', (error as Error).message);
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
      if (response.status === 401) {
        this.log.error(
          'HTTP 401 Unauthorized: the SmartThings token is invalid or expired. '
          + 'If using a PAT created after 2024-12-30, note it expires 24h after creation — '
          + 'switch to OAuth to renew automatically.',
        );
      }
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
