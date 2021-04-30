# development stage
FROM node:14-alpine AS dev-stage

RUN apk add --no-cache make gcc g++ python

WORKDIR /srv

COPY package*.json ./

RUN npm install

COPY . .

ARG PACKAGE_VERSION=untagged
ENV PACKAGE_VERSION=${PACKAGE_VERSION}
LABEL com.chrisleekr.binance-trading-bot.package-version=${PACKAGE_VERSION}

ARG GIT_HASH=unspecified
ENV GIT_HASH=${GIT_HASH}
LABEL com.chrisleekr.binance-trading-bot.git-hash=${GIT_HASH}

ARG NODE_ENV=development
ENV NODE_ENV=${NODE_ENV}
LABEL com.chrisleekr.binance-trading-bot.node-env=${NODE_ENV}

CMD [ "npm", "run", "dev" ]

# build stage
FROM dev-stage AS build-stage

RUN npm run build

RUN rm -rf node_modules

RUN npm install --production

# production stage
FROM node:14-alpine AS production-stage

ARG PACKAGE_VERSION=untagged
ENV PACKAGE_VERSION=${PACKAGE_VERSION}
LABEL com.chrisleekr.binance-trading-bot.package-version=${PACKAGE_VERSION}

ARG GIT_HASH=unspecified
ENV GIT_HASH=${GIT_HASH}
LABEL com.chrisleekr.binance-trading-bot.git-hash=${GIT_HASH}

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
LABEL com.chrisleekr.binance-trading-bot.node-env=${NODE_ENV}

WORKDIR /srv

COPY --from=build-stage /srv /srv

CMD [ "npm", "start"]
