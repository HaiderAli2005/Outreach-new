export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Not authenticated") => new AppError(401, "UNAUTHENTICATED", message);
export const paymentRequired = (message = "Add credits to continue") => new AppError(402, "INSUFFICIENT_CREDITS", message);
export const coldEmailPaused = (message: string) => new AppError(402, "COLD_EMAIL_PAUSED", message);
export const insufficientCredits = (message: string, details?: unknown) => new AppError(402, "INSUFFICIENT_CREDITS", message, details);
/** The balance couldn't be read. Not the same as "no credits": the user should simply try again. */
export const creditsUnavailable = () => new AppError(503, "CREDITS_UNAVAILABLE", "We couldn't read your credit balance just now. Please try again in a minute.");
export const forbidden = (message = "You do not have permission to do that") => new AppError(403, "FORBIDDEN", message);
export const notFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (message: string) => new AppError(409, "CONFLICT", message);
export const unprocessable = (message: string, details?: unknown) => new AppError(422, "BUSINESS_RULE", message, details);
export const tooManyRequests = (message = "Too many requests, try again shortly") => new AppError(429, "RATE_LIMITED", message);
export const upstream = (service: string, message: string) => new AppError(502, "UPSTREAM_ERROR", `${service}: ${message}`);
export const notConfigured = (what: string) => new AppError(503, "NOT_CONFIGURED", `${what} is not configured`);
