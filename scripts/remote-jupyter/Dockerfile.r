ARG OPEN_WRANGLER_REMOTE_R_BASE_IMAGE
FROM ${OPEN_WRANGLER_REMOTE_R_BASE_IMAGE}

ARG OPEN_WRANGLER_REMOTE_R_COMPLETE_LOCK_SHA256
LABEL io.openwrangler.remote-jupyter.r-lock-sha256=${OPEN_WRANGLER_REMOTE_R_COMPLETE_LOCK_SHA256}

COPY r-packages.lock.json install-r-packages.py /opt/openwrangler/
RUN test "$(printf '%s' "${OPEN_WRANGLER_REMOTE_R_COMPLETE_LOCK_SHA256}" | grep -Ec '^[0-9a-f]{64}$')" = 1 \
    && chmod 0555 /opt/openwrangler/install-r-packages.py \
    && python -I /opt/openwrangler/install-r-packages.py \
        --manifest=/opt/openwrangler/r-packages.lock.json \
        --expected-lock-sha256="${OPEN_WRANGLER_REMOTE_R_COMPLETE_LOCK_SHA256}" \
        --library=/opt/openwrangler/r-library \
        --kernelspec-prefix=/opt/openwrangler/venv \
    && test -r /opt/openwrangler/r-package-lock-receipt.json

ENV R_LIBS_SITE=/opt/openwrangler/r-library

COPY inject-token.py server.py /opt/openwrangler/
RUN chmod 0555 /opt/openwrangler/inject-token.py /opt/openwrangler/server.py \
    && test -r /opt/openwrangler/requirements.r.txt

USER 65532:65532
WORKDIR /home/openwrangler
EXPOSE 8888/tcp
ENTRYPOINT ["python", "-I", "/opt/openwrangler/server.py"]
