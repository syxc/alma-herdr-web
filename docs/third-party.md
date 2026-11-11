# 第三方资源

浏览器依赖由 `npm run build:web` 复制到 `web/vendor/`。普通构建使用已有依赖和固定资源，不下载字体或编译终端内核。分发包携带对应许可证。

| 组件                   | 来源                                                                                                                                                            | 许可证               | 用途                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------ |
| Symbols Nerd Font Mono | [nerdfont-webfonts](https://mshaugh.github.io/nerdfont-webfonts/)                                                                                               | MIT 及所含图标集许可 | Nerd Font 图标回退                                     |
| Noto Sans Symbols 2    | [noto-fonts](https://github.com/notofonts/noto-fonts)                                                                                                           | SIL OFL 1.1          | U+23F4 至 U+23FA 播放符号                              |
| Ghostty VT             | [ghostty](https://github.com/ghostty-org/ghostty)                                                                                                               | MIT                  | 终端单元格与样式                                       |
| jsQR                   | [jsQR](https://github.com/cozmo/jsQR)                                                                                                                           | Apache-2.0           | 原生扫码不可用时解码二维码                             |
| noble                  | [hashes](https://github.com/paulmillr/noble-hashes)、[ciphers](https://github.com/paulmillr/noble-ciphers)、[curves](https://github.com/paulmillr/noble-curves) | MIT                  | WebCrypto 不可用时提供 HKDF、SHA-256、AES-GCM 与 P-256 |

`scripts/copy-vendor.mjs` 只复制实际使用的 noble 模块、jsQR 和许可证。这些复制产物不入库，可通过安装依赖和构建恢复。字体与 Ghostty WASM 是仓库内的固定资源。

## 图标字体

`web/vendor/nerd-fonts/` 固定使用上游 commit `c009b09b14e1de914a552a488b9d9306e0661c1a`。原件 `symbols-nerd-font-mono.woff2` 用于生成与核对，不进入 Workers 上传目录。

全部 10,397 个字符按 256 码位一页分为 50 个 WOFF2，保留字符映射、字形、hinting 和指标。CSS 的 `unicode-range` 与实际覆盖一致；Canvas 只加载当前画面需要的页。原字体不含 `⏵`，因此另附 Noto 的 7 个播放控制符号，补充 WOFF2 为 620 bytes。

符号字体只作缺字回退，正文继续使用系统字体。加载完成会触发 Canvas 补绘；请求超过 15 秒或失败后，每 5 秒重试画面仍需要的页。同一 Unicode 页可以对应多个互不重叠的字体范围。

```bash
npm run build:icons   # 重新生成 Nerd Font 分包
npm run check:icons   # 只读核对原件、分包、指标与范围清单
```

维护命令使用 `uv` 和固定的 `fonttools[woff]==4.68.0`。脚本校验原件 SHA-256，并按码位比较轮廓、横向指标和全局纵向指标，避免内部 glyph 名规范化影响判断。

播放符号固定取自 Noto commit `ffebf8c1ee449e544955a7e813c54f9b73848eac`，生成脚本校验源文件哈希：

```bash
mkdir -p dist
curl -fL https://raw.githubusercontent.com/notofonts/noto-fonts/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSansSymbols2/NotoSansSymbols2-Regular.ttf -o dist/noto-symbols-source.ttf
uv run --no-project --with 'fonttools[woff]==4.68.0' python scripts/subset-terminal-symbols.py --source dist/noto-symbols-source.ttf
```

加 `--check` 只核对已有播放符号分包。许可证分别见 `nerd-fonts/LICENSE` 和 `nerd-fonts/terminal-symbols/LICENSE`。

构建后运行 `node scripts/check-icon-font-browser.mjs`，打开输出地址。检查包含按需下载、失败重试、静止画面补绘、全部字符宽度及每页字形像素；播放符号检查强制使用自带字体，避免系统字体掩盖缺字。重新运行 HTTP 失败检查前需重启该服务。

## 终端内核

`web/vendor/ghostty/ghostty-vt.wasm` 来自 Ghostty `v1.4.0`，仅启用 `render-state`，由 `wasm-opt -Oz` 优化。模块与许可证入库，部署无需安装 Zig。

换版本时运行 `scripts/build-ghostty-vt.sh`，需要 Zig 与 binaryen，构建参数见 [Ghostty BUILD](../web/vendor/ghostty/BUILD.md)。浏览器绑定从模块 manifest 读取 ABI 布局，不手写字段偏移。
