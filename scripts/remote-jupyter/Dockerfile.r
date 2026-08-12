ARG OPEN_WRANGLER_REMOTE_R_BASE_IMAGE
FROM ${OPEN_WRANGLER_REMOTE_R_BASE_IMAGE}

ARG R_REPOSITORY=https://p3m.dev/cran/__linux__/noble/2026-03-10
ARG R_SUPPLEMENTAL_REPOSITORY=https://p3m.dev/cran/__linux__/noble/2026-06-01
ARG IRKERNEL_VERSION=1.3.2
ARG JSONLITE_VERSION=2.0.0
ARG RLANG_VERSION=1.1.7
ARG TIBBLE_VERSION=3.3.1
ARG DATA_TABLE_VERSION=1.18.2.1
ARG COLLAPSE_VERSION=2.1.7
ARG NANOPARQUET_VERSION=0.5.1

ENV R_REPOSITORY=${R_REPOSITORY} \
    R_SUPPLEMENTAL_REPOSITORY=${R_SUPPLEMENTAL_REPOSITORY} \
    IRKERNEL_VERSION=${IRKERNEL_VERSION} \
    JSONLITE_VERSION=${JSONLITE_VERSION} \
    RLANG_VERSION=${RLANG_VERSION} \
    TIBBLE_VERSION=${TIBBLE_VERSION} \
    DATA_TABLE_VERSION=${DATA_TABLE_VERSION} \
    COLLAPSE_VERSION=${COLLAPSE_VERSION} \
    NANOPARQUET_VERSION=${NANOPARQUET_VERSION}

RUN Rscript --vanilla -e 'repository <- Sys.getenv("R_REPOSITORY"); supplemental_repository <- Sys.getenv("R_SUPPLEMENTAL_REPOSITORY"); packages <- c("IRkernel", "jsonlite", "rlang", "tibble", "data.table"); install.packages(packages, repos = repository, Ncpus = 2L); install.packages(c("collapse", "nanoparquet"), repos = supplemental_repository, Ncpus = 2L); expected <- c(IRkernel = Sys.getenv("IRKERNEL_VERSION"), jsonlite = Sys.getenv("JSONLITE_VERSION"), rlang = Sys.getenv("RLANG_VERSION"), tibble = Sys.getenv("TIBBLE_VERSION"), data.table = Sys.getenv("DATA_TABLE_VERSION"), collapse = Sys.getenv("COLLAPSE_VERSION"), nanoparquet = Sys.getenv("NANOPARQUET_VERSION")); actual <- vapply(names(expected), function(package) as.character(utils::packageVersion(package)), character(1)); stopifnot(as.character(getRversion()) == "4.5.2", identical(actual, expected)); IRkernel::installspec(user = FALSE, prefix = "/opt/openwrangler/venv", name = "openwrangler-r-remote-acceptance", displayname = "R (Open Wrangler Remote)")'

COPY inject-token.py server.py /opt/openwrangler/
RUN chmod 0555 /opt/openwrangler/inject-token.py /opt/openwrangler/server.py \
    && test -r /opt/openwrangler/requirements.r.txt

USER 65532:65532
WORKDIR /home/openwrangler
EXPOSE 8888/tcp
ENTRYPOINT ["python", "-I", "/opt/openwrangler/server.py"]
