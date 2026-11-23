# A weave Host for a machine in the cloud (WVE-238, a spike): `weave`, `weave-holder` and
# Tailscale. Built from the working tree by `scripts/host-image/build`; its entrypoint joins the
# Dispatcher named in its environment. It has Node for the agents' adapters, which the Host
# fetches the first time one is used; their sign-ins come from the Dispatcher (ADR 0036).

FROM rust:1.95-trixie AS build
RUN apt-get update -qq && apt-get install -y -qq cmake clang git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
ARG JOBS=6
# The registry, the build and the pinned Ghostty are kept between builds; the binaries are
# copied out of the build's cache, which isn't part of the image.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/target \
    CARGO_TARGET_DIR=/target WEAVE_GHOSTTY_CACHE=/target/ghostty \
    cargo build --release -j "$JOBS" --bin weave --bin weave-holder \
    && mkdir /out && cp /target/release/weave /target/release/weave-holder /out/

FROM debian:trixie-slim
RUN apt-get update -qq \
    && apt-get install -y -qq ca-certificates git iproute2 iptables \
    && rm -rf /var/lib/apt/lists/*
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscaled /usr/local/bin/tailscale /usr/local/bin/
# Node, which the agents' ACP adapters run on: the Host starts them with npx.
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
# weave-holder sits beside weave, which is where the Host looks for it.
COPY --from=build /out/weave /out/weave-holder /usr/local/bin/
COPY scripts/host-image/entrypoint.sh /usr/local/bin/weave-host-entrypoint
RUN chmod +x /usr/local/bin/weave-host-entrypoint
ENTRYPOINT ["/usr/local/bin/weave-host-entrypoint"]
