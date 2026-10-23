FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV NODE_ENV=production PORT=5000
EXPOSE 5000
USER node
CMD ["node", "server.js"]
