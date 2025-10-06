import { App } from "@tinyhttp/app";
import { cors } from "@tinyhttp/cors";
import { cookieParser } from "@tinyhttp/cookie-parser";
import dotenv from "dotenv";
import { inspect } from "util";
import admin from "./routes/admin.js";
import alliance from "./routes/alliance.js";
import auth from "./routes/auth.js";
import favoriteLocation from "./routes/favorite-location.js";
import leaderboard from "./routes/leaderboard.js";
import me from "./routes/me.js";
import moderator from "./routes/moderator.js";
import pixel from "./routes/pixel.js";
import reportUser from "./routes/report-user.js";
import store from "./routes/store.js";
import { addPrismaToRequest } from "./config/database.js";
import fs from "fs/promises";
import { json } from "milliparsec";
import sirv from "sirv";

dotenv.config();

const isDev = process.env["NODE_ENV"] !== "production";

const noMatchPage = await fs.readFile("./frontend/404.html", "utf8");

const app = new App({
	noMatchHandler: async (_req, res) => {
		return res.status(404)
			.set("Content-Type", "text/html")
			.send(noMatchPage);
	}
});

app.use(cors());
app.use(cookieParser());

const jsonMiddleware = json({
	payloadLimit: 50 * 1024 * 1024 // 50 MB
});

app.use((req, res, next) => {
	// Hack: /report-user uses multipart, not json
	if (req.path === "/report-user") {
		return next?.();
	}

	return jsonMiddleware(req, res, next);
});

// Logging
app.use((req, res, next) => {
	const inspectOptions = { colors: true, compact: true, breakLength: Number.POSITIVE_INFINITY };
	const startTime = Date.now();
	const requestId = req.get("x-forwarded-for");

	console.log(`[${requestId}] [${new Date()
		.toISOString()}] ${req.method} ${req.url}`);
	console.log(`[${requestId}] Headers:`, inspect(req.headers, inspectOptions));
	if (req.body && Object.keys(req.body).length > 0) {
		console.log(`[${requestId}] Body:`, inspect(req.body, inspectOptions));
	}

	const originalJson = res.json;
	res.json = function (data) {
		const duration = Date.now() - startTime;
		console.log(`[${requestId}] Response JSON (${res.statusCode}) [${duration}ms]:`, inspect(data, inspectOptions));
		return originalJson.call(this, data);
	};

	return next?.();
});

app.use(addPrismaToRequest);

admin(app);
alliance(app);
auth(app);
favoriteLocation(app);
leaderboard(app);
me(app);
moderator(app);
pixel(app);
reportUser(app);
store(app);

app.use(sirv("./frontend", {
	dev: isDev
}));

const port = Number(process.env["PORT"]) || Number(process.env["BACKEND_PORT"]) || 3000;
const host = process.env["HOST"] || "0.0.0.0";

app.listen(port, host, () => {
	console.log(`Server running on ${host}:${port}`);
});
