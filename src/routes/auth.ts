import { App } from "@tinyhttp/app";
import bcrypt from "bcryptjs";
import { JWT_SECRET } from "../config/auth.js";
import { prisma } from "../config/database.js";
import { authMiddleware } from "../middleware/auth.js";
import jwt from "jsonwebtoken";
import fs from "fs/promises";

export default function (app: App) {
	// Serve the new authentication modal
	app.get("/login", async (_req, res) => {
		const authHtml = await fs.readFile("./src/public/auth-modal.html", "utf8");
		res.setHeader("Content-Type", "text/html");
		return res.send(authHtml);
	});

	// Registration endpoint
	app.post("/register", async (req: any, res: any) => {
		try {
			const { username, password } = req.body;

			// Validation
			if (!username || !password) {
				return res.status(400)
					.json({ error: "Username and password are required" });
			}

			if (username.length < 3 || username.length > 20) {
				return res.status(400)
					.json({ error: "Username must be between 3 and 20 characters" });
			}

			if (password.length < 8) {
				return res.status(400)
					.json({ error: "Password must be at least 8 characters" });
			}

			// Check if username already exists
			const existingUser = await prisma.user.findFirst({
				where: { name: username }
			});

			if (existingUser) {
				return res.status(409)
					.json({ error: "Username already taken" });
			}

			// Hash password
			const passwordHash = await bcrypt.hash(password, 10);

			// Check if this is the first user (will be admin)
			const firstUser = (await prisma.user.count()) === 0;

			// Create user
			const user = await prisma.user.create({
				data: {
					name: username,
					passwordHash,
					country: "US", // TODO: Get from IP or user input
					role: firstUser ? "admin" : "user",
					droplets: 1000,
					currentCharges: 20,
					maxCharges: 20,
					pixelsPainted: 0,
					level: 1,
					extraColorsBitmap: 0,
					equippedFlag: 0,
					chargesLastUpdatedAt: new Date()
				}
			});

			// Create session
			const session = await prisma.session.create({
				data: {
					userId: user.id,
					expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
				}
			});

			// Generate JWT token
			const token = jwt.sign(
				{
					userId: user.id,
					sessionId: session.id,
					iss: "openplace",
					exp: Math.floor(session.expiresAt.getTime() / 1000),
					iat: Math.floor(Date.now() / 1000)
				},
				JWT_SECRET!
			);

			// Set cookie
			res.setHeader("Set-Cookie", [
				`j=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`
			]);

			return res.json({
				success: true,
				message: firstUser ? "Account created! You are now an admin." : "Account created successfully!"
			});
		} catch (error) {
			console.error("Registration error:", error);
			return res.status(500)
				.json({ error: "Internal server error" });
		}
	});

	// Login endpoint
	app.post("/login", async (req: any, res: any) => {
		try {
			const { username, password } = req.body;

			if (!username || !password) {
				return res.status(400)
					.json({ error: "Username and password required" });
			}

			// Find user by username or email
			const user = await prisma.user.findFirst({
				where: {
					OR: [
						{ name: username },
						{ email: username }
					]
				}
			});

			if (!user) {
				return res.status(401)
					.json({ error: "Invalid username or password" });
			}

			// Verify password
			const passwordValid = await bcrypt.compare(password, user.passwordHash ?? "");
			if (!passwordValid) {
				return res.status(401)
					.json({ error: "Invalid username or password" });
			}

			const session = await prisma.session.create({
				data: {
					userId: user.id,
					expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
				}
			});

			const token = jwt.sign(
				{
					userId: user.id,
					sessionId: session.id,
					iss: "openplace",
					exp: Math.floor(session.expiresAt.getTime() / 1000),
					iat: Math.floor(Date.now() / 1000)
				},
				JWT_SECRET!
			);

			res.setHeader("Set-Cookie", [
				`j=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`
			]);

			return res.json({ success: true });
		} catch (error) {
			console.error("Login error:", error);
			return res.status(500)
				.json({ error: "Internal Server Error" });
		}
	});

	app.post("/auth/logout", authMiddleware, async (req: any, res: any) => {
		try {
			if (req.user?.sessionId) {
				await prisma.session.delete({
					where: { id: req.user.sessionId }
				});
			}

			res.setHeader("Set-Cookie", [
				`j=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
			]);

			return res.json({ success: true });
		} catch (error) {
			console.error("Logout error:", error);
			return res.status(500)
				.json({ error: "Internal Server Error" });
		}
	});
}
