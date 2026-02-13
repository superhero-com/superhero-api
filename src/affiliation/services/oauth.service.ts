import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { fetchJson } from '@/utils/common';
import {
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  X_CLIENT_ID,
  X_CLIENT_SECRET,
} from '@/configs/social';

export interface OAuthUserInfo {
  id: string;
  name: string;
  email: string;
  provider: string;
  username?: string;
}

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  /**
   * Exchange X OAuth2 authorization code (PKCE) for an access token.
   * Uses confidential client flow (Basic auth with client_id:client_secret).
   */
  async exchangeXCodeForAccessToken(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<string> {
    if (!X_CLIENT_ID) {
      throw new BadRequestException('X OAuth client id is not configured');
    }
    const body = new URLSearchParams({
      client_id: X_CLIENT_ID,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (X_CLIENT_SECRET) {
      const basicAuth = Buffer.from(
        `${X_CLIENT_ID}:${X_CLIENT_SECRET}`,
        'utf-8',
      ).toString('base64');
      headers.Authorization = `Basic ${basicAuth}`;
    }
    const response = await fetch('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      this.logger.warn('X token exchange failed', {
        status: response.status,
        www_authenticate: response.headers.get('www-authenticate'),
        error: data.error,
        error_description: data.error_description,
        detail: data.detail,
      });
      throw new BadRequestException(
        data.error_description ||
          data.detail ||
          'Failed to exchange X authorization code',
      );
    }
    return data.access_token;
  }

  async verifyAccessToken(
    provider: string,
    accessToken: string,
  ): Promise<OAuthUserInfo> {
    switch (provider.toLowerCase()) {
      case 'github':
        return this.verifyGitHubToken(accessToken);
      case 'google':
        return this.verifyGoogleToken(accessToken);
      case 'x':
        return this.verifyXToken(accessToken);
      default:
        throw new BadRequestException(`Unsupported provider: ${provider}`);
    }
  }

  private async verifyGitHubToken(
    authorizationCode: string,
  ): Promise<OAuthUserInfo> {
    try {
      // First, exchange the authorization code for an access token
      const tokenResponse = await fetchJson<any>(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            client_secret: GITHUB_CLIENT_SECRET,
            code: authorizationCode,
          }),
        },
      );

      if (!tokenResponse || !tokenResponse.access_token) {
        throw new BadRequestException('Invalid GitHub authorization code');
      }

      const accessToken = tokenResponse.access_token;

      // Now get user info with the access token
      const response = await fetchJson<any>('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'tokaen-api',
        },
      });

      if (!response || !response.id) {
        throw new BadRequestException('Failed to get GitHub user info');
      }

      // Get user's primary email
      const emailResponse = await fetchJson<any[]>(
        'https://api.github.com/user/emails',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'tokaen-api',
          },
        },
      );

      const primaryEmail =
        emailResponse?.find((email) => email.primary)?.email || response.email;

      return {
        id: response.id.toString(),
        name: response.name || response.login,
        email: primaryEmail,
        provider: 'github',
        username: response.login,
      };
    } catch (error) {
      this.logger.error('GitHub OAuth verification failed:', error);
      throw new BadRequestException('Failed to verify GitHub OAuth code');
    }
  }

  private async verifyGoogleToken(accessToken: string): Promise<OAuthUserInfo> {
    try {
      const response = await fetchJson<any>(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!response || !response.id) {
        throw new BadRequestException('Invalid Google access token');
      }

      return {
        id: response.id,
        name: response.name,
        email: response.email,
        provider: 'google',
        username: response.email?.split('@')[0],
      };
    } catch (error) {
      this.logger.error('Google token verification failed:', error);
      throw new BadRequestException('Failed to verify Google token');
    }
  }

  private async verifyXToken(accessToken: string): Promise<OAuthUserInfo> {
    try {
      // X API v2 – use api.x.com; requires OAuth scopes users.read and tweet.read
      const res = await fetch(
        'https://api.x.com/2/users/me?user.fields=id,name,username',
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      const response = await res.json().catch(() => ({}));

      if (!res.ok) {
        this.logger.warn('X users/me request failed', {
          status: res.status,
          www_authenticate: res.headers.get('www-authenticate'),
          body: response,
        });
        if (res.status === 403) {
          throw new BadRequestException(
            'X returned Forbidden. Verify: (1) the X App belongs to a Project with API v2 access, (2) authorize scopes include users.read and tweet.read, and (3) redirect_uri exactly matches both the authorize request and app callback settings.',
          );
        }
        throw new BadRequestException(
          (response as any).detail || 'Invalid or expired X access token',
        );
      }

      if (!response?.data?.id) {
        throw new BadRequestException('Invalid X access token');
      }

      const userData = response.data;

      return {
        id: userData.id,
        name: userData.name || userData.username || '',
        email: '', // X often does not provide email; request offline.access + scope if needed
        provider: 'x',
        username: userData.username,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error('X token verification failed:', error);
      throw new BadRequestException('Failed to verify X token');
    }
  }
}
