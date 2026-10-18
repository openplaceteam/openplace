import { App } from "@tinyhttp/app";
import bcrypt from "bcryptjs";
import { JWT_SECRET } from "../config/auth.js";
import { prisma } from "../config/database.js";
import { authMiddleware } from "../middleware/auth.js";
import jwt from "jsonwebtoken";
import { COOLDOWN_MS, UserService } from "../services/user.js";
import { AuthenticatedRequest, BanReason, UserRole } from "../types/index.js";
import { AuthService, AuthToken } from "../services/auth.js";
import { FingerprintService, isValidFingerprint } from "../services/fingerprint.js";
import { rateLimiter } from "../services/rate-limiter.js";
import { discordBot } from "../discord/bot.js";

const LOGIN_RATE_LIMIT_ATTEMPTS = Number.parseInt(process.env["LOGIN_RATE_LIMIT_ATTEMPTS"] ?? "") || 5;
const LOGIN_RATE_LIMIT_MS = Number.parseInt(process.env["LOGIN_RATE_LIMIT_MS"] ?? "") || 300_000;
const SIGNUP_RATE_LIMIT_ATTEMPTS = Number.parseInt(process.env["SIGNUP_RATE_LIMIT_ATTEMPTS"] ?? "") || 2;
const SIGNUP_RATE_LIMIT_MS = Number.parseInt(process.env["SIGNUP_RATE_LIMIT_MS"] ?? "") || 3_600_000;
const PASSWORD_RESET_RATE_LIMIT_ATTEMPTS = Number.parseInt(process.env["PASSWORD_RESET_RATE_LIMIT_ATTEMPTS"] ?? "") || 3;
const PASSWORD_RESET_RATE_LIMIT_MS = Number.parseInt(process.env["PASSWORD_RESET_RATE_LIMIT_MS"] ?? "") || 600_000;

const userService = new UserService(prisma);
const authService = new AuthService(prisma);
const fingerprintService = new FingerprintService(prisma, userService);

