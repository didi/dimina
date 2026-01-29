## 查看当前分支

```bash
git branch

# 带*号就是当前分支
  main
* 上电冒烟

```

# 合并main分支到自己的分支
```bash
# 先切换到main分支
git checkout main
# 拉取远程main分支的最新代码（同步本地main）
git pull origin main
# 切回你的当前分支「上电冒烟」
git checkout 上电冒烟

# 合并
git merge main

```