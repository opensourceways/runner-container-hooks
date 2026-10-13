ARG RUNNER_VERSION
ARG BASE_REGISTRY=ghcr.nju.edu.cn
ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/opensourceway/node:latest

FROM ${NODE_IMAGE} AS runner_builder

WORKDIR /app

COPY . /app/

RUN npm install && npm run bootstrap && npm run build-all

FROM ${BASE_REGISTRY}/actions/actions-runner:${RUNNER_VERSION}

COPY --from=runner_builder /app/packages/k8s/dist/index.js /home/runner/k8s/index.js

USER runner
