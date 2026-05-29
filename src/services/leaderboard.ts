import { prisma } from "../config/database.js";

export type LeaderboardType = "player" | "alliance" | "country" | "region" | "regionPlayers" | "regionAlliances";
export type LeaderboardMode = "today" | "week" | "month" | "all-time";

interface LeaderboardEntry {
	id: number;
	name?: string;
	pixelsPainted: number;
	rank?: number;
	allianceId?: number;
	allianceName?: string;
	equippedFlag?: number;
	picture?: string;
	discord?: string;
	lastLatitude?: number;
	lastLongitude?: number;
	cityId?: number;
	number?: number;
	countryId?: number;
}

export class LeaderboardService {
	private updateQueue = new Set<string>();
	private isUpdating = false;
	private isWarmingUp = false;
	private batchSize = 5;
	private maxQueueSize = 1000;
	private updateInterval = 3000;
	private lastUpdate = 0;
	private memoryCache = new Map<string, { items: LeaderboardEntry[]; ts: number }>();
	private cacheMaxAge = 60_000;
	private cacheCleanupInterval: NodeJS.Timeout | null = null;
	private queuedCount = 0;
	private processedCount = 0;
	private warmupSnapshotTime: Date | null = null;

	constructor() {
		this.startCacheCleanup();
	}

	private startCacheCleanup(): void {
		if (this.cacheCleanupInterval) return;
		this.cacheCleanupInterval = setInterval(() => {
			const now = Date.now();
			let cleaned = 0;
			for (const [key, value] of this.memoryCache.entries()) {
				if (now - value.ts > this.cacheMaxAge) {
					this.memoryCache.delete(key);
					cleaned++;
				}
			}
		}, 30_000);
	}


	private async ensureConnected(retries = 3): Promise<boolean> {
		for (let i = 0; i < retries; i++) {
			try {
				await prisma.$queryRaw`SELECT 1`;
				return true;
			} catch {
				if (i === retries - 1) return false;
				await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
			}
		}
		return false;
	}

	private async updateLeaderboardEntries(
		type: LeaderboardType,
		mode: LeaderboardMode,
		entries: { type: LeaderboardType; mode: LeaderboardMode; entityId: number; rank: number; pixelsPainted: number }[]
	): Promise<void> {
		await this.retryTransaction(async () => {
			// First, get existing entries to avoid duplicates
			const existingEntries = await prisma.leaderboardView.findMany({
				where: { type, mode },
				select: { entityId: true }
			});

			const existingEntityIds = new Set(existingEntries.map(e => e.entityId)
				.filter(id => id !== null));
			const newEntityIds = new Set(entries.map(e => e.entityId));

			// Delete entries that are no longer in the new list
			const toDelete = [...existingEntityIds].filter(id => !newEntityIds.has(id));
			if (toDelete.length > 0) {
				await prisma.leaderboardView.deleteMany({
					where: {
						type,
						mode,
						entityId: { in: toDelete }
					}
				});
			}

			// Update or create entries using updateMany to bypass the read-modify-write race condition
			for (const entry of entries) {
				const updateResult = await prisma.leaderboardView.updateMany({
					where: {
						type: entry.type,
						mode: entry.mode,
						entityId: entry.entityId
					},
					data: {
						rank: entry.rank,
						pixelsPainted: entry.pixelsPainted
					}
				});

				// If count is 0, the entry does not exist yet
				if (updateResult.count === 0) {
					try {
						await prisma.leaderboardView.create({
							data: entry
						});
					} catch (error: any) {
						// P2002 is Prisma's Unique Constraint error. 
						// If another thread created it in the exact same millisecond, just ignore it safely.
						if (error.code !== "P2002") {
							throw error;
						}
					}
				}
			}
		});
	}

