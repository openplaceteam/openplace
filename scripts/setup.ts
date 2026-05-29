#!/usr/bin/env tsx

import { PrismaClient } from "@prisma/client";
import { BlobReader, FileEntry, ZipReader } from "@zip.js/zip.js";
import { execSync } from "child_process";
import inquirer from "inquirer";
import { COUNTRIES } from "../src/utils/country";
import chalk from "chalk";

(BigInt.prototype as any).toJSON = function () {
	return this.toString();
};

const BATCH_SIZE = Number(process.env.REGION_BATCH_SIZE ?? 10000);  // lines per DB batch
const CONCURRENCY = Number(process.env.REGION_CONCURRENCY ?? 32);  // concurrent upserts within a batch (kept for backwards compatibility but unused in bulk insert)
const PROGRESS_REFRESH_MS = Number(process.env.PROGRESS_REFRESH_MS ?? 120); // progress redraw throttle

const prisma = new PrismaClient({
	log: process.env.DEBUG?.includes("prisma") ? ["query", "info", "warn", "error"] : ["warn"]
});

const yes = process.argv.includes("--yes");

async function prompt(message: string, defaultValue = false) {
	if (yes) return defaultValue;
	return (
		await inquirer.prompt([
			{
				type: "confirm",
				name: "answer",
				message,
				default: defaultValue
			}
		])
	).answer as boolean;
}

function makeProgressPrinter(prefix = "Downloading: ") {
	let last = 0;
	return (percentText: string) => {
		const now = Date.now();
		if (now - last < PROGRESS_REFRESH_MS) return;
		last = now;
		process.stdout.write(chalk.blue(`\r${prefix}${percentText}`));
	};
}

async function downloadToUint8Array(url: string): Promise<Uint8Array[]> {
	const res = await fetch(url);
	if (!res.ok || !res.body) {
		throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
	}

	const contentLengthHeader = res.headers.get("content-length");
	const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : 0;
	const toMB = (n: number) => (n / 1024 / 1024).toFixed(2);
	const totalText = contentLength ? `${toMB(contentLength)} MB` : "unknown size";

	const print = makeProgressPrinter();
	let received = 0;

	const chunks: Uint8Array[] = [];
	for await (const chunk of res.body) {
		const u8 = chunk as Uint8Array;
		received += u8.byteLength;
		chunks.push(u8);

		if (contentLength) {
			const pct = ((received / contentLength) * 100).toFixed(1);
			print(`${pct}% (${toMB(received)} MB / ${totalText})`);
		} else {
			print(`${toMB(received)} MB / ${totalText}`);
		}
	}
	print(`100% (${toMB(received)} MB / ${totalText})`);
	process.stdout.write("\n");
	return chunks;
}

function nowStr() {
	return new Date()
	.toISOString()
	.replace("T", " ")
	.replace("Z", "");
}

function limit(concurrency: number) {
	let running = 0;
	const queue: (() => void)[] = [];
	const next = () => {
		running--;
		if (queue.length > 0) queue.shift()!();
	};
		return async <T>(fn: () => Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const run = async () => {
				running++;
				try {
					const v = await fn();
					resolve(v);
				} catch (error) {
					reject(error);
				} finally {
					next();
				}
			};
			if (running < concurrency) run();
			else queue.push(run);
		});
}

console.log(chalk.bgHex("#406ae1").white.bold(" Welcome to openplace "));

