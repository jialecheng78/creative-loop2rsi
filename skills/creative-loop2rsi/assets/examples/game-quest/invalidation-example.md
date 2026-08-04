# L3 局部失效示意（不是执行证据）

## 情况一：世界规则改变

若“邮票只能保存一句话”变为“邮票只能保存一个声音”，则：

- `world-rule-patch` 产生新版本；
- `quest-outline` 与 `quest-dialogue` 标为 `STALE`；
- 重跑 `design-quest-structure` 和 `write-quest-dialogue`；
- 保留旧 attempt，不覆盖旧世界规则。

## 情况二：只调整一句对白

若用户只认为一句对白解释过多，则：

- `quest-dialogue` 产生新 attempt；
- `world-rule-patch` 和 `quest-outline` 的路径与哈希不变；
- 只重跑 `write-quest-dialogue` 和端到端发布判断；
- 不允许对白 Loop 反向改写世界事实。

真实 L3 验收必须用 manifest 和哈希证明这些边界。
