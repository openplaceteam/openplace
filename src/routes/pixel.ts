import { App } from "@tinyhttp/app";
import { authMiddleware } from "../middleware/auth.js";
import { handleServiceError } from "../middleware/errorHandler.js";
import { PixelService } from "../services/pixel.js";
import { validateSeason, validateTileCoordinates } from "../validators/common.js";
import { validatePaintPixels, validatePixelInfo } from "../validators/pixel.js";
import { createErrorResponse, HTTP_STATUS } from "../utils/response.js";
import { prisma } from "../config/database.js";
import { UserService } from "../services/user.js";
import { AuthenticatedRequest } from "../types/index.js";
import { FingerprintService, isValidFingerprint } from "../services/fingerprint.js";
import { rateLimiter } from "../services/rate-limiter.js";

const PAINT_RATE_LIMIT_ATTEMPTS = Number.parseInt(process.env["PAINT_RATE_LIMIT_ATTEMPTS"] ?? "") || 60;
const PAINT_RATE_LIMIT_MS = Number.parseInt(process.env["PAINT_RATE_LIMIT_MS"] ?? "") || 10_000;

const pixelService = new PixelService(prisma);
const userService = new UserService(prisma);
const fingerprintService = new FingerprintService(prisma, userService);

export default function (app: App) {
	app.get("/:season/tile/random", async (req, res) => {
		try {
			// TODO: validation
			const season = req.params["season"] as string;
			if (!validateSeason(season)) {
				return res.status(HTTP_STATUS.BAD_REQUEST)
					.json(createErrorResponse("Bad Request", HTTP_STATUS.BAD_REQUEST));
			}

			const result = await pixelService.getRandomTile();
			return res.json(result);
		} catch (error) {
			console.error("Error getting random tile:", error);
			return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
				.json(createErrorResponse("Internal Server Error", HTTP_STATUS.INTERNAL_SERVER_ERROR));
		}
	});

	app.get("/:season/pixel/:tileX/:tileY", async (req, res) => {
		try {
			// TODO: validation
			const season = req.params["season"] as string;
			const tileX = Number.parseInt(req.params["tileX"] as string);
			const tileY = Number.parseInt(req.params["tileY"] as string);
			const x = Number.parseInt(req.query["x"] as string);
			const y = Number.parseInt(req.query["y"] as string);

			const validationError = validatePixelInfo({ season, tileX, tileY, x, y });
			if (validationError) {
				return res.status(HTTP_STATUS.BAD_REQUEST)
					.json(createErrorResponse(validationError, HTTP_STATUS.BAD_REQUEST));
			}

			const result = await pixelService.getPixelInfo({ season: 0, tileX, tileY, x, y });
			return res.json({
				region: result.region,
				paintedBy: result.paintedBy?.[0]
			});
		} catch (error) {
			console.error("Error getting pixel info:", error);
			return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
				.json(createErrorResponse("Internal Server Error", HTTP_STATUS.INTERNAL_SERVER_ERROR));
		}
	});

	app.get("/files/:season/tiles/:tileX/:tileY.png", async (req, res) => {
		try {
			const season = req.params["season"] as string;
			const tileX = Number.parseInt(req.params["tileX"] as string);
			const tileY = Number.parseInt(req.params["tileY"] as string);

			if (!validateSeason(season)) {
				return res.status(HTTP_STATUS.BAD_REQUEST)
					.json(createErrorResponse("Bad Request", HTTP_STATUS.BAD_REQUEST));
			}

			if (!validateTileCoordinates(tileX, tileY)) {
				return res.status(HTTP_STATUS.BAD_REQUEST)
					.json(createErrorResponse("Bad Request", HTTP_STATUS.BAD_REQUEST));
			}

			const { buffer, updatedAt } = await pixelService.getTileImage(tileX, tileY);

			if (updatedAt) {
				const lastModified = updatedAt.toUTCString();
				res.setHeader("Last-Modified", lastModified);

				const ifModifiedSince = req.get("if-modified-since") as string;
				if (ifModifiedSince) {
					const ifModifiedSinceDate = new Date(ifModifiedSince);
					if (Math.floor(updatedAt.getTime() / 1000) <= Math.floor(ifModifiedSinceDate.getTime() / 1000)) {
						return res.status(304)
							.send("");
					}
				}
			}

			res.setHeader("Content-Type", "image/png");
			res.setHeader("Cache-Control", "private, must-revalidate");
			res.setHeader("Pragma", "no-cache");
			res.setHeader("Expires", "0");
			return res.send(buffer);
		} catch (error) {
			console.error("Error generating tile image:", error);
			return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
				.json(createErrorResponse("Internal Server Error", HTTP_STATUS.INTERNAL_SERVER_ERROR));
		}
	});

	app.post("/:season/pixel/:tileX/:tileY", authMiddleware, async (req: AuthenticatedRequest, res) => {
		try {
			const rateLimit = rateLimiter.checkRateLimit(req.ip!, PAINT_RATE_LIMIT_ATTEMPTS, PAINT_RATE_LIMIT_MS);
			if (!rateLimit.allowed) {
				return res.status(429)
					.json({ error: "Too many requests. Please slow down." });
			}

			const season = req.params["season"] as string;
			const tileX = Number.parseInt(req.params["tileX"] as string);
			const tileY = Number.parseInt(req.params["tileY"] as string);
			const { colors, coords } = req.body;

			const validationError = validatePaintPixels({ season, tileX, tileY, colors, coords });
			if (validationError) {
				return res.status(HTTP_STATUS.BAD_REQUEST)
					.json(createErrorResponse(validationError, HTTP_STATUS.BAD_REQUEST));
			}

			const userRow = await userService.getUserProfile(req.user!.id)
				.catch(() => null);
			if (userRow) {
				if (userRow.banned) {
					const reason = userRow.suspensionReason ?? "other";
					const date = new Date();
					console.log(`[${date.toISOString()}] [${req.ip}] ${userRow.name}#${userRow.id} attempted to paint ${colors.length} pixels at tile (${tileX}, ${tileY}) while banned.`);
					return res.status(451)
						.json({ err: reason, suspension: "ban" });
				}

				if (new Date(userRow.timeoutUntil) > new Date()) {
					const reason = userRow.suspensionReason ?? "other";
					const date = new Date();
					console.log(`[${date.toISOString()}] [${req.ip}] ${userRow.name}#${userRow.id} attempted to paint ${colors.length} pixels at tile (${tileX}, ${tileY}) while timed out.`);
					return res.status(451)
						.json({ err: reason, suspension: "timeout" });
				}
			}

			const { fp } = req.body;
			if (isValidFingerprint(fp)) {
				await fingerprintService.record(req.user!.id, fp);
				if (await fingerprintService.checkAndBan(req.user!.id, fp)) {
					const date = new Date();
					console.log(`[${date.toISOString()}] [${req.ip}] user#${req.user!.id} was banned for multi-accounting while painting at tile (${tileX}, ${tileY})`);
					return res.status(451)
						.json({ err: "multi-accounting", suspension: "ban" });
				}
			}

			const account = {
				userId: req.user!.id,
				ip: req.ip!,
				country: req.get("cf-ipcountry") as string ?? null
			};
			const result = await pixelService.paintPixels(account, { tileX, tileY, colors, coords });
			const name = await userService.getUserName(req.user!.id) ?? `user:${req.user!.id}`;
			const date = new Date();
			console.log(`[${date.toISOString()}] [${req.ip}] ${name}#${req.user!.id} painted ${colors.length} pixels at tile (${tileX}, ${tileY})`);
			if (req.ip) {
				await userService.setLastIP(req.user!.id, req.ip);
			}

			return res.json(result);
		} catch (error) {
			return handleServiceError(error as Error, res);
		}
	});
}
