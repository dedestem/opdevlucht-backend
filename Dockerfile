FROM denoland/deno:latest

WORKDIR /app

COPY . .

EXPOSE 8000

CMD ["run", "--unstable", "--allow-net", "--allow-env", "server.ts"]
