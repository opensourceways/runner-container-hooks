# 发布规范（main + tag）

本仓库是 `actions/runner-container-hooks` 的 fork。发布采用 **main + tag** 方式。

## 三条铁律

1. **唯一主干**：所有要发布的改动必须先进 `main`。
2. **版本一致**：`package.json` 的 `version` == git tag（去掉前缀 `v`）== Release 产物文件名。
3. **不可变**：tag 一经推送不得修改或删除；生产只引用 tag，不引用分支或 `latest`。

## 版本号

- 格式：`<上游版本>-ascend.<序号>`，例如 `0.8.1-ascend.1`。
- `<上游版本>` = 本仓库基于的上游 `actions/runner-container-hooks` 版本。
- git tag 加前缀 `v`：`v0.8.1-ascend.1`。

## 发布流程

1. 改动经 PR 合入 `main`。
2. 更新 `package.json` 的 `version`。
3. 在 `main` 上打 tag 并推送：
   ```bash
   git tag v0.8.1-ascend.1
   git push origin v0.8.1-ascend.1
   ```
4. `.github/workflows/release.yaml`（CD）自动执行：
   - 校验 tag 位于主干（默认分支）历史上；
   - 校验 tag 与 `package.json` 版本一致；
   - 构建并创建 GitHub Release（含 k8s / docker hooks zip）。
5. 生产 `runner/images/Dockerfile` 的 `RUNNER_CONTAINER_HOOKS_VERSION` 指向该版本。

## 同步上游

```bash
git fetch upstream --tags
git merge vX.Y.0        # 合并上游新版本 tag
# 解决冲突、测试、合入 main
```

- `main` 基于固定的上游 **tag**，而非移动的 `upstream/main`。
- 能回贡上游的通用改动，尽量提 PR 回上游，减少长期私有 diff。

## 自有 runner 镜像

由 GitHub Actions（`.github/workflows/build-image.yaml`）构建并推送到 SWR（替换原 Jenkins 流水线）。

- 底座版本集中在 `.github/runner-versions.yaml`，升级 runner 只改此文件。
- `Dockerfile` 通过 `--build-arg RUNNER_VERSION=<version>` 接收底座版本。
- 镜像 tag 编码两个维度：

| 场景 | 触发 | 镜像 tag | 可变性 |
|---|---|---|---|
| 生产 | 打 tag `vX.Y.Z-ascend.N` | `<runner>-vX.Y.Z-ascend.N` | 不可变 |
| 测试 | 推分支 / 手动 dispatch | `<runner>-<branch>-<短sha>` | 可变 |

- 测试镜像用分支名 + 短 sha 标识，不打 tag、随时可弃；生产只引用不可变的 tag 镜像。
- 需要 secrets：`SWR_USERNAME`（含 region 前缀的完整用户名）、`SWR_PASSWORD`；镜像名与仓库见 workflow 的 `IMAGE_NAME`。

## 回滚

将生产 `RUNNER_CONTAINER_HOOKS_VERSION` 改回上一个 tag 版本并重建即可。

## 本地/临时验证

`release.yaml` 支持 `workflow_dispatch` 的 `dry_run`：只跑校验与构建，不创建 Release。
