# 插件市场提交（awesome-dsh-plugin）

本目录只放**提交给 `awesome-dsh-plugin` 的条目 YAML**，不含任何运行数据、聊天记录、Cookie、Token 或 openid。

## 为什么是 PR 而不是“上传”

插件市场的实际收录流程：

1. 插件代码在**公开 GitHub 仓库**（本仓库：<https://github.com/wuwo1979/dsh-qqbot-muu>）；
2. 向 [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 **Pull Request**，在 `data/plugins/` 下新增一个 YAML；
3. 合并后市场/目录站自动收录。

## 本插件的条目

已准备好：`submission/wuwo1979__dsh-qqbot-muu.yml`

文件名规则：`<owner>__<repo>.yml`（owner 与 repo 之间是**双下划线**）。

## 提 PR 的步骤

```powershell
# 1) fork + clone awesome-dsh-plugin
git clone https://github.com/<你的账号>/awesome-dsh-plugin
cd awesome-dsh-plugin
git checkout -b add-dsh-qqbot-muu

# 2) 只加这一个文件
copy F:\qqbot\submission\wuwo1979__dsh-qqbot-muu.yml data\plugins\wuwo1979__dsh-qqbot-muu.yml

# 3) 提交并发起 PR
git add data/plugins/wuwo1979__dsh-qqbot-muu.yml
git commit -m "Add dsh-qqbot-muu"
git push -u origin add-dsh-qqbot-muu
```

## CI 会检查

- 仓库的 `package.json` 必须有 `dsh.bundle`（本仓库已有 `dsh.bundle.patch = ./cordis.patch.yml`）；
- 仓库带 `dsh-plugin` topic（已设置：`dsh-plugin`、`dsh`、`qqbot`、`bilibili`）；
- 仓库创建满 1 天；
- 条目 YAML 的 `url` / `name` / `category` / `description.en|zh` 齐全，描述与代码一致；
- 一个 PR 最多 3 条。

## 隐私边界（提交前必须保持）

- 不提交 `docs/`、`secrets/`、`dshqqbot/.qqbot/`、`dshqqbot/表情包/`、`bili-cookie.json`、`bili-ops-config.json`、`memory.db`、`bili-shares.jsonl`、B 站成片产物；
- 提交前跑 `scripts/check-secrets.ps1`；
- 本条目只描述功能，不含任何真实账号、群号、openid、B 站 UID 或评论内容。