try {
	if (!yes) {
		console.log("");
		console.log(
			chalk.gray(
				"This script asks questions that require manual response. If you want to automate this script, run with --yes."
			)
		);
		if (!(await prompt("Ready to continue?"))) {
			process.exit(1);
		}
	}

	console.log("");
	console.log(chalk.gray("Running database migration:"));
	execSync("npm run db:deploy", { stdio: "inherit" });

	console.log("");
	console.log(chalk.gray("Running base database setup:"));

	const baseUsers = [
		{ id: -1, name: "System" },
		{ id: -2, name: "Deleted Account" }
	] as const;

	await prisma.$transaction(
		baseUsers.map((user) =>
		prisma.user.upsert({
			where: { id: user.id },
			update: {},
			create: {
				...user,
				country: "XX",
				passwordHash: "",
				banned: true
			}
		})
		)
	);

	const hasRegionData = (await prisma.region.count()) > 0;
	console.log("");
	console.log(
		chalk.gray(
			hasRegionData
			? "You already have region data. You can choose to update it:"
			: "Choose the region data you would like to use:"
		)
	);

	let regionSelection:
	| null
	| "cities500"
	| "cities1000"
	| "cities5000"
	| "allCountries" = null;

	if (!yes) {
		const regionChoice = await inquirer.prompt([
			{
				type: "list",
				name: "region",
				message: "GeoNames region data file:",
				choices: [
					{
						name: `Skip (${hasRegionData ? "keep existing data" : "don’t use region data"})`,
												   value: null
					},
					{
						name: "Cities with population > 500 (224,000+ entries, recommended)",
												   value: "cities500"
					},
					{
						name: "Cities with population > 1000 (162,000+ entries)",
												   value: "cities1000"
					},
					{
						name: "Cities with population > 5000 (66,000+ entries)",
												   value: "cities5000"
					},
					{
						name: "Pin-point landmarks (13 million+ entries, not recommended)",
												   value: "allCountries"
					}
				]
			}
		]);
		regionSelection = regionChoice.region;
	}

	if (regionSelection) {
		const countryCodesToIDs = new Map<string, number>(
			COUNTRIES.map((item) => [item.code, item.id])
		);

		console.log(chalk.gray("Downloading region data"));
		const zipChunks = await downloadToUint8Array(
			`https://download.geonames.org/export/dump/${regionSelection}.zip`
		);

		const zipReader = new ZipReader(new BlobReader(new Blob(zipChunks)));
		const entries = await zipReader.getEntries();
		const fileEntry = entries[0] as FileEntry | undefined;

		if (!fileEntry || fileEntry.directory) {
			await zipReader.close();
			throw new Error("Zip file did not contain the data file");
		}

		const transform = new TransformStream();
		const reader = transform.readable.getReader();
		const decoder = new TextDecoder();
		fileEntry.getData(transform.writable);

		let addedCount = 0;
		let buffer = "";
		let batch: string[] = [];
		const ignoredCountries = new Set<string>();

		const flushBatch = async () => {
			if (batch.length === 0) return;

			const lines = batch;
			batch = [];
			const dataToInsert: any[] = [];

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				const parts = trimmed.split("\t");
				const id = parts[0];
				const name = parts[1];
				const latitude = parts[4];
				const longitude = parts[5];
				const countryCode = parts[8];
				const population = parts[14];

				if (!id || !name || !latitude || !longitude || !countryCode || !population) continue;

				if (ignoredCountries.has(countryCode)) continue;

				const countryId = countryCodesToIDs.get(countryCode);
				if (!countryId) {
					ignoredCountries.add(countryCode);
					console.warn(
						chalk.yellow(`[${nowStr()}] Skipping unknown country:`),
								 countryCode
					);
					continue;
				}

				const parsedPopulation = population.trim() !== '' ? BigInt(population) : null;

				dataToInsert.push({
					cityId: Number(id),
								  name,
								  number: 1,
								  countryId,
								  latitude: Number(latitude),
								  longitude: Number(longitude),
								  population: parsedPopulation
				});
			}

			if (dataToInsert.length > 0) {
				try {
					await prisma.region.createMany({
						data: dataToInsert,
						skipDuplicates: true
					});
				} catch (error) {
					console.error("Batch insert failed:", error);
				}
			}

			addedCount += lines.length;
			process.stdout.write(
				chalk.blue(`\rImported ${addedCount.toLocaleString()} entries`)
			);
		};

		console.log(chalk.gray("Importing region data (streaming)…"));
		let hasData = true;
		while (hasData) {
			const { value, done } = await reader.read();
			hasData = !done;
			if (value) buffer += decoder.decode(value, { stream: true });

			let newlineIdx: number;
			while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newlineIdx);
				buffer = buffer.slice(newlineIdx + 1);
				batch.push(line);
				if (batch.length >= BATCH_SIZE) {
					await flushBatch();
				}
			}
		}

		if (buffer) {
			batch.push(...buffer.split("\n"));
			buffer = "";
		}
		await flushBatch();

		await reader.releaseLock();
		await zipReader.close();

		console.log("");
		console.log(chalk.blue.bold("Done"));
	}
} finally {
	await prisma.$disconnect();
}

process.on("SIGINT", async () => {
	console.log(chalk.gray("\nShutting down…"));
	try {
		await prisma.$disconnect();
	} finally {
		process.exit(0);
	}
});
