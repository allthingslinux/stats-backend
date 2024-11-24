FROM node:22-alpine
WORKDIR /app
COPY package.json package.json
COPY package-lock.json package-lock.json

RUN npm install

# copy src/, prisma/, .env
COPY src/ src/
COPY prisma/ prisma/
COPY .env .env

RUN npx prisma generate
CMD ["npm", "run", "bot"]