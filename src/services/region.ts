import { PrismaClient } from "@prisma/client";
import { TILE_SIZE } from "./pixel";

export interface Region {
	id: number;
	cityId: number;
	name: string;
	number: number;
	countryId: number;
	flagId: number;
}

interface Point {
	latitude: number;
	longitude: number;
	id: number;
	cityId: number;
	name: string;
	number: number;
	countryId: number;
}

export class RegionService {
	constructor(private prisma: PrismaClient) {}

	private cache = new Map<string, Region>();
	private inflight = new Map<string, Promise<Region>>();

	private staticKey(lat: number, lon: number): string {
		const rLat = Math.round(lat * 10_000) / 10_000;
		const rLon = Math.round(lon * 10_000) / 10_000;
		return `${rLat}:${rLon}`;
	}

	static pixelsToCoordinates(tile: [number, number], pixel: [number, number], { tileSize, canonicalZ }: { tileSize?: number; canonicalZ?: number } = {}): { latitude: number; longitude: number } {
		const [tileX, tileY] = tile;
		const [pixelX, pixelY] = pixel;

		tileSize ??= TILE_SIZE;
		canonicalZ ??= 11;
		const worldPixels = tileSize * Math.pow(2, canonicalZ);

		const [globalX, globalY] = [tileX * tileSize + pixelX + 0.5, tileY * tileSize + pixelY + 0.5];
		const [normX, normY] = [globalX / worldPixels, globalY / worldPixels];

		const longitude = normX * 360 - 180;
		const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * normY))) * 180 / Math.PI;

		return { latitude, longitude };
	}

	async getRegionForCoordinates(tile: [number, number], pixel: [number, number]): Promise<Region> {
		const { latitude, longitude } = RegionService.pixelsToCoordinates(tile, pixel);

		const key = this.staticKey(latitude, longitude);
		const cached = this.cache.get(key);
		if (cached) return cached;
		const existing = this.inflight.get(key);
		if (existing) return existing;

		const work = (async () => {
			const nearest = await this.findNearestRegionByDistance(latitude, longitude);
			if (nearest) {
				const result = {
					id: nearest.id,
					cityId: nearest.cityId,
					name: nearest.name,
					number: nearest.number,
					countryId: nearest.countryId,
					flagId: nearest.countryId
				} as Region;

				this.cache.set(key, result);
				return result;
			}

			// Fallback if no region found
			return {
				id: 0,
				cityId: 0,
				name: "openplace",
				number: 1,
				countryId: 13,
				flagId: 13
			};
		})();

		this.inflight.set(key, work);
		try {
			const r = await work;
			return r;
		} finally {
			this.inflight.delete(key);
		}
	}

	private deg2rad(v: number): number { return v * Math.PI / 180 }

	// ref: https://stackoverflow.com/questions/27928/calculate-distance-between-two-latitude-longitude-points-haversine-formula
	private getDistanceFromLatLon(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
		const R = 6_371_000;
		const dLat = this.deg2rad(b.latitude - a.latitude);
		const dLon = this.deg2rad(b.longitude - a.longitude);
		const lat1 = this.deg2rad(a.latitude);
		const lat2 = this.deg2rad(b.latitude);
		const sinDLat = Math.sin(dLat / 2);
		const sinDLon = Math.sin(dLon / 2);
		const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
		return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
	}

	private async findNearestRegionByDistance(latitude: number, longitude: number) {
		// Start with a small bounding box (~55km) to keep DB queries lightning fast
		let radiusDeg = 0.5; 
		const maxRadiusDeg = 5.0; // Max out at ~550km so we don't query the whole ocean

		while (radiusDeg <= maxRadiusDeg) {
			const minLat = latitude - radiusDeg;
			const maxLat = latitude + radiusDeg;
			const minLon = longitude - radiusDeg;
			const maxLon = longitude + radiusDeg;

			const candidates = await this.prisma.region.findMany({
				where: {
					latitude: { gte: minLat, lte: maxLat },
					longitude: { gte: minLon, lte: maxLon }
				}
			});

			if (candidates.length > 0) {
				let best: any = null;
				let bestD = Number.POSITIVE_INFINITY;
				for (const region of candidates) {
					const d = this.getDistanceFromLatLon(
						{ latitude, longitude }, 
						{ latitude: Number(region.latitude), longitude: Number(region.longitude) }
					);
					if (d < bestD) {
						bestD = d;
						best = region;
					}
				}
				return best;
			}
			
			// If no cities found in the box, expand the search radius
			radiusDeg *= 2; 
		}
		return null;
	}

	public async findRegionsByQuery(query: string): Promise<Point[]> {
		const queryLowercase = query.toLowerCase();
		const results = await this.prisma.region.findMany({
			where: {
				name: { startsWith: queryLowercase } 
			},
			orderBy: {
				population: "desc"
			},
			take: 20
		});

		const sorted = results.sort((a, b) => {
			const aName = a.name.toLowerCase();
			const bName = b.name.toLowerCase();

			const aExact = aName === queryLowercase ? 0 : 1;
			const bExact = bName === queryLowercase ? 0 : 1;
			if (aExact !== bExact) {
				return aExact - bExact;
			}

			const aStarts = aName.startsWith(queryLowercase) ? 0 : 1;
			const bStarts = bName.startsWith(queryLowercase) ? 0 : 1;
			if (aStarts !== bStarts) {
				return aStarts - bStarts;
			}

			const popA = BigInt(a.population || 0);
			const popB = BigInt(b.population || 0);
			if (popA !== popB) {
				return popB > popA ? 1 : -1;
			}

			return aName.length - bName.length;
		}).slice(0, 10);

		return sorted.map(item => ({
			latitude: Number(item.latitude),
			longitude: Number(item.longitude),
			id: item.id,
			cityId: item.cityId,
			name: item.name,
			number: item.number,
			countryId: item.countryId,
			flagId: item.countryId
		}));
	}
}
