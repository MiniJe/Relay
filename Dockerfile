FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 4000
CMD ["sh", "-c", "npm run migrate && npm run start"]
