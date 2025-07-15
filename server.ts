// deno-lint-ignore-file no-explicit-any
import { Application, Router } from "https://deno.land/x/oak@v12.5.0/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { Client } from "https://deno.land/x/mysql/mod.ts";

// TODO
// Add last_interacted to match info. To expire based on that.
// Let players expire based on an alive ping

// Create MySQL client
const client = await new Client().connect({
  hostname: Deno.env.get("DB_HOST"),
  username: Deno.env.get("DB_USER"),
  password: Deno.env.get("DB_PASSWORD"),
  db: Deno.env.get("DB_NAME"),
  port: 3306,
});

// Function to wait until DB is ready
async function waitForDbReady(retries = 20, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await client.execute("SELECT 1");
      console.log("DB is ready!");
      return;
    } catch (error: any) {
      console.log(
        `DB not ready yet, retrying in ${delayMs}ms... Error: ${error.message}`,
      );
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw new Error("DB connection failed after multiple attempts");
}

await waitForDbReady();

// Initialize database tables if they don't exist
const createMatchesTableQuery = `
  CREATE TABLE IF NOT EXISTS matches (
    id INT PRIMARY KEY AUTO_INCREMENT,
    joincode VARCHAR(10) NOT NULL UNIQUE,
    maxplayers INT NOT NULL,
    locationinterval INT NOT NULL,
    matchtime INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(30) NOT NULL,
    started_at VARCHAR(30) NULL,
    current_iteration INT DEFAULT 0
  )
`;

const createSessionsTableQuery = `
  CREATE TABLE IF NOT EXISTS sessions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    match_id INT NOT NULL,
    name VARCHAR(50) NOT NULL,
    role ENUM('hunter', 'criminal') NOT NULL,
    is_owner BOOLEAN DEFAULT FALSE,
    token VARCHAR(36) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    picture TEXT NOT NULL, 
    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
  )
`;

const createLocationsTableQuery = `
  CREATE TABLE IF NOT EXISTS locations (
    id INT PRIMARY KEY AUTO_INCREMENT,
    session_id INT NOT NULL,
    lat DOUBLE NOT NULL,
    lon DOUBLE NOT NULL,
    iteration INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`;

await client.execute(createMatchesTableQuery);
await client.execute(createSessionsTableQuery);
await client.execute(createLocationsTableQuery);

// Join code generator
function generateJoinCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function generateUniqueJoinCode(): Promise<string> {
  while (true) {
    const code = generateJoinCode();
    const result = await client.query(
      "SELECT id FROM matches WHERE joincode = ?",
      [code],
    );
    if (result.length === 0) {
      return code;
    }
  }
}

// Token generator (UUID v4)
function generateToken(): string {
  // gebruik crypto API om een UUID te maken
  // Deno ondersteund crypto.randomUUID sinds v1.8
  return crypto.randomUUID();
}

