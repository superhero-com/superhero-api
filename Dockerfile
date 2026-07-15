FROM node:20-alpine
RUN apk add --no-cache git
# support for private repositories
RUN --mount=type=secret,id=GITHUB_TOKEN \
    git config --global url."https://x-access-token:$(cat /run/secrets/GITHUB_TOKEN)@github.com/".insteadOf "ssh://git@github.com"

WORKDIR /src
COPY . .
RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

# Run as an unprivileged user so a compromise of the Node process does not
# grant root inside the container (and does not make container-escape
# trivial). `node` is the default unprivileged user shipped in the
# official node images.
RUN chown -R node:node /src
USER node

# Run pending DB migrations (synchronize is off), then start the app.
# `migrate:prod:locked` wraps migration:run in a Postgres advisory lock so
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
CMD ["sh", "-c", "npm run migrate:prod:locked && exec node dist/main"]
