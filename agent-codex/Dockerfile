# OpenAI's Codex CLI, as a Bot. Bun runs the AG-UI bridge; the CLI is the exact version pinned in
# agent-codex/package.json and resolved from bun.lock, so an image built later is the same one.
FROM oven/bun:1.4-alpine

WORKDIR /app
RUN chown bun:bun /app
USER bun
# The lockfile as well as the manifest, for the reason agent-bot gives: without it `--frozen-lockfile`
# resolves afresh and still exits 0.
COPY --chown=bun:bun agent-codex/package.json agent-codex/bun.lock ./agent-codex/
RUN cd agent-codex && bun install --frozen-lockfile

# Preserve the repo layout so `../../shared/listen-port` resolves the same in the image and locally.
COPY --chown=bun:bun shared ./shared
COPY --chown=bun:bun agent-codex/src ./agent-codex/src

# The CLI ships one native binary per platform, and bun installs only the one for this build. The
# link puts it on PATH as `codex` without naming an architecture here.
USER root
RUN set -eu; \
  case "$(uname -m)" in \
    x86_64) target=x86_64-unknown-linux-musl ;; \
    aarch64) target=aarch64-unknown-linux-musl ;; \
    *) echo "No Codex CLI build for $(uname -m)." >&2; exit 1 ;; \
  esac; \
  binary="$(ls /app/agent-codex/node_modules/@openai/codex-linux-*/vendor/${target}/bin/codex)"; \
  ln -s "$binary" /usr/local/bin/codex

# Everything Codex writes lives under one volume, so a container recreated from this image keeps
# its sessions (`codex exec resume` needs them), its per-thread workspaces and its session IDs.
# Made here so Docker copies bun's ownership into a new named volume.
RUN mkdir -p /var/lib/openbot-codex/home /var/lib/openbot-codex/workspaces /var/lib/openbot-codex/sessions && chown -R bun:bun /var/lib/openbot-codex
ENV CODEX_BIN=codex
ENV CODEX_HOME=/var/lib/openbot-codex/home
ENV CODEX_WORKSPACE_ROOT=/var/lib/openbot-codex/workspaces
ENV CODEX_STATE_DIR=/var/lib/openbot-codex/sessions
USER bun

ENV PORT=4215
EXPOSE 4215
CMD ["bun", "agent-codex/src/index.ts"]
