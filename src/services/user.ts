import { PrismaClient } from "@prisma/client";
import { calculateChargeRecharge } from "../utils/charges.js";
import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from "obscenity";
import { BanReason } from "../types/index.js";
import { AuthService } from "./auth.js";
import { ValidationError } from "../utils/error.js";

export const COOLDOWN_MS = Number.parseInt(process.env["COOLDOWN_MS"] ?? "") || 30_000;
export const ACTIVE_COOLDOWN_MS = Number.parseInt(process.env["ACTIVE_COOLDOWN_MS"] ?? "") || 15_000;
export const BOOSTER_COOLDOWN_MS = Number.parseInt(process.env["BOOSTER_COOLDOWN_MS"] ?? "") || 10_000;
export const SPECIAL_COOLDOWN_MS = Number.parseInt(process.env["SPECIAL_COOLDOWN_MS"] ?? "") || 5000;
export const COOLDOWN_OVERRIDE_FOR_SPECIAL = (process.env["COOLDOWN_OVERRIDE_FOR_SPECIAL"] ?? "false") === "true";

export const MAX_FAVORITE_LOCATIONS = 50;

export interface UpdateUserInput {
	nickname?: string;
	showLastPixel?: boolean;
	discord?: string;
}

const config = {
	maxFavoriteLocations: MAX_FAVORITE_LOCATIONS,
	experiments: {
		"2025-09_pawtect": {
			variant: "disabled"
		},
		"2025-09_discord_linking": {
			enabled: false
		}
	}
};

const usernameRegex = /^[\w-]{3,16}$/i;

const usernameMatcher = new RegExpMatcher({
	...englishDataset.build(),
	...englishRecommendedTransformers
});

export class UserService {
	private readonly authService: AuthService;

	constructor(private prisma: PrismaClient) {
		this.authService = new AuthService(prisma, this);
	}

	static isValidUsername(username: string): boolean {
		return usernameRegex.test(username);
	}

	static isAcceptableUsername(username: string): boolean {
		return !usernameMatcher.hasMatch(username);
	}

