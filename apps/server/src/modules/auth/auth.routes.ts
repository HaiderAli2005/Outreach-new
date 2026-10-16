import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { limiter } from "../../middleware/rateLimit.js";
import * as c from "./auth.controller.js";

export const authRouter = Router();

const authLimiter = limiter("auth", 15 * 60_000, 60);

authRouter.get("/providers", c.providers);
authRouter.post("/register", authLimiter, c.register);
authRouter.post("/login", authLimiter, c.login);
authRouter.post("/refresh", limiter("refresh", 60_000, 30), c.refresh);
authRouter.post("/logout", c.logout);
authRouter.get("/me", requireAuth, c.me);
authRouter.post("/accept-invite", requireAuth, c.acceptInvite);
authRouter.post("/challenge/status", limiter("challenge-status", 15 * 60_000, 600), c.challengeStatus);
authRouter.post("/challenge/code", authLimiter, c.challengeCode);
authRouter.post("/challenge/send-code", limiter("challenge-send", 15 * 60_000, 10), c.challengeSendCode);
authRouter.post("/verify-email", authLimiter, c.verifyEmail);
authRouter.post("/verify-email/resend", limiter("verify-resend", 15 * 60_000, 10), c.resendVerification);
authRouter.post("/claim", limiter("claim", 60_000, 60), c.claim);
authRouter.post("/password/forgot", limiter("forgot", 15 * 60_000, 10), c.forgotPassword);
authRouter.post("/password/check", authLimiter, c.checkResetLink);
authRouter.post("/password/reset", authLimiter, c.resetPassword);
authRouter.get("/oauth/google/start", c.googleStart);
authRouter.get("/oauth/google/callback", c.googleCallback);
