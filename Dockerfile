FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS development
# Native dependencies may compile when a platform has no prebuilt binary.
ARG TARGETARCH
COPY docker/apk/${TARGETARCH}/api-build.lock /tmp/packages.lock
COPY docker/apk/${TARGETARCH}/api-build.sha256 /tmp/packages.sha256
RUN mkdir /tmp/apks \
    && apk update \
    && apk fetch --recursive --output /tmp/apks $(grep -v '^#' /tmp/packages.lock) \
    && cd /tmp/apks && sha256sum -c /tmp/packages.sha256 \
    && test "$(ls -1 *.apk | wc -l)" -eq "$(wc -l < /tmp/packages.sha256)" \
    && apk add --no-network /tmp/apks/*.apk \
    && rm -rf /tmp/apks /tmp/packages.lock /tmp/packages.sha256 /var/cache/apk/*
WORKDIR /src
COPY package.json package-lock.json ./
COPY scripts/update-package-type.js ./scripts/update-package-type.js
# Bound dependency resolution separately from TypeScript compilation. Native
# install scripts inherit this limit as well; the builder still needs a cgroup cap.
ARG INSTALL_NODE_OPTIONS=--max-old-space-size=512
# Private repository authentication exists only in this RUN's process environment.
# Never write the token into a Git URL/configuration file or an image ENV layer.
RUN --mount=type=secret,id=GITHUB_TOKEN \
    export GIT_CONFIG_COUNT=2 \
      GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf \
      GIT_CONFIG_VALUE_0=ssh://git@github.com/ \
      GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf \
      GIT_CONFIG_VALUE_1=git@github.com: \
    && if [ -s /run/secrets/GITHUB_TOKEN ]; then \
      export GIT_CONFIG_COUNT=3 \
        GIT_CONFIG_KEY_2=http.https://github.com/.extraHeader \
        GIT_CONFIG_VALUE_2="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$(cat /run/secrets/GITHUB_TOKEN)" | base64 | tr -d '\n')"; \
    fi \
    && NODE_OPTIONS="$INSTALL_NODE_OPTIONS" npm ci --no-audit --no-fund \
    && npm cache clean --force
COPY . .
CMD ["npm", "run", "start:dev"]

FROM development AS build
ARG BUILD_NODE_OPTIONS=--max-old-space-size=1152
RUN NODE_OPTIONS="$BUILD_NODE_OPTIONS" npm run build
RUN NODE_OPTIONS="$INSTALL_NODE_OPTIONS" npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
ENV NODE_ENV=production
# Verify exact signed archives, including transitive media dependencies.
ARG TARGETARCH
COPY docker/apk/${TARGETARCH}/runtime.lock /usr/share/superhero-build/apk.lock
COPY docker/apk/${TARGETARCH}/runtime.sha256 /usr/share/superhero-build/apk.sha256
RUN mkdir /tmp/apks \
    && apk update \
    && apk fetch --recursive --output /tmp/apks $(grep -v '^#' /usr/share/superhero-build/apk.lock) \
    && cd /tmp/apks && sha256sum -c /usr/share/superhero-build/apk.sha256 \
    && test "$(ls -1 *.apk | wc -l)" -eq "$(wc -l < /usr/share/superhero-build/apk.sha256)" \
    && apk add --no-network /tmp/apks/*.apk \
    && rm -rf /tmp/apks /var/cache/apk/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /src
# Copy only executable output, production dependencies and required assets.
COPY --from=build --chown=node:node /src/dist ./dist
COPY --from=build --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/package.json ./package.json
COPY --from=build --chown=node:node /src/views ./views
COPY --from=build --chown=node:node /src/scripts/migrate-with-lock.js ./scripts/migrate-with-lock.js
COPY --from=build --chown=node:node /src/src/plugins/address-links/aci/*.json ./dist/plugins/address-links/aci/
# The historical price loader resolves this data file relative to process.cwd().
COPY --from=build --chown=node:node /src/src/data/ae-pricing.json ./src/data/ae-pricing.json

# Run as an unprivileged user so a compromise of the Node process does not
# grant root inside the container (and does not make container-escape
# trivial). `node` is the default unprivileged user shipped in the
# official node images.
USER node

# Run pending DB migrations (synchronize is off), then start the app.
# `migrate-with-lock.js` wraps migration:run in a Postgres advisory lock so
# concurrent replica starts (rolling deploy, autoscaling) serialize on the
# migration instead of racing DDL — only one replica actually migrates, the
# rest block on the lock and then no-op against the already-applied history.
#
# `exec node dist/main` (NOT `npm run start:prod`) so the Node process REPLACES
# the shell and becomes PID 1: Docker's SIGTERM on a rolling deploy then reaches
# Node directly, so `enableShutdownHooks()` runs and every OnModuleDestroy /
# OnApplicationShutdown teardown (Redis/Bull quit, websocket close, TGR relay
# duties, indexer intervals) executes gracefully instead of being hard-killed
# after the grace period. `exec node …` is required rather than `exec npm …`
# because npm would stay PID 1 and spawn Node as a child that never sees the
# signal.
CMD ["sh", "-c", "node scripts/migrate-with-lock.js && exec node dist/main"]
