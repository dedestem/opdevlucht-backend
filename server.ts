// server.ts

import { Application, Router } from "https://deno.land/x/oak@v12.5.0/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import mysql from "npm:mysql2/promise";

// Maak een MySQL connection pool
const pool = mysql.createPool({
  host: Deno.env.get("DB_HOST"),
  user: Deno.env.get("DB_USER"),
  password: Deno.env.get("DB_PASSWORD"),
  database: Deno.env.get("DB_NAME"),
  port: 3306,
  waitForConnections: true,
  connectionLimit: 10,
});

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

const connection = await pool.getConnection();
await connection.query(createTableQuery);
connection.release();

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
    const [rows] = await pool.query(
      `SELECT id FROM matches WHERE koppelcode = ?`,
      [code],
    ) as [any[], any];
    if (rows.length === 0) {
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

    const [result] = await pool.query(
      `INSERT INTO matches (koppelcode, maxAantalSpelers, locatieInterval, spelDuur) VALUES (?, ?, ?, ?)`,
      [koppelcode, maxAantalSpelers, locatieInterval, spelDuur],
    ) as [mysql.ResultSetHeader, any];

    ctx.response.status = 200;
    ctx.response.body = {
      id: result.insertId,
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
