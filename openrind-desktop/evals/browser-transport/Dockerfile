# Experiment overlay only: never modify the normal image/launcher contract here.
ARG BASE_IMAGE=openrind-shell-fuse:local
FROM ${BASE_IMAGE}
USER root
COPY launcher.c /tmp/browser-probe-launcher.c
RUN cc -std=c11 -O2 -Wall -Wextra -Werror /tmp/browser-probe-launcher.c -o /usr/local/bin/openrind-browser-spike \
    && rm /tmp/browser-probe-launcher.c
COPY dist/*.cjs /opt/openrind-browser-spike/
COPY descriptor.json /etc/openrind-browser-spike.json
COPY policy.yaml /etc/openshell/policy.yaml
COPY tls/ /usr/local/share/ca-certificates/browser-probe/
RUN for cert in /usr/local/share/ca-certificates/browser-probe/*.crt; do \
      if [ -f "$cert" ]; then cat "$cert" >> /etc/ssl/certs/ca-certificates.crt; fi; \
    done
RUN mkdir -p /sandbox/browser-probe-home \
    && printf '%s\n' '{"mcpServers":{"openrind-browser":{"type":"stdio","command":"/usr/local/bin/openrind-browser-spike","args":[]}}}' > /sandbox/browser-probe-home/.claude.json \
    && chown -R sandbox:sandbox /sandbox/browser-probe-home \
    && chmod 755 /usr/local/bin/openrind-browser-spike \
    && chmod 644 /etc/openrind-browser-spike.json \
    && chmod -R a+rX /opt/openrind-browser-spike
WORKDIR /sandbox
