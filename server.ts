import { Application, Router } from "https://deno.land/x/oak@v12.5.0/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { Client } from "https://deno.land/x/mysql/mod.ts";

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
    } catch (error) {
      console.log(`DB not ready yet, retrying in ${delayMs}ms... Error: ${error.message}`);
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
  )
`;

await client.execute(createMatchesTableQuery);
await client.execute(createSessionsTableQuery);

// Join code generator
function generateJoinCode(length = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function generateUniqueJoinCode(): Promise<string> {
  while (true) {
    const code = generateJoinCode();
    const result = await client.query("SELECT id FROM matches WHERE joincode = ?", [code]);
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
      `INSERT INTO matches (joincode, maxplayers, locationinterval, matchtime) VALUES (?, ?, ?, ?)`,
      [joincode, maxPlayers, locationInterval, matchDuration],
    );

    const matchId = result.lastInsertId;

    // Maker token
    const token = generateToken();

    // Maker toevoegen als owner met rol hunter
    await client.execute(
      `INSERT INTO sessions (match_id, name, role, is_owner, token) VALUES (?, ?, ?, ?, ?)`,
      [matchId, name.trim(), 'hunter', true, token],
    );

    ctx.response.status = 200;
    ctx.response.body = {
      id: matchId,
      joincode,
      token,
      role: 'hunter',
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
    const matches = await client.query("SELECT * FROM matches WHERE joincode = ?", [joincode.trim()]);
    if (matches.length === 0) {
      ctx.response.status = 404;
      ctx.response.body = { error: "match not found" };
      return;
    }
    const match = matches[0];

    // Check spelers aantal
    const players = await client.query("SELECT * FROM sessions WHERE match_id = ?", [match.id]);
    if (players.length >= match.maxplayers) {
      ctx.response.status = 403;
      ctx.response.body = { error: "match is full" };
      return;
    }

    // Eerlijke rol verdeling
    const huntersCount = players.filter(p => p.role === 'hunter').length;
    const criminalsCount = players.filter(p => p.role === 'criminal').length;
    const role = huntersCount <= criminalsCount ? 'hunter' : 'criminal';

    // Nieuwe token voor speler
    const token = generateToken();

    // Voeg speler toe
    const _insertResult = await client.execute(
      `INSERT INTO sessions (match_id, name, role, is_owner, token) VALUES (?, ?, ?, ?, ?)`,
      [match.id, name.trim(), role, false, token],
    );

    ctx.response.status = 200;
    ctx.response.body = {
      role,
      token,
      matchId: match.id,
    };
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "unknown error" };
  }
});

// Endpoint om rollen aan te passen (alleen door owner)
// Verwacht JSON body: { matchId, playerId, newRole, tokenRequester }
router.post("/change-role", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const { matchId, playerId, newRole, tokenRequester } = body;

    if (!['hunter', 'criminal'].includes(newRole)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid role" };
      return;
    }

    if (
      typeof matchId !== "number" ||
      typeof playerId !== "number" ||
      typeof tokenRequester !== "string"
    ) {
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid data" };
      return;
    }

    // Check of requester owner is
    const requester = await client.query(
      "SELECT * FROM sessions WHERE token = ? AND match_id = ? AND is_owner = TRUE",
      [tokenRequester, matchId]
    );
    if (requester.length === 0) {
      ctx.response.status = 403;
      ctx.response.body = { error: "not authorized" };
      return;
    }

    // Update rol van speler
    const _updateResult = await client.execute(
      "UPDATE sessions SET role = ? WHERE id = ? AND match_id = ?",
      [newRole, playerId, matchId]
    );

    ctx.response.status = 200;
    ctx.response.body = { status: "ok" };
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "unknown error" };
  }
});

// Endpoint om spelerslijst op te halen per match (naam, rol, is_owner)
router.get("/match-players/:joincode", async (ctx) => {
  const joincode = ctx.params.joincode;
  if (!joincode) {
    ctx.response.status = 400;
    ctx.response.body = { error: "joincode required" };
    return;
  }

  const matches = await client.query("SELECT * FROM matches WHERE joincode = ?", [joincode]);
  if (matches.length === 0) {
    ctx.response.status = 404;
    ctx.response.body = { error: "match not found" };
    return;
  }

  const match = matches[0];
  const players = await client.query("SELECT id, name, role, is_owner FROM sessions WHERE match_id = ?", [match.id]);

  ctx.response.status = 200;
  ctx.response.body = { players };
});

// Leave match endpoint - speler verlaat de match via zijn token
router.post("/leave-match", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const { token } = body;

    if (typeof token !== "string" || token.trim() === "") {
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid token" };
      return;
    }

    // Zoek speler sessie
    const sessions = await client.query(
      "SELECT * FROM sessions WHERE token = ?",
      [token.trim()],
    );
    if (sessions.length === 0) {
      ctx.response.status = 404;
      ctx.response.body = { error: "session not found" };
      return;
    }

    const session = sessions[0];

    // Verwijder sessie
    await client.execute(
      "DELETE FROM sessions WHERE id = ?",
      [session.id],
    );

    ctx.response.status = 200;
    ctx.response.body = { success: true };
  } catch (err) {
    console.error(err);
    ctx.response.status = 500;
    ctx.response.body = { error: "unknown error" };
  }
});


app.use(router.routes());
app.use(router.allowedMethods());

console.log("Server running on http://localhost:4500");
await app.listen({ port: 4500 });
