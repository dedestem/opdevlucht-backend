FROM denoland/deno:alpine-2.4.1

WORKDIR /app

COPY . .

EXPOSE 8000

CMD ["run", "--allow-net", "--allow-env", "server.ts"]
