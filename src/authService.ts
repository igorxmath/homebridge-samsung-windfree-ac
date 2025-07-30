import { Logger, PlatformConfig } from 'homebridge';
import {
  AuthData,
  Authenticator,
  BearerTokenAuthenticator,
  RefreshData,
  RefreshTokenAuthenticator,
  RefreshTokenStore,
} from '@smartthings/core-sdk';
import * as fs from 'node:fs';
import path from 'node:path';

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  baseURL: string;
  AccessToken: string;
  authMethod: 'oauth2' | 'pat';
}

export class AuthService implements RefreshTokenStore {
  private authData: AuthData | undefined;
  private configPath = process.env.UIX_CONFIG_PATH || path.join('./', 'config.json');

  constructor(
    public readonly config: PlatformConfig,
    private readonly log: Logger,
  ) {}

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getAuthenticator(): Promise<Authenticator> {
    if (this.config.authMethod === 'oauth2') {
      return await this.getOAuthAccessToken();
    } else {
      // Fallback to Personal Access Token
      return await this.getPersonalAccessToken();
    }
  }

  async getOAuthAccessToken(): Promise<Authenticator> {
    try {
      return new RefreshTokenAuthenticator(this.config.refreshToken as string, this);
    } catch (error) {
      this.log.error('Failed to create OAuth authenticator:', error);
      this.log.error('Please check your clientId, clientSecret, and refreshToken configuration.');
      this.log.error('You may need to generate a new refresh token.');
      throw error;
    }
  }

  async getPersonalAccessToken(): Promise<Authenticator> {
    return new BearerTokenAuthenticator(this.config.AccessToken as string);
  }

  async getRefreshData(): Promise<RefreshData> {
    const refreshData = {
      refreshToken: this.authData?.refreshToken ?? this.config.refreshToken,
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    };

    this.log.debug('Refresh data:', {
      clientId: refreshData.clientId,
      hasRefreshToken: !!refreshData.refreshToken,
      hasClientSecret: !!refreshData.clientSecret,
    });

    return refreshData;
  }

  async putAuthData(data: AuthData): Promise<void> {
    this.authData = data;

    const config = this.getPlatformConfig();
    config.refreshToken = data.refreshToken;
    this.savePlatformConfig(config);
  }

  getPlatformConfig() {
    try {
      const readConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return readConfig.platforms.find((p: { platform: string; }) => p.platform === this.config.platform);
    } catch (error) {
      this.log.error('Error when reading configuration:', error);
      return null;
    }
  }

  savePlatformConfig(platformConfig: unknown) {
    try {
      const newConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      const platform = newConfig.platforms.find((p: { platform: string; }) => p.platform === this.config.platform);
      newConfig.platforms[newConfig.platforms.indexOf(platform)] = platformConfig;
      fs.writeFileSync(this.configPath, JSON.stringify(newConfig, null, 4), 'utf8');
    } catch (error) {
      this.log.error('Error when writing configuration:', error);
    }
  }

}
