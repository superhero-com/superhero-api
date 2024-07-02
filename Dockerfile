FROM node:18-alpine
RUN apk add --no-cache git
# support for private repositories
RUN --mount=type=secret,id=GITHUB_TOKEN \
    git config --global url."https://x-access-token:$(cat /run/secrets/GITHUB_TOKEN)@github.com/".insteadOf "ssh://git@github.com"

WORKDIR /src
COPY . .
RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

CMD ["npm", "run", "start:prod"]
