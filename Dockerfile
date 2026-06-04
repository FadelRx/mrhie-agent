FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# คาดหวังให้ mount config.json เข้ามา หรือ set AGENT_CONFIG
CMD ["node", "src/index.js"]
