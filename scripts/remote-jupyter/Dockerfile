FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN groupadd --gid 65532 openwrangler \
    && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /home/openwrangler --shell /usr/sbin/nologin openwrangler \
    && install --directory --owner=65532 --group=65532 --mode=0500 /home/openwrangler \
    && install --directory --owner=0 --group=0 --mode=0555 /opt/openwrangler

COPY requirements.txt /opt/openwrangler/requirements.txt
RUN python -I -m pip install \
      --isolated \
      --no-input \
      --only-binary=:all: \
      --require-hashes \
      --requirement /opt/openwrangler/requirements.txt \
    && python -I -m pip check \
    && python -I -m ipykernel install \
      --sys-prefix \
      --name openwrangler-remote-acceptance \
      --display-name "Open Wrangler Remote Acceptance"

COPY inject-token.py server.py /opt/openwrangler/
RUN chmod 0555 /opt/openwrangler/inject-token.py /opt/openwrangler/server.py \
    && chmod 0444 /opt/openwrangler/requirements.txt

USER 65532:65532
WORKDIR /home/openwrangler
EXPOSE 8888/tcp
ENTRYPOINT ["python", "-I", "/opt/openwrangler/server.py"]
