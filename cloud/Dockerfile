# Impulse Cloud as a container (Google Cloud Run, or any host that runs one).
# The server reads its settings from the environment (see .env.example),
# migrates the database on start, and serves the API and public/ on $PORT.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY public ./public
# Cloud Run sets PORT; the server must listen on every interface in a container.
ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
CMD ["node", "scripts/serve.js"]
