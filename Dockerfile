# release 分支按版本固定默认值，避免构建时忘记传 --build-arg
ARG RUNNER_VERSION=2.338.0
ARG BASE_REGISTRY=ghcr.nju.edu.cn
ARG NODE_IMAGE=swr.cn-north-4.myhuaweicloud.com/opensourceway/node:latest

FROM ${NODE_IMAGE} AS runner_builder

WORKDIR /app

COPY . /app/

RUN npm install && npm run bootstrap && npm run build-all

FROM ${BASE_REGISTRY}/actions/actions-runner:${RUNNER_VERSION}

COPY --from=runner_builder /app/packages/k8s/dist/index.js /home/runner/k8s/index.js

USER runner
