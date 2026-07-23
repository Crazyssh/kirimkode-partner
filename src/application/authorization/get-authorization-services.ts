/**
 * Composition root for the session-authorization service.
 *
 * Reuses the already-composed session read path (task 7.2
 * {@link ResolveSessionService}) from the auth module so there is a single
 * place that turns a session token into a principal. Transport imports only
 * {@link SessionAuthorizationService} from here.
 */
import { getAuthServices } from "@application/auth";

import { SessionAuthorizationService } from "./session-authorization-service";

export interface AuthorizationServices {
  readonly sessionAuthorization: SessionAuthorizationService;
}

let singleton: AuthorizationServices | undefined;

export function getAuthorizationServices(): AuthorizationServices {
  if (singleton === undefined) {
    const { resolveSession } = getAuthServices();
    singleton = Object.freeze({
      sessionAuthorization: new SessionAuthorizationService({
        sessionResolver: resolveSession,
      }),
    });
  }
  return singleton;
}
