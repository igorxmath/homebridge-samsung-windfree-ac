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

  /** Device IDs and labels to skip, normalized for case-insensitive matching. */
  private readonly ignoredDevices: string[];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,

  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    this.ignoredDevices = this.parseIgnoredDevices(this.config.IgnoredDevices);

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

      if (this.isDeviceIgnored(device)) {
        this.log.info('Ignoring device (listed in IgnoredDevices):', device.label);

        this.removeCachedAccessory(uuid);
        continue;
      }

      const capabilities = device.components[0].capabilities
        .map((capability: { id: string }) => capability.id);

      // The device ID is logged alongside the name so it can be copied into
      // IgnoredDevices, which is the identifier that survives a rename.
      this.log.debug('Discovered device:', device.label, device.deviceId, capabilities);

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

  /**
   * Reads the `IgnoredDevices` config entry, dropping anything that isn't a
   * usable string so one bad entry can't take discovery down with it.
   */
  private parseIgnoredDevices(configured: unknown): string[] {
    if (configured === undefined || configured === null) {
      return [];
    }

    if (!Array.isArray(configured)) {
      this.log.warn('IgnoredDevices must be a list of device IDs or names; ignoring it.');
      return [];
    }

    const ignored = configured
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim().toLowerCase())
      .filter(entry => entry !== '');

    if (ignored.length !== configured.length) {
      this.log.warn('IgnoredDevices contains entries that are not text; those were skipped.');
    }

    if (ignored.length > 0) {
      this.log.debug('Ignoring devices matching:', ignored);
    }

    return ignored;
  }

  /** Matches a device against `IgnoredDevices` by device ID or by name. */
  private isDeviceIgnored(device: { deviceId?: string; label?: string; name?: string }): boolean {
    if (this.ignoredDevices.length === 0) {
      return false;
    }

    return [device.deviceId, device.label, device.name]
      .filter((value): value is string => typeof value === 'string')
      .some(value => this.ignoredDevices.includes(value.trim().toLowerCase()));
  }

  /**
   * Drops an accessory HomeKit already knows about. Without this, a device
   * added to `IgnoredDevices` would keep its (now unmanaged) tile in the Home
   * app until the user removed it by hand.
   */
  private removeCachedAccessory(uuid: string): void {
    const index = this.accessories.findIndex(accessory => accessory.UUID === uuid);

    if (index === -1) {
      return;
    }

    const [accessory] = this.accessories.splice(index, 1);

    this.log.info('Removing accessory from HomeKit:', accessory.displayName);

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  doesDeviceSupportCapabilities(capabilities: string[]): boolean {
    const supportedCapabilities = AirConditionerPlatformAccessory.supportedCapabilities;

    return supportedCapabilities.every(capability => {
      this.log.debug('Checking if device supports capability:', capability);

      return capabilities.includes(capability);
    });
  }
}
