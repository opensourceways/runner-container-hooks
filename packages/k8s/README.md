# K8s Hooks

## Description
This implementation provides a way to dynamically spin up jobs to run container workflows, rather then relying on the default docker implementation. It is meant to be used when the runner itself is running in k8s, for example when using the [Actions Runner Controller](https://github.com/actions-runner-controller/actions-runner-controller)

## Pre-requisites 
Some things are expected to be set when using these hooks
- The runner itself should be running in a pod, with a service account with the following permissions
```
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: default
  name: runner-role
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "create", "delete"]
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["get", "create"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get", "list", "watch",]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "create", "delete"]
```
- (Recommended) Granting `events` read access lets the hooks attach recent
  `Warning` events (e.g. `FailedScheduling`, `FailedMount`) to the error message
  when a pod fails to come online, and lets the image-pull grace check tell an
  in-flight retry from a plain backoff (see
  `ACTIONS_RUNNER_K8S_IMAGE_PULL_GRACE_SECONDS`). The hooks still work without
  it — they omit the event section from diagnostics and fall back to the plain
  grace window, which can abort a slow but progressing pull.
```
- apiGroups: [""]
  resources: ["events"]
  verbs: ["get", "list"]
```
- The `ACTIONS_RUNNER_POD_NAME` env should be set to the name of the pod
- The `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` env should be set to true to prevent the runner from running any jobs outside of a container
- The runner pod should map a persistent volume claim into the `_work` directory
    - The `ACTIONS_RUNNER_CLAIM_NAME` env should be set to the persistent volume claim that contains the runner's working directory, otherwise it defaults to `${ACTIONS_RUNNER_POD_NAME}-work`
- Some actions runner env's are expected to be set. These are set automatically by the runner.
    - `RUNNER_WORKSPACE` is expected to be set to the workspace of the runner
    - `GITHUB_WORKSPACE` is expected to be set to the workspace of the job
- Optional tuning env's
    - `ACTIONS_RUNNER_K8S_UNRECOVERABLE_WAITING_REASONS` — comma-separated list of
      extra container `waiting` reasons that should be treated as deterministic
      terminal failures (fail fast instead of waiting for the timeout). These are
      *added* to the built-ins (`InvalidImageName`, `CreateContainerConfigError`);
      the built-ins can never be removed. Use with care — only list reasons that
      are truly unrecoverable for your workloads (e.g. `CrashLoopBackOff`).
    - `ACTIONS_RUNNER_K8S_IMAGE_PULL_GRACE_SECONDS` — how long `ImagePullBackOff`
      / `ErrImagePull` may persist before the hook fails the job (default `300`,
      i.e. 5 minutes). The pod is given this window to self-heal, e.g. during a
      transient network outage. When the grace period expires the hook checks
      the pod's events: if the latest `Pulling` event is newer than the latest
      pull failure (`FailedPullImage` / `BackOffPullImage`, or
      `Failed` / `BackOff` / `InspectFailed` depending on the kubelet build), a
      retry is still in flight and the window restarts, so a large image that
      keeps making progress is not killed mid-transfer (the overall
      prepare-job timeout still applies). This check needs the recommended
      `events` list permission; without it the plain grace window is used and a
      slow retry is killed at the grace boundary. Permanent image errors (bad
      tag, invalid credentials, missing repository) are detected from the
      waiting message and still fail immediately. Set to `0` to fail as soon as
      the pull failure is observed (the previous behavior).
    - `ACTIONS_RUNNER_K8S_SCHEDULING_GRACE_SECONDS` — how long a job pod may stay
      unschedulable (`FailedScheduling`) before the hook fails it (default
      `600`, i.e. 10 minutes). The window is measured from the job pod's
      `metadata.creationTimestamp`, so a hook restart or a job retry never
      restarts the clock; if that timestamp is missing the hook falls back to
      the first time it observed the pod. Within the window the pod keeps
      queuing (a periodic progress line is logged) and no error is raised, so a
      job waiting for nodes to scale up is not killed. Once the window expires
      the hook fails with the last scheduler message and the elapsed time.
      Scheduler message text is never matched on its own: a single message often
      mixes a normal "node(s) didn't match Pod's node affinity/selector" line
      with real cpu/memory shortages. Deterministic failures such as
      `FailedMount`, `FailedBinding` and container-level errors still fail
      immediately. Set to `0` to disable the window (fail as soon as
      `FailedScheduling` is observed). The prepare-job timeout
      (`ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS`) remains the outer bound; if
      the grace is greater than or equal to it, the timeout wins (with a
      warning).


## Limitations
- A [job containers](https://docs.github.com/en/actions/using-jobs/running-jobs-in-a-container) will be required for all jobs
- Building container actions from a dockerfile is not supported at this time
- Container actions will not have access to the services network or job container network
- Docker [create options](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idcontaineroptions) are not supported
- Container actions will have to specify the entrypoint, since the default entrypoint will be overridden to run the commands from the workflow.
- Container actions need to have the following binaries in their container image: `sh`, `env`, `tail`.
