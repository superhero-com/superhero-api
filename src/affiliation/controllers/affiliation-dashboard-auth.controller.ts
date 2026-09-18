import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { RateLimitGuard } from '@/api-core/guards/rate-limit.guard';
import { readCookie } from '../guards/affiliation-analytics.guard';
import {
  AFFILIATION_DASHBOARD_COOKIE,
  AFFILIATION_DASHBOARD_LIMITS,
  AffiliationDashboardAuthService,
} from '../services/affiliation-dashboard-auth.service';

const DASHBOARD_HOME = '/api/bcl-affiliation/analytics/x-explorer/preview';

/**
 * Sign-in for the affiliation dashboards.
 *
 * Excluded from Swagger: these are browser forms, not an API, and listing them
 * only invites automated probing of the login.
 *
 * NOT behind `AffiliationAnalyticsGuard` — it would redirect these pages to
 * themselves. `RateLimitGuard` covers the POSTs instead, on top of the
 * per-account lockout in the service, so guessing is throttled both by who is
 * asking and by which account is being guessed at.
 */
@Controller('bcl-affiliation/auth')
@ApiExcludeController()
export class AffiliationDashboardAuthController {
  constructor(private readonly authService: AffiliationDashboardAuthService) {}

  @Get('setup')
  async setupPage(@Res() response: Response) {
    if (!(await this.authService.needsSetup())) {
      return response.redirect(302, '/api/bcl-affiliation/auth/login');
    }
    return response.render('affiliation-dashboard-setup', {
      title: 'Set up dashboard access',
      minPasswordLength: AFFILIATION_DASHBOARD_LIMITS.MIN_PASSWORD_LENGTH,
    });
  }

  @Post('setup')
  @UseGuards(RateLimitGuard)
  async setup(
    @Body() body: { username?: string; password?: string },
    @Res() response: Response,
  ) {
    const result = await this.authService.setup(
      String(body?.username ?? ''),
      String(body?.password ?? ''),
    );
    if (result.status !== 'ok') {
      if (result.status === 'already_configured') {
        return response.redirect(302, '/api/bcl-affiliation/auth/login');
      }
      const message = {
        invalid_username:
          'Username must be 3–64 characters, lowercase letters, digits, dot, dash or underscore.',
        weak_password: `Password must be at least ${AFFILIATION_DASHBOARD_LIMITS.MIN_PASSWORD_LENGTH} characters.`,
        // Distinct from the validation errors on purpose: nothing the operator
        // typed is wrong, so telling them to fix their input would be a lie.
        error: 'Could not create the operator. Check the server logs.',
      }[result.status];
      return response
        .status(result.status === 'error' ? 500 : 400)
        .render('affiliation-dashboard-setup', {
          title: 'Set up dashboard access',
          minPasswordLength: AFFILIATION_DASHBOARD_LIMITS.MIN_PASSWORD_LENGTH,
          error: message,
          username: String(body?.username ?? ''),
        });
    }
    this.setSessionCookie(response, result.token, result.expiresAt);
    return response.redirect(302, DASHBOARD_HOME);
  }

  @Get('login')
  async loginPage(@Res() response: Response) {
    if (await this.authService.needsSetup()) {
      return response.redirect(302, '/api/bcl-affiliation/auth/setup');
    }
    return response.render('affiliation-dashboard-login', {
      title: 'Dashboard sign in',
    });
  }

  @Post('login')
  @UseGuards(RateLimitGuard)
  async login(
    @Body() body: { username?: string; password?: string },
    @Res() response: Response,
  ) {
    const result = await this.authService.login(
      String(body?.username ?? ''),
      String(body?.password ?? ''),
    );
    if (result.status !== 'ok') {
      const minutes =
        result.status === 'locked' ? Math.ceil(result.retryAfterMs / 60000) : 0;
      return response.status(401).render('affiliation-dashboard-login', {
        title: 'Dashboard sign in',
        error:
          result.status === 'locked'
            ? `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
            : 'Wrong username or password.',
        username: String(body?.username ?? ''),
      });
    }
    this.setSessionCookie(response, result.token, result.expiresAt);
    return response.redirect(302, DASHBOARD_HOME);
  }

  @Post('logout')
  async logout(@Req() request: Request, @Res() response: Response) {
    await this.authService.logout(
      readCookie(request, AFFILIATION_DASHBOARD_COOKIE),
    );
    response.clearCookie(AFFILIATION_DASHBOARD_COOKIE, { path: '/api' });
    return response.redirect(302, '/api/bcl-affiliation/auth/login');
  }

  private setSessionCookie(
    response: Response,
    token: string,
    expiresAt: Date,
  ): void {
    response.cookie(AFFILIATION_DASHBOARD_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      // Only mark Secure when the request actually arrived over TLS; setting it
      // unconditionally would silently drop the cookie on a plain-HTTP
      // deployment and make the login look broken.
      secure:
        response.req?.secure ||
        response.req?.headers['x-forwarded-proto'] === 'https',
      expires: expiresAt,
      path: '/api',
    });
  }
}
