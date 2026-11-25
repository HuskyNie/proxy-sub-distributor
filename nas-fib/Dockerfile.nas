# Reuse the verified running image's Node and YAML dependencies during NAS upgrades.
ARG BASE_IMAGE=fib-sub-sync:chain-fix-20260927
FROM ${BASE_IMAGE}
WORKDIR /app
COPY src ./src