function GenPlrPic(name: string): string {
  // Get initials based on the rules
  const words = name.trim().split(/\s+/);
  let initials = "";

  if (words.length === 1) {
    const w = words[0];
    initials = (w[0] + (w[1] || "")).toUpperCase();
  } else {
    initials = (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }

  // Generate random pastel color for background
  // Pastel colors are easier on eyes, use HSL with fixed saturation/lightness
  const hue = Math.floor(Math.random() * 360);
  const bgColor = `hsl(${hue}, 70%, 80%)`;
  const textColor = `hsl(${hue}, 70%, 30%)`;

  // SVG size
  const size = 128;

  // Create SVG string
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${
    size / 2
  }" fill="${bgColor}" />
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="${textColor}" font-family="Arial, Helvetica, sans-serif" font-weight="bold" font-size="64">${initials}</text>
    </svg>`.trim();

  // Convert SVG to base64
  const base64 = btoa(unescape(encodeURIComponent(svg)));

  return `data:image/svg+xml;base64,${base64}`;
}

async function deleteExpiredMatches() {
  console.log("Running match cleanup...");

  const result = await client.execute(`
    DELETE FROM matches
    WHERE NOW() > DATE_ADD(created_at, INTERVAL (matchtime + 30) MINUTE)
  `);

  console.log(
    `Deleted ${result.affectedRows} expired matches.`,
  );
  console.log(
    "Next scheduled deletion of expired matches is at: " +
      new Date(Date.now() + 30 * 60 * 1000).toTimeString().slice(0, 5),
  );
}

const app = new Application();
const router = new Router();

app.use(oakCors());

// Root route
router.get("/", (ctx) => {
  ctx.response.body = "OK";
});

// Connectivity check
router.get("/connectivitycheck", (ctx) => {
  ctx.response.status = 200;
  ctx.response.body = { status: "OK", timestamp: new Date().toISOString() };
});

// Create match endpoint - maker is owner en krijgt rol 'hunter' + token
router.post("/create-match", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const { maxPlayers, locationInterval, matchDuration, name } = body;

    if (
      typeof maxPlayers !== "number" || maxPlayers <= 0 ||
      typeof locationInterval !== "number" || locationInterval <= 0 ||
      typeof matchDuration !== "number" || matchDuration <= 0 ||
      typeof name !== "string" || name.trim() === ""
    ) {
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid data" };
      return;
    }

    const joincode = await generateUniqueJoinCode();

    const result = await client.execute(
      `INSERT INTO matches (joincode, maxplayers, locationinterval, matchtime, status) VALUES (?, ?, ?, ?, ?)`,
      [joincode, maxPlayers, locationInterval, matchDuration, "lobby"],
    );

    const matchId = result.lastInsertId;

    // Maker token
    const token = generateToken();
    const picture = GenPlrPic(name);

    // Maker toevoegen als owner met rol hunter
    await client.execute(
      `INSERT INTO sessions (match_id, name, role, is_owner, token, picture) VALUES (?, ?, ?, ?, ?, ?)`,
      [matchId, name.trim(), "hunter", true, token, picture],
    );

    ctx.response.status = 200;
    ctx.response.body = {
      id: matchId,
      joincode,
      token,
      role: "hunter",
      picture,
    };
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "unknown error" };
  }
});

// Join match endpoint - speler krijgt een rol (evenwichtig), token en id terug
router.post("/join-match", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const { joincode, name } = body;

    if (
      typeof joincode !== "string" || joincode.trim() === "" ||
      typeof name !== "string" || name.trim() === ""
    ) {
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid data" };
      return;
    }

    // Zoek match
    const matches = await client.query(
      "SELECT * FROM matches WHERE joincode = ?",
      [joincode.trim()],
    );
    if (matches.length === 0) {
      ctx.response.status = 404;
      ctx.response.body = { error: "match not found" };
      return;
    }
    const match = matches[0];

    // Check spelers aantal
    const players = await client.query(
      "SELECT * FROM sessions WHERE match_id = ?",
      [match.id],
    );
    if (players.length >= match.maxplayers) {
      ctx.response.status = 403;
      ctx.response.body = { error: "match is full" };
      return;
    }

    // Eerlijke rol verdeling
    const huntersCount = players.filter((p: any) => p.role === "hunter").length;
    const criminalsCount = players.filter((p: any) =>
      p.role === "criminal"
    ).length;
    const role = huntersCount <= criminalsCount ? "hunter" : "criminal";

    // Nieuwe token voor speler
    const token = generateToken();
    const picture = GenPlrPic(name);

    // Voeg speler toe
    const _insertResult = await client.execute(
      `INSERT INTO sessions (match_id, name, role, is_owner, token, picture) VALUES (?, ?, ?, ?, ?, ?)`,
      [match.id, name.trim(), role, false, token, picture],
    );

    ctx.response.status = 200;
    ctx.response.body = {
      role,
      token,
      matchId: match.id,
      picture,
    };
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "unknown error" };
  }
});

// Endpoint om rollen aan te passen (alleen door owner)
// Verwacht JSON body: { matchId, playerId, newRole, token }
router.post("/change-role", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const { matchId, playerId, newRole, token } = body;

    if (!["hunter", "criminal"].includes(newRole)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid role" };
      return;
    }

    if (
      typeof matchId !== "number" ||
      typeof playerId !== "number" ||
      typeof token !== "string"
    ) {
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid data" };
      return;
    }

    // Check of requester owner is
    const requester = await client.query(
      "SELECT * FROM sessions WHERE token = ? AND match_id = ? AND is_owner = TRUE",
      [token, matchId],
    );
    if (requester.length === 0) {
      ctx.response.status = 403;
      ctx.response.body = { error: "not authorized" };
      return;
    }

    // Update rol van speler
    const _updateResult = await client.execute(
      "UPDATE sessions SET role = ? WHERE id = ? AND match_id = ?",
      [newRole, playerId, matchId],
    );

    ctx.response.status = 200;
    ctx.response.body = { status: "ok" };
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "unknown error" };
  }
});

// Endpoint om spelerslijst op te halen per match
router.get("/match-players/:joincode", async (ctx) => {
  const joincode = ctx.params.joincode;
  if (!joincode) {
    ctx.response.status = 400;
    ctx.response.body = { error: "joincode required" };
    return;
  }

  const matches = await client.query(
    "SELECT * FROM matches WHERE joincode = ?",
    [joincode],
  );
  if (matches.length === 0) {
    ctx.response.status = 404;
    ctx.response.body = { error: "match not found" };
    return;
  }

  const match = matches[0];
  const players = await client.query(
    "SELECT id, name, role, is_owner, picture FROM sessions WHERE match_id = ?",
    [match.id],
  );

  ctx.response.status = 200;
  ctx.response.body = { players };
});

router.post("/leave-match", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const { token } = body;

    if (typeof token !== "string" || token.trim() === "") {
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid token" };
      return;
    }

    // Zoek sessie
    const sessions = await client.query(
      "SELECT * FROM sessions WHERE token = ?",
      [token.trim()],
    );

    if (sessions.length === 0) {
      console.log("Session not found");
      ctx.response.status = 404;
      ctx.response.body = { error: "session not found" };
      return;
    }

    const session = sessions[0];

    // Haal match_id op
    const matchId = session.match_id;

    // Verwijder sessie
    await client.execute(
      "DELETE FROM sessions WHERE id = ?",
      [session.id],
    );

    // Zoek resterende spelers in dezelfde match
    const remainingSessions = await client.query(
      "SELECT * FROM sessions WHERE match_id = ? ORDER BY created_at ASC",
      [matchId],
    );

    if (remainingSessions.length === 0) {
      // Verwijder de match zelf als er geen spelers meer zijn
      await client.execute(
        "DELETE FROM matches WHERE id = ?",
        [matchId],
      );

      ctx.response.status = 200;
      ctx.response.body = {
        success: true,
        info: "match deleted because no players left",
      };
      return;
    }

    // Als de vertrekkende speler de owner was: promote de volgende oudste
    if (session.is_owner) {
      const nextOwner = remainingSessions[0];
      await client.execute(
        "UPDATE sessions SET is_owner = TRUE WHERE id = ?",
        [nextOwner.id],
      );
    }

    ctx.response.status = 200;
    ctx.response.body = { success: true };
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "unknown error" };
  }
});

// Endpoint om match info op te halen.
router.get("/match-status/:joincode", async (ctx) => {
  const joincode = ctx.params.joincode;
  if (!joincode) {
    ctx.response.status = 400;
    ctx.response.body = { error: "jomatch-statusincode required" };
    return;
  }

  const match = await client.query(
    "SELECT * FROM matches WHERE joincode = ?",
    [joincode],
  );

  if (match.length === 0) {
    ctx.response.status = 404;
    ctx.response.body = { error: "match not found" };
    return;
  }

  const now = new Date().toISOString();
  ctx.response.status = 200;
  ctx.response.body = { match, now };
});

// Endpoint om match te starten
// Verwacht JSON body: { token }
router.post("/start-match", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const { matchId, token } = body;

    // Check if requester is owner
    const requester = await client.query(
      "SELECT * FROM sessions WHERE token = ? AND match_id = ? AND is_owner = TRUE",
      [token, matchId],
    );
    if (requester.length === 0) {
      ctx.response.status = 403;
      ctx.response.body = { error: "not authorized" };
      return;
    }

    // Check if there's at least 1 hunter and 1 criminal
    const roles = await client.query(
      `SELECT role, COUNT(*) as count 
       FROM sessions 
       WHERE match_id = ? 
       GROUP BY role`,
      [matchId],
    );

    const hasHunter = roles.some((r: any) =>
      r.role === "hunter" && r.count > 0
    );
    const hasCriminal = roles.some((r: any) =>
      r.role === "criminal" && r.count > 0
    );

    if (!hasHunter || !hasCriminal) {
      ctx.response.status = 400;
      ctx.response.body = {
        error:
          "At least 1 hunter and 1 criminal are required to start the match.",
      };
      return;
    }

    const startsAt = new Date(Date.now() + 25000); // 25 sec in de toekomst

    await client.execute(
      "UPDATE matches SET status = ?, started_at = ? WHERE id = ?",
      ["starting", startsAt.toISOString(), matchId],
    );

    // Respond immediately to avoid timeout
    console.log("Starting match: " + matchId);
    ctx.response.status = 200;
    ctx.response.body = { status: "ok" };

    // Actually start the match after a delay
    setTimeout(async () => {
      console.log("Started match: " + matchId);
      await client.execute(
        "UPDATE matches SET status = ? WHERE id = ?",
        ["started", matchId],
      );
    }, 25 * 1000);
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "unknown error" };
  }
});

router.post("/send-location", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const { token, lat, lon } = body;

    if (
      typeof token !== "string" ||
      typeof lat !== "number" ||
      typeof lon !== "number"
    ) {
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid input" };
      return;
    }

    // Start transaction
    await client.execute("START TRANSACTION");

    // Zoek criminal sessie
    const sessions = await client.query(
      "SELECT * FROM sessions WHERE token = ? AND role = 'criminal'",
      [token.trim()],
    );

    if (sessions.length === 0) {
      await client.execute("ROLLBACK");
      ctx.response.status = 404;
      ctx.response.body = { error: "criminal session not found" };
      return;
    }

    const session = sessions[0];

    // Haal match info + current_iteration
    const matches = await client.query(
      "SELECT * FROM matches WHERE id = ?",
      [session.match_id],
    );

    if (matches.length === 0) {
      await client.execute("ROLLBACK");
      ctx.response.status = 404;
      ctx.response.body = { error: "match not found" };
      return;
    }

    const match = matches[0];
    const currentIteration = match.current_iteration || 0;

    // Haal laatste iteration van deze criminal
    const latestLoc = await client.query(
      "SELECT iteration FROM locations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
      [session.id],
    );

    const lastIteration = latestLoc.length > 0 ? latestLoc[0].iteration : null;

    // Hier de nieuwe check voor 2+ iteraties achterstand
    if (lastIteration !== null && lastIteration < currentIteration - 1) {
      // Zoek sessie
      const sessions = await client.query(
        "SELECT * FROM sessions WHERE token = ?",
        [token.trim()],
      );

      if (sessions.length === 0) {
        console.log("Session not found");
        ctx.response.status = 404;
        ctx.response.body = { error: "session not found" };
        return;
      }

      const session = sessions[0];

      console.log(
        `Criminal with session id ${session.id} is 2 or more iterations behind.`,
      );

      // Haal match_id op
      const matchId = session.match_id;

      // Verwijder sessie
      await client.execute(
        "DELETE FROM sessions WHERE id = ?",
        [session.id],
      );

      // Zoek resterende spelers in dezelfde match
      const remainingSessions = await client.query(
        "SELECT * FROM sessions WHERE match_id = ? ORDER BY created_at ASC",
        [matchId],
      );

      if (remainingSessions.length === 0) {
        // Verwijder de match zelf als er geen spelers meer zijn
        await client.execute(
          "DELETE FROM matches WHERE id = ?",
          [matchId],
        );

        ctx.response.status = 404;
        ctx.response.body = {
          success: true,
          info: "criminal too far behind in iterations",
          extra: "Match deleted no players left",
        };
        return;
      }

      // Als de vertrekkende speler de owner was: promote de volgende oudste
      if (session.is_owner) {
        const nextOwner = remainingSessions[0];
        await client.execute(
          "UPDATE sessions SET is_owner = TRUE WHERE id = ?",
          [nextOwner.id],
        );
      }

      await client.execute("ROLLBACK");
      ctx.response.status = 404;
      ctx.response.body = { error: "criminal too far behind in iterations" };
      return;
    }

    if (lastIteration === null) {
      // Geen locatie nog → INSERT eerste
      await client.execute(
        "INSERT INTO locations (session_id, lat, lon, iteration) VALUES (?, ?, ?, ?)",
        [session.id, lat, lon, currentIteration],
      );
    } else if (lastIteration === currentIteration) {
      // UPDATE huidige
      await client.execute(
        "UPDATE locations SET lat = ?, lon = ?, created_at = CURRENT_TIMESTAMP WHERE session_id = ? AND iteration = ?",
        [lat, lon, session.id, currentIteration],
      );
    } else if (lastIteration < currentIteration) {
      // Nieuwe iteration → INSERT
      await client.execute(
        "INSERT INTO locations (session_id, lat, lon, iteration) VALUES (?, ?, ?, ?)",
        [session.id, lat, lon, currentIteration],
      );
    } else {
      await client.execute("ROLLBACK");
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid iteration" };
      return;
    }

    // Check of ALLE criminals nu geüpload hebben voor deze iteration
    const criminals = await client.query(
      "SELECT id FROM sessions WHERE match_id = ? AND role = 'criminal'",
      [session.match_id],
    );

    let allUploaded = true;

    for (const criminal of criminals) {
      const loc = await client.query(
        "SELECT id FROM locations WHERE session_id = ? AND iteration = ?",
        [criminal.id, currentIteration],
      );
      if (loc.length === 0) {
        allUploaded = false;
        break;
      }
    }

    // Als alle criminelen geüpload hebben, update iteration
    if (allUploaded) {
      await client.execute(
        "UPDATE matches SET current_iteration = ? WHERE id = ?",
        [currentIteration + 1, session.match_id],
      );
    }

    // Commit de hele transaction
    await client.execute("COMMIT");

    ctx.response.status = 200;
    ctx.response.body = {
      success: true,
      currentIteration,
      allUploaded,
    };
  } catch (err) {
    console.error(err);
    await client.execute("ROLLBACK");
    ctx.response.status = 500;
    ctx.response.body = { error: "unknown error" };
  }
});

router.get("/get-criminals-locations", async (ctx) => {
  try {
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get("token");

    if (!token || token.trim() === "") {
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid token" };
      return;
    }

    // Vind hunter sessie
    const sessions = await client.query(
      "SELECT * FROM sessions WHERE token = ? AND role = 'hunter'",
      [token.trim()],
    );

    if (sessions.length === 0) {
      ctx.response.status = 404;
      ctx.response.body = { error: "hunter session not found" };
      return;
    }

    const hunterSession = sessions[0];
    const matchId = hunterSession.match_id;

    // Haal globale iteration
    const matches = await client.query(
      "SELECT current_iteration FROM matches WHERE id = ?",
      [matchId],
    );

    const currentIteration = matches[0]?.current_iteration || 0;

    // Zoek alle criminals
    const criminals = await client.query(
      "SELECT id, name FROM sessions WHERE match_id = ? AND role = 'criminal'",
      [matchId],
    );

    const locations: Record<
      string,
      { lat: number; lon: number; iteration: number }
    > = {};

    for (const criminal of criminals) {
      const loc = await client.query(
        "SELECT lat, lon, iteration FROM locations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
        [criminal.id],
      );

      if (loc.length > 0) {
        locations[criminal.name] = {
          lat: loc[0].lat,
          lon: loc[0].lon,
          iteration: loc[0].iteration,
        };
      }
    }

    ctx.response.status = 200;
    ctx.response.body = {
      NewestIteration: currentIteration,
      locations,
    };
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "unknown error" };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

deleteExpiredMatches();
setInterval(deleteExpiredMatches, 30 * 60 * 1000);

console.log("Server running on http://localhost:4500");
await app.listen({ port: 4500 });
