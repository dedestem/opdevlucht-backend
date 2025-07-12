import { Application, Router } from "https://deno.land/x/oak@v12.5.0/mod.ts";

const app = new Application();
const router = new Router();

router.get("/", async (ctx) => {
  ctx.response.body = "OK";
});

app.use(router.routes());
app.use(router.allowedMethods());

await app.listen({ port: 8000 });
