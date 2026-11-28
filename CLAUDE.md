# CLAUDE.md — runner-container-hooks (ascend fork) 发布指南

发版分两部分：**tag 自动出 zip Release** + **手动出镜像**。

## 完整步骤

### 1）先把要发布的代码合进 main

tag 必须打在 main 上，CD 会校验（`git merge-base --is-ancestor`）。

### 2）确认版本号

`package.json` 的 `version` 字段就是版本号，tag 名 = `v` + 它。

- 现在 main 上是 `0.8.0-ascend.1`，所以首个 tag 就是 `v0.8.0-ascend.1`。
- 要发新版就改这个字段（如 `0.8.0-ascend.2`），顺便同步 `package-lock.json`（跑一次 `npm install`），提交合入 main。

### 3）打 tag 并推送

```bash
git checkout main
git pull
git tag v0.8.0-ascend.1
git push origin v0.8.0-ascend.1
```

### 4）CD 自动跑（`.github/workflows/release.yaml`）

推送 tag 后自动：

- 校验 tag 在 main 上 ✅
- 校验 tag == package.json 版本 ✅
- 构建 zip → 创建 GitHub Release `v0.8.0-ascend.1`（含 `actions-runner-hooks-k8s-*.zip`、`-docker-*.zip`）

### 5）镜像（手动，因为改成了手动出包）

- Actions → **Build & Push runner image** → Run workflow
- `image_tag` 填 `2.337.0-v0.8.0-ascend.1`（不填则默认 `<runner>-<分支>-<sha>`）
  - 注意：示例中的 runner 版本按实际选定的底座填写；`.github/runner-versions.yaml` 矩阵默认取最新一项（当前为 `2.338.0`）
- 结果推到 `swr.cn-southwest-2.myhuaweicloud.com/modelfoundry/runner:2.337.0-v0.8.0-ascend.1`

## 三条铁律（CD 会强制）

1. **tag 名 = `v` + package.json 版本**，必须一致；
2. **tag 必须打在 main 上**；
3. **tag 不可变**，推之前定好版本号（推了就改不了）。

> 更详细的镜像/Release 说明见 `docs/RELEASE.md`。
