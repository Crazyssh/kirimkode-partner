/**
 * Signals that registration hit the unique-email constraint. Thrown by the
 * identity gateway (which detects the persistence-level unique violation) and
 * translated by the register service into a conflict outcome. Kept separate
 * from the generic login failure so registration can report a usable message
 * while login stays deliberately opaque.
 */
export class EmailAlreadyRegisteredError extends Error {
  readonly kind = "email_already_registered" as const;

  constructor(message = "Email is already registered.") {
    super(message);
    this.name = "EmailAlreadyRegisteredError";
  }
}
