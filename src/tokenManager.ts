import { Logger, PlatformConfig } from 'homebridge';
import { promises as fs } from 'fs';
import path from 'path';

const TOKEN_URL = 'https://api.smartthings.com/oauth/token';

// Renew the access token this many milliseconds before it actually expires,
// so an in-flight request never races the expiry.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

// Fallback lifetime used only when the token endpoint omits `expires_in`.
const DEFAULT_EXPIRES_IN_S = 24 * 60 * 60;

interface PersistedTokens {
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
}

/**
 * Handles SmartThings authentication in one of two mutually exclusive modes:
 *
 *  - PAT: a static Personal Access Token supplied in the config. Returned as-is.
 *    Note that PATs created after 2024-12-30 expire 24h after creation and cannot
 *    be renewed programmatically.
 *
 *  - OAuth: ClientID + ClientSecret + RefreshToken. The access token is fetched
 *    from the refresh token and renewed automatically before it expires. Refresh
 *    tokens rotate on every use, so the newest one is persisted to disk and takes
 *    priority over the (now stale) value in the config on subsequent runs.
 */
export class TokenManager {
  public readonly mode: 'pat' | 'oauth' | 'none';

  private readonly pat?: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly persistPath: string;

  private refreshToken?: string;
  private accessToken?: string;
  private expiresAt = 0;

  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly log: Logger,
    config: PlatformConfig,
    storagePath: string,
  ) {
    this.pat = typeof config.AccessToken === 'string' && config.AccessToken.trim() !== ''
      ? config.AccessToken.trim()
      : undefined;
    this.clientId = typeof config.ClientID === 'string' && config.ClientID.trim() !== ''
      ? config.ClientID.trim()
      : undefined;
    this.clientSecret = typeof config.ClientSecret === 'string' && config.ClientSecret.trim() !== ''
      ? config.ClientSecret.trim()
      : undefined;
    this.refreshToken = typeof config.RefreshToken === 'string' && config.RefreshToken.trim() !== ''
      ? config.RefreshToken.trim()
      : undefined;

    this.persistPath = path.join(storagePath, '.samsung-windfree-oauth.json');

    if (this.clientId && this.clientSecret && this.refreshToken) {
      this.mode = 'oauth';
    } else if (this.pat) {
      this.mode = 'pat';
    } else {
      this.mode = 'none';
    }
  }

  /**
   * Returns a valid bearer token, refreshing it automatically in OAuth mode.
   * Throws in 'none' mode or when a refresh fails.
   */
  async getAccessToken(): Promise<string> {
    if (this.mode === 'pat') {
      return this.pat!;
    }

    if (this.mode === 'none') {
      throw new Error(
        'No SmartThings credentials configured. Provide either AccessToken (PAT) or ClientID + ClientSecret + RefreshToken (OAuth).',
      );
    }

    await this.loadPersisted();

    if (this.accessToken && Date.now() < this.expiresAt - EXPIRY_MARGIN_MS) {
      return this.accessToken;
    }

    return this.refresh();
  }

  /**
   * Forces a refresh regardless of the cached expiry. Call this after a 401 to
   * recover from a token that was revoked/rotated out-of-band.
   */
  async forceRefresh(): Promise<string> {
    if (this.mode !== 'oauth') {
      return this.getAccessToken();
    }
    await this.loadPersisted();
    this.expiresAt = 0;
    return this.refresh();
  }

  private async refresh(): Promise<string> {
    // Coalesce concurrent refreshes into a single request.
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async doRefresh(): Promise<string> {
    if (!this.refreshToken) {
      throw new Error('OAuth refresh token is missing. Re-run the OAuth setup helper.');
    }

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId!,
      refresh_token: this.refreshToken,
    });

    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: body.toString(),
      });
    } catch (error) {
      throw new Error(`Network error while refreshing SmartThings token: ${(error as Error).message}`);
    }

    const text = await response.text();

    if (!response.ok) {
      if (text.includes('invalid_grant')) {
        this.log.error(
          'SmartThings refused the refresh token (invalid_grant). It was revoked or expired — '
          + 're-run the OAuth setup helper to obtain a new RefreshToken.',
        );
      } else {
        this.log.error(`Failed to refresh SmartThings token (HTTP ${response.status} ${response.statusText}): ${text}`);
      }
      throw new Error(`Token refresh failed with HTTP ${response.status}`);
    }

    let data: { access_token?: string; refresh_token?: string; expires_in?: number };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Token refresh returned a non-JSON response');
    }

    if (!data.access_token) {
      throw new Error('Token refresh response did not contain an access_token');
    }

    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in ?? DEFAULT_EXPIRES_IN_S) * 1000;

    // We now hold the newest credentials, so nothing on disk can improve on
    // them. Mark the load as done to stop a retried read (see loadPersisted)
    // from overwriting them with an older snapshot.
    this.loaded = true;

    // Refresh tokens rotate: persist the new one so it survives restarts.
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.refreshToken = data.refresh_token;
    }

    await this.persist();

    this.log.debug('SmartThings access token refreshed; valid until', new Date(this.expiresAt).toISOString());

    return this.accessToken;
  }

  /**
   * Loads the persisted tokens once. The on-disk refresh token is the only copy
   * of the current (rotated) credential, so a failed read must not be treated as
   * "there is nothing stored" — that would silently fall back to the config
   * value, which SmartThings already invalidated on the first rotation.
   *
   * Transient I/O errors therefore leave the manager unloaded so the next call
   * retries. Only a successful read, a missing file, or unparseable content
   * (which no amount of retrying will fix) mark the load as done.
   */
  private async loadPersisted(): Promise<void> {
    if (this.loaded) {
      return;
    }
    // Coalesce concurrent loads into a single read.
    if (!this.loadPromise) {
      this.loadPromise = this.doLoadPersisted().finally(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  private async doLoadPersisted(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.persistPath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Nothing persisted yet: the config value is the right starting point.
        this.loaded = true;
        return;
      }
      // Could be transient (EACCES during a permissions fix, EIO, ...). Keep the
      // manager unloaded so a later call can still recover the stored token.
      this.log.error(
        `Could not read persisted OAuth tokens from ${this.persistPath}: ${(error as Error).message}. `
        + 'Falling back to the RefreshToken from config for now; this will fail with invalid_grant if the '
        + 'token has already rotated. Fix the file permissions and the stored token will be picked up again.',
      );
      return;
    }

    let persisted: PersistedTokens;
    try {
      persisted = JSON.parse(raw) as PersistedTokens;
    } catch (error) {
      // Unparseable content will not repair itself, so stop retrying — but be
      // loud, because the stored refresh token is unrecoverable from here.
      this.loaded = true;
      this.log.error(
        `Persisted OAuth token file ${this.persistPath} is corrupt (${(error as Error).message}). `
        + 'Falling back to the RefreshToken from config; if that fails with invalid_grant, delete the file '
        + 'and re-run the OAuth setup helper.',
      );
      return;
    }

    this.loaded = true;

    // A persisted (rotated) refresh token always beats the stale config value.
    if (persisted.refreshToken) {
      this.refreshToken = persisted.refreshToken;
    }
    if (persisted.accessToken && persisted.expiresAt) {
      this.accessToken = persisted.accessToken;
      this.expiresAt = persisted.expiresAt;
    }
  }

  /**
   * Writes the tokens to disk atomically (temp file + fsync + rename) so a crash
   * or a full disk can never leave a half-written file behind. This file holds
   * the only valid refresh token after the first rotation, so a failure here is
   * an error, not a warning: the plugin keeps working until the next restart and
   * then cannot authenticate at all.
   */
  private async persist(): Promise<void> {
    const data: PersistedTokens = {
      refreshToken: this.refreshToken,
      accessToken: this.accessToken,
      expiresAt: this.expiresAt,
    };

    const tmpPath = `${this.persistPath}.${process.pid}.tmp`;

    try {
      const handle = await fs.open(tmpPath, 'w', 0o600);
      try {
        await handle.writeFile(JSON.stringify(data), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmpPath, this.persistPath);
    } catch (error) {
      this.log.error(
        `Could not persist OAuth tokens to ${this.persistPath}: ${(error as Error).message}. `
        + 'The rotated refresh token exists only in memory — if Homebridge restarts before this succeeds, '
        + 'you will have to re-run the OAuth setup helper to obtain a new RefreshToken.',
      );
      await fs.rm(tmpPath, { force: true }).catch(() => { /* best effort */ });
    }
  }
}
