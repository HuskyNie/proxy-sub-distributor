ARG KITTY_BROWSER_IMAGE=ghcr.io/linuxserver/chromium:latest
FROM ${KITTY_BROWSER_IMAGE}

COPY provider.py /opt/kitty-browser/provider.py
COPY kitty-provider /custom-services.d/kitty-provider
RUN chmod 0755 /custom-services.d/kitty-provider
