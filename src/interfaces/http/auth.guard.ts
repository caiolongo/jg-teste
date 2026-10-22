import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const IS_PUBLIC = 'isPublic';
/** Marks a route as open (health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Authentication extension point — intentionally a no-op (see ARCHITECTURE.md §13).
 *
 * Intended design: providers authenticate against an external IdP (Keycloak) with the OAuth2
 * client-credentials flow; this guard validates the JWT (issuer, audience, signature via JWKS) and
 * exposes the provider identity from the token. Use cases then check that `body.providerId`
 * matches the authenticated provider — the same domain validation applies to queue messages,
 * which are treated as a trusted internal channel.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    return true;
  }
}
