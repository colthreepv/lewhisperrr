FROM oven/bun:1.1.45

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json tsconfig.json ./
RUN bun install

COPY src ./src

CMD ["bun", "run", "start"]
