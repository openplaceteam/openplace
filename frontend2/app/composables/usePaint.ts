import type { TileCoords } from "~/utils/coordinates";
import { palette } from "~/utils/palette";

interface PaintPixel {
	tileCoords: TileCoords;
	color: string;
}

interface TilePixels {
	tileX: number;
	tileY: number;
	pixels: PaintPixel[];
}

export function usePaint() {
	const config = useRuntimeConfig();
	const { getVisitorId } = useFingerprint();

	const getColorIndex = (rgbaString: string): number => {
		// TODO: This is terrible
		const match = rgbaString.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d+(?:\.\d+)?))?\)/);
		if (!match) {
			throw new Error(`Invalid color format: ${rgbaString}`);
		}

		const [, r, g, b, a] = match;
		const rgba: [number, number, number, number] = [
			Number.parseInt(r!),
			Number.parseInt(g!),
			Number.parseInt(b!),
			a ? Number.parseFloat(a) : 1
		];

		const color = palette.find(item =>
			item.rgba[0] === rgba[0] &&
			item.rgba[1] === rgba[1] &&
			item.rgba[2] === rgba[2] &&
			item.rgba[3] === rgba[3]
		);

		if (!color) {
			throw new Error(`Color not found in palette: ${rgbaString}`);
		}

		return color.index;
	};

	const groupPixelsByTile = (pixels: PaintPixel[]): TilePixels[] => {
		const tileMap = new Map<string, TilePixels>();

		for (const pixel of pixels) {
			const [tileX, tileY] = pixel.tileCoords.tile;
			const key = `${tileX}-${tileY}`;

			if (!tileMap.has(key)) {
				tileMap.set(key, {
					tileX,
					tileY,
					pixels: []
				});
			}

			tileMap.get(key)!.pixels.push(pixel);
		}

		return [...tileMap.values()];
	};

	const submitPixels = async (pixels: PaintPixel[]) => {
		const tileGroups = groupPixelsByTile(pixels);
		const results: { tileX: number; tileY: number; painted: number }[] = [];
		const fingerprint = await getVisitorId();

		for (const group of tileGroups) {
			const colors: number[] = [];
			const coords: number[] = [];

			for (const pixel of group.pixels) {
				const [x, y] = pixel.tileCoords.pixel;
				const colorIndex = getColorIndex(pixel.color);

				colors.push(colorIndex);
				coords.push(x, y);
			}

			try {
				const response = await $fetch<{ painted: number }>(`${config.public.backendUrl}/s0/pixel/${group.tileX}/${group.tileY}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json"
					},
					body: {
						colors,
						coords,
						t: "turnstile-disabled",
						fp: fingerprint ?? ""
					},
					credentials: "include"
				});

				results.push({
					tileX: group.tileX,
					tileY: group.tileY,
					painted: response.painted
				});
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to paint pixels at tile (${group.tileX}, ${group.tileY}): ${message}`
				);
			}
		}

		return results;
	};

	return {
		submitPixels
	};
}
