// server.ts

import { Application, Router } from "https://deno.land/x/oak@v12.5.0/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { Client } from "https://deno.land/x/mysql/mod.ts";

// Maak MySQL client aan
const client = await new Client().connect({
  hostname: Deno.env.get("DB_HOST"),
  username: Deno.env.get("DB_USER"),
  password: Deno.env.get("DB_PASSWORD"),
  db: Deno.env.get("DB_NAME"),
  port: 3306,
});

// Functie om te wachten tot de DB klaar is
async function waitForDbReady(retries = 20, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await client.execute("SELECT 1");
      console.log("DB is ready!");
      return;
    } catch (error) {
      console.log(`DB nog niet ready, probeer opnieuw in ${delayMs}ms... Error: ${error.message}`);
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw new Error("DB connectie mislukt na meerdere pogingen");
}

await waitForDbReady();

// Init database tabel als hij niet bestaat
const createTableQuery = `
  CREATE TABLE IF NOT EXISTS matches (
    id INT PRIMARY KEY AUTO_INCREMENT,
    koppelcode VARCHAR(10) NOT NULL UNIQUE,
    maxAantalSpelers INT NOT NULL,
    locatieInterval INT NOT NULL,
    spelDuur INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`;

await client.execute(createTableQuery);

// Koppelcode generator
function generateKoppelcode(length = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function generateUniqueKoppelcode(): Promise<string> {
  while (true) {
    const code = generateKoppelcode();
    const result = await client.query("SELECT id FROM matches WHERE koppelcode = ?", [code]);
    if (result.length === 0) {
      return code;
    }
  }
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

// Create match
router.post("/create-match", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const { maxAantalSpelers, locatieInterval, spelDuur } = body;

    if (
      typeof maxAantalSpelers !== "number" || maxAantalSpelers <= 0 ||
      typeof locatieInterval !== "number" || locatieInterval <= 0 ||
      typeof spelDuur !== "number" || spelDuur <= 0
    ) {
      ctx.response.status = 400;
      ctx.response.body = { error: "invalid data" };
      return;
    }

    const koppelcode = await generateUniqueKoppelcode();

    const result = await client.execute(
      `INSERT INTO matches (koppelcode, maxAantalSpelers, locatieInterval, spelDuur) VALUES (?, ?, ?, ?)`,
      [koppelcode, maxAantalSpelers, locatieInterval, spelDuur],
    );

    ctx.response.status = 200;
    ctx.response.body = {
      id: result.lastInsertId,
      koppelcode,
    };
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