	private async retryTransaction<T>(operation: () => Promise<T>, maxRetries = 5): Promise<T> {
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				return await operation();
			} catch (error: any) {
				// Check if it's a deadlock, write conflict, timeout error, OR Error 1020
				const isRetryableError = (
					error.code === "P2034" ||
					error.code === "P2024" ||
					error.message?.includes("deadlock") ||
					error.message?.includes("write conflict") ||
					error.message?.includes("timeout") ||
					error.message?.includes("connection") ||
					error.message?.includes("1020") || // Added MySQL 1020 Catch
					error.message?.includes("Record has changed since last read") // Added fallback
				);

				if (isRetryableError && attempt < maxRetries) {
					// Exponential backoff with jitter and longer delays
					const baseDelay = 200 * Math.pow(2, attempt - 1);
					const jitter = Math.random() * 100;
					const delay = Math.min(baseDelay + jitter, 2000);

					console.warn(`[LeaderboardService] Retryable error on attempt ${attempt}/${maxRetries}: ${error.message}. Retrying in ${delay}ms`);
					await new Promise(resolve => setTimeout(resolve, delay));
					continue;
				}

				// Log non-retryable errors
				if (!isRetryableError) {
					console.error(`[LeaderboardService] Non-retryable error:`, error);
				}
				throw error;
			}
		}
		throw new Error(`Max retries (${maxRetries}) exceeded for leaderboard transaction`);
	}

	async getLeaderboard(
		type: LeaderboardType,
		mode: LeaderboardMode,
		entityId?: number,
		limit = 50
	): Promise<LeaderboardEntry[]> {
		// Try real-time data first for region-specific leaderboards
		if (type === "regionPlayers" && entityId) {
			const realTimeEntries = await this.getRegionPlayersLeaderboard(entityId, limit, mode);
			if (realTimeEntries.length > 0) {
				return realTimeEntries;
			}
		}

		if (type === "regionAlliances" && entityId) {
			const realTimeEntries = await this.getRegionAlliancesLeaderboard(entityId, limit, mode);
			if (realTimeEntries.length > 0) {
				return realTimeEntries;
			}
		}

		const cacheKey = this.getCacheKey(type, mode, entityId);
		let entries = await this.getFromView(type, mode, entityId, limit);
		if (entries.length === 0) {
			const cached = this.memoryCache.get(cacheKey);
			if (cached && cached.items.length > 0) {
				entries = cached.items.slice(0, limit);
			}
		}

		if (entries.length === 0 || this.shouldUpdate(type, mode, entityId)) {
			this.queueUpdate(type, mode, entityId);
		}

		return entries;
	}

	private async getRegionPlayersLeaderboard(cityId: number, limit: number, mode: LeaderboardMode = "all-time"): Promise<LeaderboardEntry[]> {
		try {
			// Get date filter like global leaderboard
			const dateFilter = this.getDateFilter(mode, this.warmupSnapshotTime ?? undefined);
			let queryPromise: Promise<any>;
			if (mode === "all-time") {
				queryPromise = prisma.userRegionStats.groupBy({
					by: ["userId"],
					where: {
						regionCityId: cityId
					},
					_sum: { pixelsPainted: true },
					_max: { lastPaintedAt: true },
					orderBy: { _sum: { pixelsPainted: "desc" } },
					take: limit
				});
			} else {
				// today/week/month from daily rollup
				const where: any = { regionCityId: cityId };
				if (dateFilter.paintedAt?.gte) {
					where.date = { gte: dateFilter.paintedAt.gte };
				}
				queryPromise = prisma.userRegionStatsDaily.groupBy({
					by: ["userId"],
					where,
					_sum: { pixelsPainted: true },
					_max: { lastPaintedAt: true },
					orderBy: { _sum: { pixelsPainted: "desc" } },
					take: limit
				});
			}

			const timeoutPromise = new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Query timeout after 10 seconds")), 10_000)
			);

			const stats = await Promise.race([queryPromise, timeoutPromise]) as any;

			// Get user details for the grouped results
			const userIds = stats.map((s: any) => s.userId)
				.filter(Boolean) as number[];
			const users = await prisma.user.findMany({
				where: { id: { in: userIds }, role: "user" },
				select: {
					id: true,
					name: true,
					nickname: true,
					picture: true,
					allianceId: true,
					equippedFlag: true,
					discord: true,
					alliance: {
						select: { name: true }
					}
				}
			});

			const userMap = new Map(users.map(u => [u.id, u]));

			const result = stats
				.filter((stat: any) => (stat._sum.pixelsPainted || 0) > 0) // Filter out users with 0 pixels
				.map((stat: any) => {
					const user = userMap.get(stat.userId);
					if (!user) return null;

					// Match format of global leaderboard enrichPlayerEntries
					const entry: any = {
						id: user.id,
						name: user.nickname || user.name,
						pixelsPainted: stat._sum.pixelsPainted || 0,
						allianceId: user.allianceId || 0,
						allianceName: user.alliance?.name || "",
						...(user.picture && { picture: user.picture }),
						...(user.equippedFlag && { equippedFlag: user.equippedFlag }),
						...(user.discord && { discord: user.discord })
					};

					// Validate entry has all required fields
					if (!entry.id || !entry.name) {
						console.warn(`[${new Date()
							.toISOString()}] Invalid entry found:`, entry);
					}

					return entry;
				})
				.filter(Boolean);

			return result;
		} catch {
			return [];
		}
	}

	private async getRegionAlliancesLeaderboard(cityId: number, limit: number, mode: LeaderboardMode = "all-time"): Promise<LeaderboardEntry[]> {
		try {
			// Time filter
			const dateFilter = this.getDateFilter(mode, this.warmupSnapshotTime ?? undefined);
			let allianceStats: any[] = [];
			if (mode === "all-time") {
				allianceStats = await prisma.userRegionStats.groupBy({
					by: ["allianceId"],
					where: {
						regionCityId: cityId,
						allianceId: { not: null }
					},
					_sum: { pixelsPainted: true },
					_max: { lastPaintedAt: true },
					orderBy: { _sum: { pixelsPainted: "desc" } },
					take: limit
				} as any);
			} else {
				const where: any = { regionCityId: cityId, allianceId: { not: null } };
				if (dateFilter.paintedAt?.gte) {
					where.date = { gte: dateFilter.paintedAt.gte };
				}
				allianceStats = await prisma.userRegionStatsDaily.groupBy({
					by: ["allianceId"],
					where,
					_sum: { pixelsPainted: true },
					_max: { lastPaintedAt: true },
					orderBy: { _sum: { pixelsPainted: "desc" } },
					take: limit
				} as any);
			}

			const allianceIds = allianceStats.map((s: { allianceId: any; }) => s.allianceId)
				.filter(Boolean) as number[];
			const alliances = await prisma.alliance.findMany({
				where: { id: { in: allianceIds } },
				select: { id: true, name: true }
			});

			const allianceMap = new Map(alliances.map(a => [a.id, a.name]));

			const result = allianceStats.map((stat) => ({
				id: stat.allianceId!,
				name: allianceMap.get(stat.allianceId!) || "",
				pixelsPainted: stat._sum.pixelsPainted || 0,
				allianceId: stat.allianceId!,
				allianceName: allianceMap.get(stat.allianceId!) || "",
				picture: ""
			}));

			return result;
		} catch {
			return [];
		}
	}

	private getCacheKey(type: LeaderboardType, mode: LeaderboardMode, entityId?: number): string {
		return `${type}:${mode}:${entityId || "all"}`;
	}

	private async getFromView(
		type: LeaderboardType,
		mode: LeaderboardMode,
		entityId?: number,
		limit = 50
	): Promise<LeaderboardEntry[]> {
		// For region leaderboards, we now use real-time data, so return empty
		if (type === "regionPlayers" || type === "regionAlliances") {
			return [];
		}

		// For all-time mode, query directly from database instead of leaderboardView
		if (mode === "all-time") {
			if (type === "player") {
				const users = await prisma.user.findMany({
					where: { role: "user", pixelsPainted: { gt: 0 } },
					orderBy: { pixelsPainted: "desc" },
					take: limit,
					select: {
						id: true,
						name: true,
						nickname: true,
						picture: true,
						allianceId: true,
						alliance: { select: { name: true } },
						equippedFlag: true,
						discord: true,
						pixelsPainted: true
					}
				});

				return users.map((user) => ({
					id: user.id,
					name: user.nickname || user.name, // Use nickname as name, fallback to name
					...(user.picture && { picture: user.picture }),
					...(user.allianceId && { allianceId: user.allianceId }),
					...(user.alliance?.name && { allianceName: user.alliance.name }),
					...(user.equippedFlag && { equippedFlag: user.equippedFlag }),
					...(user.discord && { discord: user.discord }),
					pixelsPainted: user.pixelsPainted
				}));
			} else if (type === "alliance") {
				const alliances = await prisma.alliance.findMany({
					where: { pixelsPainted: { gt: 0 } },
					orderBy: { pixelsPainted: "desc" },
					take: limit,
					select: { id: true, name: true, pixelsPainted: true }
				});

				return alliances.map((alliance) => ({
					id: alliance.id,
					name: alliance.name,
					pixelsPainted: alliance.pixelsPainted
				}));
			}
		}

		const whereClause: any = {
			type,
			mode
		};

		if (entityId) {
			whereClause.entityId = entityId;
		}

		const viewEntries = await prisma.leaderboardView.findMany({
			where: whereClause,
			orderBy: { rank: "asc" },
			take: limit
		});

		if (viewEntries.length === 0) {
			if (type === "region" && entityId) {
				return await this.getRegionLeaderboardByCountry(mode, entityId, limit, this.warmupSnapshotTime || undefined);
			}
			return [];
		}

		return await this.enrichEntries(viewEntries, type, mode);
	}

	private async enrichEntries(viewEntries: any[], type: LeaderboardType, mode?: LeaderboardMode): Promise<LeaderboardEntry[]> {
		const entityIds = viewEntries.map(e => e.entityId)
			.filter(Boolean);

		switch (type) {
		case "player":
			return await this.enrichPlayerEntries(viewEntries, entityIds);
		case "alliance":
			return await this.enrichAllianceEntries(viewEntries, entityIds, mode);
		case "country":
			return await this.enrichCountryEntries(viewEntries, entityIds);
		case "region":
			return await this.enrichRegionEntries(viewEntries, entityIds);
		case "regionPlayers":
			return await this.enrichPlayerEntries(viewEntries, entityIds);
		case "regionAlliances":
			return await this.enrichAllianceEntries(viewEntries, entityIds, mode);
		default:
			return [];
		}
	}

	private async enrichPlayerEntries(viewEntries: any[], userIds: number[]): Promise<LeaderboardEntry[]> {
		const users = await prisma.user.findMany({
			where: { id: { in: userIds }, role: "user" },
			select: {
				id: true,
				name: true,
				nickname: true,
				allianceId: true,
				equippedFlag: true,
				picture: true,
				discord: true,
				alliance: { select: { name: true } }
			}
		});

		const userMap = new Map(users.map(u => [u.id, u]));

		return viewEntries.map(entry => {
			const user = userMap.get(entry.entityId);
			if (!user) return null;

			return {
				id: user.id,
				name: user.nickname || user.name,
				...(user.picture && { picture: user.picture }),
				...(user.allianceId && { allianceId: user.allianceId }),
				...(user.alliance?.name && { allianceName: user.alliance.name }),
				...(user.equippedFlag && { equippedFlag: user.equippedFlag }),
				...(user.discord && { discord: user.discord }),
				pixelsPainted: entry.pixelsPainted
			};
		})
			.filter(Boolean) as LeaderboardEntry[];
	}

	private async enrichAllianceEntries(viewEntries: any[], allianceIds: number[], mode?: LeaderboardMode): Promise<LeaderboardEntry[]> {
		const alliances = await prisma.alliance.findMany({
			where: { id: { in: allianceIds } },
			select: { id: true, name: true, pixelsPainted: true }
		});

		const allianceMap = new Map(alliances.map(a => [a.id, a]));

		return viewEntries.map(entry => {
			const alliance = allianceMap.get(entry.entityId);
			if (!alliance) return null;

			return {
				id: alliance.id,
				name: alliance.name,
				pixelsPainted: mode === "all-time" ? alliance.pixelsPainted : entry.pixelsPainted
			};
		})
			.filter(Boolean) as LeaderboardEntry[];
	}

	private async enrichCountryEntries(viewEntries: any[], _countryIds: number[]): Promise<LeaderboardEntry[]> {
		return viewEntries.map(entry => ({
			id: entry.entityId,
			pixelsPainted: entry.pixelsPainted
		}));
	}

	private async enrichRegionEntries(viewEntries: any[], cityIds: number[]): Promise<LeaderboardEntry[]> {
		const regions = await prisma.region.findMany({
			where: { cityId: { in: cityIds } },
			select: {
				id: true,
				name: true,
				cityId: true,
				number: true,
				countryId: true,
				latitude: true,
				longitude: true
			}
		});

		const regionMap = new Map(regions.map(r => [r.cityId, r]));

		return viewEntries.map(entry => {
			const region = regionMap.get(entry.entityId);
			if (!region) return null;

			return {
				id: region.id,
				name: region.name,
				pixelsPainted: entry.pixelsPainted,
				cityId: region.cityId,
				number: region.number,
				countryId: region.countryId,
				lastLatitude: Number(region.latitude),
				lastLongitude: Number(region.longitude)
			};
		})
			.filter(Boolean) as LeaderboardEntry[];
	}

	private async getRegionLeaderboardByCountry(mode: LeaderboardMode, countryId: number, limit: number, snapshotTime?: Date): Promise<LeaderboardEntry[]> {
		const cacheKey = this.getCacheKey("region", mode, countryId);
		const cached = this.memoryCache.get(cacheKey);
		if (cached && cached.items.length > 0) {
			return cached.items.slice(0, limit);
		}

		const dateFilter = this.getDateFilter(mode, snapshotTime);
		let counts: { regionCityId: number; count: bigint }[] = [];

		// Use userRegionStats for better performance
		if (mode === "all-time") {
			// For all-time, sum all pixelsPainted by regionCityId
			const stats = await prisma.userRegionStats.groupBy({
				by: ["regionCityId"],
				_sum: { pixelsPainted: true },
				where: {
					regionCityId: { not: null },
					regionCountryId: countryId
				},
				orderBy: { _sum: { pixelsPainted: "desc" } },
				take: limit
			});

			counts = stats.map(stat => ({
				regionCityId: stat.regionCityId!,
				count: BigInt(stat._sum.pixelsPainted || 0)
			}));
		} else {
			// For time-based modes, filter by lastPaintedAt
			const stats = await prisma.userRegionStats.groupBy({
				by: ["regionCityId"],
				_sum: { pixelsPainted: true },
				where: {
					regionCityId: { not: null },
					regionCountryId: countryId,
					...(dateFilter.paintedAt && { lastPaintedAt: dateFilter.paintedAt })
				},
				orderBy: { _sum: { pixelsPainted: "desc" } },
				take: limit
			});

			counts = stats.map(stat => ({
				regionCityId: stat.regionCityId!,
				count: BigInt(stat._sum.pixelsPainted || 0)
			}));
		}

		if (counts.length === 0) return [];

		const cityIds = counts.map(c => c.regionCityId)
			.filter(Boolean);
		const regions = await prisma.region.findMany({
			where: { cityId: { in: cityIds } },
			select: {
				id: true,
				name: true,
				cityId: true,
				number: true,
				countryId: true,
				latitude: true,
				longitude: true
			}
		});
		const regionMap = new Map(regions.map(r => [r.cityId, r]));

		const entries: LeaderboardEntry[] = [];
		for (const current of counts) {
			if (!current) continue;
			const cityIdVal = current.regionCityId;
			if (!cityIdVal) continue;
			const reg = regionMap.get(cityIdVal);
			if (!reg) continue;
			entries.push({
				id: reg.id,
				name: reg.name,
				pixelsPainted: Number(current.count),
				cityId: reg.cityId,
				number: reg.number,
				countryId: reg.countryId,
				lastLatitude: Number(reg.latitude),
				lastLongitude: Number(reg.longitude)
			});
			if (entries.length >= limit) break;
		}

		if (entries.length > 0) {
			this.memoryCache.set(cacheKey, { items: entries, ts: Date.now() });
		}

		return entries;
	}


	private shouldUpdate(type: LeaderboardType, mode: LeaderboardMode, entityId?: number): boolean {
		const cacheKey = this.getCacheKey(type, mode, entityId);
		return this.updateQueue.has(cacheKey);
	}

	private queueUpdate(type: LeaderboardType, mode: LeaderboardMode, entityId?: number): void {
		const cacheKey = this.getCacheKey(type, mode, entityId);
		this.updateQueue.add(cacheKey);

		if (!this.isUpdating) {
			this.processUpdateQueue();
		}
	}

	private async processUpdateQueue(): Promise<void> {
		if (this.isUpdating) return;
		if (!(await this.ensureConnected())) {
			console.error("Database not connected, retrying in 1s");
			setTimeout(() => this.processUpdateQueue(), 1000);
			return;
		}

		this.isUpdating = true;

		try {
			let processed = 0;
			const batch: { type: LeaderboardType; mode: LeaderboardMode; entityId?: number }[] = [];

			while (this.updateQueue.size > 0 && processed < this.batchSize) {
				const cacheKey = this.updateQueue.values()
					.next().value;
				if (!cacheKey) break;

				this.updateQueue.delete(cacheKey);

				const [type, mode, entityIdStr] = cacheKey.split(":");
				const entityId = entityIdStr === "all" ? undefined : Number.parseInt(entityIdStr ?? "0");

				const item: { type: LeaderboardType; mode: LeaderboardMode; entityId?: number } = {
					type: type as LeaderboardType,
					mode: mode as LeaderboardMode
				};
				if (entityId !== undefined) {
					item.entityId = entityId;
				}
				batch.push(item);
				processed++;
			}

			for (const { type, mode, entityId } of batch) {
				try {
					await this.updateLeaderboardView(type, mode, entityId, this.warmupSnapshotTime || undefined);
					await this.refreshCache(type, mode, entityId);
					this.processedCount++;
				} catch (error) {
					console.error(`Error updating leaderboard ${type}:${mode}:${entityId || "all"}:`, error);
				}
			}

			if (this.updateQueue.size > 0) {
				setTimeout(() => this.processUpdateQueue(), 500);
			}
		} finally {
			this.isUpdating = false;
		}
	}

	private async updateLeaderboardView(
		type: LeaderboardType,
		mode: LeaderboardMode,
		_entityId?: number,
		snapshotTime?: Date
	): Promise<void> {
		const dateFilter = this.getDateFilter(mode, snapshotTime);

		switch (type) {
		case "player":
			await this.updatePlayerLeaderboard(mode, dateFilter);
			break;
		case "alliance":
			await this.updateAllianceLeaderboard(mode, dateFilter);
			break;
		case "country":
			await this.updateCountryLeaderboard(mode, dateFilter);
			break;
		case "region":
			await this.updateRegionLeaderboard(mode, dateFilter);
			break;
		case "regionPlayers":
		case "regionAlliances":
			// These now use real-time UserRegionStats data, no need to update LeaderboardView
			break;
		}
	}

	private async refreshCache(type: LeaderboardType, mode: LeaderboardMode, entityId?: number): Promise<void> {
		const key = this.getCacheKey(type, mode, entityId);
		const items = await this.getFromView(type, mode, entityId, 50);
		if (items.length > 0) {
			this.memoryCache.set(key, { items, ts: Date.now() });
		}
	}

	private getDateFilter(mode: LeaderboardMode, snapshotTime?: Date): any {
		const now = snapshotTime || new Date();

		switch (mode) {
		case "today": {
			const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			startOfDay.setHours(0, 0, 0, 0);
			return { paintedAt: { gte: startOfDay } };
		}
		case "week": {
			const startOfWeek = new Date(now);
			startOfWeek.setDate(now.getDate() - 7);
			startOfWeek.setHours(0, 0, 0, 0);
			return { paintedAt: { gte: startOfWeek } };
		}
		case "month": {
			const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
			startOfMonth.setHours(0, 0, 0, 0);
			return { paintedAt: { gte: startOfMonth } };
		}
		case "all-time":
			return {};
		default:
			return {};
		}
	}

	private async updatePlayerLeaderboard(mode: LeaderboardMode, dateFilter: any): Promise<void> {
		if (mode === "all-time") {
			// For all-time, we don't need to store in leaderboardView since we query directly from user table
			return;
		}

		// Use userRegionStats for better performance
		const stats = await prisma.userRegionStats.groupBy({
			by: ["userId"],
			_sum: { pixelsPainted: true },
			where: {
				...(dateFilter.paintedAt && { lastPaintedAt: dateFilter.paintedAt })
			},
			orderBy: { _sum: { pixelsPainted: "desc" } },
			take: 50
		});

		const entries = stats
			.filter(stat => stat.userId != null && (stat._sum.pixelsPainted || 0) > 0) // Filter out users with 0 pixels
			.map((stat, index) => ({
				type: "player" as const,
				mode,
				entityId: stat.userId!,
				rank: index + 1,
				pixelsPainted: stat._sum.pixelsPainted || 0
			}));

		// Use helper function to avoid deleteMany deadlocks
		await this.updateLeaderboardEntries("player", mode, entries);
	}

	private async updateAllianceLeaderboard(mode: LeaderboardMode, dateFilter: any): Promise<void> {
		if (mode === "all-time") {
			// For all-time, use alliance.pixelsPainted which is now correctly calculated
			const allianceStats = await prisma.alliance.findMany({
				where: { pixelsPainted: { gt: 0 } },
				orderBy: { pixelsPainted: "desc" },
				take: 50,
				select: { id: true, pixelsPainted: true }
			});

			const entries = allianceStats.map((alliance, index) => ({
				type: "alliance" as const,
				mode,
				entityId: alliance.id,
				rank: index + 1,
				pixelsPainted: alliance.pixelsPainted
			}));

			// Use helper function to avoid deleteMany deadlocks
			await this.updateLeaderboardEntries("alliance", mode, entries);
			return;
		}

		// For time-based modes, get all alliances and calculate pixels for each member
		const alliances = await prisma.alliance.findMany({
			where: { pixelsPainted: { gt: 0 } },
			select: { id: true },
			take: 50
		});

		const allianceMap = new Map<number, number>();

		// Calculate pixels for each alliance
		for (const alliance of alliances) {
			// Get all members of this alliance
			const members = await prisma.user.findMany({
				where: {
					allianceId: alliance.id,
					allianceJoinedAt: { not: null }
				},
				select: { id: true, allianceJoinedAt: true }
			});

			let totalPixels = 0;

			for (const member of members) {
				if (!member.allianceJoinedAt) continue;

				// Count pixels painted by this member after joining alliance
				// Combine alliance join date with time period filter
				const paintedAtFilter: any = { gte: member.allianceJoinedAt };

				// Add time period filter if it exists (today/week/month)
				if (dateFilter && "paintedAt" in dateFilter && dateFilter.paintedAt) {
					// Use the later date between alliance join date and time period start
					const timePeriodStart = dateFilter.paintedAt.gte;
					if (timePeriodStart && timePeriodStart > member.allianceJoinedAt) {
						paintedAtFilter.gte = timePeriodStart;
					}
				}

				const pixelCount = await prisma.pixel.count({
					where: {
						paintedBy: member.id,
						paintedAt: paintedAtFilter
					}
				});
				totalPixels += pixelCount;
			}

			if (totalPixels > 0) {
				allianceMap.set(alliance.id, totalPixels);
			}
		}

		const entries = [...allianceMap.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 50)
			.map(([allianceId, pixelsPainted], index) => ({
				type: "alliance" as const,
				mode,
				entityId: allianceId,
				rank: index + 1,
				pixelsPainted
			}));

		// Use helper function to avoid deleteMany deadlocks
		await this.updateLeaderboardEntries("alliance", mode, entries);
	}

	private async updateCountryLeaderboard(mode: LeaderboardMode, dateFilter: any): Promise<void> {
		// Use userRegionStats for better performance
		let counts: { regionCountryId: number; count: bigint }[] = [];

		if (mode === "all-time") {
			// For all-time, sum all pixelsPainted by regionCountryId
			const stats = await prisma.userRegionStats.groupBy({
				by: ["regionCountryId"],
				_sum: { pixelsPainted: true },
				where: {
					regionCountryId: { not: null }
				},
				orderBy: { _sum: { pixelsPainted: "desc" } },
				take: 50
			});

			counts = stats.map(stat => ({
				regionCountryId: stat.regionCountryId!,
				count: BigInt(stat._sum.pixelsPainted || 0)
			}));
		} else {
			// For time-based modes, filter by lastPaintedAt
			const stats = await prisma.userRegionStats.groupBy({
				by: ["regionCountryId"],
				_sum: { pixelsPainted: true },
				where: {
					regionCountryId: { not: null },
					...(dateFilter.paintedAt && { lastPaintedAt: dateFilter.paintedAt })
				},
				orderBy: { _sum: { pixelsPainted: "desc" } },
				take: 50
			});

			counts = stats.map(stat => ({
				regionCountryId: stat.regionCountryId!,
				count: BigInt(stat._sum.pixelsPainted || 0)
			}));
		}

		const entries = counts
			.filter(c => c.regionCountryId != null && c.count > 0)
			.map((c, index) => ({
				type: "country" as const,
				mode,
				entityId: c.regionCountryId,
				rank: index + 1,
				pixelsPainted: Number(c.count)
			}));

		// Use helper function to avoid deleteMany deadlocks
		await this.updateLeaderboardEntries("country", mode, entries);
	}

	private async updateRegionLeaderboard(mode: LeaderboardMode, dateFilter: any): Promise<void> {
		// Use userRegionStats for better performance
		let counts: { regionCityId: number; count: bigint }[] = [];

		if (mode === "all-time") {
			// For all-time, sum all pixelsPainted by regionCityId
			const stats = await prisma.userRegionStats.groupBy({
				by: ["regionCityId"],
				_sum: { pixelsPainted: true },
				where: {
					regionCityId: { not: null }
				},
				orderBy: { _sum: { pixelsPainted: "desc" } },
				take: 50
			});

			counts = stats.map(stat => ({
				regionCityId: stat.regionCityId!,
				count: BigInt(stat._sum.pixelsPainted || 0)
			}));
		} else {
			// For time-based modes, filter by lastPaintedAt
			const stats = await prisma.userRegionStats.groupBy({
				by: ["regionCityId"],
				_sum: { pixelsPainted: true },
				where: {
					regionCityId: { not: null },
					...(dateFilter.paintedAt && { lastPaintedAt: dateFilter.paintedAt })
				},
				orderBy: { _sum: { pixelsPainted: "desc" } },
				take: 50
			});

			counts = stats.map(stat => ({
				regionCityId: stat.regionCityId!,
				count: BigInt(stat._sum.pixelsPainted || 0)
			}));
		}

		const entries = counts
			.filter(c => c.regionCityId != null && c.count > 0)
			.map((c, index) => ({
				type: "region" as const,
				mode,
				entityId: c.regionCityId,
				rank: index + 1,
				pixelsPainted: Number(c.count)
			}));

		// Use helper function to avoid deleteMany deadlocks
		await this.updateLeaderboardEntries("region", mode, entries);
	}


	async invalidateLeaderboard(type: LeaderboardType, mode?: LeaderboardMode, entityId?: number): Promise<void> {
		const cacheKey = this.getCacheKey(type, mode ?? "all-time", entityId);

		if (this.updateQueue.size >= this.maxQueueSize) {
			console.warn(`Leaderboard queue overflow (${this.updateQueue.size}/${this.maxQueueSize}), dropping oldest 100 entries`);
			const toRemove = [...this.updateQueue].slice(0, 100);
			for (const key of toRemove) this.updateQueue.delete(key);
		}

		const isNew = !this.updateQueue.has(cacheKey);
		this.updateQueue.add(cacheKey);

		if (isNew) {
			this.queuedCount++;
		}

		// Clear cache for region leaderboards since we have real-time data
		if (type === "regionPlayers" || type === "regionAlliances") {
			this.memoryCache.delete(cacheKey);
		}

		if (type === "region" && entityId) {
			this.memoryCache.delete(cacheKey);
		}

		const now = Date.now();
		const isRegionLeaderboard = type === "regionPlayers" || type === "regionAlliances";

		// For region leaderboards, we have real-time data so don't need to queue updates
		// For global leaderboards, continue with normal update process
		if (!isRegionLeaderboard && now - this.lastUpdate > this.updateInterval) {
			this.lastUpdate = now;
			if (!this.isUpdating) {
				this.processUpdateQueue();
			}
		}
	}

	getStats(): { queued: number; processed: number; queueSize: number; cacheSize: number } {
		return {
			queued: this.queuedCount,
			processed: this.processedCount,
			queueSize: this.updateQueue.size,
			cacheSize: this.memoryCache.size
		};
	}

	async warmupGlobalLeaderboards(): Promise<void> {
		if (this.isWarmingUp) {
			return;
		}

		this.isWarmingUp = true;
		const startTime = Date.now();
		const timeout = 5 * 60 * 1000;
		let timeoutId: NodeJS.Timeout | null = null;

		try {
			const warmupPromise = (async () => {
				const modes: LeaderboardMode[] = ["today", "week", "month", "all-time"];
				const types: LeaderboardType[] = ["player", "alliance", "country", "region"];

				this.warmupSnapshotTime = new Date();

				for (const type of types) {
					for (const mode of modes) {
						this.queueUpdate(type, mode);
					}
				}

				if (!this.isUpdating) {
					await this.processUpdateQueue();
				}
			})();

			const timeoutPromise = new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error(`Warmup timeout after ${timeout}ms`));
				}, timeout);
			});

			await Promise.race([warmupPromise, timeoutPromise]);
		} catch (error) {
			const duration = Date.now() - startTime;
			console.error(`[LeaderboardService] Warmup failed after ${duration}ms:`, error);
			throw error;
		} finally {
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
			this.isWarmingUp = false;
			this.warmupSnapshotTime = null;
		}
	}


	async initializeAllLeaderboards(): Promise<void> {
		const types: LeaderboardType[] = ["player", "alliance", "country", "region"];

		// Create snapshot timestamp for consistent data across all modes
		const snapshotTime = new Date();

		// Initialize leaderboards
		// Players & Alliances: only today, week, month (all-time queries directly)
		// Countries & Regions: all modes including all-time (no direct field)
		for (const type of types) {
			if (type === "player" || type === "alliance") {
				// Only today, week, month for players/alliances
				const modes: LeaderboardMode[] = ["today", "week", "month"];
				for (const mode of modes) {
					await this.updateLeaderboardView(type, mode, undefined, snapshotTime);
					await this.refreshCache(type, mode);
				}
			} else {
				// All modes for countries/regions
				const modes: LeaderboardMode[] = ["today", "week", "month", "all-time"];
				for (const mode of modes) {
					await this.updateLeaderboardView(type, mode, undefined, snapshotTime);
					await this.refreshCache(type, mode);
				}
			}
		}
	}
}

export const leaderboardService = new LeaderboardService();
