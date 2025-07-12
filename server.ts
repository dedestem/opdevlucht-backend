import { Application, Router } from "https://deno.land/x/oak@v12.5.0/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { Client } from "https://deno.land/x/mysql@v2.10.2/mod.ts";

const client = await new Client().connect({
  hostname: Deno.env.get("DB_HOST") || "localhost",
  username: Deno.env.get("DB_USER") || "root",
  password: Deno.env.get("DB_PASSWORD") || "",
  db: Deno.env.get("DB_NAME") || "test",
  port: 3306,
});

// Init database tables als ze niet bestaan
await client.execute(`
  CREATE TABLE IF NOT EXISTS matches (
    id INT PRIMARY KEY AUTO_INCREMENT,
    koppelcode VARCHAR(10) NOT NULL UNIQUE,
    maxAantalSpelers INT NOT NULL,
    locatieInterval INT NOT NULL,
    spelDuur INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

// Functie om een unieke koppelcode te maken, bv. 6 letters/cijfers
function generateKoppelcode(length = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Check of koppelcode uniek is
async function generateUniqueKoppelcode(): Promise<string> {
  while (true) {
    const code = generateKoppelcode();
    const result = await client.execute(`SELECT id FROM matches WHERE koppelcode = ?`, [code]);
    if (result.rows?.length === 0) {
      return code;
    }
  }
}

const app = new Application();
const router = new Router();

// Enable CORS for all routes and origins
app.use(oakCors()); // <- This enables CORS with default settings (allow all origins)

// Root route
router.get("/", (ctx) => {
  ctx.response.body = "OK";
});

// Connectivity check route
router.get("/connectivitycheck", (ctx) => {
  ctx.response.status = 200;
  ctx.response.body = { status: "OK", timestamp: new Date().toISOString() };
});

router.post("/create-match", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;

    const { maxAantalSpelers, locatieInterval, spelDuur } = body;

    // Geldig check
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

    // Insert in DB
    const result = await client.execute(
      `INSERT INTO matches (koppelcode, maxAantalSpelers, locatieInterval, spelDuur) VALUES (?, ?, ?, ?)`,
      [koppelcode, maxAantalSpelers, locatieInterval, spelDuur],
    );

    const insertId = result.lastInsertId;
    console.log(result.id)
    console.log(result.insertId)
    console.log(result.lastInsertId)

    ctx.response.status = 200;
    ctx.response.body = {
      id: insertId,
      koppelcode,
    };
  } catch {
    ctx.response.status = 500;
    ctx.response.body = { error: "unknown" };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

console.log("Server running on http://localhost:4500");
await app.listen({ port: 4500 });