// TODO: Refactor into service
// eslint-disable-next-line max-lines-per-function
export default function (app: App) {
	app.post("/login", async (req, res) => {
		try {
			const { username, password, fingerprint } = req.body;

			if (!username || !password) {
				return res.status(400)
					.json({ error: "Username and password required" });
			}

			// Rate limiting
			const rateLimit = rateLimiter.checkRateLimit(req.ip!, LOGIN_RATE_LIMIT_ATTEMPTS, LOGIN_RATE_LIMIT_MS);
			if (!rateLimit.allowed) {
				const timestamp = new Date()
					.toISOString();
				console.log(`[${timestamp}] Rate limit exceeded for IP ${req.ip}`);
				return res.status(429)
					.json({ error: "Too many attempts. Please try again later." });
			}

			if (!UserService.isAcceptableUsername(username)) {
				return res.status(401)
					.json({ error: "Invalid username or password or username contains offensive words" });
			}

			const user = await prisma.user.findFirst({
				where: { name: username }
			});

			if (!user) {
				rateLimiter.recordAttempt(req.ip!, false);
				return res.status(401)
					.json({ error: "Invalid username or password" });
			}

			const passwordValid = await bcrypt.compare(password, user.passwordHash ?? "");
			if (!passwordValid) {
				rateLimiter.recordAttempt(req.ip!, false);
				return res.status(401)
					.json({ error: "Invalid username or password" });
			}

			if (user.role === "deleted") {
				return res.status(403)
					.json({ error: "Your account has been deleted. If you believe this is a mistake, please contact the admin for assistance." });
			}

			if (user.banned) {
				const reason = authService.messageForBanReason(user.suspensionReason as BanReason);
				return res.status(403)
					.json({ error: `You have been banned. Reason: ${reason}` });
			}

			if (isValidFingerprint(fingerprint)) {
				await fingerprintService.record(user.id, fingerprint);
				if (await fingerprintService.checkAndBan(user.id, fingerprint)) {
					return res.status(403)
						.json({ error: "You have been banned. Reason: Multi-accounting" });
				}
			}

			if (req.ip) {
				await userService.setLastIP(user.id, req.ip);
			}

			const session = await prisma.session.create({
				data: {
					userId: user.id,
					expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
				}
			});

			const authToken: AuthToken = {
				userId: user.id,
				sessionId: session.id,
				role: user.role as UserRole,
				iss: "openplace",
				exp: Math.floor(session.expiresAt.getTime() / 1000),
				iat: Math.floor(Date.now() / 1000)
			};
			const token = jwt.sign(authToken, JWT_SECRET!);

			res.setHeader("Set-Cookie", [
				`j=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`
			]);
			rateLimiter.recordAttempt(req.ip!, true);
			const date = new Date();
			console.log(`[${date.toISOString()}] [${req.ip}] ${user.name}#${user.id} logged in`);
			return res.json({ success: true });
		} catch (error) {
			console.error("Login error:", error);
			return res.status(500)
				.json({ error: "Internal Server Error" });
		}
	});

	app.post("/register", async (req, res) => {
		try {
			const { username, password, fingerprint } = req.body;

			if (!username || !password) {
				return res.status(400)
					.json({ error: "Username and password required" });
			}

			// Rate limiting
			const rateLimit = rateLimiter.checkRateLimit(req.ip!, SIGNUP_RATE_LIMIT_ATTEMPTS, SIGNUP_RATE_LIMIT_MS);
			if (!rateLimit.allowed) {
				const timestamp = new Date()
					.toISOString();
				console.log(`[${timestamp}] Rate limit exceeded for IP ${req.ip}`);
				return res.status(429)
					.json({ error: "Too many attempts. Please try again later." });
			}

			if (!UserService.isValidUsername(username)) {
				return res.status(400)
					.json({ error: "Username must be between 3 and 16 characters and cannot contain special characters." });
			}

			const existingUser = await prisma.user.findFirst({
				where: { name: username }
			});

			if (existingUser) {
				return res.status(400)
					.json({ error: "Username already exists" });
			}

			let country = req.get("cf-ipcountry") as string ?? null;
			if (!(/^[A-Z]{2}$/).test(country)) {
				country = "US";
			}

			const ban = await authService.getBan({ ip: req.ip!, country });
			if (ban) {
				console.log(`Banned IP ${req.ip} attempted to register as ${username}`);
				const reason = authService.messageForBanReason(ban.reason);
				return res.status(403)
					.json({ error: `You have been banned. Reason: ${reason}` });
			}

			const passwordHash = await bcrypt.hash(password, 10);
			const firstUser = (await prisma.user.count({
				where: {
					id: { gte: 0 }
				}
			})) === 0;

			const user = await prisma.user.create({
				data: {
					name: username,
					nickname: username,
					passwordHash,
					registrationIP: req.ip!,
					lastIP: req.ip!,
					country,
					role: firstUser ? "admin" : "user",
					droplets: 1000,
					currentCharges: 20,
					maxCharges: 20,
					chargesCooldownMs: COOLDOWN_MS,
					pixelsPainted: 0,
					level: 1,
					extraColorsBitmap: 0,
					equippedFlag: 0,
					chargesLastUpdatedAt: new Date()
				}
			});

			if (isValidFingerprint(fingerprint)) {
				await fingerprintService.record(user.id, fingerprint);
				if (await fingerprintService.checkAndBan(user.id, fingerprint)) {
					return res.status(403)
						.json({ error: "You have been banned. Reason: Multi-accounting" });
				}
			}

			const session = await prisma.session.create({
				data: {
					userId: user.id,
					expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
				}
			});

			const authToken: AuthToken = {
				userId: user.id,
				sessionId: session.id,
				role: user.role as UserRole,
				iss: "openplace",
				exp: Math.floor(session.expiresAt.getTime() / 1000),
				iat: Math.floor(Date.now() / 1000)
			};
			const token = jwt.sign(authToken, JWT_SECRET!);

			res.setHeader("Set-Cookie", [
				`j=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`
			]);
			rateLimiter.recordAttempt(req.ip!, true);
			const date = new Date();
			console.log(`[${date.toISOString()}] [${req.ip}] registered with ${user.name}#${user.id}!`);
			return res.json({ success: true });
		} catch (error) {
			console.error("Registration error:", error);
			return res.status(500)
				.json({ error: "Internal Server Error" });
		}
	});

	app.post("/auth/logout", authMiddleware, async (req: AuthenticatedRequest, res) => {
		try {
			if (req.user?.sessionId) {
				await prisma.session.delete({
					where: { id: req.user.sessionId }
				});
			}

			res.setHeader("Set-Cookie", [
				`j=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
			]);
			const name = await userService.getUserName(req.user!.id) ?? `user:${req.user!.id}`;
			const date = new Date();
			console.log(`[${date.toISOString()}] [${req.ip}] ${name}#${req.user!.id} logged out`);
			return res.json({ success: true });
		} catch (error) {
			console.error("Logout error:", error);
			return res.status(500)
				.json({ error: "Internal Server Error" });
		}
	});

	app.post("/auth/request-password-reset", async (req, res) => {
		try {
			const { username } = req.body;

			if (!username) {
				return res.status(400)
					.json({ error: "Username required" });
			}

			const rateLimit = rateLimiter.checkRateLimit(req.ip!, PASSWORD_RESET_RATE_LIMIT_ATTEMPTS, PASSWORD_RESET_RATE_LIMIT_MS);
			if (!rateLimit.allowed) {
				return res.status(429)
					.json({ error: "Too many password reset attempts. Please try again later." });
			}

			const user = await prisma.user.findFirst({
				where: { name: username },
				select: {
					id: true,
					name: true,
					discordUserId: true,
					banned: true,
					role: true
				}
			});

			if (!user) {
				rateLimiter.recordAttempt(req.ip!, true);
				return res.json({ success: true });
			}

			if (user.role === "deleted") {
				return res.status(403)
					.json({ error: "Your account has been deleted. If you believe this is a mistake, please contact the admin for assistance." });
			}

			if (user.banned) {
				return res.status(403)
					.json({ error: "You have been banned." });
			}

			if (!user.discordUserId) {
				return res.status(400)
					.json({ error: "Your account could not be recovered as it was not linked with a Discord account. Please contact an administrator for assistance." });
			}

			const recentToken = await prisma.passwordResetToken.findFirst({
				where: {
					userId: user.id,
					createdAt: {
						gte: new Date(Date.now() - 10 * 60 * 1000)
					}
				}
			});

			if (recentToken) {
				const waitTime = Math.ceil((recentToken.createdAt.getTime() + 10 * 60 * 1000 - Date.now()) / 1000);
				return res.status(429)
					.json({ error: "You already requested a password reset recently. Please wait before sending another one." });
			}

			await prisma.passwordResetToken.deleteMany({
				where: { userId: user.id }
			});

			const resetToken = await prisma.passwordResetToken.create({
				data: {
					userId: user.id,
					expiresAt: new Date(Date.now() + 60 * 60 * 1000)
				}
			});

			const params = new URLSearchParams([
				["token", resetToken.id]
			]);
			const resetUrl = `[Reset your password](${process.env["EXTERNAL_URL"]}/login/set-password?${params.toString()})`;
			const message = `### Password Reset Requested

A password reset was requested for your openplace account. If you requested this, click this link to reset your password:

${resetUrl}

*Wasn't you? You can safely ignore this message.*`;

			await discordBot.sendDM(user.discordUserId, message);

			rateLimiter.recordAttempt(req.ip!, true);
			console.log(`[${new Date()
				.toISOString()}] [${req.ip}] Password reset requested for ${user.name}#${user.id}`);

			return res.json({ success: true });
		} catch (error) {
			console.error("Password reset request error:", error);
			return res.status(500)
				.json({ error: "Internal Server Error" });
		}
	});

	app.post("/auth/reset-password", async (req, res) => {
		try {
			const { token, password } = req.body;

			if (!token || !password) {
				return res.status(400)
					.json({ error: "Token and password required" });
			}

			if (password.length < 8) {
				return res.status(400)
					.json({ error: "Password must be at least 8 characters long" });
			}

			const rateLimit = rateLimiter.checkRateLimit(req.ip!, PASSWORD_RESET_RATE_LIMIT_ATTEMPTS, PASSWORD_RESET_RATE_LIMIT_MS);
			if (!rateLimit.allowed) {
				return res.status(429)
					.json({ error: "Too many password reset attempts. Please try again later." });
			}

			const resetToken = await prisma.passwordResetToken.findUnique({
				where: { id: token }
			});

			if (!resetToken || resetToken.expiresAt < new Date()) {
				rateLimiter.recordAttempt(req.ip!, false);
				return res.status(400)
					.json({ error: "Invalid or expired reset token" });
			}

			const user = await prisma.user.findUnique({
				where: { id: resetToken.userId },
				select: {
					id: true,
					name: true,
					banned: true,
					role: true
				}
			});

			if (!user) {
				return res.status(400)
					.json({ error: "User not found" });
			}

			if (user.role === "deleted") {
				return res.status(403)
					.json({ error: "Your account has been deleted. If you believe this is a mistake, please contact the admin for assistance." });
			}

			if (user.banned) {
				return res.status(403)
					.json({ error: "You have been banned." });
			}

			const passwordHash = await bcrypt.hash(password, 10);

			await prisma.$transaction([
				prisma.user.update({
					where: { id: user.id },
					data: { passwordHash }
				}),
				prisma.passwordResetToken.delete({
					where: { id: token }
				}),
				prisma.session.deleteMany({
					where: { userId: user.id }
				})
			]);

			rateLimiter.recordAttempt(req.ip!, true);
			console.log(`[${new Date()
				.toISOString()}] [${req.ip}] Password reset completed for ${user.name}#${user.id}`);

			return res.json({ success: true });
		} catch (error) {
			console.error("Password reset error:", error);
			return res.status(500)
				.json({ error: "Internal Server Error" });
		}
	});
}