	async getUserProfile(userId: number) {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			include: {
				alliance: true,
				favoriteLocations: true
			}
		});

		if (!user) {
			throw new Error("User not found");
		}

		const updatedCharges = calculateChargeRecharge(
			user.currentCharges,
			user.maxCharges,
			user.chargesLastUpdatedAt,
			user.chargesCooldownMs
		);

		if (updatedCharges !== user.currentCharges) {
			await this.prisma.user.update({
				where: { id: userId },
				data: {
					currentCharges: updatedCharges,
					chargesLastUpdatedAt: new Date()
				}
			});
			user.currentCharges = updatedCharges;
		}

		const flagsBitmap = Buffer.from(user.flagsBitmap ?? [0])
			.toString("base64");

		let cooldownBoost: string | null = null;
		switch (user.chargesCooldownMs) {
		case ACTIVE_COOLDOWN_MS:
			cooldownBoost = "active";
			break;
		case BOOSTER_COOLDOWN_MS:
			cooldownBoost = "booster";
			break;
		case SPECIAL_COOLDOWN_MS:
			cooldownBoost = "special";
			break;
		}

		return {
			...config,
			id: user.id,
			name: user.nickname || user.name,
			discord: user.discord ?? "",
			discordUserId: user.discordUserId,
			country: user.country,
			banned: user.banned,
			verified: user.verified,
			suspensionReason: user.suspensionReason,
			timeoutUntil: user.timeoutUntil.toISOString(),
			charges: {
				cooldownMs: user.chargesCooldownMs,
				count: user.currentCharges,
				max: user.maxCharges,
				boost: cooldownBoost
			},
			droplets: user.droplets,
			equippedFlag: user.equippedFlag,
			extraColorsBitmap: user.extraColorsBitmap,
			favoriteLocations: user.favoriteLocations.map(loc => ({
				id: loc.id,
				name: loc.name,
				latitude: loc.latitude,
				longitude: loc.longitude
			})),
			flagsBitmap,
			role: user.role,
			isCustomer: user.isCustomer,
			level: user.level,
			needsPhoneVerification: user.needsPhoneVerification,
			picture: user.picture ?? "",
			pixelsPainted: user.pixelsPainted,
			showLastPixel: user.showLastPixel,
			allianceId: user.allianceId,
			allianceRole: user.allianceRole
		};
	}

	private sanitizeInput(str: string): string {
		return str.replaceAll(/["&'<>]/g, (char) => {
			const escapeMap: Record<string, string> = {
				"<": "&lt;",
				">": "&gt;",
				"'": "&#39;",
				"\"": "&quot;",
				"&": "&amp;"
			};
			return escapeMap[char] || char;
		})
			.trim();
	}

	async updateUser(userId: number, input: UpdateUserInput) {
		const { nickname, showLastPixel, discord } = input;

		if (nickname && nickname.length > 16) {
			throw new Error("The nickname has more than 16 characters");
		}

		const updateData: {
			nickname?: string;
			showLastPixel?: boolean;
			discord?: string | null;
		} = {};

		if (nickname !== undefined) {
			const sanitized = this.sanitizeInput(nickname);
			if (sanitized.length === 0) {
				throw new Error("The nickname cannot be empty");
			}
			updateData.nickname = sanitized;
		}
		if (showLastPixel !== undefined) {
			updateData.showLastPixel = showLastPixel;
		}
		if (discord !== undefined) {
			// Check if Discord account is linked - prevent editing if linked
			const user = await this.prisma.user.findUnique({
				where: { id: userId },
				select: {
					discord: true,
					discordUserId: true
				}
			});

			if (user?.discordUserId && discord !== user?.discord) {
				throw new Error("Can’t change Discord username while account is linked.");
			}

			const sanitized = this.sanitizeInput(discord);
			updateData.discord = sanitized.length > 0 ? sanitized : null;
		}

		await this.prisma.user.update({
			where: { id: userId },
			data: updateData
		});

		return { success: true };
	}


	async deleteAccount(userId: number) {
		const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
		if (!user) {
			throw new Error("User not found");
		}
		await this.prisma.$transaction([
			// this.prisma.pixel.deleteMany({ where: { user: { id: userId } } }), // kinda sus
			this.prisma.userFingerprint.deleteMany({ where: { userId } }),
			// this.prisma.userRegionStats.deleteMany({ where: { userId } }),
			// this.prisma.userRegionStatsDaily.deleteMany({ where: { userId } }),
			this.prisma.profilePicture.deleteMany({ where: { userId } }),
			this.prisma.session.deleteMany({ where: { userId } }),
			this.prisma.user.update({
				where: { id: userId },
				data: {
					nickname: "Deleted Account",
					discord: null,
					discordUserId: null,
					role: "deleted"
				}
			})
		]);
		return { success: true };
	}

	async getUserName(userId: number) {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: { name: true, nickname: true }
		});

		return (user?.nickname || user?.name) ?? null;
	}

	async getNickname(userId: number) {
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: { nickname: true }
		});

		return user?.nickname ?? null;
	}

	async setLastIP(userId: number, ip: string) {
		let retries = 3;
		while (retries > 0) {
			try {
				await this.prisma.$transaction(async (tx) => {
					await tx.$queryRaw`SELECT id FROM User WHERE id = ${userId} LIMIT 1 FOR UPDATE`;
					await tx.user.update({ where: { id: userId }, data: { lastIP: ip } });
				}, {
					timeout: 5000,
					isolationLevel: "ReadCommitted"
				});
				break;
			} catch (error: unknown) {
				const error2 = error as { message?: string; code?: string; };
				retries--;
				const isRetryableError = (
					error2.message?.includes("deadlock") ||
					error2.message?.includes("timeout") ||
					error2.code === "P2034" ||
					error2.code === "P2024"
				);

				if (isRetryableError && retries > 0) {
					const delay = 100 * Math.pow(2, 3 - retries) + Math.random() * 50;
					await new Promise(resolve => setTimeout(resolve, delay));
					continue;
				}
				throw error;
			}
		}
	}

	async ban(userId: number, state: boolean, reason: BanReason | null, isRecursive = false) {
		await this.prisma.user.update({
			where: { id: userId },
			data: {
				banned: state,
				suspensionReason: state ? reason : null
			}
		});

		if (!isRecursive) {
			await this.authService.banUser(userId, state, reason);
		}
	}

	async timeout(userId: number, state: boolean) {
		const timeoutUntil = new Date();

		if (state) {
			// 3 day timeout
			timeoutUntil.setDate(timeoutUntil.getDate() + 3);
		}

		await this.prisma.user.update({
			where: { id: userId },
			data: {
				timeoutUntil
			}
		});
	}

	async updateProfilePicture(userId: number, pictureUrl: string) {
		if (!pictureUrl || typeof pictureUrl !== "string") {
			throw new ValidationError("Invalid picture URL");
		}

		// Validate URL length (prevent extremely long URLs)
		if (pictureUrl.length > 100_000) { // ~100KB limit for data URL
			throw new ValidationError("Picture URL too long");
		}

		// Validate URL format - support both HTTP URLs and data URLs
		try {
			// Check if it's a data URL
			if (pictureUrl.startsWith("data:")) {
				// Validate data URL format: data:[<mediatype>][;base64],<data>
				if (!pictureUrl.includes(",") || pictureUrl.length < 10) {
					throw new ValidationError("Invalid data URL format");
				}

				// Check if data URL is complete (not truncated)
				const parts = pictureUrl.split(",");
				if (parts.length !== 2) {
					throw new ValidationError("Invalid data URL format - missing data part");
				}

				// Validate MIME type in data URL
				const header = parts[0];
				if (!header) {
					throw new ValidationError("Invalid data URL format - missing header");
				}
				const allowedMimeTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
				const hasValidMimeType = allowedMimeTypes.some(mimeType => header.includes(mimeType));
				if (!hasValidMimeType) {
					throw new ValidationError("Invalid image type in data URL");
				}

				// Check if base64 data is valid
				const base64Data = parts[1];
				if (!base64Data || base64Data.length === 0) {
					throw new ValidationError("Invalid data URL format - empty data");
				}

				// Validate base64 content
				const base64Regex = /^[\d+/A-Za-z]*={0,2}$/;
				if (!base64Regex.test(base64Data)) {
					throw new ValidationError("Invalid base64 data in URL");
				}
			} else {
				// Validate HTTP/HTTPS URL
				const url = new URL(pictureUrl);
				if (!["http:", "https:"].includes(url.protocol)) {
					throw new ValidationError("Only HTTP/HTTPS URLs are allowed");
				}

				// Basic domain validation (optional - can be enhanced)
				if (url.hostname.includes("localhost") || url.hostname.includes("127.0.0.1")) {
					throw new ValidationError("Local URLs are not allowed");
				}
			}
		} catch (error) {
			if (error instanceof ValidationError) {
				throw error;
			}
			throw new ValidationError("Invalid URL format");
		}

		// Use transaction to ensure atomicity
		const result = await this.prisma.$transaction(async (tx) => {
			// Create profile picture
			const profilePicture = await tx.profilePicture.create({
				data: {
					userId,
					url: pictureUrl
				}
			});
			// -20k bitcoin
			await tx.user.update({
				where: { id: userId },
				data: {
					picture: pictureUrl,
					droplets: {
						decrement: 20_000
					}
				}
			});

			return { success: true, pictureId: profilePicture.id };
		});

		return result;
	}

	async changeProfilePicture(userId: number, pictureId: number | null) {
		if (pictureId === null) {
			// Set empty profile picture
			await this.prisma.user.update({
				where: { id: userId },
				data: {
					picture: null
				}
			});
			return { success: true };
		}

		const profilePicture = await this.prisma.profilePicture.findFirst({
			where: {
				id: pictureId,
				userId
			}
		});

		if (!profilePicture) {
			throw new ValidationError("Profile picture not found or access denied");
		}

		await this.prisma.user.update({
			where: { id: userId },
			data: {
				picture: profilePicture.url
			}
		});

		return { success: true };
	}

	async getProfilePictures(userId: number) {
		const pictures = await this.prisma.profilePicture.findMany({
			where: { userId },
			orderBy: { id: "desc" },
			select: {
				id: true,
				url: true
			}
		});

		return pictures;
	}

	async logoutFromAllDevices(userId: number) {
		await this.prisma.session.deleteMany({
			where: { userId }
		});

		return { success: true };
	}
}
