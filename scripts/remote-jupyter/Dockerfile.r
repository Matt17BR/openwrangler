FROM rocker/r-ver:4.5.2@sha256:fd4ccdd3a4a6f7ef805e2daeee2a0fe3bf126bc231f36351223baecf5a595a4c

ARG UBUNTU_SNAPSHOT=20260311T000000Z
ARG R_REPOSITORY=https://p3m.dev/cran/__linux__/noble/2026-03-10
ARG IRKERNEL_VERSION=1.3.2
ARG JSONLITE_VERSION=2.0.0
ARG RLANG_VERSION=1.1.7
ARG TIBBLE_VERSION=3.3.1
ARG DATA_TABLE_VERSION=1.18.2.1

ENV PATH=/opt/openwrangler/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    R_REPOSITORY=${R_REPOSITORY} \
    IRKERNEL_VERSION=${IRKERNEL_VERSION} \
    JSONLITE_VERSION=${JSONLITE_VERSION} \
    RLANG_VERSION=${RLANG_VERSION} \
    TIBBLE_VERSION=${TIBBLE_VERSION} \
    DATA_TABLE_VERSION=${DATA_TABLE_VERSION}

RUN find /etc/apt -maxdepth 2 -type f \( -name sources.list -o -name '*.sources' \) \
      -exec sed -i "s|http://archive.ubuntu.com/ubuntu|https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}|g; s|http://security.ubuntu.com/ubuntu|https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}|g" {} + \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      build-essential \
      libcurl4-openssl-dev \
      libssl-dev \
      libxml2-dev \
      libzmq3-dev \
      python3 \
      python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/openwrangler/venv \
    && groupadd --gid 65532 openwrangler \
    && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /home/openwrangler --shell /usr/sbin/nologin openwrangler \
    && install --directory --owner=65532 --group=65532 --mode=0500 /home/openwrangler \
    && chmod 0555 /opt/openwrangler

COPY requirements.txt /opt/openwrangler/requirements.txt
RUN python -I -m pip install \
      --isolated \
      --no-input \
      --only-binary=:all: \
      --require-hashes \
      --requirement /opt/openwrangler/requirements.txt \
    && python -I -m pip check \
    && Rscript --vanilla -e 'repository <- Sys.getenv("R_REPOSITORY"); packages <- c("IRkernel", "jsonlite", "rlang", "tibble", "data.table"); install.packages(packages, repos = repository, Ncpus = 2L); expected <- c(IRkernel = Sys.getenv("IRKERNEL_VERSION"), jsonlite = Sys.getenv("JSONLITE_VERSION"), rlang = Sys.getenv("RLANG_VERSION"), tibble = Sys.getenv("TIBBLE_VERSION"), data.table = Sys.getenv("DATA_TABLE_VERSION")); actual <- vapply(names(expected), function(package) as.character(utils::packageVersion(package)), character(1)); stopifnot(as.character(getRversion()) == "4.5.2", identical(actual, expected)); IRkernel::installspec(user = FALSE, prefix = "/opt/openwrangler/venv", name = "openwrangler-r-remote-acceptance", displayname = "R (Open Wrangler Remote)")'

COPY inject-token.py server.py /opt/openwrangler/
RUN chmod 0555 /opt/openwrangler/inject-token.py /opt/openwrangler/server.py \
    && chmod 0444 /opt/openwrangler/requirements.txt

USER 65532:65532
WORKDIR /home/openwrangler
EXPOSE 8888/tcp
ENTRYPOINT ["python", "-I", "/opt/openwrangler/server.py"]
