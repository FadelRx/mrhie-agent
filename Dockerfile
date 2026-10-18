FROM node:20-alpine
WORKDIR /app
# ติดตั้งตาม lockfile (ชุดเดียวกับที่ผ่าน npm audit ใน CI) — ไม่ resolve เวอร์ชันใหม่ตอน build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# secret/สถานะของเครื่อง build ถูกกันไว้ใน .dockerignore — ค่าจริงอยู่ใน volume /data
COPY . .
# คาดหวังให้ mount config.json เข้ามา หรือ set AGENT_CONFIG
CMD ["node", "src/index.js"]
