FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY src/ ./src/
COPY tsconfig.json ./
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist/ ./dist/
COPY system-prompt.txt compaction-prompt.txt agent-prompt.txt ./
COPY entrypoint.sh ./
EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "dist/index.js"]
