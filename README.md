# jimeng-drama

即梦（Dreamina）CLI 驱动的 AI 短剧生成引擎。输入一份剧本，输出 9:16 竖屏、1080P、带配音与字幕的成片。

## 为什么这样做

即梦官方 CLI `dreamina` 是面向 Agent 的命令行工具，用自己账号的会员权益与积分，**不需要额外申请 API**。项目围绕它做编排，把"抽卡式单条生成"变成"可恢复的批量生产流水线"。

三个关键设计决定：

1. **Provider 抽象层**。默认走官方 CLI，另有 `mock` 通道（ffmpeg 合成占位素材，零积分）用于联调和回归。计划中的火山引擎 API 通道只需新增一个 adapter，业务代码零改动。
2. **状态机 + 幂等**。每个镜头独立记录 `status / submitId / output / creditsSpent`，落盘走原子写并串行化。中断后 `run` 续跑不会重复扣费。
3. **依赖感知调度**。镜头按「上一镜末帧 → 下一镜首帧」串联时，子镜头会等父镜头完成末帧抽取后才启动，避免抢跑导致画面断层。

## 快速开始（零积分验证）

```bash
npm install

# 环境自检：node / ffmpeg / dreamina / 登录态 / 字幕能力 / 中文 TTS
npx tsx src/cli.ts doctor

# 用 mock 通道跑通全链路，不花一分积分
npx tsx src/cli.ts init demo
npx tsx src/cli.ts all demo --provider=mock
```

产物在 `projects/demo/out/final.mp4`。

## 真实出片

```bash
npx tsx src/cli.ts init <slug> --title "剧名·EP01" --ratio 9:16 --duration 100 --budget 400
# 编辑 projects/<slug>/script.md
npx tsx src/cli.ts script <slug>
npx tsx src/cli.ts chars  <slug>      # 角色定妆图
npx tsx src/cli.ts audio  <slug>      # 对白配音
npx tsx src/cli.ts plan   <slug>      # 先看要花多少积分
npx tsx src/cli.ts run    <slug>
npx tsx src/cli.ts compose <slug>
```

## 剧本文法

```markdown
## 场景 1 · 雨夜街头
[动作] 雨幕倾泻，霓虹倒映在积水里
林夏：你终于来了。
陈默：我以为你不会等我。
```

`##` = 场景，`[动作]` 或纯描述行 = 空镜，`名字：台词` = 对白镜。对白时长按 4.5 字/秒自动估算。

## 命令

| 命令 | 作用 |
|---|---|
| `doctor` | 环境、登录态、字幕能力、TTS 自检 |
| `init` | 建项目，生成示例剧本与 3 个示例镜头 |
| `script` | 剧本 → 分镜（已完成镜头保留） |
| `chars` | 角色定妆图（身份锚点） |
| `audio` | 对白配音，真人录音优先复用 |
| `plan` | 预估积分消耗 |
| `status` | 镜头状态与花费 |
| `run` | 逐镜生成，支持并发与续跑 |
| `compose` | 拼接成片、字幕、BGM |
| `all` | 一条龙 |

## 结构

```
src/
├── types.ts              zod schema：Project / Shot / Character / ShotMode
├── core/
│   ├── fsx.ts            原子写（随机临时名）
│   ├── project.ts        项目读写，shots.json 写入串行化
│   ├── budget.ts         积分预算硬闸
│   └── logger.ts
├── providers/
│   ├── types.ts          Provider 接口 + ratio 禁传规则
│   ├── dreamina.ts       官方 CLI 适配器，错误码分类
│   └── mock.ts           ffmpeg 占位素材，零积分
├── pipeline/
│   ├── bible.ts          剧本解析 → 分镜
│   ├── characters.ts     角色定妆图
│   ├── shots.ts          调度主循环、依赖感知、末帧衔接
│   ├── audio.ts          TTS 配音与时长适配
│   └── compose.ts        规格统一、拼接、字幕、BGM、末帧抽取
└── cli.ts
```

## 成片组装做了什么

`compose` 阶段按顺序做六件事，每一步都有实测踩过的坑：

1. **规格统一** —— 每镜重编码到同分辨率/同帧率/同音频参数，否则 `concat` 会音画错位
2. **拼接** —— concat demuxer + `-c copy`，无损快速
3. **字幕** —— 有 libass 就烧硬字幕；没有就内嵌 `mov_text` **软字幕轨**（显式 `-map`，默认流选择会静默丢轨）
4. **配音轨装配** —— 按镜头顺序把 TTS 拼成一条时间线，每段用 `apad` **补齐到镜头时长**。不补的话台词会逐段提前，104 秒的片子能错位 25 秒
5. **BGM** —— 循环铺满、压低到 18%、随主片长截断
6. **末帧抽取** —— 上一镜末帧喂给下一镜首帧，做镜头衔接

## 已知限制

- **硬字幕需要 libass**。当前 ffmpeg 若无 `subtitles` 滤镜，自动降级为**内嵌软字幕轨**（`mov_text`），播放器可开关，不影响发布。
- **TTS 依赖 macOS `say`**。要换豆包语音或真人配音，把音频放到 `projects/<slug>/audio/<shotId>.mp3` 即可，引擎会优先复用且不覆盖。
- **口型对齐尚未验证**。`multimodal2video --image --audio` 是官方给的口型路径，但 CLI help 只承诺"音频作为参考输入"，实测前不要对外承诺效果。若实测不可用，备选方案是本地 lip-sync 后处理（LatentSync / Sonic）或镜头语言规避（对白改背影侧脸 + 旁白）。
- **成本为估算**。`budget.ts` 里的单价来自实测与社区数据，真实扣费以返回的 `credit_count` 为准（引擎已优先读取该字段）。
- **mock 通道产出的是测试图案**，只用于验证流水线，不是可用画面。
