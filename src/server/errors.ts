export class AppError extends Error {
  constructor(
    message: string,
    public code: string = "app_error",
    public status = 400,
  ) {
    super(message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do that") {
    super(message, "forbidden", 403);
  }
}
export class ComplianceBlockedError extends AppError {
  constructor(public reasons: string[]) {
    super(`Blocked by compliance: ${reasons.join("; ")}`, "compliance_blocked", 422);
  }
}
export class OutreachHaltedError extends AppError {
  constructor(message = "Outreach is halted by emergency stop") {
    super(message, "outreach_halted", 423);
  }
}
