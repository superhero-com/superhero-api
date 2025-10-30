import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { fetchJson } from '@/utils/common';
import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } from '@/configs/social';

export interface OAuthUserInfo {
  id: string;
  name: string;
  email: string;
  provider: string;
}

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

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

      console.log('github token response:', tokenResponse);

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

      console.log('github user response:', response);

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
      };
    } catch (error) {
      this.logger.error('Google token verification failed:', error);
      throw new BadRequestException('Failed to verify Google token');
    }
  }

  private async verifyXToken(accessToken: string): Promise<OAuthUserInfo> {
    try {
      // X (Twitter) API v2 endpoint for user info
      const response = await fetchJson<any>(
        'https://api.twitter.com/2/users/me?user.fields=id,name,username,email',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!response || !response.data || !response.data.id) {
        throw new BadRequestException('Invalid X access token');
      }

      const userData = response.data;

      return {
        id: userData.id,
        name: userData.name || userData.username,
        email: userData.email || '', // X doesn't always provide email
        provider: 'x',
      };
    } catch (error) {
      this.logger.error('X token verification failed:', error);
      throw new BadRequestException('Failed to verify X token');
    }
  }
}
