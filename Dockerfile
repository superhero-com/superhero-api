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

CMD ["npm", "run", "start:prod"]
