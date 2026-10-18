import { PrismaClient } from "@prisma/client";
import { BanReason } from "../types";
import { UserService } from "./user";

// FingerprintJS visitorId is a hex hash (16-32 chars in the open-source build)
const FINGERPRINT_REGEX = /^[\da-f]{16,64}$/i;

export function isValidFingerprint(value: unknown): value is string {
	return typeof value === "string" && FINGERPRINT_REGEX.test(value);
}

function isRuleEnabled(key: string): boolean {
	const value = process.env[key];
	return value === "1" || value === "true";
}

export function isAnticheatEnabled(): boolean {
	// Enabled by default; set ENABLE_FINGERPRINT_ANTICHEAT=false to opt out
	const value = process.env["ENABLE_FINGERPRINT_ANTICHEAT"];
	return value === undefined || isRuleEnabled("ENABLE_FINGERPRINT_ANTICHEAT");
}

export class FingerprintService {
	private readonly userService: UserService;

	constructor(private prisma: PrismaClient, userService?: UserService) {
		this.userService = userService ?? new UserService(prisma);
	}

	/**
	 * Record a fingerprint sighting for a user.
	 * Returns false when the fingerprint is invalid.
	 */
	async record(userId: number, fingerprint: string): Promise<boolean> {
		if (!isAnticheatEnabled() || !isValidFingerprint(fingerprint)) {
			return false;
		}

		const normalized = fingerprint.toLowerCase();
		await this.prisma.userFingerprint.upsert({
			where: { userId_fingerprint: { userId, fingerprint: normalized } },
			create: { userId, fingerprint: normalized },
			update: { lastSeenAt: new Date() }
		});
		return true;
	}

	/**
	 * Find the user who owns this fingerprint (the earliest account seen with it).
	 */
	async findOwner(fingerprint: string): Promise<number | null> {
		if (!isValidFingerprint(fingerprint)) {
			return null;
		}

		const normalized = fingerprint.toLowerCase();
		const entry = await this.prisma.userFingerprint.findFirst({
			where: { fingerprint: normalized },
			orderBy: { firstSeenAt: "asc" },
			select: { userId: true }
		});
		return entry?.userId ?? null;
	}

	/**
	 * Check a fingerprint against its owner and auto-ban the current user
	 * for multi-accounting when it belongs to a different account.
	 *
	 * Unlike manual bans, this does not cascade to the user's IPs, since
	 * shared household IPs are expected and the owner must stay online.
	 *
	 * Returns true when the current user was banned.
	 */
	async checkAndBan(userId: number, fingerprint: string): Promise<boolean> {
		if (!isAnticheatEnabled() || isRuleEnabled("ALLOW_MULTI_ACCOUNT")) {
			return false;
		}

		const ownerId = await this.findOwner(fingerprint);
		if (ownerId === null || ownerId === userId) {
			return false;
		}

		const owner = await this.prisma.user.findUnique({
			where: { id: ownerId },
			select: { name: true, nickname: true, banned: true }
		});
		const user = await this.prisma.user.findUnique({
			where: { id: userId },
			select: { name: true, nickname: true, banned: true }
		});
		if (!owner || !user || user.banned) {
			return false;
		}

		console.log(`Banning ${user.nickname || user.name}#${userId} for multi-accounting: ` +
			`fingerprint ${fingerprint} belongs to ${owner.nickname || owner.name}#${ownerId}`);
		await this.userService.ban(userId, true, BanReason.MultiAccounting, true);
		return true;
	}
}
